using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.ScheduledTasks
{
    /// <summary>
    /// ARR-9: the sync task's write-side prefix default must match the config-property
    /// default and the client read-side default so blanking the field can't write bare
    /// tags the client then fails to recognize.
    /// </summary>
    public class ArrTagsSyncPrefixTests
    {
        [Fact]
        public void ResolveTagPrefix_BlankValue_FallsBackToSharedDefault()
        {
            var config = new PluginConfiguration { ArrTagsPrefix = string.Empty };

            var resolved = ArrTagsSyncTask.ResolveTagPrefix(config);

            Assert.Equal("JE Arr Tag: ", resolved);
            Assert.Equal(PluginConfiguration.DefaultArrTagsPrefix, resolved);
        }

        [Fact]
        public void ResolveTagPrefix_WhitespaceValue_FallsBackToSharedDefault()
        {
            var config = new PluginConfiguration { ArrTagsPrefix = "   " };

            Assert.Equal(PluginConfiguration.DefaultArrTagsPrefix, ArrTagsSyncTask.ResolveTagPrefix(config));
        }

        [Fact]
        public void ResolveTagPrefix_NonBlankValue_IsPreserved()
        {
            var config = new PluginConfiguration { ArrTagsPrefix = "Requested by: " };

            Assert.Equal("Requested by: ", ArrTagsSyncTask.ResolveTagPrefix(config));
        }

        [Fact]
        public void DefaultPrefix_MatchesPropertyInitializer()
        {
            // The property initializer and the const must agree — that's the whole point
            // of routing both through DefaultArrTagsPrefix.
            Assert.Equal(PluginConfiguration.DefaultArrTagsPrefix, new PluginConfiguration().ArrTagsPrefix);
        }
    }
}
