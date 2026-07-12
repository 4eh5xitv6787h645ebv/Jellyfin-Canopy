using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinElevate.Model.Awards;
using Jellyfin.Plugin.JellyfinElevate.ScheduledTasks;
using Jellyfin.Plugin.JellyfinElevate.Services.Awards;
using Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;
using MediaBrowser.Controller.Entities.Movies;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.ScheduledTasks
{
    /// <summary>
    /// The refresh task must never publish a PARTIAL fetch over an existing complete index —
    /// a single timed-out ceremony query would otherwise erase that ceremony's awards until a
    /// later full run. A partial fetch is only accepted when there is no index yet (first install).
    /// </summary>
    public sealed class BuildAwardsCacheTaskTests : IDisposable
    {
        private readonly string _dir;

        public BuildAwardsCacheTaskTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "je-awards-task-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); } catch { /* best-effort */ }
        }

        private sealed class FakeProvider : IAwardsProvider
        {
            public AwardsFetchResult Result { get; set; } = new(Array.Empty<AwardRow>(), true);

            public Task<AwardsFetchResult> FetchAllAsync(IProgress<double>? progress, CancellationToken cancellationToken)
                => Task.FromResult(Result);
        }

        private AwardsCacheService NewCache() =>
            new(new StubAppPaths(_dir), NullLogger<AwardsCacheService>.Instance);

        private static AwardRow Row(string ceremony, string category, string imdb) =>
            new() { Ceremony = ceremony, Category = category, Won = true, Year = 2024, ImdbId = imdb, MediaType = "movie" };

        private static Movie Movie(string imdb)
        {
            var m = new Movie { Id = Guid.NewGuid() };
            m.ProviderIds["Imdb"] = imdb;
            return m;
        }

        private static Task Run(IAwardsProvider provider, AwardsCacheService cache) =>
            new BuildAwardsCacheTask(provider, cache, NullLogger<BuildAwardsCacheTask>.Instance)
                .ExecuteAsync(new Progress<double>(), CancellationToken.None);

        [Fact]
        public async Task CompleteFetch_PublishesIndex()
        {
            var cache = NewCache();
            var provider = new FakeProvider { Result = new(new[] { Row("Academy Awards", "Best Picture", "tt1") }, true) };

            await Run(provider, cache);

            Assert.Single(cache.LookupForItem(Movie("tt1")));
            Assert.Equal(1, cache.Version);
        }

        [Fact]
        public async Task PartialFetch_OverExistingIndex_IsNotPublished()
        {
            var cache = NewCache();
            cache.ReplaceFrom(new[] { Row("Academy Awards", "Best Picture", "tt1") }); // existing complete index
            var versionBefore = cache.Version;

            // A partial refresh returns different data (as if only one ceremony query succeeded).
            var provider = new FakeProvider { Result = new(new[] { Row("BAFTA Awards", "Best Film", "tt2") }, false) };
            await Run(provider, cache);

            // The old award survives; the partial data was NOT published.
            Assert.Single(cache.LookupForItem(Movie("tt1")));
            Assert.Empty(cache.LookupForItem(Movie("tt2")));
            Assert.Equal(versionBefore, cache.Version);
        }

        [Fact]
        public async Task PartialFetch_OnFirstInstall_IsPublished()
        {
            var cache = NewCache(); // empty — first install
            var provider = new FakeProvider { Result = new(new[] { Row("Academy Awards", "Best Picture", "tt1") }, false) };

            await Run(provider, cache);

            // Partial beats an empty section when there is nothing yet.
            Assert.Single(cache.LookupForItem(Movie("tt1")));
            Assert.Equal(1, cache.Version);
        }

        [Fact]
        public async Task EmptyFetch_LeavesExistingIndexUntouched()
        {
            var cache = NewCache();
            cache.ReplaceFrom(new[] { Row("Academy Awards", "Best Picture", "tt1") });
            var versionBefore = cache.Version;

            var provider = new FakeProvider { Result = new(Array.Empty<AwardRow>(), true) };
            await Run(provider, cache);

            Assert.Single(cache.LookupForItem(Movie("tt1")));
            Assert.Equal(versionBefore, cache.Version);
        }
    }
}
