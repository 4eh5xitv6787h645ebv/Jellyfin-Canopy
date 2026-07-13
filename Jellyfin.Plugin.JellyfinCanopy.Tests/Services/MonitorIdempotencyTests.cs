using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    /// <summary>
    /// Proves the library/session monitors are idempotent across repeated <c>Initialize()</c> calls.
    /// The startup scheduled task always exposes a dashboard "Run" button, so a second run must not
    /// double-subscribe a handler that only unsubscribes on Dispose — that would fan every library
    /// event out to two (then three, …) handlers until a restart. The fakes expose the true live
    /// subscriber count (event invocation-list length), so "subscribe twice attaches one handler"
    /// is asserted directly.
    /// </summary>
    public sealed class MonitorIdempotencyTests
    {
        private static PluginConfiguration WatchlistEnabled() =>
            new() { AddRequestedMediaToWatchlist = true, SeerrEnabled = true };

        [Fact]
        public void WatchlistMonitor_Initialize_Twice_SubscribesOnce()
        {
            var library = new CountingLibraryManager();
            var monitor = new WatchlistMonitor(
                library,
                null!,
                null!,
                null!,
                null!,
                NullLogger<WatchlistMonitor>.Instance,
                new FakePluginConfigProvider(WatchlistEnabled()));

            monitor.Initialize();
            monitor.Initialize();

            Assert.Equal(1, library.ItemAddedCount);
            Assert.Equal(1, library.ItemUpdatedCount);
        }

        [Fact]
        public void AutoMovieRequestMonitor_Initialize_Twice_SubscribesOnce()
        {
            var sessions = new CountingSessionManager();
            var monitor = new AutoMovieRequestMonitor(
                sessions,
                null!,
                null!,
                null!,
                NullLogger<AutoMovieRequestMonitor>.Instance,
                new FakePluginConfigProvider(new PluginConfiguration { AutoMovieRequestEnabled = true, SeerrEnabled = true }));

            monitor.Initialize();
            monitor.Initialize();

            Assert.Equal(1, sessions.PlaybackProgressCount);
        }

        [Fact]
        public void AutoSeasonRequestMonitor_Initialize_Twice_SubscribesOnce()
        {
            var sessions = new CountingSessionManager();
            var monitor = new AutoSeasonRequestMonitor(
                sessions,
                null!,
                null!,
                null!,
                NullLogger<AutoSeasonRequestMonitor>.Instance,
                new FakePluginConfigProvider(new PluginConfiguration { AutoSeasonRequestEnabled = true, SeerrEnabled = true }));

            monitor.Initialize();
            monitor.Initialize();

            Assert.Equal(1, sessions.PlaybackProgressCount);
            Assert.Equal(1, sessions.PlaybackStoppedCount);
        }

        [Fact]
        public void TagCacheMonitor_Initialize_Twice_SubscribesOnce()
        {
            var library = new CountingLibraryManager();
            var monitor = new TagCacheMonitor(library, null!, NullLogger<TagCacheMonitor>.Instance);

            monitor.Initialize();
            monitor.Initialize();

            Assert.Equal(1, library.ItemAddedCount);
            Assert.Equal(1, library.ItemUpdatedCount);
            Assert.Equal(1, library.ItemRemovedCount);
        }
    }
}
