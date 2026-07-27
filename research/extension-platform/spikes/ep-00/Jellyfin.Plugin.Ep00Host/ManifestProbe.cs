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
                try
                {
                    using var doc = JsonDocument.Parse(manifestJson);
                    var root = doc.RootElement;
                    entry["manifestId"] = root.TryGetProperty("id", out var id) ? id.GetString() : null;
                    entry["manifestVersion"] = root.TryGetProperty("version", out var v) ? v.GetString() : null;
                    var declaredPluginId = root.TryGetProperty("pluginId", out var pid) ? pid.GetString() : null;
                    entry["declaredPluginId"] = declaredPluginId;

                    // Fingerprint binding: the manifest's self-declared plugin identity must
                    // match what Jellyfin reports, otherwise the manifest is untrusted input
                    // claiming to be someone else.
                    entry["fingerprintBound"] = string.Equals(
                        declaredPluginId?.Replace("-", string.Empty, StringComparison.Ordinal),
                        plugin.Id.ToString("N"),
                        StringComparison.OrdinalIgnoreCase);
                }
                catch (JsonException ex)
                {
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
        };

        var host = _pluginManager.Plugins.FirstOrDefault(p => p.Id == new Guid("a0b1c2d3-e4f5-4061-8273-8495a6b7c8d9"));
        var root = host?.Path ?? AppContext.BaseDirectory;

        var results = new List<Dictionary<string, object?>>();
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
    /// The only sanctioned manifest read. Rejects anything that does not resolve to a
    /// regular file physically inside <paramref name="root"/>, symlinks included.
    /// </summary>
    private static bool TryRead(string? root, string relativeName, out string? json, out string reason)
    {
        json = null;

        if (string.IsNullOrWhiteSpace(root))
        {
            reason = "rejected: plugin has no root path";
            return false;
        }

        if (relativeName.Contains('\0', StringComparison.Ordinal))
        {
            reason = "rejected: embedded NUL in name";
            return false;
        }

        if (Path.IsPathRooted(relativeName))
        {
            reason = "rejected: absolute path";
            return false;
        }

        string canonicalRoot;
        string candidate;
        try
        {
            canonicalRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
            candidate = Path.GetFullPath(Path.Combine(canonicalRoot, relativeName));
        }
        catch (Exception ex)
        {
            reason = "rejected: unresolvable path (" + ex.GetType().Name + ")";
            return false;
        }

        if (!candidate.StartsWith(canonicalRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        {
            reason = "rejected: resolves outside plugin root";
            return false;
        }

        if (!File.Exists(candidate))
        {
            reason = "absent: no manifest at " + Path.GetRelativePath(canonicalRoot, candidate);
            return false;
        }

        var info = new FileInfo(candidate);
        if (info.LinkTarget is not null)
        {
            var linkTarget = Path.GetFullPath(info.LinkTarget, canonicalRoot);
            if (!linkTarget.StartsWith(canonicalRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            {
                reason = "rejected: symlink escaping plugin root";
                return false;
            }
        }

        if (info.Length > 256 * 1024)
        {
            reason = "rejected: manifest exceeds 256 KiB";
            return false;
        }

        json = File.ReadAllText(candidate);
        reason = "accepted";
        return true;
    }
}
