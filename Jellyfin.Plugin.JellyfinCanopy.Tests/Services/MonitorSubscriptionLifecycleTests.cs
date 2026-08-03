using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

/// <summary>
/// Regression coverage for BI-SRV-096 (#157): the auto-movie, auto-season and
/// watchlist monitors subscribe to Jellyfin events only through their
/// Initialize() reconcile, which used to run ONLY from the startup task — so a
/// feature toggled on after startup stayed silently inactive until a restart.
/// These tests drive the production config-change path
/// (<see cref="LiveNotifierService.HandleConfigurationChangedAsync"/> →
/// <see cref="SeerrIntegrationPolicy.InvalidateCachedActiveState"/> → each
/// monitor's reconcile) and assert against the fakes' true live subscriber
/// counts (event invocation-list length), so "the subscription was actually
/// acquired/released" is proven directly rather than inferred from handler
/// no-ops.
/// </summary>
public sealed class MonitorSubscriptionLifecycleTests
{
    private sealed class Fixture
    {
        public Fixture(PluginConfiguration? initialConfig)
        {
            Provider = new FakePluginConfigProvider(initialConfig);
            Library = new CountingLibraryManager();
            Sessions = new CountingSessionManager();
            // No live sessions: HandleConfigurationChangedAsync exercises the real
            // config-change path without attempting a client push.
            Sessions.SetSessions();
            Watchlist = new WatchlistMonitor(
                Library,
                null!,
                null!,
                null!,
                null!,
                NullLogger<WatchlistMonitor>.Instance,
                Provider,
                new StubItemLookupService());
            AutoMovie = new AutoMovieRequestMonitor(
                Sessions,
                null!,
                null!,
                null!,
                NullLogger<AutoMovieRequestMonitor>.Instance,
                Provider);
            AutoSeason = new AutoSeasonRequestMonitor(
                Sessions,
                null!,
                null!,
                null!,
                NullLogger<AutoSeasonRequestMonitor>.Instance,
                Provider);
            Capabilities = new PlatformActionCapabilityService();
            PrepareHandles = new PlatformPrepareHandleOwner();
            PreparedContexts = new PlatformPreparedActionContextOwner(Capabilities);
            Notifier = new LiveNotifierService(
                null!,
                Sessions,
                new LiveSessionRegistry(),
                new SeerrCache(Provider),
                Watchlist,
                AutoMovie,
                AutoSeason,
                PrepareHandles,
                PreparedContexts,
                NullLogger<LiveNotifierService>.Instance);
        }

        public FakePluginConfigProvider Provider { get; }

        public CountingLibraryManager Library { get; }

        public CountingSessionManager Sessions { get; }

        public WatchlistMonitor Watchlist { get; }

        public AutoMovieRequestMonitor AutoMovie { get; }

        public AutoSeasonRequestMonitor AutoSeason { get; }

        public PlatformActionCapabilityService Capabilities { get; }

        public PlatformPrepareHandleOwner PrepareHandles { get; }

        public PlatformPreparedActionContextOwner PreparedContexts { get; }

        public LiveNotifierService Notifier { get; }

        /// <summary>Models the startup scheduled task's three Initialize() calls.</summary>
        public void RunStartup()
        {
            AutoSeason.Initialize();
            AutoMovie.Initialize();
            Watchlist.Initialize();
        }

        /// <summary>Drives the production admin-save config-change path.</summary>
        public Task SaveConfigurationAsync(PluginConfiguration config)
        {
            Provider.Current = config;
            return Notifier.HandleConfigurationChangedAsync(CancellationToken.None);
        }

        public void AssertAllSubscribedOnce()
        {
            Assert.Equal(1, Library.ItemAddedCount);
            Assert.Equal(1, Library.ItemUpdatedCount);
            Assert.Equal(1, Sessions.PlaybackStoppedCount);
            // One auto-season handler + one auto-movie handler.
            Assert.Equal(2, Sessions.PlaybackProgressCount);
        }

        public void AssertNoneSubscribed()
        {
            Assert.Equal(0, Library.ItemAddedCount);
            Assert.Equal(0, Library.ItemUpdatedCount);
            Assert.Equal(0, Sessions.PlaybackStoppedCount);
            Assert.Equal(0, Sessions.PlaybackProgressCount);
        }

        public void DisposeMonitors()
        {
            AutoSeason.Dispose();
            AutoMovie.Dispose();
            Watchlist.Dispose();
            PreparedContexts.Dispose();
            Capabilities.Dispose();
            PrepareHandles.Dispose();
        }
    }

    private static PluginConfiguration Config(
        bool seerrEnabled,
        bool autoMovie,
        bool autoSeason,
        bool watchlist)
        => new()
        {
            SeerrEnabled = seerrEnabled,
            AutoMovieRequestEnabled = autoMovie,
            AutoSeasonRequestEnabled = autoSeason,
            AddRequestedMediaToWatchlist = watchlist,
        };

    // AC1 + AC5: features disabled when the startup task ran, then hot-enabled via
    // an admin save — every monitor must ACQUIRE its event subscription without a
    // restart or manual startup-task run.
    [Fact]
    public async Task DisabledAtStartup_HotEnableSubscribesAllThree()
    {
        var fixture = new Fixture(Config(seerrEnabled: true, autoMovie: false, autoSeason: false, watchlist: false));

        fixture.RunStartup();
        fixture.AssertNoneSubscribed();

        await fixture.SaveConfigurationAsync(
            Config(seerrEnabled: true, autoMovie: true, autoSeason: true, watchlist: true));

        fixture.AssertAllSubscribedOnce();
        fixture.DisposeMonitors();
    }

    // AC2 + AC5: features enabled at startup, then hot-disabled — every monitor
    // must RELEASE its subscription (true release, not just handler gating).
    [Fact]
    public async Task Enabled_HotDisableReleasesAllThree()
    {
        var fixture = new Fixture(Config(seerrEnabled: true, autoMovie: true, autoSeason: true, watchlist: true));

        fixture.RunStartup();
        fixture.AssertAllSubscribedOnce();

        await fixture.SaveConfigurationAsync(
            Config(seerrEnabled: true, autoMovie: false, autoSeason: false, watchlist: false));

        fixture.AssertNoneSubscribed();
        fixture.DisposeMonitors();
    }

    // AC3 + AC5: repeated ConfigurationChanged with no state change, plus a second
    // startup-task run, each subscribe AT MOST ONCE; and once disposed, a late
    // config callback can never re-acquire the events.
    [Fact]
    public async Task RepeatedConfigurationChangedAndSecondStartupRunRemainIdempotent()
    {
        var enabled = Config(seerrEnabled: true, autoMovie: true, autoSeason: true, watchlist: true);
        var fixture = new Fixture(enabled);

        fixture.RunStartup();
        await fixture.SaveConfigurationAsync(enabled);
        await fixture.SaveConfigurationAsync(enabled);
        fixture.RunStartup(); // second dashboard "Run" of the startup task

        fixture.AssertAllSubscribedOnce();

        fixture.DisposeMonitors();
        fixture.AssertNoneSubscribed();

        // Post-disposal notification must not re-acquire any subscription.
        await fixture.SaveConfigurationAsync(enabled);
        fixture.AssertNoneSubscribed();
    }

    // AC4 + AC5: the Seerr master switch off overrides per-feature on — no
    // subscription may exist while the integration is disabled; enabling the
    // master with the features already on then subscribes exactly once.
    [Fact]
    public async Task MasterOffOverridesFeatureFlagsThenMasterOnSubscribes()
    {
        var fixture = new Fixture(Config(seerrEnabled: false, autoMovie: true, autoSeason: true, watchlist: true));

        fixture.RunStartup();
        fixture.AssertNoneSubscribed();

        await fixture.SaveConfigurationAsync(
            Config(seerrEnabled: false, autoMovie: true, autoSeason: true, watchlist: true));
        fixture.AssertNoneSubscribed();

        await fixture.SaveConfigurationAsync(
            Config(seerrEnabled: true, autoMovie: true, autoSeason: true, watchlist: true));
        fixture.AssertAllSubscribedOnce();

        // Master hot-disabled again: every subscription is released even though
        // the per-feature flags stay on.
        await fixture.SaveConfigurationAsync(
            Config(seerrEnabled: false, autoMovie: true, autoSeason: true, watchlist: true));
        fixture.AssertNoneSubscribed();
        fixture.DisposeMonitors();
    }

    // Unavailable configuration (plugin unloaded mid-flight) must release an
    // existing subscription rather than leave stale handlers attached, and must
    // not throw.
    [Fact]
    public async Task ConfigurationBecomingUnavailable_ReleasesExistingSubscriptions()
    {
        var fixture = new Fixture(Config(seerrEnabled: true, autoMovie: true, autoSeason: true, watchlist: true));

        fixture.RunStartup();
        fixture.AssertAllSubscribedOnce();

        fixture.Provider.Current = null;
        await fixture.Notifier.HandleConfigurationChangedAsync(CancellationToken.None);

        fixture.AssertNoneSubscribed();
        fixture.DisposeMonitors();
    }

    [Fact]
    public async Task ConfigurationSaveSynchronouslyRevokesNativeAuthorityAndReenableCannotReviveIt()
    {
        var fixture = new Fixture(new PluginConfiguration { PlatformEnabled = true });
        var actor = new PlatformActor(
            Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
            isElevated: false,
            "correlation",
            "android-tv",
            "device-a");
        var item = new HostAccessibleItem(
            Guid.Parse("11111111-2222-3333-4444-555555555555"),
            HostItemKind.Episode,
            Guid.Parse("bbbbbbbb-cccc-dddd-eeee-ffffffffffff"),
            ImmutableArray<HostProviderReference>.Empty);
        var handle = fixture.PrepareHandles.IssueOrReuse(new PlatformPrepareSnapshot(
            actor,
            item,
            PlatformOperationDefinition.HiddenContentConfigureItem,
            new PlatformPrepareClientContext(
                ["action"],
                ["confirmation"],
                ["dpad"],
                ["screen_reader"],
                "en-AU"),
            [new PlatformPrepareStateRevision("owner", 1)],
            configurationRevision: 1,
            catalogRevision: "sha256-catalog",
            privateState: [1, 2, 3],
            attenuateToCurrentDevice: false));
        var prepared = fixture.PreparedContexts.Issue(
            actor,
            new PlatformPreparedActionRequest(
                PlatformOperationDefinition.HiddenContentConfigureItem,
                item,
                configurationRevision: 1,
                privateState: [4, 5, 6]),
            attenuateToCurrentDevice: false);
        var inspection = fixture.Capabilities.Inspect(prepared.Capability);
        var idempotency = new PlatformIdempotencyStore();
        Assert.True(PlatformIdempotencyKey.TryParse("ambiguous-save-boundary", out var idempotencyKey));
        var idempotencyRequest = new PlatformIdempotencyRequest(
            actor.UserId,
            "hidden-content.configure",
            idempotencyKey,
            new PlatformSemanticFingerprint(SHA256.HashData(Encoding.UTF8.GetBytes("exact-input"))),
            maximumResultBytes: 1024);
        await Assert.ThrowsAsync<InvalidOperationException>(() => idempotency.ExecuteAsync(
            idempotencyRequest,
            _ => throw new InvalidOperationException("external outcome unknown"),
            CancellationToken.None));

        Assert.Equal(1, fixture.PrepareHandles.EntryCount);
        Assert.Equal(1, fixture.PreparedContexts.EntryCount);
        Assert.Equal(1, fixture.Capabilities.LedgerEntryCount);

        var notification = fixture.SaveConfigurationAsync(new PluginConfiguration { PlatformEnabled = false });

        // These assertions intentionally run before awaiting the async notification:
        // the synchronous ConfigurationChanged prefix must revoke authority before
        // any live-session push can yield.
        Assert.Equal(0, fixture.PrepareHandles.EntryCount);
        Assert.Equal(0, fixture.PreparedContexts.EntryCount);
        Assert.Equal(0, fixture.Capabilities.LedgerEntryCount);
        Assert.Null(fixture.PrepareHandles.Resolve(handle.Handle, actor));
        Assert.Null(fixture.PreparedContexts.Resolve(prepared.Capability, inspection));
        await notification;

        var retriedMutation = false;
        var retry = await idempotency.ExecuteAsync(
            idempotencyRequest,
            _ =>
            {
                retriedMutation = true;
                using var result = JsonDocument.Parse("{\"unexpected\":true}");
                return Task.FromResult(new PlatformIdempotencyResult(200, "ok", result.RootElement));
            },
            CancellationToken.None);
        Assert.Equal(PlatformIdempotencyOutcomeKind.Indeterminate, retry.Kind);
        Assert.False(retriedMutation);

        await fixture.SaveConfigurationAsync(new PluginConfiguration { PlatformEnabled = true });
        Assert.Null(fixture.PrepareHandles.Resolve(handle.Handle, actor));
        Assert.Null(fixture.PreparedContexts.Resolve(
            prepared.Capability,
            fixture.Capabilities.Inspect(prepared.Capability)));
        fixture.DisposeMonitors();
    }
}
