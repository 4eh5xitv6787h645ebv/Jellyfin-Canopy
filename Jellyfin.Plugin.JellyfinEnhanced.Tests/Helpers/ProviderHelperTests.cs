using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Helpers
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
    }
}
