using Jellyfin.Plugin.JellyfinCanopy.Configuration;
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
                Provider);
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
            Notifier = new LiveNotifierService(
                null!,
                Sessions,
                new LiveSessionRegistry(),
                new SeerrCache(Provider),
                Watchlist,
                AutoMovie,
                AutoSeason,
                NullLogger<LiveNotifierService>.Instance);
        }

        public FakePluginConfigProvider Provider { get; }

        public CountingLibraryManager Library { get; }

        public CountingSessionManager Sessions { get; }

        public WatchlistMonitor Watchlist { get; }

        public AutoMovieRequestMonitor AutoMovie { get; }

        public AutoSeasonRequestMonitor AutoSeason { get; }

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
}
