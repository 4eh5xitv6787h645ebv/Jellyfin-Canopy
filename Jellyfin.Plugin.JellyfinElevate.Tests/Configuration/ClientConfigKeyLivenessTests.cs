using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Configuration
{
    /// <summary>
    /// W2-TEST-2 — the CLIENT→SERVER liveness direction. The config suite only validated
    /// server→page; nothing checked that each <c>JE.pluginConfig.X</c> the TypeScript reads
    /// is actually PROJECTED to a client config endpoint. A dead client knob (XCUT-5:
    /// <c>pluginConfig.PeopleTagsCacheTtlDays</c>, neither a property nor a descriptor —
    /// always <c>undefined</c>) passed every test. This scans the shipped client source and
    /// asserts every read is backed by a real projected descriptor.
    ///
    /// The projected set is every descriptor whose exposure is NOT
    /// <see cref="SettingExposure.Neither"/>: <c>JE.pluginConfig</c> is public-config merged
    /// with private-config for admins (core/live-config.ts, facade.ts), so a Public OR
    /// Private descriptor is legitimately readable; only <c>Neither</c> (ServerOnlyUser)
    /// defaults are not — those reach the client through per-user settings.json, never
    /// through <c>pluginConfig</c>.
    /// </summary>
    public class ClientConfigKeyLivenessTests
    {
        private static readonly Regex MemberReadRegex =
            new(@"pluginConfig\s*\??\.\s*([A-Za-z_][A-Za-z0-9_]*)", RegexOptions.Compiled);

        private static readonly Regex DestructureRegex =
            new(@"(?:const|let|var)\s*\{([^}]*)\}\s*=\s*[^;{}]*pluginConfig", RegexOptions.Compiled);

        private static readonly Regex LineCommentRegex = new(@"//[^\n]*", RegexOptions.Compiled);
        private static readonly Regex BlockCommentRegex = new(@"/\*.*?\*/", RegexOptions.Compiled | RegexOptions.Singleline);

        /// <summary>
        /// Genuinely client-only pluginConfig reads with no server descriptor (each with a
        /// reason). Empty today — PeopleTagsCacheTtlDays (XCUT-5) was the only offender and is
        /// fixed. A new entry here must be justified, not a way to launder a dead knob.
        /// </summary>
        private static readonly Dictionary<string, string> KnownClientOnlyConfigKeys = new(StringComparer.Ordinal);

        private static HashSet<string> ProjectedDescriptorKeys()
            => SettingDescriptors.All
                .Where(d => d.Exposure != SettingExposure.Neither)
                .Select(d => d.Key)
                .ToHashSet(StringComparer.Ordinal);

        [Fact]
        public void EveryClientPluginConfigReadIsBackedByAProjectedDescriptor()
        {
            var projected = ProjectedDescriptorKeys();

            var reads = CollectClientPluginConfigReads();
            Assert.True(reads.Count > 30, $"the client-read scan looks broken — only found {reads.Count} keys");

            var orphans = reads
                .Where(kv => !projected.Contains(kv.Key) && !KnownClientOnlyConfigKeys.ContainsKey(kv.Key))
                .OrderBy(kv => kv.Key, StringComparer.Ordinal)
                .ToList();

            Assert.True(
                orphans.Count == 0,
                "JE.pluginConfig reads with no projected (Public/Private/Both) descriptor — the key is "
                + "always undefined on the client (the XCUT-5 class). Add a projecting descriptor in "
                + "SettingDescriptors.cs, point the read at the real key, or document a genuine client-only "
                + "read in KnownClientOnlyConfigKeys:\n  "
                + string.Join("\n  ", orphans.Select(o => $"{o.Key}  ({o.Value})")));
        }

        [Fact]
        public void KnownClientOnlyConfigKeys_AreNotAlsoProjected()
        {
            // A key that IS projected must not sit on the client-only exception list (it would
            // hide a future regression). Keeps the exception list honest.
            var projected = ProjectedDescriptorKeys();
            var redundant = KnownClientOnlyConfigKeys.Keys
                .Where(projected.Contains)
                .OrderBy(k => k, StringComparer.Ordinal)
                .ToList();
            Assert.True(redundant.Count == 0,
                $"KnownClientOnlyConfigKeys entries that ARE projected (remove them): {string.Join(", ", redundant)}");
        }

        [Fact]
        public void TypedPluginConfigKeys_AreProjectedDescriptors()
        {
            // src/types/je.ts's PluginConfig is a deliberate placeholder (an index signature
            // plus the handful of keys converted modules read). Whatever IS explicitly typed
            // there must be a real projected descriptor — a phantom typed key is as dead as a
            // phantom read. The index signature must remain so unlisted keys stay `unknown`.
            var (typedKeys, hasIndexSignature) = ParsePluginConfigInterface();

            Assert.True(hasIndexSignature,
                "src/types/je.ts PluginConfig lost its `[key: string]: unknown` index signature");
            Assert.NotEmpty(typedKeys);

            var projected = ProjectedDescriptorKeys();
            var phantom = typedKeys
                .Where(k => !projected.Contains(k))
                .OrderBy(k => k, StringComparer.Ordinal)
                .ToList();
            Assert.True(phantom.Count == 0,
                $"src/types/je.ts PluginConfig declares keys with no projected descriptor: {string.Join(", ", phantom)}");
        }

        private static Dictionary<string, string> CollectClientPluginConfigReads()
        {
            var reads = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var file in ClientSourceFiles())
            {
                var rel = Path.GetRelativePath(SrcRoot(), file).Replace('\\', '/');
                var text = StripComments(File.ReadAllText(file));

                foreach (Match m in MemberReadRegex.Matches(text))
                {
                    reads.TryAdd(m.Groups[1].Value, rel);
                }

                foreach (Match m in DestructureRegex.Matches(text))
                {
                    foreach (var part in m.Groups[1].Value.Split(','))
                    {
                        var name = part.Split(':', '=')[0].Trim();
                        if (Regex.IsMatch(name, "^[A-Za-z_][A-Za-z0-9_]*$"))
                        {
                            reads.TryAdd(name, rel);
                        }
                    }
                }
            }

            return reads;
        }

        private static (HashSet<string> Keys, bool HasIndexSignature) ParsePluginConfigInterface()
        {
            var text = File.ReadAllText(Path.Combine(SrcRoot(), "types", "je.ts"));
            var start = text.IndexOf("export interface PluginConfig {", StringComparison.Ordinal);
            Assert.True(start >= 0, "PluginConfig interface not found in src/types/je.ts");
            var bodyStart = text.IndexOf('{', start) + 1;
            var end = text.IndexOf('}', bodyStart);
            Assert.True(end > bodyStart, "PluginConfig interface body not terminated");
            var body = StripComments(text[bodyStart..end]);

            var hasIndex = body.Contains("[key: string]", StringComparison.Ordinal);
            var keys = Regex.Matches(body, @"([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:")
                .Select(m => m.Groups[1].Value)
                .Where(k => k != "key") // the index-signature parameter name
                .ToHashSet(StringComparer.Ordinal);
            return (keys, hasIndex);
        }

        private static string StripComments(string source)
            => LineCommentRegex.Replace(BlockCommentRegex.Replace(source, string.Empty), string.Empty);

        private static IEnumerable<string> ClientSourceFiles()
            => Directory.EnumerateFiles(SrcRoot(), "*.ts", SearchOption.AllDirectories)
                .Where(f =>
                {
                    var rel = Path.GetRelativePath(SrcRoot(), f).Replace('\\', '/');
                    return !rel.EndsWith(".test.ts", StringComparison.Ordinal)
                        && !rel.EndsWith(".d.ts", StringComparison.Ordinal)
                        && !rel.StartsWith("types/", StringComparison.Ordinal);
                });

        private static string SrcRoot([CallerFilePath] string sourceFile = "")
            => Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!,
                "..", "..", "Jellyfin.Plugin.JellyfinElevate", "src"));
    }
}
