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
    /// regular file physically inside <paramref name="root"/> — including a path whose
    /// *directory* components are symlinks, which a lexical check cannot see.
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

        // Normalise BOTH separators before any test. A backslash is a legal filename
        // character on Unix, so without this a Windows-style traversal is silently
        // treated as an ordinary (missing) filename and appears to be "rejected"
        // when in fact it was never evaluated.
        var normalised = relativeName.Replace('\\', Path.DirectorySeparatorChar).Replace('/', Path.DirectorySeparatorChar);

        if (Path.IsPathRooted(normalised))
        {
            reason = "rejected: absolute path";
            return false;
        }

        string canonicalRoot;
        string candidate;
        try
        {
            canonicalRoot = Path.TrimEndingDirectorySeparator(ResolveFinal(Path.GetFullPath(root)));
            candidate = Path.GetFullPath(Path.Combine(canonicalRoot, normalised));
        }
        catch (Exception ex)
        {
            reason = "rejected: unresolvable path (" + ex.GetType().Name + ")";
            return false;
        }

        if (!IsInside(candidate, canonicalRoot))
        {
            reason = "rejected: resolves outside plugin root";
            return false;
        }

        // Lexical containment is not enough: Path.GetFullPath does not follow links,
        // so `root/evil/passwd` where `root/evil -> /etc` passes the check above.
        // Re-test against the fully resolved path.
        string resolved;
        try
        {
            resolved = ResolveFinal(candidate);
        }
        catch (Exception ex)
        {
            reason = "rejected: unresolvable link target (" + ex.GetType().Name + ")";
            return false;
        }

        if (!IsInside(resolved, canonicalRoot))
        {
            reason = "rejected: symlink escapes plugin root";
            return false;
        }

        if (!File.Exists(resolved))
        {
            reason = "absent: no manifest at " + Path.GetRelativePath(canonicalRoot, candidate);
            return false;
        }

        var info = new FileInfo(resolved);
        if (info.Length > MaximumManifestBytes)
        {
            reason = "rejected: manifest exceeds " + (MaximumManifestBytes / 1024) + " KiB";
            return false;
        }

        json = File.ReadAllText(resolved);
        reason = "accepted";
        return true;
    }

    /// <summary>Resolves every symlink in <paramref name="path"/>, one component at a time.</summary>
    private static string ResolveFinal(string path)
    {
        // ResolveLinkTarget(returnFinalTarget: true) only follows a link at the leaf,
        // so walk the chain from the root down and resolve each component.
        var parts = path.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
        var current = Path.DirectorySeparatorChar.ToString();
        foreach (var part in parts)
        {
            current = Path.Combine(current, part);
            FileSystemInfo? target = null;
            try
            {
                target = Directory.Exists(current)
                    ? new DirectoryInfo(current).ResolveLinkTarget(true)
                    : new FileInfo(current).ResolveLinkTarget(true);
            }
            catch (IOException)
            {
                // Broken or cyclic link: leave the component unresolved. The
                // containment test below still runs against what we have.
            }

            if (target is not null)
            {
                current = Path.GetFullPath(target.FullName);
            }
        }

        return current;
    }

    private static bool IsInside(string candidate, string canonicalRoot) =>
        string.Equals(candidate, canonicalRoot, StringComparison.Ordinal)
        || candidate.StartsWith(canonicalRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal);
}
