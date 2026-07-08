using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Controllers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Controllers
{
    /// <summary>
    /// Golden-snapshot tests that pin the EXACT payloads of
    /// GET /JellyfinElevate/public-config and GET /JellyfinElevate/private-config
    /// (key set AND values) as the behavioral contract for the settings-as-data refactor.
    ///
    /// Methodology:
    ///  - Payloads are built through the pure builder methods on <see cref="ConfigController"/>
    ///    (extracted verbatim from the endpoint bodies) for (a) a default-constructed
    ///    <see cref="PluginConfiguration"/> and (b) a "distinctive" configuration where every
    ///    writable string/int/long property is set to a unique non-default value via reflection,
    ///    so a projection that reads the WRONG property (rename/copy-paste drift) produces a
    ///    visibly different value, not a coincidentally equal one.
    ///  - The public payload is snapshotted for both authenticated and anonymous callers because
    ///    the Seerr URL fields are redacted pre-login.
    ///  - JSON is canonicalized (object keys sorted recursively) before comparison, so property
    ///    ORDER may change freely (anonymous object -> dictionary) while key set and values are
    ///    enforced structurally.
    ///
    /// If one of these tests fails, fix the projection/descriptor — never the snapshot.
    /// Deliberate contract changes must regenerate snapshots in their own clearly-labeled
    /// commit: JE_UPDATE_GOLDEN=1 dotnet test --filter ConfigPayloadGoldenTests
    /// </summary>
    public class ConfigPayloadGoldenTests
    {
        private static readonly JsonSerializerOptions SerializerOptions = new()
        {
            // No naming policy: Jellyfin's server-wide MVC JSON options serialize property
            // names as-is (PascalCase), and the injected JS reads e.g. `pluginConfig.ToastDuration`.
            WriteIndented = true,
        };

        [Fact]
        public void PublicConfig_DefaultConfig_Authenticated_MatchesGolden()
        {
            var payload = ConfigController.BuildPublicConfigPayload(new PluginConfiguration(), isAuthed: true);
            AssertMatchesSnapshot("public-config.default.authenticated", payload);
        }

        [Fact]
        public void PublicConfig_DefaultConfig_Anonymous_MatchesGolden()
        {
            var payload = ConfigController.BuildPublicConfigPayload(new PluginConfiguration(), isAuthed: false);
            AssertMatchesSnapshot("public-config.default.anonymous", payload);
        }

        [Fact]
        public void PublicConfig_DistinctiveConfig_Authenticated_MatchesGolden()
        {
            var payload = ConfigController.BuildPublicConfigPayload(CreateDistinctiveConfig(), isAuthed: true);
            AssertMatchesSnapshot("public-config.distinctive.authenticated", payload);
        }

        [Fact]
        public void PublicConfig_DistinctiveConfig_Anonymous_MatchesGolden()
        {
            var payload = ConfigController.BuildPublicConfigPayload(CreateDistinctiveConfig(), isAuthed: false);
            AssertMatchesSnapshot("public-config.distinctive.anonymous", payload);
        }

        /// <summary>
        /// Pins the external-wins projection end-to-end through the REAL
        /// <c>JellyseerrBaseUrl</c> descriptor: a VALID external URL is emitted verbatim to
        /// authenticated callers (and the different internal URL is NOT). The distinctive golden
        /// only covers the fallback branch — its external URL is an invalid "cfg-…" sentinel — so
        /// this is the only assertion that the valid-external path actually reaches the payload.
        /// </summary>
        [Fact]
        public void PublicConfig_ValidExternalUrl_ProjectsExternalAsJellyseerrBaseUrl()
        {
            var config = new PluginConfiguration
            {
                JellyseerrUrls = "http://seerr.internal:5055",
                JellyseerrExternalUrl = "https://requests.example.com/seerr",
            };

            var payload = ConfigController.BuildPublicConfigPayload(config, isAuthed: true);

            Assert.Equal("https://requests.example.com/seerr", GetStringField(payload, "JellyseerrBaseUrl"));
        }

        /// <summary>
        /// The fallback branch: with no external URL, the authenticated
        /// <c>JellyseerrBaseUrl</c> is the first internal URL unchanged.
        /// </summary>
        [Fact]
        public void PublicConfig_EmptyExternalUrl_FallsBackToInternalJellyseerrBaseUrl()
        {
            var config = new PluginConfiguration
            {
                JellyseerrUrls = "http://seerr.internal:5055",
                JellyseerrExternalUrl = string.Empty,
            };

            var payload = ConfigController.BuildPublicConfigPayload(config, isAuthed: true);

            Assert.Equal("http://seerr.internal:5055", GetStringField(payload, "JellyseerrBaseUrl"));
        }

        [Fact]
        public void PrivateConfig_DefaultConfig_MatchesGolden()
        {
            var payload = ConfigController.BuildPrivateConfigPayload(new PluginConfiguration());
            AssertMatchesSnapshot("private-config.default", payload);
        }

        [Fact]
        public void PrivateConfig_DistinctiveConfig_MatchesGolden()
        {
            var payload = ConfigController.BuildPrivateConfigPayload(CreateDistinctiveConfig());
            AssertMatchesSnapshot("private-config.distinctive", payload);
        }

        /// <summary>
        /// Pins the nested instance projection {Name, Url, UrlMappings, Enabled} for valid
        /// multi-instance JSON. The stored instances carry API keys, so this snapshot is also
        /// the proof that ApiKey never leaks into the private-config payload.
        /// </summary>
        [Fact]
        public void PrivateConfig_WithParsedArrInstances_MatchesGolden()
        {
            var config = new PluginConfiguration
            {
                SonarrInstances = """
                    [
                      {"Name":"Sonarr Main","Url":"http://sonarr:8989","ExternalUrl":"https://sonarr.example.com","ApiKey":"sonarr-secret","UrlMappings":"internal=external","Enabled":true},
                      {"Name":"Sonarr 4K","Url":"http://sonarr-4k:8989","ApiKey":"sonarr-4k-secret","UrlMappings":"","Enabled":false}
                    ]
                    """,
                RadarrInstances = """
                    [
                      {"Name":"Radarr Main","Url":"http://radarr:7878","ApiKey":"radarr-secret","UrlMappings":"","Enabled":true}
                    ]
                    """,
            };

            var payload = ConfigController.BuildPrivateConfigPayload(config);
            AssertMatchesSnapshot("private-config.parsed-instances", payload);
        }

        /// <summary>
        /// Every writable string property becomes "cfg-{PropertyName}", every int/long a
        /// unique number, and every bool the NEGATION of its default, assigned in ordinal
        /// property-name order so the values are stable across runs and machines. Side effects
        /// worth knowing when reading the snapshots:
        ///  - TMDB_API_KEY becomes non-empty, so TmdbEnabled flips to true (computed field).
        ///  - JellyseerrUrls becomes a single non-URL line, which is what JellyseerrBaseUrl
        ///    echoes back for authenticated callers (first-line extraction).
        ///  - SonarrInstances/RadarrInstances become unparseable JSON, which pins the
        ///    corruption behavior: empty instance lists + *InstancesCorrupt = true.
        /// Flipping every bool to !default makes a wrong-bool projection whose two properties
        /// have DIFFERENT defaults visibly diverge in the snapshot; the same-default case
        /// (both false→both true) is caught by BoolProjectionGuardTests, which isolates each
        /// descriptor→property binding.
        /// </summary>
        private static PluginConfiguration CreateDistinctiveConfig()
        {
            var config = new PluginConfiguration();
            var defaults = new PluginConfiguration();
            var properties = typeof(PluginConfiguration)
                .GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Where(p => p.CanWrite)
                .OrderBy(p => p.Name, StringComparer.Ordinal)
                .ToList();

            for (var i = 0; i < properties.Count; i++)
            {
                var property = properties[i];
                if (property.PropertyType == typeof(string))
                {
                    property.SetValue(config, $"cfg-{property.Name}");
                }
                else if (property.PropertyType == typeof(int))
                {
                    property.SetValue(config, 1000 + i);
                }
                else if (property.PropertyType == typeof(long))
                {
                    property.SetValue(config, 5_000_000L + i);
                }
                else if (property.PropertyType == typeof(bool))
                {
                    property.SetValue(config, !(bool)property.GetValue(defaults)!);
                }
            }

            return config;
        }

        /// <summary>Reads a single top-level string field from a built payload via the same
        /// serializer the golden snapshots use, so the assertion sees exactly the emitted value.</summary>
        private static string? GetStringField(object payload, string field)
        {
            var node = JsonSerializer.SerializeToNode(payload, SerializerOptions);
            return node?[field]?.GetValue<string>();
        }

        private static void AssertMatchesSnapshot(string name, object payload)
        {
            var actualNode = SortNode(JsonSerializer.SerializeToNode(payload, SerializerOptions));
            var actualJson = actualNode!.ToJsonString(SerializerOptions);

            if (Environment.GetEnvironmentVariable("JE_UPDATE_GOLDEN") == "1")
            {
                Directory.CreateDirectory(SourceSnapshotDirectory());
                File.WriteAllText(Path.Combine(SourceSnapshotDirectory(), name + ".json"), actualJson + "\n");
                return;
            }

            var snapshotPath = Path.Combine(AppContext.BaseDirectory, "Snapshots", name + ".json");
            Assert.True(
                File.Exists(snapshotPath),
                $"Missing golden snapshot {name}.json. Run once with JE_UPDATE_GOLDEN=1 to generate it, review, and commit.");

            var expectedNode = JsonNode.Parse(File.ReadAllText(snapshotPath));
            var differences = new List<string>();
            Diff("$", SortNode(expectedNode), actualNode, differences);

            Assert.True(
                differences.Count == 0,
                $"Payload for {name} diverged from the golden snapshot — fix the projection/descriptor, never the snapshot:\n  "
                + string.Join("\n  ", differences));
        }

        /// <summary>Recursively sorts object keys so comparison and snapshots are order-independent.</summary>
        private static JsonNode? SortNode(JsonNode? node) => node switch
        {
            JsonObject obj => new JsonObject(obj
                .OrderBy(kv => kv.Key, StringComparer.Ordinal)
                .Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, SortNode(kv.Value)))),
            JsonArray array => new JsonArray(array.Select(SortNode).ToArray()),
            _ => node?.DeepClone(),
        };

        /// <summary>Structural diff: missing keys, unexpected keys and value mismatches with JSON paths.</summary>
        private static void Diff(string path, JsonNode? expected, JsonNode? actual, List<string> differences)
        {
            if (expected is JsonObject expectedObject && actual is JsonObject actualObject)
            {
                foreach (var kv in expectedObject)
                {
                    if (!actualObject.ContainsKey(kv.Key))
                    {
                        differences.Add($"{path}.{kv.Key}: missing from actual payload");
                    }
                }

                foreach (var kv in actualObject)
                {
                    if (!expectedObject.ContainsKey(kv.Key))
                    {
                        differences.Add($"{path}.{kv.Key}: unexpected key in actual payload");
                    }
                    else
                    {
                        Diff($"{path}.{kv.Key}", expectedObject[kv.Key], kv.Value, differences);
                    }
                }

                return;
            }

            if (expected is JsonArray expectedArray && actual is JsonArray actualArray)
            {
                if (expectedArray.Count != actualArray.Count)
                {
                    differences.Add($"{path}: array length expected {expectedArray.Count}, got {actualArray.Count}");
                    return;
                }

                for (var i = 0; i < expectedArray.Count; i++)
                {
                    Diff($"{path}[{i}]", expectedArray[i], actualArray[i], differences);
                }

                return;
            }

            var expectedJson = expected?.ToJsonString() ?? "null";
            var actualJson = actual?.ToJsonString() ?? "null";
            if (expectedJson != actualJson)
            {
                differences.Add($"{path}: expected {expectedJson}, got {actualJson}");
            }
        }

        private static string SourceSnapshotDirectory([CallerFilePath] string sourceFile = "")
            => Path.GetFullPath(Path.Combine(Path.GetDirectoryName(sourceFile)!, "..", "Snapshots"));
    }
}
