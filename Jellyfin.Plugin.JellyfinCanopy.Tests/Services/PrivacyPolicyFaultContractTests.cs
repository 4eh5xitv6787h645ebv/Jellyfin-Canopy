using System;
using System.IO;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    /// <summary>
    /// Enforcement-side fault contract (BI-SEC-010): Hidden Content and Spoiler
    /// Guard must retain last-known-good protection when a policy file becomes
    /// corrupt/unreadable, fail CLOSED on a cold-start fault with no recoverable
    /// policy, and still pass through for a genuinely missing (never-configured)
    /// policy.
    ///
    /// Every assertion here fails against the old implementation, which routed
    /// both features through the lenient read: a fault produced an empty policy,
    /// protection silently dropped, and the empty state was cached.
    /// </summary>
    public sealed class PrivacyPolicyFaultContractTests : IDisposable
    {
        private const string HcFile = "hidden-content.json";
        private const string SpoilerFile = "spoilerblur.json";

        private readonly string _baseDir;
        private readonly UserConfigurationManager _mgr;

        public PrivacyPolicyFaultContractTests()
        {
            _baseDir = Path.Combine(Path.GetTempPath(), "jc-fault-contract-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_baseDir);
            _mgr = new UserConfigurationManager(new StubAppPaths(_baseDir), NullLogger<UserConfigurationManager>.Instance);
        }

        public void Dispose()
        {
            try { Directory.Delete(_baseDir, recursive: true); } catch { /* best effort */ }
        }

        private string PathFor(string userIdN, string file)
        {
            var dir = Path.Combine(_baseDir, "configurations", "Jellyfin.Plugin.JellyfinCanopy", userIdN);
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, file);
        }

        private static void Corrupt(string path) => File.WriteAllText(path, "{ this is not : valid json ]");

        private HiddenContentResponseFilter NewHcFilter()
        {
            var hierarchy = new HiddenContentHierarchyResolver(new CountingLibraryManager(), new StubUserManager());
            return new HiddenContentResponseFilter(
                _mgr,
                NullLogger<HiddenContentResponseFilter>.Instance,
                new FakePluginConfigProvider(new PluginConfiguration()),
                hierarchy);
        }

        private SpoilerUserResolver NewResolver()
        {
            var markers = new SpoilerIdentityService(new StubUserManager(), NullLogger<SpoilerIdentityService>.Instance);
            var identity = new RequestIdentityService(
                new CountingSessionManager(), new StubUserManager(), markers, NullLogger<RequestIdentityService>.Instance);
            return new SpoilerUserResolver(_mgr, new CountingLibraryManager(), NullLogger<SpoilerUserResolver>.Instance, identity);
        }

        // ───────────────────────── Hidden Content ─────────────────────────────────

        [Fact]
        public void Hc_ValidThenCorrupt_RetainsLastKnownGood()
        {
            var userId = Guid.NewGuid();
            var userIdN = userId.ToString("N");
            var hiddenItem = Guid.NewGuid();

            var hc = new UserHiddenContent();
            hc.Items["k"] = new HiddenContentItem { ItemId = hiddenItem.ToString(), HideScope = "global" };
            _mgr.SaveUserConfiguration(userIdN, HcFile, hc);

            var filter = NewHcFilter();
            // Prime last-known-good from the valid read.
            Assert.True(filter.WouldHideForTest(userId, hiddenItem.ToString(), "library"));

            // Corrupt the file, then simulate a genuine TTL expiry (entry retained).
            Corrupt(PathFor(userIdN, HcFile));
            HiddenContentResponseFilter.ExpireCacheForTest(userIdN);

            // The previously hidden item stays hidden (LKG retained, not fail-open).
            Assert.True(filter.WouldHideForTest(userId, hiddenItem.ToString(), "library"));
            // But an unrelated item is NOT hidden — proving this is LKG, not the
            // blunt fail-closed over-hide.
            Assert.False(filter.WouldHideForTest(userId, Guid.NewGuid().ToString(), "library"));
        }

        [Fact]
        public void Hc_ColdStartCorrupt_FailsClosed_OverHidesEverySurface()
        {
            var userId = Guid.NewGuid();
            var userIdN = userId.ToString("N");
            Corrupt(PathFor(userIdN, HcFile)); // corrupt before any valid read → no LKG

            var filter = NewHcFilter();
            // Any item, on any matched surface, is hidden — content cannot leak.
            Assert.True(filter.WouldHideForTest(userId, Guid.NewGuid().ToString(), "library"));
            Assert.True(filter.WouldHideForTest(userId, Guid.NewGuid().ToString(), "search"));
            Assert.True(filter.WouldHideForTest(userId, Guid.NewGuid().ToString(), "nextup"));
            // The fault populated a NON-empty (protective) cache entry.
            Assert.True(HiddenContentResponseFilter.IsCachedForTest(userIdN));
        }

        [Fact]
        public void Hc_MissingFile_PassesThrough()
        {
            // The overwhelmingly common case: feature enabled globally, this user
            // never configured anything. A missing file is NOT a fault.
            var userId = Guid.NewGuid();
            var filter = NewHcFilter();
            Assert.False(filter.WouldHideForTest(userId, Guid.NewGuid().ToString(), "library"));
        }

        [Fact]
        public void Hc_RepairAfterFault_Reactivates()
        {
            var userId = Guid.NewGuid();
            var userIdN = userId.ToString("N");
            Corrupt(PathFor(userIdN, HcFile));

            var filter = NewHcFilter();
            Assert.True(filter.WouldHideForTest(userId, Guid.NewGuid().ToString(), "library")); // fail-closed

            // Repair: write a valid policy that hides nothing, then invalidate as the
            // controller write path does.
            _mgr.SaveUserConfiguration(userIdN, HcFile, new UserHiddenContent());
            HiddenContentResponseFilter.InvalidateUser(userIdN);

            Assert.False(filter.WouldHideForTest(userId, Guid.NewGuid().ToString(), "library"));
        }

        // ───────────────────────── Spoiler Guard ─────────────────────────────────

        [Fact]
        public void Spoiler_ValidThenCorrupt_RetainsLastKnownGood()
        {
            var userId = Guid.NewGuid();
            var userIdN = userId.ToString("N");
            var seriesN = Guid.NewGuid().ToString("N");

            var state = new UserSpoilerBlur();
            state.Series[seriesN] = new SpoilerBlurSeriesEntry { SeriesId = seriesN };
            _mgr.SaveUserConfiguration(userIdN, SpoilerFile, state);

            var resolver = NewResolver();
            var loaded1 = resolver.LoadUserState(new DefaultHttpContext(), userId);
            Assert.True(loaded1.Series.ContainsKey(seriesN));
            Assert.False(loaded1.FailClosed);

            Corrupt(PathFor(userIdN, SpoilerFile));
            SpoilerUserResolver.ExpireUserStateCacheForTest(userIdN);

            var loaded2 = resolver.LoadUserState(new DefaultHttpContext(), userId);
            Assert.True(loaded2.Series.ContainsKey(seriesN)); // LKG retained
            Assert.False(loaded2.FailClosed);
        }

        [Fact]
        public void Spoiler_ColdStartCorrupt_FailsClosed()
        {
            var userId = Guid.NewGuid();
            var userIdN = userId.ToString("N");
            Corrupt(PathFor(userIdN, SpoilerFile));

            var resolver = NewResolver();
            var loaded = resolver.LoadUserState(new DefaultHttpContext(), userId);
            Assert.True(loaded.FailClosed);
            Assert.Empty(loaded.Series);
            Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(userIdN)); // non-empty protective entry
        }

        [Fact]
        public void Spoiler_MissingFile_EmptyNotFailClosed()
        {
            var userId = Guid.NewGuid();
            var resolver = NewResolver();
            var loaded = resolver.LoadUserState(new DefaultHttpContext(), userId);
            Assert.False(loaded.FailClosed);
            Assert.Empty(loaded.Series);
        }

        [Fact]
        public void Spoiler_RepairAfterFault_Reactivates()
        {
            var userId = Guid.NewGuid();
            var userIdN = userId.ToString("N");
            Corrupt(PathFor(userIdN, SpoilerFile));

            var resolver = NewResolver();
            Assert.True(resolver.LoadUserState(new DefaultHttpContext(), userId).FailClosed);

            _mgr.SaveUserConfiguration(userIdN, SpoilerFile, new UserSpoilerBlur());
            SpoilerUserResolver.InvalidateUser(userIdN);

            Assert.False(resolver.LoadUserState(new DefaultHttpContext(), userId).FailClosed);
        }

        // ───────────────────────── Pure decision (Spoiler) ────────────────────────

        [Fact]
        public void ResolvePolicyState_Fault_WithLkg_RetainsLkg()
        {
            var lkg = new UserSpoilerBlur();
            lkg.Series["abc"] = new SpoilerBlurSeriesEntry { SeriesId = "abc" };

            var corrupt = new UserConfigReadResult<UserSpoilerBlur>(UserConfigReadStatus.Corrupt, null, "malformed");
            var result = SpoilerUserResolver.ResolvePolicyState(corrupt, lkg);

            Assert.Same(lkg, result);
            Assert.False(result.FailClosed);
        }

        [Fact]
        public void ResolvePolicyState_Fault_NoLkg_FailsClosed()
        {
            var unavailable = new UserConfigReadResult<UserSpoilerBlur>(UserConfigReadStatus.Unavailable, null, "io");
            var result = SpoilerUserResolver.ResolvePolicyState(unavailable, lastKnownGood: null);
            Assert.True(result.FailClosed);
        }

        [Fact]
        public void ResolvePolicyState_Missing_IsEmpty_NotFailClosed()
        {
            var missing = new UserConfigReadResult<UserSpoilerBlur>(UserConfigReadStatus.Missing, new UserSpoilerBlur(), null);
            var result = SpoilerUserResolver.ResolvePolicyState(missing, lastKnownGood: null);
            Assert.False(result.FailClosed);
            Assert.Empty(result.Series);
        }

        [Fact]
        public void ResolvePolicyState_Valid_UsesParsedValue()
        {
            var parsed = new UserSpoilerBlur();
            parsed.Movies["m"] = new SpoilerBlurMovieEntry();
            var valid = new UserConfigReadResult<UserSpoilerBlur>(UserConfigReadStatus.Valid, parsed, null);
            var result = SpoilerUserResolver.ResolvePolicyState(valid, lastKnownGood: null);
            Assert.Same(parsed, result);
            Assert.False(result.FailClosed);
        }
    }
}
