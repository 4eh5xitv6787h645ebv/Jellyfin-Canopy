using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Helpers
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
            Assert.Equal("Sonarr||5", ArrIdHelper.NamespacedId("Sonarr", null, 5));
        }
    }
}
