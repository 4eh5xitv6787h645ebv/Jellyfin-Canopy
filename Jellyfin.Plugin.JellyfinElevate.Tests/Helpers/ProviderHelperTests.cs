using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinElevate.Helpers;
using Jellyfin.Plugin.JellyfinElevate.Model.Arr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Helpers
{
    /// <summary>
    /// Guards the provider-list producer against the zero-as-key leak (W4-ID-1): an ArrItem
    /// carrying a 0 numeric id must never emit a ("Tvdb","0")/("Tmdb","0") pair, and such a
    /// pair must never resolve to a library item.
    /// </summary>
    public class ProviderHelperTests
    {
        [Fact]
        public void GetEpisodeProviders_ZeroEpisodeTvdbId_EmitsNoTvdbZeroPair()
        {
            var item = new ArrItem { EpisodeTvdbId = 0 };

            var providers = ProviderHelper.GetEpisodeProviders(item);

            Assert.DoesNotContain(("Tvdb", "0"), providers);
            Assert.Empty(providers);
        }

        [Fact]
        public void GetProviders_ZeroTvdbAndTmdbIds_EmitNoZeroPairs()
        {
            var item = new ArrItem { TvdbId = 0, TmdbId = 0 };

            var providers = ProviderHelper.GetProviders(item);

            Assert.DoesNotContain(("Tvdb", "0"), providers);
            Assert.DoesNotContain(("Tmdb", "0"), providers);
            Assert.Empty(providers);
        }

        [Fact]
        public void GetBestItemId_ZeroEpisodeTvdbId_DoesNotResolveToTvdbZeroItem()
        {
            var item = new ArrItem { EpisodeTvdbId = 0 };
            var unrelated = Guid.NewGuid();
            var map = new Dictionary<(string Provider, string Value), Guid>
            {
                [("Tvdb", "0")] = unrelated,
            };

            var resolved = ProviderHelper.GetBestItemId(ProviderHelper.GetEpisodeProviders(item), map);

            Assert.Null(resolved);
        }

        [Fact]
        public void GetBestItemId_EqualScoreTie_DeterministicallyPicksSmallestGuid()
        {
            // Two providers each score 1, resolving to two distinct items. MaxBy resolved the tie by
            // Dictionary enumeration order (nondeterministic); the fix returns the smallest Guid.
            var larger = Guid.Parse("22222222-2222-2222-2222-222222222222");
            var smaller = Guid.Parse("11111111-1111-1111-1111-111111111111");
            var providers = new[] { ("Tvdb", "1"), ("Tmdb", "2") };

            // Two insertion orders of the same logical map — the winner must not depend on order.
            var mapA = new Dictionary<(string Provider, string Value), Guid>
            {
                [("Tvdb", "1")] = larger,
                [("Tmdb", "2")] = smaller,
            };
            var mapB = new Dictionary<(string Provider, string Value), Guid>
            {
                [("Tmdb", "2")] = smaller,
                [("Tvdb", "1")] = larger,
            };

            var resultA = ProviderHelper.GetBestItemId(providers, mapA);
            var resultB = ProviderHelper.GetBestItemId(providers, mapB);

            Assert.Equal(smaller, resultA);
            Assert.Equal(smaller, resultB);
            // Repeated calls are stable.
            Assert.Equal(resultA, ProviderHelper.GetBestItemId(providers, mapA));
        }
    }
}
