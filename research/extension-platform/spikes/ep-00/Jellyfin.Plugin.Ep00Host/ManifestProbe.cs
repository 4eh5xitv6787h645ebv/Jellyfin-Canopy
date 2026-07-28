using System.Text.Json;
using MediaBrowser.Common.Plugins;

namespace Jellyfin.Plugin.Ep00Host;

/// <summary>
/// EP-00 spike of EP-03 manifest discovery: a manifest is only ever read from the
/// root Jellyfin itself reports for an installed plugin, and only after the resolved
/// path is proven to stay inside that root.
/// </summary>
public sealed class ManifestProbe
{
    public const string ManifestFileName = "jellyfin-canopy-extension.json";

    /// <summary>Manifests are third-party input; cap them before reading.</summary>
    public const int MaximumManifestBytes = 256 * 1024;

    /// <summary>Bounds the link-resolution loop so a pathological chain cannot spin.</summary>
    private const int MaximumLinkResolutionPasses = 40;

    /// <summary>
    /// Where the traversal fixtures live — deliberately OUTSIDE every plugin
    /// directory. Jellyfin walks plugin roots looking for assemblies, and a link to
    /// "/" inside one prevents the server from starting at all. The containment
    /// function takes its root as a parameter, so exercising it against a controlled
    /// directory tests exactly the same code path.
    /// </summary>
    private const string LinkFixtureRoot = "/config/ep00-linktests";

    private static readonly Guid HostPluginId = new("a0b1c2d3-e4f5-4061-8273-8495a6b7c8d9");

    private readonly IPluginManager _pluginManager;

    public ManifestProbe(IPluginManager pluginManager)
    {
        _pluginManager = pluginManager;
    }

    public IReadOnlyList<Dictionary<string, object?>> Discover()
    {
        var results = new List<Dictionary<string, object?>>();
        foreach (var plugin in _pluginManager.Plugins)
        {
            var entry = new Dictionary<string, object?>
            {
                ["plugin"] = plugin.Name,
                ["pluginId"] = plugin.Id.ToString("N"),
                ["pluginVersion"] = plugin.Version?.ToString(),
                ["status"] = plugin.Manifest.Status.ToString(),
                ["root"] = plugin.Path,
            };

            var outcome = TryRead(plugin.Path, ManifestFileName, out var manifestJson, out var reason);
            entry["manifestFound"] = outcome;
            entry["reason"] = reason;

            if (outcome && manifestJson is not null)
            {
                entry["registered"] = false;
                try
                {
                    using var doc = JsonDocument.Parse(manifestJson);
                    if (doc.RootElement.ValueKind != JsonValueKind.Object)
                    {
                        entry["rejected"] = "manifest_not_an_object";
                        results.Add(entry);
                        continue;
                    }

                    var root = doc.RootElement;
                    entry["manifestId"] = root.TryGetProperty("id", out var id) ? id.GetString() : null;
                    entry["manifestVersion"] = root.TryGetProperty("version", out var v) ? v.GetString() : null;
                    var declaredPluginId = root.TryGetProperty("pluginId", out var pid) ? pid.GetString() : null;
                    entry["declaredPluginId"] = declaredPluginId;

                    // Fingerprint binding: the manifest's self-declared plugin identity
                    // must match what Jellyfin reports. A manifest claiming another
                    // plugin's identity is REJECTED, not merely flagged — otherwise the
                    // check is a report field and the registry trusts it anyway.
                    var bound = declaredPluginId is not null && string.Equals(
                        declaredPluginId.Replace("-", string.Empty, StringComparison.Ordinal),
                        plugin.Id.ToString("N"),
                        StringComparison.OrdinalIgnoreCase);
                    entry["fingerprintBound"] = bound;
                    if (!bound)
                    {
                        entry["rejected"] = "fingerprint_mismatch";
                        results.Add(entry);
                        continue;
                    }

                    entry["registered"] = true;
                }
                catch (JsonException ex)
                {
                    entry["rejected"] = "manifest_malformed";
                    entry["manifestParseError"] = ex.Message;
                }
            }

            results.Add(entry);
        }

        return results;
    }

    /// <summary>Traversal probe: the same reader fed hostile relative names.</summary>
    public IReadOnlyList<Dictionary<string, object?>> ProbeTraversal()
    {
        var candidates = new[]
        {
            ManifestFileName,
            "../" + ManifestFileName,
            "../../../../../../etc/passwd",
            "..\\..\\..\\etc\\passwd",
            "subdir/../../escape.json",
            "/etc/passwd",
            "manifest.json\0/etc/passwd",
            // These require the runner to have created, inside the host plugin root:
            //   escape-dir  -> /etc          (symlinked DIRECTORY component)
            //   escape-file -> /etc/hostname (symlinked leaf)
            //   inside-file -> ./meta.json   (symlink that stays inside the root)
            "escape-dir/passwd",
            "escape-file",
            "inside-file",
            // Two-hop chain: hop-root -> /etc and hop-etc -> <root>/hop-root/ssl.
            // A single resolution pass leaves the components introduced by the first
            // target unresolved, so this escapes unless resolution runs to a fixed point.
            "hop-etc/openssl.cnf",
            // A symlink loop: passes File.Exists and the size cap, and only fails on read.
            "cycle",
            // Shapes that look harmless and are worth pinning behaviour on.
            "./inside.json",
            "sub/./../inside.json",
            "inside.json/",
            "inside.json/.",
            ".",
            "..",
            "   ",
            new string('a', 5000),
            // Unicode: a decomposed form that normalises to a different byte sequence
            // than the composed one. Filesystems differ on whether these are the same
            // name; the containment decision must not depend on that.
            // A named pipe: open(2) blocks on it until a writer appears.
            "fifo",
            "caf\u00e9.json",
            "cafe\u0301.json",
        };

        var root = Directory.Exists(LinkFixtureRoot)
            ? LinkFixtureRoot
            : _pluginManager.Plugins.FirstOrDefault(p => p.Id == HostPluginId)?.Path ?? AppContext.BaseDirectory;

        var results = new List<Dictionary<string, object?>>
        {
            new() { ["candidate"] = "(fixture root in use)", ["accepted"] = Directory.Exists(LinkFixtureRoot), ["reason"] = root },
        };
        foreach (var candidate in candidates)
        {
            var accepted = TryRead(root, candidate, out _, out var reason);
            results.Add(new Dictionary<string, object?>
            {
                ["candidate"] = candidate,
                ["accepted"] = accepted,
                ["reason"] = reason,
            });
        }

        return results;
    }

    /// <summary>
    /// The only sanctioned manifest read. Delegates to <see cref="PathContainment"/>
    /// so the containment decision has exactly one implementation, which EP-03
    /// inherits rather than re-derives.
    /// </summary>
    private static bool TryRead(string? root, string relativeName, out string? json, out string reason)
    {
        json = PathContainment.ReadContained(root, relativeName, MaximumManifestBytes, out reason);
        return json is not null;
    }
}
