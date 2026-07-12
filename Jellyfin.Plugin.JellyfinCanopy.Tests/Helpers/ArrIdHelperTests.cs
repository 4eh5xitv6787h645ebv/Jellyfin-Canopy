using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Helpers
{
    /// <summary>
    /// Unit coverage for the shared numeric-id guard. A present-but-0 (or absent/negative)
    /// tmdb/tvdb id is never a real key, so it must normalize to null / no provider pair.
    /// </summary>
    public class ArrIdHelperTests
    {
        [Theory]
        [InlineData(null, null)]
        [InlineData(0, null)]
        [InlineData(-1, null)]
        [InlineData(5, 5)]
        public void ToNullableId_ZeroAbsentOrNegative_IsNull(int? raw, int? expected)
        {
            Assert.Equal(expected, ArrIdHelper.ToNullableId(raw));
        }

        [Theory]
        [InlineData(null, null)]
        [InlineData(0, null)]
        [InlineData(-3, null)]
        [InlineData(5, "5")]
        public void ToProviderValue_ZeroAbsentOrNegative_IsNull(int? raw, string? expected)
        {
            Assert.Equal(expected, ArrIdHelper.ToProviderValue(raw));
        }

        [Fact]
        public void NamespacedId_SameRawIdDifferentInstance_AreDistinct()
        {
            // The property that fails pre-fix: two same-source instances both number rows from 1,
            // so the raw ids were equal and collided as a global key.
            Assert.NotEqual(
                ArrIdHelper.NamespacedId("Sonarr", "Anime", 123),
                ArrIdHelper.NamespacedId("Sonarr", "4K", 123));
        }

        [Fact]
        public void NamespacedId_SameSourceInstanceAndId_AreEqual()
        {
            // Stable: the client round-trips the id and the user-data echo must resolve to the same key.
            Assert.Equal(
                ArrIdHelper.NamespacedId("Sonarr", "Anime", 123),
                ArrIdHelper.NamespacedId("Sonarr", "Anime", 123));
        }

        [Fact]
        public void NamespacedId_DifferentSourceSameInstanceAndId_AreDistinct()
        {
            Assert.NotEqual(
                ArrIdHelper.NamespacedId("Sonarr", "Main", 5),
                ArrIdHelper.NamespacedId("Radarr", "Main", 5));
        }

        [Fact]
        public void NamespacedId_NullInstanceName_IsStable()
        {
            Assert.Equal("Sonarr||5", ArrIdHelper.NamespacedId("Sonarr", (string?)null, 5));
        }

        [Fact]
        public void NamespacedId_ByPosition_DisambiguatesSameNamedInstances()
        {
            // The real-world bug: two instances share a display name (e.g. both "Radarr", or both
            // blank), so keying the id by instance.Name collided them. Namespacing by the instance's
            // position in the configured list gives each a distinct id even when the names — and the
            // per-instance row id — are identical.
            Assert.NotEqual(
                ArrIdHelper.NamespacedId("Radarr", 0, 5),
                ArrIdHelper.NamespacedId("Radarr", 1, 5));
        }

        [Fact]
        public void NamespacedId_IntOverload_EqualsItsStringPosition()
        {
            Assert.Equal(
                ArrIdHelper.NamespacedId("Radarr", "1", 5),
                ArrIdHelper.NamespacedId("Radarr", 1, 5));
        }
    }
}
