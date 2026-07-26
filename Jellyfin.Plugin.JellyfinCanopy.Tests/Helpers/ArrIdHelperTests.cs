using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
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

        [Theory]
        [InlineData("1", "1")]
        [InlineData("2147483647", "2147483647")]
        [InlineData("0", null)]
        [InlineData("-1", null)]
        [InlineData("1.5", null)]
        [InlineData("2147483648", null)]
        [InlineData("false", null)]
        [InlineData("\"1\"", null)]
        [InlineData("{}", null)]
        [InlineData("[]", null)]
        public void ToStableRecordIdentity_RequiresPositiveInt32Scalar(
            string json,
            string? expected)
        {
            Assert.Equal(
                expected,
                ArrIdHelper.ToStableRecordIdentity(JsonNode.Parse(json)));
        }

        [Fact]
        public void NamespacedId_SameRawIdDifferentInstance_AreDistinct()
        {
            var anime = Instance("http://anime:8989", "key-a");
            var fourK = Instance("http://four-k:8989", "key-b");

            Assert.NotEqual(
                ArrIdHelper.NamespacedId("Sonarr", anime, 123),
                ArrIdHelper.NamespacedId("Sonarr", fourK, 123));
        }

        [Fact]
        public void PersistedInstanceId_SurvivesRenameReorderAndConnectionChanges()
        {
            var instance = Instance("http://sonarr:8989", "old-key");
            instance.InstanceId = "ABCDEF0123456789ABCDEF0123456789";
            var before = ArrIdHelper.NamespacedId("Sonarr", instance, 123);

            instance.Name = "Renamed";
            instance.Url = "https://new-sonarr.example.com";
            instance.ApiKey = "rotated-key";
            instance.Enabled = false;

            Assert.Equal("abcdef0123456789abcdef0123456789", ArrIdHelper.GetStableInstanceId(instance));
            Assert.Equal(before, ArrIdHelper.NamespacedId("Sonarr", instance, 123));
        }

        [Fact]
        public void LegacyFallback_IsStableAcrossRenameAndReorder()
        {
            var first = Instance("http://one:8989/", "key-one");
            var second = Instance("http://two:8989", "key-two");
            var firstId = ArrIdHelper.GetStableInstanceId(first);
            var secondId = ArrIdHelper.GetStableInstanceId(second);
            var reordered = new[] { second, first };

            first.Name = "Renamed after reorder";
            second.Name = "Also renamed";

            Assert.Equal(firstId, ArrIdHelper.GetStableInstanceId(reordered[1]));
            Assert.Equal(secondId, ArrIdHelper.GetStableInstanceId(reordered[0]));
            Assert.NotEqual(firstId, secondId);
        }

        [Fact]
        public void LegacyFallback_UsesApiKeyToDisambiguateSharedUrlWithoutExposingIt()
        {
            const string secret = "super-secret-api-key";
            var first = Instance("http://shared:8989", secret);
            var second = Instance("http://shared:8989", "different-secret");

            var firstId = ArrIdHelper.GetStableInstanceId(first);
            var namespaced = ArrIdHelper.NamespacedId("Sonarr", first, 7);

            Assert.NotEqual(firstId, ArrIdHelper.GetStableInstanceId(second));
            Assert.DoesNotContain(secret, firstId, StringComparison.Ordinal);
            Assert.DoesNotContain(secret, namespaced, StringComparison.Ordinal);
            Assert.Matches("^[0-9a-f]{32}$", firstId);
        }

        [Fact]
        public void NamespacedId_DifferentSourceSameInstanceAndId_AreDistinct()
        {
            var instance = Instance("http://shared:8989", "key");
            Assert.NotEqual(
                ArrIdHelper.NamespacedId("Sonarr", instance, 5),
                ArrIdHelper.NamespacedId("Radarr", instance, 5));
        }

        [Fact]
        public void EnsureInstanceIdsJson_PersistsLegacyFallbackAndPreservesModernId()
        {
            var json = """
                [
                  {"Name":"Legacy","Url":"http://one:8989","ApiKey":"legacy-secret","Enabled":true},
                  {"InstanceId":"ABCDEF0123456789ABCDEF0123456789","Name":"Modern","Url":"http://two:8989","ApiKey":"modern-secret","Enabled":true}
                ]
                """;

            var result = ArrIdHelper.EnsureInstanceIdsJson(json);
            var instances = JsonSerializer.Deserialize<List<ArrInstance>>(result)!;

            Assert.All(instances, instance => Assert.Matches("^[0-9a-f]{32}$", instance.InstanceId));
            Assert.Equal("abcdef0123456789abcdef0123456789", instances[1].InstanceId);
            Assert.DoesNotContain("legacy-secret", instances[0].InstanceId, StringComparison.Ordinal);
            Assert.Equal(result, ArrIdHelper.EnsureInstanceIdsJson(result));
        }

        [Fact]
        public void EnsureInstanceIdsJson_RekeysEveryAmbiguousDuplicate()
        {
            var json = """
                [
                  {"Name":"One","Url":"http://same:8989","ApiKey":"same-key","Enabled":true},
                  {"Name":"Two","Url":"http://same:8989","ApiKey":"same-key","Enabled":true}
                ]
                """;
            var reassigned = new List<string>();

            var result = ArrIdHelper.EnsureInstanceIdsJson(json, reassigned.Add);
            var instances = JsonSerializer.Deserialize<List<ArrInstance>>(result)!;

            Assert.Equal(new[] { "One", "Two" }, reassigned);
            Assert.Equal(2, instances.Select(instance => instance.InstanceId).Distinct().Count());
            Assert.All(instances, instance => Assert.Matches("^[0-9a-f]{32}$", instance.InstanceId));
        }

        private static ArrInstance Instance(string url, string apiKey) => new()
        {
            Name = "Display name",
            Url = url,
            ApiKey = apiKey,
            Enabled = true,
        };
    }
}
