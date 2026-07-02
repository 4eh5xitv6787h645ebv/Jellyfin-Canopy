using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Configuration
{
    /// <summary>
    /// Read-compatibility tests for the per-user/shared JSON files: every fixture
    /// under Snapshots/UserFiles/*.read.*.json is a hand-written stand-in for a
    /// file that could exist on a real server today (written by any past plugin
    /// version, via the typed path, the raw client-JSON path, or a hand edit).
    ///
    /// These pin the LENIENT read semantics the Newtonsoft path provided
    /// (NullValueHandling.Ignore + case-insensitive member matching + unknown
    /// member tolerance + primitive coercion) so the System.Text.Json migration
    /// cannot silently change what an existing user file deserializes to — the
    /// failure mode being that a misread file returns defaults, and the next
    /// save permanently overwrites the user's real data.
    ///
    /// Also pins the STRICT read-modify-write semantics: corrupt files must
    /// throw (never silently become defaults) and leave a .corrupt-* backup.
    /// </summary>
    public class UserFileReadCompatTests : IDisposable
    {
        private const string UserId = "3f2504e04f8941d39a0c0305e82c3301";

        private readonly string _baseDir;
        private readonly UserConfigurationManager _manager;

        public UserFileReadCompatTests()
        {
            _baseDir = Path.Combine(Path.GetTempPath(), "je-userfile-read-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_baseDir);
            _manager = new UserConfigurationManager(new StubAppPaths(_baseDir), NullLogger<UserConfigurationManager>.Instance);
        }

        public void Dispose()
        {
            try { Directory.Delete(_baseDir, recursive: true); } catch { /* best effort */ }
        }

        private string UserDir => Path.Combine(_baseDir, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", UserId);

        private void SeedUserFile(string fixtureName, string targetFileName)
        {
            Directory.CreateDirectory(UserDir);
            File.Copy(UserFileFormatGoldenTests.FixturePath(fixtureName), Path.Combine(UserDir, targetFileName), overwrite: true);
        }

        private void SeedUserFileRaw(string targetFileName, string content)
        {
            Directory.CreateDirectory(UserDir);
            File.WriteAllText(Path.Combine(UserDir, targetFileName), content);
        }

        // ─── Lenient read semantics ──────────────────────────────────────────────

        /// <summary>
        /// JSON null on a non-nullable (or defaulted) property must be SKIPPED,
        /// keeping the constructor default — Newtonsoft's NullValueHandling.Ignore.
        /// This is load-bearing: fields that were once `bool?`/`string?` left
        /// literal nulls in real files, and reading them as "throw → defaults →
        /// next save wipes everything" was the original data-loss bug.
        /// </summary>
        [Fact]
        public void LenientRead_NullFields_KeepConstructorDefaults()
        {
            SeedUserFile("settings.read.null-fields", "settings.json");
            var s = _manager.GetUserConfiguration<UserSettings>(UserId, "settings.json");

            Assert.False(s.AutoPauseEnabled);                 // null → default(bool)
            Assert.Equal(5, s.PauseScreenDelaySeconds);       // null → non-trivial default kept
            Assert.Equal("percentage", s.WatchProgressMode);  // null → default string kept
            Assert.Equal(85, s.SubtitleVerticalPosition);     // null → default kept
            Assert.True(s.ShowResolutionTag);                 // null → default(true) kept
            Assert.Null(s.ResolutionTagOrder);                // nullable stays null
            Assert.Equal("kept-value", s.LastOpenedTab);      // real value still binds
        }

        /// <summary>Property-name matching is case-insensitive (Newtonsoft default).
        /// Files written via the raw client-JSON path have camelCase keys on disk.</summary>
        [Fact]
        public void LenientRead_CaseVariantKeys_Bind()
        {
            SeedUserFile("settings.read.case-variant", "settings.json");
            var s = _manager.GetUserConfiguration<UserSettings>(UserId, "settings.json");

            Assert.True(s.AutoPauseEnabled);
            Assert.Equal(11, s.PauseScreenDelaySeconds);
            Assert.Equal("time", s.WatchProgressMode);
            Assert.Equal("tab-x", s.LastOpenedTab);
            Assert.False(s.ShowResolutionTag); // even SHOUTING-case binds
        }

        /// <summary>Unknown members (from newer/older plugin versions) are ignored,
        /// not fatal — Newtonsoft MissingMemberHandling.Ignore default.</summary>
        [Fact]
        public void LenientRead_UnknownFields_AreIgnored()
        {
            SeedUserFile("settings.read.unknown-fields", "settings.json");
            var s = _manager.GetUserConfiguration<UserSettings>(UserId, "settings.json");

            Assert.True(s.AutoPauseEnabled);
            Assert.Equal(8, s.PauseScreenDelaySeconds);
        }

        /// <summary>
        /// Primitive coercion the Newtonsoft reader performed and legacy files rely on:
        /// numeric strings bind to int, "true"/"false" strings bind to bool, and
        /// bare numbers bind to string properties (e.g. TmdbId stored as a number
        /// by an old client payload).
        /// </summary>
        [Fact]
        public void LenientRead_LegacyPrimitiveCoercion_StillBinds()
        {
            SeedUserFile("settings.read.legacy-coercion", "settings.json");
            var s = _manager.GetUserConfiguration<UserSettings>(UserId, "settings.json");

            Assert.Equal(7, s.PauseScreenDelaySeconds); // "7" → 7
            Assert.True(s.AutoSkipIntro);               // "true" → true
            Assert.Equal("42", s.WatchProgressMode);    // 42 → "42"
        }

        [Fact]
        public void LenientRead_HiddenContent_MixedLegacyShapes()
        {
            SeedUserFile("hidden-content.read.mixed", "hidden-content.json");
            var hc = _manager.GetUserConfiguration<UserHiddenContent>(UserId, "hidden-content.json");

            // Valid entry binds, including number→string coercion for TmdbId.
            Assert.Equal("Kept — 映画", hc.Items["kept"].Name);
            Assert.Equal("27205", hc.Items["kept"].TmdbId);

            // A null dictionary entry must never surface as a usable item.
            // (Newtonsoft materialized the key with a null value; the STJ path may
            // drop it entirely — both are acceptable, "item exists" is not.)
            Assert.True(!hc.Items.TryGetValue("nulled", out var nulled) || nulled == null);

            // "Settings": null keeps the default settings object (NullValueHandling.Ignore).
            Assert.NotNull(hc.Settings);
            Assert.True(hc.Settings.Enabled);
            Assert.False(hc.Settings.FilterSearch);
        }

        /// <summary>All ISO 8601 shapes historically written to disk keep parsing
        /// to the same instants/kinds (Z, fractional seconds, no suffix, offset).</summary>
        [Fact]
        public void LenientRead_ProcessedWatchlist_DateShapes()
        {
            SeedUserFile("processed-watchlist.read.date-shapes", "processed-watchlist-items.json");
            var items = _manager.GetProcessedWatchlistItems(Guid.Parse(UserId)).Items;

            Assert.Equal(4, items.Count);

            Assert.Equal(new DateTime(2025, 1, 2, 3, 4, 5, DateTimeKind.Utc), items[0].ProcessedAt);
            Assert.Equal(DateTimeKind.Utc, items[0].ProcessedAt.Kind);

            Assert.Equal(new DateTime(2025, 1, 2, 3, 4, 5, 123, DateTimeKind.Utc), items[1].ProcessedAt);

            Assert.Equal(new DateTime(2025, 1, 2, 3, 4, 5), items[2].ProcessedAt);
            Assert.Equal(DateTimeKind.Unspecified, items[2].ProcessedAt.Kind);

            // Offset form: instant is what matters (Kind is machine-local after adjust).
            Assert.Equal(new DateTime(2025, 1, 2, 3, 4, 5, DateTimeKind.Utc), items[3].ProcessedAt.ToUniversalTime());
        }

        [Fact]
        public void Reviews_LegacyFile_ReadsWithMissingAndCaseVariantFields()
        {
            var configDir = Path.Combine(_baseDir, "configurations", "Jellyfin.Plugin.JellyfinEnhanced");
            Directory.CreateDirectory(configDir);
            File.Copy(UserFileFormatGoldenTests.FixturePath("reviews.read.legacy"), Path.Combine(configDir, "reviews.json"), overwrite: true);

            var store = _manager.GetAllReviews();
            Assert.Equal(2, store.Reviews.Count);

            var movie = store.Reviews["abc:movie:603"];
            Assert.Equal("Ancien avis — 素晴らしい", movie.Content);
            Assert.Null(movie.Rating);
            Assert.Equal(string.Empty, movie.UpdatedAt); // missing member → default

            var tv = store.Reviews["def:tv:1399"]; // camelCase member names bind
            Assert.Equal(3, tv.Rating);
            Assert.Equal("case-variant keys", tv.Content);
        }

        // ─── Lenient read: corruption returns defaults (read-only paths) ─────────

        [Fact]
        public void LenientRead_EmptyOrGarbageOrLiteralNull_ReturnsDefaults()
        {
            SeedUserFileRaw("settings.json", "");
            Assert.Equal(5, _manager.GetUserConfiguration<UserSettings>(UserId, "settings.json").PauseScreenDelaySeconds);

            SeedUserFileRaw("settings.json", "{{{ not json");
            Assert.Equal(5, _manager.GetUserConfiguration<UserSettings>(UserId, "settings.json").PauseScreenDelaySeconds);

            SeedUserFileRaw("settings.json", "null");
            Assert.Equal(5, _manager.GetUserConfiguration<UserSettings>(UserId, "settings.json").PauseScreenDelaySeconds);
        }

        // ─── Strict read semantics (the write/RMW path) ──────────────────────────

        [Fact]
        public void StrictRead_MissingFile_ReturnsDefaults()
        {
            var s = _manager.GetUserConfigurationStrict<UserSettings>(UserId, "settings.json");
            Assert.Equal(5, s.PauseScreenDelaySeconds);
        }

        [Theory]
        [InlineData("")]           // crashed-write artifact
        [InlineData("   \n")]      // whitespace only
        [InlineData("null")]       // literal JSON null
        [InlineData("{{{ nope")]   // parse failure
        public void StrictRead_CorruptFile_Throws_And_BacksUp(string content)
        {
            SeedUserFileRaw("settings.json", content);

            Assert.ThrowsAny<Exception>(() => _manager.GetUserConfigurationStrict<UserSettings>(UserId, "settings.json"));

            // Original bytes are preserved twice over: in place and as a forensic backup.
            Assert.Equal(content, File.ReadAllText(Path.Combine(UserDir, "settings.json")));
            Assert.Single(Directory.GetFiles(UserDir, "settings.json.corrupt-*"));
        }

        /// <summary>JSON null on a non-nullable property is corruption on the STRICT
        /// path (both serializers throw), unlike the lenient path which skips it.</summary>
        [Fact]
        public void StrictRead_NullIntoNonNullable_Throws_And_BacksUp()
        {
            SeedUserFileRaw("settings.json", "{\"AutoPauseEnabled\": null}");

            Assert.ThrowsAny<Exception>(() => _manager.GetUserConfigurationStrict<UserSettings>(UserId, "settings.json"));
            Assert.Single(Directory.GetFiles(UserDir, "settings.json.corrupt-*"));
        }

        [Fact]
        public void Rmw_OnCorruptFile_Throws_And_DoesNotOverwrite()
        {
            SeedUserFileRaw("hidden-content.json", "{{{ corrupt");

            Assert.ThrowsAny<Exception>(() =>
                _manager.RmwUserConfiguration<UserHiddenContent>(UserId, "hidden-content.json", hc => 1));

            Assert.Equal("{{{ corrupt", File.ReadAllText(Path.Combine(UserDir, "hidden-content.json")));
        }

        [Fact]
        public void UpsertReview_OnCorruptReviewsFile_Throws_And_BacksUp()
        {
            var configDir = Path.Combine(_baseDir, "configurations", "Jellyfin.Plugin.JellyfinEnhanced");
            Directory.CreateDirectory(configDir);
            File.WriteAllText(Path.Combine(configDir, "reviews.json"), "not-json");

            Assert.ThrowsAny<Exception>(() => _manager.UpsertReview("u", "movie", "1", "c", null, "2024-01-01T00:00:00.000Z"));

            Assert.Equal("not-json", File.ReadAllText(Path.Combine(configDir, "reviews.json")));
            Assert.Single(Directory.GetFiles(configDir, "reviews.json.corrupt-*"));
        }

        // ─── Value-level round-trips for known byte-level divergences ────────────

        /// <summary>Whole-number doubles: Newtonsoft wrote "0.0"/"1750000000.0",
        /// STJ writes "0"/"1750000000". Value must round-trip regardless.</summary>
        [Fact]
        public void WholeNumberTimestamp_RoundTripsByValue()
        {
            var bookmarks = new UserBookmark
            {
                Bookmarks = new Dictionary<string, BookmarkItem>
                {
                    ["whole"] = new BookmarkItem { ItemId = "w", Timestamp = 1750000000 },
                },
            };
            _manager.SaveUserConfiguration(UserId, "bookmark.json", bookmarks);

            var back = _manager.GetUserConfiguration<UserBookmark>(UserId, "bookmark.json");
            Assert.Equal(1750000000d, back.Bookmarks["whole"].Timestamp);

            // And the historical form ("...0.0") keeps reading too.
            SeedUserFileRaw("bookmark.json", "{\"Bookmarks\":{\"whole\":{\"ItemId\":\"w\",\"Timestamp\":1750000000.0}}}");
            Assert.Equal(1750000000d, _manager.GetUserConfiguration<UserBookmark>(UserId, "bookmark.json").Bookmarks["whole"].Timestamp);
        }

        /// <summary>Astral-plane characters: Newtonsoft wrote raw emoji, STJ writes
        /// surrogate-pair escapes. Both are the same JSON string; value must round-trip.</summary>
        [Fact]
        public void EmojiLabel_RoundTripsByValue()
        {
            var bookmarks = new UserBookmark
            {
                Bookmarks = new Dictionary<string, BookmarkItem>
                {
                    ["e"] = new BookmarkItem { ItemId = "e", Label = "🎬 popcorn 🍿", Timestamp = 1.5 },
                },
            };
            _manager.SaveUserConfiguration(UserId, "bookmark.json", bookmarks);

            var back = _manager.GetUserConfiguration<UserBookmark>(UserId, "bookmark.json");
            Assert.Equal("🎬 popcorn 🍿", back.Bookmarks["e"].Label);

            // Historical raw-emoji bytes keep reading.
            SeedUserFileRaw("bookmark.json", "{\"Bookmarks\":{\"e\":{\"ItemId\":\"e\",\"Label\":\"🎬 popcorn 🍿\",\"Timestamp\":1.5}}}");
            Assert.Equal("🎬 popcorn 🍿", _manager.GetUserConfiguration<UserBookmark>(UserId, "bookmark.json").Bookmarks["e"].Label);
        }

        /// <summary>
        /// Raw client-JSON pass-through with a full ISO datetime string: Newtonsoft
        /// re-parsed it as a date and re-serialized it normalized
        /// ("2024-01-15T10:30:00Z"); STJ preserves the client's text verbatim
        /// ("2024-01-15T10:30:00.000Z"). Both must remain the SAME instant when read.
        /// </summary>
        [Fact]
        public void RawClientJson_IsoDateString_KeepsInstant()
        {
            using var doc = JsonDocument.Parse("{\"CreatedAt\": \"2024-01-15T10:30:00.000Z\"}");
            _manager.SaveUserConfiguration(UserId, "raw.json", doc.RootElement.Clone());

            using var written = JsonDocument.Parse(File.ReadAllText(Path.Combine(UserDir, "raw.json")));
            var value = written.RootElement.GetProperty("CreatedAt").GetString();
            Assert.True(
                DateTime.TryParse(value, null, System.Globalization.DateTimeStyles.RoundtripKind, out var parsed),
                $"CreatedAt '{value}' is no longer a parseable ISO instant");
            Assert.Equal(new DateTime(2024, 1, 15, 10, 30, 0, DateTimeKind.Utc), parsed.ToUniversalTime());
        }
    }
}
