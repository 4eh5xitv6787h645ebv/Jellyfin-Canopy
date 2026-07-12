using System;
using System.IO;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration
{
    /// <summary>
    /// Typed policy-read contract (BI-SEC-010). ReadUserConfiguration must
    /// distinguish an intentionally absent/empty policy (Missing / valid-empty)
    /// from a persistence fault (Corrupt / Unavailable), where the OLD lenient
    /// GetUserConfiguration path collapsed every one of these into an empty
    /// new T() — silently disabling Hidden Content / Spoiler Guard protection.
    ///
    /// These assertions fail against the old implementation, which had no typed
    /// read and returned new T() for corrupt/unavailable files.
    /// </summary>
    public sealed class UserConfigTypedReadTests : IDisposable
    {
        private const string FileName = "hidden-content.json";
        private readonly string _baseDir;
        private readonly UserConfigurationManager _mgr;
        private readonly string _userId = Guid.NewGuid().ToString("N");

        public UserConfigTypedReadTests()
        {
            _baseDir = Path.Combine(Path.GetTempPath(), "jc-typedread-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_baseDir);
            _mgr = new UserConfigurationManager(new StubAppPaths(_baseDir), NullLogger<UserConfigurationManager>.Instance);
        }

        public void Dispose()
        {
            try { Directory.Delete(_baseDir, recursive: true); } catch { /* best effort */ }
        }

        private string FilePath()
        {
            var dir = Path.Combine(_baseDir, "configurations", "Jellyfin.Plugin.JellyfinCanopy", _userId);
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, FileName);
        }

        private void Write(string content) => File.WriteAllText(FilePath(), content);

        private UserConfigReadResult<UserHiddenContent> Read()
            => _mgr.ReadUserConfiguration<UserHiddenContent>(_userId, FileName);

        // ─── Missing vs empty policy ─────────────────────────────────────────────

        [Fact]
        public void AbsentFile_IsMissing_WithUsableEmptyValue()
        {
            var r = Read();
            Assert.Equal(UserConfigReadStatus.Missing, r.Status);
            Assert.False(r.IsFault);
            Assert.True(r.HasUsableValue);
            Assert.NotNull(r.Value); // an intentionally empty policy
        }

        [Fact]
        public void ValidEmptyJsonObject_IsValid_NotCorrupt()
        {
            // A user with the feature enabled but nothing hidden yet writes "{}".
            // This must read as Valid, NOT as a fault, or a genuine empty policy
            // would be mistaken for corruption.
            Write("{}");
            var r = Read();
            Assert.Equal(UserConfigReadStatus.Valid, r.Status);
            Assert.NotNull(r.Value);
        }

        [Fact]
        public void PopulatedFile_IsValid_WithParsedValue()
        {
            var hc = new UserHiddenContent();
            hc.Items["k"] = new HiddenContentItem { ItemId = Guid.NewGuid().ToString(), HideScope = "global" };
            _mgr.SaveUserConfiguration(_userId, FileName, hc);

            var r = Read();
            Assert.Equal(UserConfigReadStatus.Valid, r.Status);
            Assert.NotNull(r.Value);
            Assert.Single(r.Value!.Items);
        }

        // ─── Corrupt variants ────────────────────────────────────────────────────

        [Theory]
        [InlineData("")]                    // empty bytes
        [InlineData("   \n\t ")]            // whitespace only
        [InlineData("null")]               // literal JSON null
        [InlineData("{ \"Items\": ")]      // truncated / malformed JSON
        [InlineData("not json at all")]    // garbage
        [InlineData("[1,2,3]")]            // well-formed JSON but non-object payload → deserializes to null
        public void UnusableContent_IsCorrupt_WithNoValue(string content)
        {
            Write(content);
            var r = Read();
            Assert.Equal(UserConfigReadStatus.Corrupt, r.Status);
            Assert.True(r.IsFault);
            Assert.False(r.HasUsableValue);
            Assert.Null(r.Value);
            Assert.False(string.IsNullOrEmpty(r.FaultDetail));
        }

        // ─── Unavailable (I/O failure) ───────────────────────────────────────────

        [Fact]
        public void UnreadableFile_IsUnavailable_WithNoValue()
        {
            var path = FilePath();
            File.WriteAllText(path, "{}");
            // Hold an exclusive (FileShare.None) handle so File.ReadAllText inside
            // the store throws IOException — .NET enforces sharing per-process on
            // every platform, so this is deterministic in CI.
            using var exclusive = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None);

            var r = Read();
            Assert.Equal(UserConfigReadStatus.Unavailable, r.Status);
            Assert.True(r.IsFault);
            Assert.Null(r.Value);
        }

        [Fact]
        public void PathBlockedByDirectory_IsUnavailable_NotMissing()
        {
            // A directory sitting where the policy file is expected: File.Exists
            // returns false for it (so a File.Exists pre-check would wrongly report
            // Missing → empty fail-open policy), but reading it throws. The typed
            // read must classify this as Unavailable, not Missing. Deterministic and
            // root-safe (no chmod), unlike a permission-denied probe.
            var path = FilePath();
            Directory.CreateDirectory(path);

            var r = Read();
            Assert.Equal(UserConfigReadStatus.Unavailable, r.Status);
            Assert.True(r.IsFault);
            Assert.Null(r.Value);

            Directory.Delete(path);
        }

        [Fact]
        public void InvalidFileName_IsUnavailable_NeverEmptyPolicy()
        {
            // A programming error resolving the path must fail CLOSED (Unavailable),
            // never be mistaken for an intentionally empty policy.
            var r = _mgr.ReadUserConfiguration<UserHiddenContent>(_userId, "bad/name.json");
            Assert.Equal(UserConfigReadStatus.Unavailable, r.Status);
            Assert.Null(r.Value);
        }

        // ─── Lenient path unchanged (compat, criterion 7) ────────────────────────

        [Theory]
        [InlineData("")]
        [InlineData("null")]
        [InlineData("not json")]
        public void LenientRead_StillReturnsDefault_ForNonPolicySettings(string content)
        {
            // Ordinary display settings keep their lenient behavior: a fault still
            // returns new T(). Only the security enforcement path branches on the
            // typed result.
            Write(content);
            var lenient = _mgr.GetUserConfiguration<UserHiddenContent>(_userId, FileName);
            Assert.NotNull(lenient);
            Assert.Empty(lenient.Items);
        }
    }
}
