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
    }
}
