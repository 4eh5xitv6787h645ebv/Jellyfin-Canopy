using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.ScheduledTasks;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.ScheduledTasks
{
    /// <summary>
    /// ARR-9 / ARR-CS-3: the sync task's write-side prefix default must match the config-property
    /// default AND the client read-side default so blanking the field can't write bare tags the
    /// client then fails to recognize. The client uses <c>config.ArrTagsPrefix || 'JE Arr Tag: '</c>,
    /// so only an empty/absent value defaults — a whitespace-only prefix is kept verbatim. The write
    /// side must mirror that (IsNullOrEmpty, not IsNullOrWhiteSpace) or write and read diverge.
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
        public void ResolveTagPrefix_WhitespaceValue_IsPreservedToMatchClient()
        {
            // JS treats a whitespace-only string as truthy, so the client keeps "   " as the prefix.
            // The write side must keep it too (IsNullOrEmpty, not IsNullOrWhiteSpace) or the tags the
            // sync writes ("   Anime") won't match the client's startsWith("   ") read.
            var config = new PluginConfiguration { ArrTagsPrefix = "   " };

            Assert.Equal("   ", ArrTagsSyncTask.ResolveTagPrefix(config));
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
