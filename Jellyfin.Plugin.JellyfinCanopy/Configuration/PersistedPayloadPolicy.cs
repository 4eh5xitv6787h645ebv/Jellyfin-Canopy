using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    internal enum PersistedPayloadStatus
    {
        Valid,
        Invalid,
        TooLarge
    }

    internal readonly record struct PersistedPayloadValidation(
        PersistedPayloadStatus Status,
        string Code,
        int SerializedBytes)
    {
        public bool IsValid => Status == PersistedPayloadStatus.Valid;

        public static PersistedPayloadValidation Valid(int serializedBytes)
            => new(PersistedPayloadStatus.Valid, string.Empty, serializedBytes);

        public static PersistedPayloadValidation Invalid(string code)
            => new(PersistedPayloadStatus.Invalid, code, 0);

        public static PersistedPayloadValidation TooLarge(
            int serializedBytes,
            string code = "payload_too_large")
            => new(PersistedPayloadStatus.TooLarge, code, serializedBytes);
    }

    /// <summary>
    /// One policy primitive for every complete user-owned configuration payload.
    /// Request limits are enforced before model binding; these typed limits are
    /// the second line of defence before a lock, cache mutation, or disk write.
    /// </summary>
    internal static class PersistedPayloadPolicy
    {
        public const long StandardRequestBytes = 1024 * 1024;
        public const int StandardPersistedBytes = 1024 * 1024;
        public const long HiddenContentRequestBytes = 8L * 1024 * 1024;
        public const int HiddenContentPersistedBytes = 7 * 1024 * 1024;
        public const long SpoilerOverridesRequestBytes = 2L * 1024 * 1024;
        public const int SpoilerOverridesPersistedBytes = 2 * 1024 * 1024;
        // A 1,000-operation move can repeat every bounded bookmark field plus
        // source/target ids. Field limits count UTF-16 characters, while JSON
        // control-character escaping can consume six UTF-8 bytes per character.
        // Twenty MiB covers that proven worst-case shape while remaining below
        // Kestrel's 30,000,000-byte host ceiling; persisted state stays at 1 MiB.
        public const long BookmarkRequestBytes = 20L * 1024 * 1024;
        public const int BookmarkPersistedBytes = 1024 * 1024;
        public const int AbsolutePersistedBytes = 8 * 1024 * 1024;

        public const int MaximumStandardStringLength = 512;
        public const int MaximumExtensionProperties = 1000;
        public const int MaximumExtensionPropertyNameLength = 256;
        public const int MaximumExtensionStringLength = 4096;
        public const int MaximumExtensionDepth = 16;
        public const int MaximumExtensionNodes = 20_000;
        public const int MaximumShortcuts = 1000;
        public const int MaximumElsewhereEntries = 500;
        public const int MaximumHiddenItems = 10_000;
        public const int MaximumHiddenKeyLength = 256;
        public const int MaximumSpoilerEntriesPerDictionary = 1000;
        public const int MaximumSpoilerKeyLength = 128;
        public const int MaximumHiddenIndex = 100_000;
        public const int MaximumBookmarks = 1000;
        public const int MaximumBookmarkIdLength = 256;
        public const int MaximumBookmarkItemIdLength = 256;
        // Base64url may expand a 256-code-unit legacy item id beyond 512 bytes
        // when it contains non-ASCII text. Keep the opaque cursor itself bounded
        // while accepting every item id the migration policy accepts.
        public const int MaximumBookmarkCursorLength = 2048;
        public const int MaximumBookmarkProviderIdLength = 128;
        public const int MaximumBookmarkTypeLength = 64;
        public const int MaximumBookmarkTextLength = 512;
        public const int MaximumBookmarkTimestampLength = 64;
        public const int MaximumBookmarkPageSize = 100;

        /// <summary>
        /// Deterministically bounds a server-derived display name before it is
        /// persisted. Back off one UTF-16 code unit when the boundary would split
        /// a valid surrogate pair so the resulting string remains serializable.
        /// </summary>
        internal static string ClampPersistedDisplayName(string? value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return string.Empty;
            }

            if (value.Length <= MaximumStandardStringLength)
            {
                return value;
            }

            var length = MaximumStandardStringLength;
            if (char.IsHighSurrogate(value[length - 1])
                && char.IsLowSurrogate(value[length]))
            {
                length--;
            }

            return value.Substring(0, length);
        }

        /// <summary>
        /// Library index metadata is optional. Discard values outside the durable
        /// Hidden Content contract instead of persisting a state its readers reject.
        /// </summary>
        internal static int? NormalizeHiddenIndex(int? value)
            => value is >= 0 and <= MaximumHiddenIndex ? value : null;

        /// <summary>
        /// Adopts legacy Hidden Content rows written from unbounded Jellyfin
        /// metadata. Only fields owned by server-side library projection are
        /// normalized; identities, revisions, scopes, and extension data remain
        /// untouched. The complete graph must still pass <see cref="Validate(UserHiddenContent?)"/>.
        /// </summary>
        internal static bool NormalizeLegacyRuntimeState(UserHiddenContent? payload)
        {
            if (payload?.Items == null)
            {
                return false;
            }

            var changed = false;
            foreach (var item in payload.Items.Values)
            {
                if (item == null)
                {
                    continue;
                }

                changed |= ReplaceIfDifferent(
                    item.Name,
                    ClampPersistedDisplayName(item.Name),
                    value => item.Name = value);
                changed |= ReplaceIfDifferent(
                    item.SeriesName,
                    ClampPersistedDisplayName(item.SeriesName),
                    value => item.SeriesName = value);

                var seasonNumber = NormalizeHiddenIndex(item.SeasonNumber);
                if (seasonNumber != item.SeasonNumber)
                {
                    item.SeasonNumber = seasonNumber;
                    changed = true;
                }

                var episodeNumber = NormalizeHiddenIndex(item.EpisodeNumber);
                if (episodeNumber != item.EpisodeNumber)
                {
                    item.EpisodeNumber = episodeNumber;
                    changed = true;
                }
            }

            return changed;
        }

        /// <summary>
        /// Adopts legacy Spoiler Guard rows whose names came directly from
        /// Jellyfin before the durable 512-character contract was enforced.
        /// Client-owned pending labels and every non-name field remain untouched.
        /// </summary>
        internal static bool NormalizeLegacyRuntimeState(UserSpoilerBlur? payload)
        {
            if (payload == null)
            {
                return false;
            }

            var changed = false;
            if (payload.Series != null)
            {
                foreach (var entry in payload.Series.Values)
                {
                    if (entry == null) continue;
                    changed |= ReplaceIfDifferent(
                        entry.SeriesName,
                        ClampPersistedDisplayName(entry.SeriesName),
                        value => entry.SeriesName = value);
                }
            }

            if (payload.Movies != null)
            {
                foreach (var entry in payload.Movies.Values)
                {
                    if (entry == null) continue;
                    changed |= ReplaceIfDifferent(
                        entry.MovieName,
                        ClampPersistedDisplayName(entry.MovieName),
                        value => entry.MovieName = value);
                }
            }

            if (payload.Collections != null)
            {
                foreach (var entry in payload.Collections.Values)
                {
                    if (entry == null) continue;
                    changed |= ReplaceIfDifferent(
                        entry.CollectionName,
                        ClampPersistedDisplayName(entry.CollectionName),
                        value => entry.CollectionName = value);
                }
            }

            return changed;
        }

        internal static bool NormalizeLegacyRuntimeState(
            SpoilerGuardOverrides? payload)
        {
            if (payload == null)
            {
                return false;
            }

            var changed = false;
            foreach (var entry in payload.Series.Values)
            {
                if (entry == null) continue;
                changed |= ReplaceIfDifferent(
                    entry.SeriesName,
                    ClampPersistedDisplayName(entry.SeriesName),
                    value => entry.SeriesName = value);
            }

            foreach (var entry in payload.Movies.Values)
            {
                if (entry == null) continue;
                changed |= ReplaceIfDifferent(
                    entry.MovieName,
                    ClampPersistedDisplayName(entry.MovieName),
                    value => entry.MovieName = value);
            }

            foreach (var entry in payload.Collections.Values)
            {
                if (entry == null) continue;
                changed |= ReplaceIfDifferent(
                    entry.CollectionName,
                    ClampPersistedDisplayName(entry.CollectionName),
                    value => entry.CollectionName = value);
            }

            return changed;
        }

        /// <summary>
        /// Compatibility validator for a locked mutation read. It accepts only
        /// states that become fully policy-valid after normalizing the narrow set
        /// of legacy server-derived metadata fields, without mutating the caller's
        /// graph. A successful resource mutation must still normalize the real
        /// graph and pass the ordinary strict validator before save.
        /// </summary>
        internal static PersistedPayloadValidation ValidateMutationSource(
            UserHiddenContent? payload)
            => ValidateHiddenMutationCompatibility(
                payload,
                normalizeLegacyServerMetadata: true);

        /// <summary>
        /// Validates a Hidden Content graph after a resource mutation has
        /// normalized the real server-derived metadata fields. Bounded explicit
        /// identities from a future schema version remain opaque and unchanged;
        /// new full-resource submissions still use the ordinary strict validator.
        /// </summary>
        internal static PersistedPayloadValidation ValidateMutationCandidate(
            UserHiddenContent? payload)
            => ValidateHiddenMutationCompatibility(
                payload,
                normalizeLegacyServerMetadata: false);

        private static PersistedPayloadValidation ValidateHiddenMutationCompatibility(
            UserHiddenContent? payload,
            bool normalizeLegacyServerMetadata)
        {
            if (payload == null)
            {
                return PersistedPayloadValidation.Invalid(
                    "invalid_hidden_content_shape");
            }

            try
            {
                var detached = CloneUnchecked(payload);
                if (normalizeLegacyServerMetadata)
                {
                    NormalizeLegacyRuntimeState(detached);
                }

                if (!MaskBoundedFutureHiddenIdentities(detached))
                {
                    return PersistedPayloadValidation.Invalid(
                        "invalid_hidden_item");
                }

                return Validate(detached);
            }
            catch (JsonException)
            {
                return PersistedPayloadValidation.Invalid("invalid_json_value");
            }
        }

        private static bool MaskBoundedFutureHiddenIdentities(
            UserHiddenContent payload)
        {
            if (payload.Items == null)
            {
                return true;
            }

            foreach (var item in payload.Items.Values)
            {
                var identity = item?.Identity;
                if (identity == null || IsValidHiddenIdentity(identity))
                {
                    continue;
                }

                // Only an explicit later version is forward-compatible. A
                // malformed v1 TMDB identity still fails closed rather than
                // being reclassified as opaque legacy data.
                if (identity.Version <= 1
                    || !IsBoundedRequiredString(identity.Provider, 64)
                    || !IsBoundedRequiredString(identity.MediaType, 64)
                    || !IsBoundedRequiredString(identity.Id, 128)
                    || !HasValidExtensionData(identity.ExtensionData))
                {
                    return false;
                }

                // The ordinary item validator has no "opaque" branch. Mask the
                // identity only in this detached validation graph; the caller's
                // persisted future-version object and its extension data remain
                // byte-for-byte owned by that future schema.
                item!.Identity = null;
            }

            return true;
        }

        internal static PersistedPayloadValidation ValidateMutationSource(
            UserSpoilerBlur? payload)
        {
            if (payload == null)
            {
                return PersistedPayloadValidation.Invalid(
                    "invalid_spoiler_guard_state");
            }

            try
            {
                var detached = CloneUnchecked(payload);
                NormalizeLegacyRuntimeState(detached);
                return Validate(detached);
            }
            catch (JsonException)
            {
                return PersistedPayloadValidation.Invalid("invalid_json_value");
            }
        }

        private static T CloneUnchecked<T>(T payload)
            where T : class
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(
                payload,
                payload.GetType(),
                PersistedJson.WriteOptions);
            return JsonSerializer.Deserialize<T>(bytes, PersistedJson.ReadOptions)
                ?? throw new JsonException("Persisted payload clone was null.");
        }

        private static bool ReplaceIfDifferent(
            string? current,
            string replacement,
            Action<string> replace)
        {
            if (string.Equals(current, replacement, StringComparison.Ordinal))
            {
                return false;
            }

            replace(replacement);
            return true;
        }
        public static PersistedPayloadValidation Validate(IRevisionedUserConfiguration? payload)
            => payload switch
            {
                UserSettings settings => ValidateSettings(settings),
                UserShortcuts shortcuts => ValidateShortcuts(shortcuts),
                ElsewhereSettings elsewhere => ValidateElsewhere(elsewhere),
                HiddenContentSettings hiddenSettings => ValidateHiddenSettings(hiddenSettings),
                SpoilerBlurUserPrefs spoilerPrefs => ValidateSpoilerPrefs(spoilerPrefs),
                SpoilerGuardOverrides spoilerOverrides => Validate(spoilerOverrides),
                UserBookmark bookmarks => Validate(bookmarks),
                null => PersistedPayloadValidation.Invalid("payload_required"),
                _ => PersistedPayloadValidation.Invalid("unsupported_payload")
            };

        public static PersistedPayloadValidation Validate(UserBookmark? payload)
        {
            if (payload?.Bookmarks == null || payload.Revision < 0)
            {
                return PersistedPayloadValidation.Invalid("invalid_bookmark_shape");
            }

            if (payload.Bookmarks.Count > MaximumBookmarks)
            {
                return PersistedPayloadValidation.TooLarge(0, "too_many_bookmarks");
            }

            foreach (var pair in payload.Bookmarks)
            {
                if (!IsValidBookmarkId(pair.Key) || !IsValidBookmarkItem(pair.Value))
                {
                    return PersistedPayloadValidation.Invalid("invalid_bookmark_entry");
                }
            }

            return ValidateSerializedSize(payload, BookmarkPersistedBytes);
        }

        public static bool IsValidBookmarkId(string? value)
            => !string.IsNullOrWhiteSpace(value) && value.Length <= MaximumBookmarkIdLength;

        public static bool IsValidBookmarkItem(BookmarkItem? bookmark)
            => bookmark != null
            && !string.IsNullOrWhiteSpace(bookmark.ItemId)
            && bookmark.ItemId.Length <= MaximumBookmarkItemIdLength
            && (bookmark.IdentityVersion == 0 || bookmark.IdentityVersion == 1)
            && (bookmark.IdentityVersion == 0 || !string.IsNullOrWhiteSpace(bookmark.ItemType))
            && IsBoundedString(bookmark.ItemType, MaximumBookmarkTypeLength)
            && IsBoundedString(bookmark.TmdbId, MaximumBookmarkProviderIdLength)
            && IsBoundedString(bookmark.TvdbId, MaximumBookmarkProviderIdLength)
            && IsBoundedString(bookmark.SeriesTmdbId, MaximumBookmarkProviderIdLength)
            && IsBoundedString(bookmark.SeriesTvdbId, MaximumBookmarkProviderIdLength)
            && IsBoundedString(bookmark.MediaType, MaximumBookmarkTypeLength)
            && IsOptionalNonNegativeRange(bookmark.SeasonNumber, 100_000)
            && IsOptionalNonNegativeRange(bookmark.EpisodeNumber, 100_000)
            && IsOptionalNonNegativeRange(bookmark.EpisodeEndNumber, 100_000)
            && (!bookmark.EpisodeNumber.HasValue || !bookmark.EpisodeEndNumber.HasValue
                || bookmark.EpisodeEndNumber.Value >= bookmark.EpisodeNumber.Value)
            && IsBoundedString(bookmark.Name, MaximumBookmarkTextLength)
            && IsBoundedString(bookmark.Label, MaximumBookmarkTextLength)
            && IsBoundedString(bookmark.CreatedAt, MaximumBookmarkTimestampLength)
            && IsBoundedString(bookmark.UpdatedAt, MaximumBookmarkTimestampLength)
            && IsBoundedString(bookmark.SyncedFrom, MaximumBookmarkItemIdLength)
            && double.IsFinite(bookmark.Timestamp)
            && bookmark.Timestamp >= 0;

        public static PersistedPayloadValidation Validate(UserHiddenContent? payload)
        {
            if (payload?.Items == null
                || payload.Settings == null
                || payload.ItemsRevision < 0
                || !ValidateHiddenSettings(payload.Settings).IsValid
                || !HasValidExtensionData(payload.ExtensionData))
            {
                return PersistedPayloadValidation.Invalid("invalid_hidden_content_shape");
            }

            if (payload.Items.Count > MaximumHiddenItems)
            {
                return PersistedPayloadValidation.Invalid("too_many_hidden_items");
            }

            foreach (var pair in payload.Items)
            {
                if (!IsBoundedRequiredString(pair.Key, MaximumHiddenKeyLength)
                    || !IsValidHiddenItem(pair.Value))
                {
                    return PersistedPayloadValidation.Invalid("invalid_hidden_item");
                }
            }

            return ValidateSerializedSize(payload, HiddenContentPersistedBytes);
        }

        /// <summary>
        /// Validates the complete co-resident spoilerblur.json graph used by
        /// ordinary/runtime writers, not only the subsection they mutate.
        /// </summary>
        public static PersistedPayloadValidation Validate(UserSpoilerBlur? payload)
        {
            if (payload == null
                || payload.Prefs == null
                || !Validate(payload.Prefs).IsValid
                || !HasValidExtensionData(payload.ExtensionData))
            {
                return PersistedPayloadValidation.Invalid("invalid_spoiler_guard_state");
            }

            return Validate(new SpoilerGuardOverrides
            {
                Revision = payload.OverridesRevision,
                Series = payload.Series,
                Movies = payload.Movies,
                Collections = payload.Collections,
                PendingTmdb = payload.PendingTmdb,
                ExtensionData = payload.OverridesExtensionData
            });
        }

        public static UserHiddenContent CloneValidated(UserHiddenContent payload)
        {
            var clone = new UserHiddenContent
            {
                ExtensionData = CloneExtensionData(payload.ExtensionData),
                ItemsRevision = payload.ItemsRevision,
                Settings = new HiddenContentSettings
                {
                    Revision = payload.Settings.Revision,
                    Enabled = payload.Settings.Enabled,
                    FilterLibrary = payload.Settings.FilterLibrary,
                    FilterDiscovery = payload.Settings.FilterDiscovery,
                    FilterUpcoming = payload.Settings.FilterUpcoming,
                    FilterCalendar = payload.Settings.FilterCalendar,
                    FilterSearch = payload.Settings.FilterSearch,
                    FilterRecommendations = payload.Settings.FilterRecommendations,
                    FilterRequests = payload.Settings.FilterRequests,
                    FilterNextUp = payload.Settings.FilterNextUp,
                    FilterContinueWatching = payload.Settings.FilterContinueWatching,
                    ShowHideButtons = payload.Settings.ShowHideButtons,
                    ShowHideConfirmation = payload.Settings.ShowHideConfirmation,
                    ShowButtonSeerr = payload.Settings.ShowButtonSeerr,
                    ShowButtonLibrary = payload.Settings.ShowButtonLibrary,
                    ShowButtonDetails = payload.Settings.ShowButtonDetails,
                    ShowButtonCast = payload.Settings.ShowButtonCast,
                    ExperimentalHideCollections = payload.Settings.ExperimentalHideCollections,
                    ExtensionData = CloneExtensionData(payload.Settings.ExtensionData)
                },
                Items = new Dictionary<string, HiddenContentItem>(payload.Items.Count, StringComparer.Ordinal)
            };

            foreach (var pair in payload.Items)
            {
                var item = pair.Value;
                clone.Items.Add(pair.Key, new HiddenContentItem
                {
                    ItemId = item.ItemId ?? string.Empty,
                    Name = item.Name ?? string.Empty,
                    Type = item.Type ?? string.Empty,
                    TmdbId = item.TmdbId ?? string.Empty,
                    Identity = item.Identity == null ? null : new HiddenContentIdentity
                    {
                        Version = item.Identity.Version,
                        Provider = item.Identity.Provider ?? string.Empty,
                        MediaType = item.Identity.MediaType ?? string.Empty,
                        Id = item.Identity.Id ?? string.Empty,
                        ExtensionData = CloneExtensionData(item.Identity.ExtensionData)
                    },
                    HiddenAt = item.HiddenAt ?? string.Empty,
                    PosterPath = item.PosterPath ?? string.Empty,
                    SeriesId = item.SeriesId ?? string.Empty,
                    SeriesName = item.SeriesName ?? string.Empty,
                    SeasonNumber = item.SeasonNumber,
                    EpisodeNumber = item.EpisodeNumber,
                    HideScope = item.HideScope ?? "global",
                    ExtensionData = CloneExtensionData(item.ExtensionData)
                });
            }

            return clone;
        }

        public static UserShortcuts CloneValidated(UserShortcuts payload)
        {
            var clone = new UserShortcuts
            {
                Revision = payload.Revision,
                ExtensionData = CloneExtensionData(payload.ExtensionData),
                Shortcuts = new List<Shortcut>(payload.Shortcuts.Count)
            };
            foreach (var shortcut in payload.Shortcuts)
            {
                clone.Shortcuts.Add(new Shortcut
                {
                    Name = shortcut.Name ?? string.Empty,
                    Key = shortcut.Key ?? string.Empty,
                    Label = shortcut.Label ?? string.Empty,
                    Category = shortcut.Category ?? string.Empty,
                    ExtensionData = CloneExtensionData(shortcut.ExtensionData)
                });
            }

            return clone;
        }

        public static PersistedPayloadValidation Validate(SpoilerGuardOverrides? payload)
        {
            if (payload == null
                || payload.Revision < 0
                || payload.Series == null
                || payload.Movies == null
                || payload.Collections == null
                || payload.PendingTmdb == null
                || payload.Series.Count > MaximumSpoilerEntriesPerDictionary
                || payload.Movies.Count > MaximumSpoilerEntriesPerDictionary
                || payload.Collections.Count > MaximumSpoilerEntriesPerDictionary
                || payload.PendingTmdb.Count > MaximumSpoilerEntriesPerDictionary
                || !HasValidExtensionData(payload.ExtensionData)
                || HasSpoilerOverridePropertyCollision(payload.ExtensionData))
            {
                return PersistedPayloadValidation.Invalid("invalid_spoiler_guard_overrides");
            }

            foreach (var pair in payload.Series.OrderBy(
                         static pair => pair.Key,
                         StringComparer.OrdinalIgnoreCase))
            {
                if (!IsCanonicalGuidKey(pair.Key, pair.Value?.SeriesId)
                    || pair.Value == null
                    || !IsBoundedString(pair.Value.SeriesName, MaximumStandardStringLength)
                    || !IsBoundedString(pair.Value.EnabledAt, 64)
                    || !HasValidExtensionData(pair.Value.ExtensionData))
                {
                    return PersistedPayloadValidation.Invalid("invalid_spoiler_guard_series");
                }
            }

            foreach (var pair in payload.Movies.OrderBy(
                         static pair => pair.Key,
                         StringComparer.OrdinalIgnoreCase))
            {
                if (!IsCanonicalGuidKey(pair.Key, pair.Value?.MovieId)
                    || pair.Value == null
                    || !IsBoundedString(pair.Value.MovieName, MaximumStandardStringLength)
                    || !IsBoundedString(pair.Value.EnabledAt, 64)
                    || !HasValidExtensionData(pair.Value.ExtensionData))
                {
                    return PersistedPayloadValidation.Invalid("invalid_spoiler_guard_movies");
                }
            }

            foreach (var pair in payload.Collections.OrderBy(
                         static pair => pair.Key,
                         StringComparer.OrdinalIgnoreCase))
            {
                if (!IsCanonicalGuidKey(pair.Key, pair.Value?.CollectionId)
                    || pair.Value == null
                    || !IsBoundedString(pair.Value.CollectionName, MaximumStandardStringLength)
                    || !IsBoundedString(pair.Value.EnabledAt, 64)
                    || !HasValidExtensionData(pair.Value.ExtensionData))
                {
                    return PersistedPayloadValidation.Invalid("invalid_spoiler_guard_collections");
                }
            }

            foreach (var pair in payload.PendingTmdb.OrderBy(
                         static pair => pair.Key,
                         StringComparer.OrdinalIgnoreCase))
            {
                var entry = pair.Value;
                if (entry == null
                    || !IsBoundedRequiredString(pair.Key, MaximumSpoilerKeyLength)
                    || (entry.MediaType != "tv" && entry.MediaType != "movie")
                    || !IsCanonicalPositiveInt32Id(entry.TmdbId)
                    || !string.Equals(
                        pair.Key,
                        $"{entry.MediaType}:{entry.TmdbId}",
                        StringComparison.OrdinalIgnoreCase)
                    || !IsBoundedString(entry.DisplayName, MaximumStandardStringLength)
                    || !IsBoundedString(entry.RequestedAt, 64)
                    || !HasValidExtensionData(entry.ExtensionData))
                {
                    return PersistedPayloadValidation.Invalid("invalid_spoiler_guard_pending");
                }
            }

            return ValidateSerializedSize(payload, SpoilerOverridesPersistedBytes);
        }

        public static SpoilerGuardOverrides CloneValidated(SpoilerGuardOverrides payload)
        {
            var clone = new SpoilerGuardOverrides
            {
                Revision = payload.Revision,
                ExtensionData = CloneExtensionData(payload.ExtensionData),
                Series = new Dictionary<string, SpoilerBlurSeriesEntry>(
                    payload.Series.Count,
                    StringComparer.OrdinalIgnoreCase),
                Movies = new Dictionary<string, SpoilerBlurMovieEntry>(
                    payload.Movies.Count,
                    StringComparer.OrdinalIgnoreCase),
                Collections = new Dictionary<string, SpoilerBlurCollectionEntry>(
                    payload.Collections.Count,
                    StringComparer.OrdinalIgnoreCase),
                PendingTmdb = new Dictionary<string, SpoilerBlurPendingEntry>(
                    payload.PendingTmdb.Count,
                    StringComparer.OrdinalIgnoreCase)
            };

            foreach (var pair in payload.Series.OrderBy(
                         static pair => pair.Key,
                         StringComparer.OrdinalIgnoreCase))
            {
                var entry = pair.Value;
                clone.Series.Add(pair.Key, new SpoilerBlurSeriesEntry
                {
                    SeriesId = entry.SeriesId,
                    SeriesName = entry.SeriesName,
                    EnabledAt = entry.EnabledAt,
                    ExtensionData = CloneExtensionData(entry.ExtensionData)
                });
            }

            foreach (var pair in payload.Movies.OrderBy(
                         static pair => pair.Key,
                         StringComparer.OrdinalIgnoreCase))
            {
                var entry = pair.Value;
                clone.Movies.Add(pair.Key, new SpoilerBlurMovieEntry
                {
                    MovieId = entry.MovieId,
                    MovieName = entry.MovieName,
                    EnabledAt = entry.EnabledAt,
                    ExtensionData = CloneExtensionData(entry.ExtensionData)
                });
            }

            foreach (var pair in payload.Collections.OrderBy(
                         static pair => pair.Key,
                         StringComparer.OrdinalIgnoreCase))
            {
                var entry = pair.Value;
                clone.Collections.Add(pair.Key, new SpoilerBlurCollectionEntry
                {
                    CollectionId = entry.CollectionId,
                    CollectionName = entry.CollectionName,
                    EnabledAt = entry.EnabledAt,
                    ExtensionData = CloneExtensionData(entry.ExtensionData)
                });
            }

            foreach (var pair in payload.PendingTmdb.OrderBy(
                         static pair => pair.Key,
                         StringComparer.OrdinalIgnoreCase))
            {
                var entry = pair.Value;
                clone.PendingTmdb.Add(pair.Key, new SpoilerBlurPendingEntry
                {
                    MediaType = entry.MediaType,
                    TmdbId = entry.TmdbId,
                    DisplayName = entry.DisplayName,
                    RequestedAt = entry.RequestedAt,
                    ExtensionData = CloneExtensionData(entry.ExtensionData)
                });
            }

            return clone;
        }

        public static PersistedPayloadValidation ValidateSerializedSize(object payload, int maximumBytes)
        {
            try
            {
                var bytes = JsonSerializer.SerializeToUtf8Bytes(
                    payload,
                    payload.GetType(),
                    PersistedJson.WriteOptions).Length;
                return ValidateByteCount(bytes, maximumBytes);
            }
            catch (JsonException)
            {
                return PersistedPayloadValidation.Invalid("invalid_json_value");
            }
        }

        internal static PersistedPayloadValidation ValidateByteCount(int serializedBytes, int maximumBytes)
            => serializedBytes <= maximumBytes
                ? PersistedPayloadValidation.Valid(serializedBytes)
                : PersistedPayloadValidation.TooLarge(serializedBytes);

        private static PersistedPayloadValidation ValidateSettings(UserSettings settings)
        {
            if (settings.Revision < 0
                || settings.PauseScreenDelaySeconds is < 1 or > 60
                || settings.SelectedStylePresetIndex is < 0 or > 5
                || settings.SelectedFontSizePresetIndex is < 0 or > 5
                || settings.SelectedFontFamilyPresetIndex is < 0 or > 4
                || settings.SubtitleVerticalPosition is < 0 or > 100
                || settings.SubtitleHorizontalPosition is < 0 or > 100
                || !IsOptionalOrder(settings.ResolutionTagOrder)
                || !IsOptionalOrder(settings.SourceTagOrder)
                || !IsOptionalOrder(settings.DynamicRangeTagOrder)
                || !IsOptionalOrder(settings.SpecialFormatTagOrder)
                || !IsOptionalOrder(settings.VideoCodecTagOrder)
                || !IsOptionalOrder(settings.AudioInfoTagOrder)
                || !RatingTagScopePolicyV1.TryNormalize(settings.RatingTagScopeOverrides, out _)
                || !LanguageTagFilterPolicyV1.TryNormalize(settings.LanguageTagFilter, out _)
                || !AreBoundedSettingsStrings(settings)
                || !HasValidExtensionData(settings.ExtensionData))
            {
                return PersistedPayloadValidation.Invalid("invalid_settings_payload");
            }

            return ValidateSerializedSize(settings, StandardPersistedBytes);
        }

        private static PersistedPayloadValidation ValidateHiddenSettings(HiddenContentSettings settings)
        {
            if (settings.Revision < 0 || !HasValidExtensionData(settings.ExtensionData))
            {
                return PersistedPayloadValidation.Invalid("invalid_hidden_content_settings");
            }

            return ValidateSerializedSize(settings, 8 * 1024);
        }

        private static PersistedPayloadValidation ValidateSpoilerPrefs(SpoilerBlurUserPrefs prefs)
        {
            if (prefs.Revision < 0 || !HasValidExtensionData(prefs.ExtensionData))
            {
                return PersistedPayloadValidation.Invalid("invalid_spoiler_guard_preferences");
            }

            return ValidateSerializedSize(prefs, 8 * 1024);
        }

        private static PersistedPayloadValidation ValidateShortcuts(UserShortcuts shortcuts)
        {
            if (shortcuts.Revision < 0
                || shortcuts.Shortcuts == null
                || shortcuts.Shortcuts.Count > MaximumShortcuts
                || !HasValidExtensionData(shortcuts.ExtensionData))
            {
                return PersistedPayloadValidation.Invalid("invalid_shortcuts_payload");
            }

            foreach (var shortcut in shortcuts.Shortcuts)
            {
                if (shortcut == null
                    || !IsBoundedString(shortcut.Name, MaximumStandardStringLength)
                    || !IsBoundedString(shortcut.Key, MaximumStandardStringLength)
                    || !IsBoundedString(shortcut.Label, MaximumStandardStringLength)
                    || !IsBoundedString(shortcut.Category, MaximumStandardStringLength)
                    || !HasValidExtensionData(shortcut.ExtensionData))
                {
                    return PersistedPayloadValidation.Invalid("invalid_shortcuts_payload");
                }
            }

            return ValidateSerializedSize(shortcuts, StandardPersistedBytes);
        }

        private static PersistedPayloadValidation ValidateElsewhere(ElsewhereSettings elsewhere)
        {
            if (elsewhere.Revision < 0
                || elsewhere.Regions == null
                || elsewhere.Services == null
                || elsewhere.Regions.Count > MaximumElsewhereEntries
                || elsewhere.Services.Count > MaximumElsewhereEntries
                || !IsBoundedString(elsewhere.Region, MaximumStandardStringLength)
                || !HasValidExtensionData(elsewhere.ExtensionData))
            {
                return PersistedPayloadValidation.Invalid("invalid_elsewhere_payload");
            }

            foreach (var value in elsewhere.Regions)
            {
                if (!IsBoundedString(value, MaximumStandardStringLength))
                {
                    return PersistedPayloadValidation.Invalid("invalid_elsewhere_payload");
                }
            }

            foreach (var value in elsewhere.Services)
            {
                if (!IsBoundedString(value, MaximumStandardStringLength))
                {
                    return PersistedPayloadValidation.Invalid("invalid_elsewhere_payload");
                }
            }

            return ValidateSerializedSize(elsewhere, StandardPersistedBytes);
        }

        private static bool AreBoundedSettingsStrings(UserSettings settings)
            => IsBoundedString(settings.CustomSubtitleTextColor, MaximumStandardStringLength)
                && IsBoundedString(settings.CustomSubtitleBgColor, MaximumStandardStringLength)
                && IsBoundedString(settings.WatchProgressMode, MaximumStandardStringLength)
                && IsBoundedString(settings.WatchProgressTimeFormat, MaximumStandardStringLength)
                && IsBoundedString(settings.QualityTagsPosition, MaximumStandardStringLength)
                && IsBoundedString(settings.GenreTagsPosition, MaximumStandardStringLength)
                && IsBoundedString(settings.LanguageTagsPosition, MaximumStandardStringLength)
                && IsBoundedString(settings.RatingTagsPosition, MaximumStandardStringLength)
                && IsBoundedString(settings.LastOpenedTab, MaximumStandardStringLength)
                && IsBoundedString(settings.DisplayLanguage, MaximumStandardStringLength)
                && IsBoundedString(settings.CalendarDisplayMode, MaximumStandardStringLength)
                && IsBoundedString(settings.CalendarDefaultViewMode, MaximumStandardStringLength);

        private static bool IsValidHiddenItem(HiddenContentItem? item)
            => item != null
                && IsOptionalBoundedString(item.ItemId, 128)
                && IsOptionalBoundedString(item.Name, 512)
                && IsOptionalBoundedString(item.Type, 64)
                && IsOptionalBoundedString(item.TmdbId, 32)
                && IsValidHiddenIdentity(item.Identity)
                && (item.Identity == null || string.IsNullOrEmpty(item.TmdbId)
                    || string.Equals(item.Identity.Id, item.TmdbId, StringComparison.Ordinal))
                && IsOptionalBoundedString(item.HiddenAt, 64)
                && IsOptionalBoundedString(item.PosterPath, 512)
                && IsOptionalBoundedString(item.SeriesId, 128)
                && IsOptionalBoundedString(item.SeriesName, 512)
                && IsOptionalNonNegativeRange(item.SeasonNumber, MaximumHiddenIndex)
                && IsOptionalNonNegativeRange(item.EpisodeNumber, MaximumHiddenIndex)
                && item.HideScope is null or "" or "global" or "series" or "continuewatching" or "nextup" or "homesections"
                && HasValidExtensionData(item.ExtensionData);

        private static bool IsValidHiddenIdentity(HiddenContentIdentity? identity)
            => identity == null
                || (identity.Version == 1
                    && string.Equals(identity.Provider, "tmdb", StringComparison.Ordinal)
                    && (string.Equals(identity.MediaType, "movie", StringComparison.Ordinal)
                        || string.Equals(identity.MediaType, "tv", StringComparison.Ordinal))
                    && IsPositiveDecimalId(identity.Id)
                    && HasValidExtensionData(identity.ExtensionData));

        private static bool IsPositiveDecimalId(string? value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 32) return false;
            var nonZero = false;
            foreach (var c in value)
            {
                if (c < '0' || c > '9') return false;
                if (c != '0') nonZero = true;
            }
            return nonZero;
        }

        private static bool IsCanonicalPositiveInt32Id(string? value)
            => int.TryParse(
                    value,
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out var parsed)
                && parsed > 0
                && string.Equals(
                    value,
                    parsed.ToString(CultureInfo.InvariantCulture),
                    StringComparison.Ordinal);

        private static bool IsCanonicalGuidKey(string? key, string? entryId)
            => IsBoundedRequiredString(key, MaximumSpoilerKeyLength)
                && Guid.TryParseExact(key, "N", out var keyGuid)
                && keyGuid != Guid.Empty
                && Guid.TryParseExact(entryId, "N", out var entryGuid)
                && entryGuid == keyGuid;

        private static bool HasSpoilerOverridePropertyCollision(
            Dictionary<string, JsonElement> extensionData)
            => extensionData.Keys.Any(static key =>
                string.Equals(key, nameof(SpoilerGuardOverrides.Revision), StringComparison.OrdinalIgnoreCase)
                || string.Equals(key, nameof(SpoilerGuardOverrides.Series), StringComparison.OrdinalIgnoreCase)
                || string.Equals(key, nameof(SpoilerGuardOverrides.Movies), StringComparison.OrdinalIgnoreCase)
                || string.Equals(key, nameof(SpoilerGuardOverrides.Collections), StringComparison.OrdinalIgnoreCase)
                || string.Equals(key, nameof(SpoilerGuardOverrides.PendingTmdb), StringComparison.OrdinalIgnoreCase));

        private static bool HasValidExtensionData(Dictionary<string, JsonElement>? extensionData)
        {
            if (extensionData == null || extensionData.Count > MaximumExtensionProperties)
            {
                return false;
            }

            var nodeCount = 0;
            foreach (var pair in extensionData)
            {
                if (!IsBoundedRequiredString(pair.Key, MaximumExtensionPropertyNameLength)
                    || !VisitExtensionValue(pair.Value, 1, ref nodeCount))
                {
                    return false;
                }
            }

            return true;
        }

        internal static Dictionary<string, JsonElement> CloneExtensionData(
            Dictionary<string, JsonElement>? extensionData)
        {
            var clone = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            if (extensionData == null) return clone;
            foreach (var pair in extensionData.OrderBy(
                         static pair => pair.Key,
                         StringComparer.Ordinal))
            {
                clone[pair.Key] = pair.Value.Clone();
            }

            return clone;
        }

        internal static Dictionary<string, JsonElement> PreserveExistingExtensionData(
            Dictionary<string, JsonElement>? candidate,
            Dictionary<string, JsonElement>? current)
        {
            var merged = new Dictionary<string, JsonElement>(
                StringComparer.Ordinal);
            if (current != null)
            {
                foreach (var pair in current)
                {
                    // Preserve both the exact raw value and the current
                    // insertion order. Content evidence is byte-shape
                    // sensitive, so sorting opaque keys would turn a browser
                    // no-op into a false revision advance.
                    merged.Add(pair.Key, pair.Value.Clone());
                }
            }

            if (candidate != null)
            {
                foreach (var pair in candidate)
                {
                    // The server-held value wins for every existing opaque
                    // key. Candidate-only keys remain forward-compatible.
                    if (!merged.ContainsKey(pair.Key))
                    {
                        merged.Add(pair.Key, pair.Value.Clone());
                    }
                }
            }

            return merged;
        }

        internal static bool TryAddMergedExtensionValue(
            Dictionary<string, JsonElement> aggregate,
            string key,
            JsonElement value,
            ref int aggregateNodeCount)
        {
            ArgumentNullException.ThrowIfNull(aggregate);
            if (aggregate.ContainsKey(key))
            {
                return true;
            }

            if (aggregate.Count >= MaximumExtensionProperties
                || !IsBoundedRequiredString(key, MaximumExtensionPropertyNameLength))
            {
                return false;
            }

            var valueNodeCount = 0;
            if (!VisitExtensionValue(value, 1, ref valueNodeCount)
                || aggregateNodeCount > MaximumExtensionNodes - valueNodeCount)
            {
                return false;
            }

            aggregate.Add(key, value.Clone());
            aggregateNodeCount += valueNodeCount;
            return true;
        }

        private static bool VisitExtensionValue(JsonElement element, int depth, ref int nodeCount)
        {
            nodeCount++;
            if (depth > MaximumExtensionDepth || nodeCount > MaximumExtensionNodes)
            {
                return false;
            }

            switch (element.ValueKind)
            {
                case JsonValueKind.String:
                    return element.GetString()?.Length <= MaximumExtensionStringLength;
                case JsonValueKind.Object:
                    foreach (var property in element.EnumerateObject())
                    {
                        if (!IsBoundedRequiredString(property.Name, MaximumExtensionPropertyNameLength)
                            || !VisitExtensionValue(property.Value, depth + 1, ref nodeCount))
                        {
                            return false;
                        }
                    }

                    return true;
                case JsonValueKind.Array:
                    foreach (var child in element.EnumerateArray())
                    {
                        if (!VisitExtensionValue(child, depth + 1, ref nodeCount))
                        {
                            return false;
                        }
                    }

                    return true;
                case JsonValueKind.Undefined:
                    return false;
                default:
                    return true;
            }
        }

        private static bool IsOptionalOrder(int? value)
            => !value.HasValue || value.Value is >= 1 and <= 6;

        private static bool IsOptionalNonNegativeRange(int? value, int maximum)
            => !value.HasValue || value.Value >= 0 && value.Value <= maximum;

        private static bool IsBoundedString(string? value, int maximum)
            => value != null && value.Length <= maximum;

        private static bool IsOptionalBoundedString(string? value, int maximum)
            => value == null || value.Length <= maximum;

        private static bool IsBoundedRequiredString(string? value, int maximum)
            => !string.IsNullOrEmpty(value) && value.Length <= maximum;
    }
}
