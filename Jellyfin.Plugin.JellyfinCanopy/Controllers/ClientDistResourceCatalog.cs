using System;
using System.Collections.Frozen;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    internal enum ClientDistResolutionStatus
    {
        Invalid,
        StaleGeneration,
        Unknown,
        Found,
    }

    internal readonly record struct ClientDistResolution(
        ClientDistResolutionStatus Status,
        bool IsGenerationScoped,
        ClientDistResource? Resource);

    internal sealed class ClientDistResource
    {
        public ClientDistResource(
            string path,
            byte[] content,
            string contentType,
            string sha256,
            bool isManifest)
        {
            Path = path;
            Content = content;
            ContentType = contentType;
            Sha256 = sha256;
            ETag = $"\"sha256-{sha256}\"";
            IsManifest = isManifest;
        }

        public string Path { get; }

        public byte[] Content { get; }

        public string ContentType { get; }

        public string Sha256 { get; }

        public string ETag { get; }

        public bool IsManifest { get; }
    }

    /// <summary>
    /// Immutable, manifest-allowlisted catalog for generated client assets. The
    /// manifest and every listed byte sequence are embedded in the same plugin
    /// assembly. Startup rejects inventory drift, unsafe paths, MIME drift, and
    /// digest/length mismatches before any asset can be served.
    /// </summary>
    internal sealed class ClientDistResourceCatalog
    {
        internal const string ManifestPath = "client-manifest.json";
        internal const string JavaScriptContentType = "text/javascript; charset=utf-8";
        internal const string JsonContentType = "application/json; charset=utf-8";

        private const string ResourcePrefix =
            "Jellyfin.Plugin.JellyfinCanopy.dist.";
        private const string ManifestResource =
            ResourcePrefix + "client-manifest.json";
        private const int MaximumManifestBytes = 1024 * 1024;
        private const int MaximumFiles = 512;
        private const int MaximumEntries = 128;
        private const int MaximumPathLength = 256;
        private const int MaximumPathSegments = 12;
        private const int MaximumRequestPathLength = MaximumPathLength + 80;
        private const int MaximumRequestPathSegments = MaximumPathSegments + 3;
        private const int MaximumFileBytes = 32 * 1024 * 1024;
        private const long MaximumTotalBytes = 128L * 1024 * 1024;

        private readonly FrozenDictionary<string, ClientDistResource> _resources;

        private ClientDistResourceCatalog(
            string buildId,
            FrozenDictionary<string, ClientDistResource> resources)
        {
            BuildId = buildId;
            _resources = resources;
        }

        public string BuildId { get; }

        public IReadOnlyCollection<string> Paths => _resources.Keys;

        public static ClientDistResourceCatalog Load(Assembly assembly)
        {
            ArgumentNullException.ThrowIfNull(assembly);

            byte[] manifestBytes;
            using (var manifestStream = assembly.GetManifestResourceStream(ManifestResource)
                ?? throw new InvalidOperationException(
                    $"Embedded client manifest is missing: {ManifestResource}"))
            {
                manifestBytes = ReadBounded(
                    manifestStream,
                    MaximumManifestBytes,
                    "Embedded client manifest has invalid size");
            }

            var manifest = ParseManifest(manifestBytes);
            var expectedNames = new Dictionary<string, string>(
                manifest.Files!.Count + 1,
                StringComparer.Ordinal)
            {
                [ManifestPath] = ManifestResource,
            };
            var logicalNames = new HashSet<string>(StringComparer.Ordinal)
            {
                ManifestResource,
            };
            foreach (var path in manifest.Files.Keys)
            {
                var logicalName = ResourcePrefix + path.Replace('/', '.');
                if (!logicalNames.Add(logicalName))
                {
                    throw new InvalidOperationException(
                        "Embedded client paths collide after resource-name normalization");
                }

                expectedNames[path] = logicalName;
            }

            var embeddedNames = assembly.GetManifestResourceNames()
                .Where(static name => name.StartsWith(ResourcePrefix, StringComparison.Ordinal))
                .ToHashSet(StringComparer.Ordinal);
            if (!logicalNames.SetEquals(embeddedNames))
            {
                throw new InvalidOperationException(
                    "Embedded client resources do not match the generated manifest inventory");
            }

            var resources = new Dictionary<string, byte[]>(
                expectedNames.Count,
                StringComparer.Ordinal)
            {
                [ManifestPath] = manifestBytes,
            };
            foreach (var pair in expectedNames)
            {
                if (pair.Key == ManifestPath)
                {
                    continue;
                }

                var descriptor = manifest.Files[pair.Key];
                using var stream = assembly.GetManifestResourceStream(pair.Value)
                    ?? throw new InvalidOperationException(
                        $"Manifest-listed client resource is missing: {pair.Key}");
                if (stream.Length != descriptor.Bytes)
                {
                    throw new InvalidOperationException(
                        $"Embedded client resource length differs from manifest: {pair.Key}");
                }

                resources[pair.Key] = ReadBounded(
                    stream,
                    MaximumFileBytes,
                    $"Embedded client resource has invalid size: {pair.Key}");
            }

            return Create(manifestBytes, resources);
        }

        internal static ClientDistResourceCatalog Create(
            byte[] manifestBytes,
            IReadOnlyDictionary<string, byte[]> resources)
        {
            ArgumentNullException.ThrowIfNull(manifestBytes);
            ArgumentNullException.ThrowIfNull(resources);
            if (manifestBytes.Length is <= 0 or > MaximumManifestBytes)
            {
                throw new InvalidOperationException(
                    "Embedded client manifest has invalid size");
            }

            var manifest = ParseManifest(manifestBytes);
            var expectedPaths = manifest.Files!.Keys
                .Append(ManifestPath)
                .ToHashSet(StringComparer.Ordinal);
            if (!expectedPaths.SetEquals(resources.Keys))
            {
                throw new InvalidOperationException(
                    "Embedded client resources do not match the generated manifest inventory");
            }

            long totalBytes = manifestBytes.Length;
            var catalog = new Dictionary<string, ClientDistResource>(
                expectedPaths.Count,
                StringComparer.Ordinal);
            var manifestSha = Convert.ToHexString(
                SHA256.HashData(manifestBytes)).ToLowerInvariant();
            catalog.Add(
                ManifestPath,
                new ClientDistResource(
                    ManifestPath,
                    manifestBytes,
                    JsonContentType,
                    manifestSha,
                    isManifest: true));

            foreach (var pair in manifest.Files)
            {
                var descriptor = pair.Value;
                var bytes = resources[pair.Key]
                    ?? throw new InvalidOperationException(
                        $"Manifest-listed client resource is null: {pair.Key}");
                if (bytes.Length is <= 0 or > MaximumFileBytes
                    || bytes.Length != descriptor.Bytes)
                {
                    throw new InvalidOperationException(
                        $"Embedded client resource length differs from manifest: {pair.Key}");
                }

                totalBytes += bytes.Length;
                if (totalBytes > MaximumTotalBytes)
                {
                    throw new InvalidOperationException(
                        "Embedded client resources exceed the aggregate size limit");
                }

                var sha256 = Convert.ToHexString(
                    SHA256.HashData(bytes)).ToLowerInvariant();
                if (!string.Equals(
                    sha256,
                    descriptor.Sha256,
                    StringComparison.Ordinal))
                {
                    throw new InvalidOperationException(
                        $"Embedded client resource digest differs from manifest: {pair.Key}");
                }

                catalog.Add(
                    pair.Key,
                    new ClientDistResource(
                        pair.Key,
                        bytes,
                        descriptor.ContentType!,
                        sha256,
                        isManifest: false));
            }

            return new ClientDistResourceCatalog(
                manifest.BuildId!,
                catalog.ToFrozenDictionary(StringComparer.Ordinal));
        }

        public ClientDistResolution Resolve(string? requestPath)
        {
            if (!TryValidatePath(
                requestPath,
                allowManifest: true,
                out var safePath,
                MaximumRequestPathLength,
                MaximumRequestPathSegments))
            {
                return new ClientDistResolution(
                    ClientDistResolutionStatus.Invalid,
                    false,
                    null);
            }

            var segments = safePath.Split('/');
            var firstSegment = segments[0];
            var generationScoped = IsLowerHexSha256(firstSegment);
            if (generationScoped)
            {
                if (!string.Equals(firstSegment, BuildId, StringComparison.Ordinal))
                {
                    return new ClientDistResolution(
                        ClientDistResolutionStatus.StaleGeneration,
                        true,
                        null);
                }

                // The attempt belongs in the path rather than the query so
                // native static and dynamic relative imports inherit one
                // cache identity for the complete module graph.
                if (segments.Length < 4
                    || !string.Equals(segments[1], "attempts", StringComparison.Ordinal)
                    || segments[2] is not ("0" or "1" or "2"))
                {
                    return new ClientDistResolution(
                        ClientDistResolutionStatus.Invalid,
                        true,
                        null);
                }

                safePath = string.Join('/', segments.Skip(3));
                if (string.Equals(safePath, ManifestPath, StringComparison.Ordinal))
                {
                    return new ClientDistResolution(
                        ClientDistResolutionStatus.Unknown,
                        true,
                        null);
                }
            }

            if (!_resources.TryGetValue(safePath, out var resource))
            {
                return new ClientDistResolution(
                    ClientDistResolutionStatus.Unknown,
                    generationScoped,
                    null);
            }

            return new ClientDistResolution(
                ClientDistResolutionStatus.Found,
                generationScoped,
                resource);
        }

        private static ClientManifest ParseManifest(byte[] bytes)
        {
            ClientManifest manifest;
            try
            {
                manifest = JsonSerializer.Deserialize<ClientManifest>(bytes)
                    ?? throw new InvalidOperationException(
                        "Embedded client manifest is empty");
            }
            catch (JsonException ex)
            {
                throw new InvalidOperationException(
                    "Embedded client manifest is invalid JSON",
                    ex);
            }

            if (manifest.SchemaVersion != 2
                || !IsLowerHexSha256(manifest.BuildId)
                || manifest.Files == null
                || manifest.Files.Count == 0
                || manifest.Files.Count > MaximumFiles
                || manifest.Entries == null
                || manifest.Entries.Count == 0
                || manifest.Entries.Count > MaximumEntries)
            {
                throw new InvalidOperationException(
                    "Embedded client manifest has an unsupported schema or invalid bounds");
            }

            var normalizedResourceNames = new HashSet<string>(StringComparer.Ordinal);
            foreach (var pair in manifest.Files)
            {
                if (!TryValidatePath(pair.Key, allowManifest: false, out var path)
                    || !string.Equals(path, pair.Key, StringComparison.Ordinal)
                    || pair.Value == null
                    || pair.Value.Bytes is <= 0 or > MaximumFileBytes
                    || pair.Value.GzipBytes is <= 0 or > MaximumFileBytes
                    || !IsLowerHexSha256(pair.Value.Sha256))
                {
                    throw new InvalidOperationException(
                        $"Embedded client manifest contains an invalid file: {pair.Key}");
                }

                var expectedContentType = ContentTypeFor(path);
                if (expectedContentType == null
                    || !string.Equals(
                        expectedContentType,
                        pair.Value.ContentType,
                        StringComparison.Ordinal)
                    || !IsValidFileKind(path, pair.Value.Kind)
                    || (pair.Value.EntryPoint != null
                        && (pair.Value.EntryPoint.Length == 0
                            || pair.Value.EntryPoint.Length > MaximumPathLength
                            || pair.Value.EntryPoint.Contains('\\')
                            || pair.Value.EntryPoint.Contains("..", StringComparison.Ordinal))))
                {
                    throw new InvalidOperationException(
                        $"Embedded client manifest has invalid MIME metadata: {pair.Key}");
                }

                if (!normalizedResourceNames.Add(pair.Key.Replace('/', '.')))
                {
                    throw new InvalidOperationException(
                        "Embedded client paths collide after resource-name normalization");
                }

                ValidateReferences(pair.Value.Imports, manifest.Files, pair.Key);
                ValidateReferences(pair.Value.DynamicImports, manifest.Files, pair.Key);
            }

            foreach (var pair in manifest.Entries)
            {
                if (!IsSafeEntryName(pair.Key)
                    || pair.Value == null
                    || !IsValidEntryContract(pair.Value.Role, pair.Value.Kind)
                    || !TryValidatePath(pair.Value.Path, allowManifest: false, out var entryPath)
                    || !manifest.Files.TryGetValue(entryPath, out var entryFile)
                    || !EntryMatchesFileKind(pair.Value.Role!, entryFile.Kind))
                {
                    throw new InvalidOperationException(
                        $"Embedded client manifest contains an invalid entry: {pair.Key}");
                }
            }

            return manifest;
        }

        private static void ValidateReferences(
            string[]? references,
            IReadOnlyDictionary<string, ClientManifestFile> files,
            string owner)
        {
            if (references == null || references.Length > MaximumFiles)
            {
                throw new InvalidOperationException(
                    $"Embedded client manifest has invalid imports: {owner}");
            }

            var unique = new HashSet<string>(StringComparer.Ordinal);
            foreach (var reference in references)
            {
                if (!TryValidatePath(reference, allowManifest: false, out var path)
                    || !string.Equals(path, reference, StringComparison.Ordinal)
                    || !files.ContainsKey(path)
                    || !unique.Add(path))
                {
                    throw new InvalidOperationException(
                        $"Embedded client manifest has invalid imports: {owner}");
                }
            }
        }

        private static string? ContentTypeFor(string path)
        {
            if (path.EndsWith(".js", StringComparison.Ordinal))
            {
                return JavaScriptContentType;
            }

            if (path.EndsWith(".js.map", StringComparison.Ordinal)
                || path.EndsWith(".json", StringComparison.Ordinal))
            {
                return JsonContentType;
            }

            return null;
        }

        private static bool TryValidatePath(
            string? path,
            bool allowManifest,
            out string safePath,
            int maximumLength = MaximumPathLength,
            int maximumSegments = MaximumPathSegments)
        {
            safePath = string.Empty;
            if (string.IsNullOrEmpty(path)
                || path.Length > maximumLength
                || path[0] == '/'
                || path[^1] == '/'
                || path.Contains('\\')
                || path.Contains('%')
                || path.Contains('?')
                || path.Contains('#'))
            {
                return false;
            }

            var segments = path.Split('/');
            if (segments.Length > maximumSegments)
            {
                return false;
            }

            foreach (var segment in segments)
            {
                if (segment.Length == 0
                    || segment is "." or ".."
                    || segment.Any(static character =>
                        !(character is >= 'a' and <= 'z')
                        && !(character is >= 'A' and <= 'Z')
                        && !(character is >= '0' and <= '9')
                        && character is not '.' and not '-' and not '_'))
                {
                    return false;
                }
            }

            if (!allowManifest
                && string.Equals(path, ManifestPath, StringComparison.Ordinal))
            {
                return false;
            }

            safePath = path;
            return true;
        }

        private static bool IsSafeEntryName(string? name)
            => !string.IsNullOrEmpty(name)
                && name.Length <= 64
                && name.All(static character =>
                    character is >= 'a' and <= 'z'
                    || character is >= '0' and <= '9'
                    || character is '-' or '_');

        private static bool IsValidFileKind(string path, string? kind)
        {
            if (path.EndsWith(".map", StringComparison.Ordinal))
            {
                return string.Equals(kind, "source-map", StringComparison.Ordinal);
            }

            if (path.StartsWith("chunks/", StringComparison.Ordinal))
            {
                return string.Equals(kind, "chunk", StringComparison.Ordinal);
            }

            if (path.StartsWith("entries/", StringComparison.Ordinal))
            {
                return string.Equals(kind, "module-entry", StringComparison.Ordinal);
            }

            return kind == "bootstrap-entry";
        }

        private static bool IsValidEntryContract(string? role, string? kind)
            => role switch
            {
                "bootstrap" => kind == "classic",
                "boot" or "feature" => kind == "module",
                _ => false,
            };

        private static bool EntryMatchesFileKind(string role, string? fileKind)
            => role switch
            {
                "bootstrap" => fileKind == "bootstrap-entry",
                "boot" or "feature" => fileKind == "module-entry",
                _ => false,
            };

        private static bool IsLowerHexSha256(string? value)
            => value?.Length == 64
                && value.All(static character =>
                    character is >= '0' and <= '9'
                    || character is >= 'a' and <= 'f');

        private static byte[] ReadBounded(
            Stream stream,
            int maximumBytes,
            string error)
        {
            if (stream.Length is <= 0 || stream.Length > maximumBytes)
            {
                throw new InvalidOperationException(error);
            }

            using var memory = new MemoryStream((int)stream.Length);
            stream.CopyTo(memory);
            if (memory.Length != stream.Length)
            {
                throw new InvalidOperationException(error);
            }

            return memory.ToArray();
        }

        private sealed class ClientManifest
        {
            [JsonPropertyName("schemaVersion")]
            public int SchemaVersion { get; set; }

            [JsonPropertyName("buildId")]
            public string? BuildId { get; set; }

            [JsonPropertyName("entries")]
            public Dictionary<string, ClientManifestEntry>? Entries { get; set; }

            [JsonPropertyName("files")]
            public Dictionary<string, ClientManifestFile>? Files { get; set; }
        }

        private sealed class ClientManifestEntry
        {
            [JsonPropertyName("role")]
            public string? Role { get; set; }

            [JsonPropertyName("kind")]
            public string? Kind { get; set; }

            [JsonPropertyName("path")]
            public string? Path { get; set; }
        }

        private sealed class ClientManifestFile
        {
            [JsonPropertyName("bytes")]
            public int Bytes { get; set; }

            [JsonPropertyName("gzipBytes")]
            public int GzipBytes { get; set; }

            [JsonPropertyName("sha256")]
            public string? Sha256 { get; set; }

            [JsonPropertyName("contentType")]
            public string? ContentType { get; set; }

            [JsonPropertyName("kind")]
            public string? Kind { get; set; }

            [JsonPropertyName("entryPoint")]
            public string? EntryPoint { get; set; }

            [JsonPropertyName("imports")]
            public string[]? Imports { get; set; }

            [JsonPropertyName("dynamicImports")]
            public string[]? DynamicImports { get; set; }
        }
    }
}
