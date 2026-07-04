using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>How a requested asset key was classified against the manifest.</summary>
    public enum AssetKind
    {
        /// <summary>Not in the manifest, not a valid family member, not a known derived asset.</summary>
        Unknown,

        /// <summary>An exact <see cref="AssetCacheManifest.StaticAssets"/> entry.</summary>
        Static,

        /// <summary>A validated member of an <see cref="AssetCacheManifest.Families"/> entry.</summary>
        Family,

        /// <summary>A url(...) reference extracted from a rewritten CSS entry (depth 1).</summary>
        Derived,

        /// <summary>Shipped inside the plugin DLL; never fetched.</summary>
        Embedded,
    }

    /// <summary>A classified asset request, carrying everything needed to fetch/serve it.</summary>
    internal sealed record ResolvedAsset(
        AssetKind Kind,
        string Key,
        string? UpstreamUrl,
        string ContentType,
        long MaxBytes,
        bool Rewrite = false,
        IReadOnlyList<string>? AllowedDerivedPrefixes = null,
        string? EmbeddedResourceName = null);

    /// <summary>A derived asset discovered while rewriting a CSS entry.</summary>
    internal sealed record DerivedAsset(string Key, string Url, string ContentType);

    /// <summary>Outcome counters for a full refresh run.</summary>
    internal sealed record AssetRefreshSummary(int Attempted, int Succeeded, int NotModified, int Failed);

    /// <summary>
    /// Manifest-driven local mirror of the third-party CDN assets the client scripts need
    /// (fonts, icon sets, flag images, theme CSS, data files). Browsers only ever talk to
    /// /JellyfinEnhanced/assets/* (AssetsController); this service populates and refreshes the
    /// on-disk cache server-side — on a ~24h schedule (RefreshCachedAssetsTask) plus an
    /// on-demand, per-key-locked fetch for first requests before the task has run.
    ///
    /// Safety properties:
    ///  - STRICT allowlist: only exact manifest URLs, validated family members, and
    ///    repo-prefix-checked derived CSS references are ever fetched (no arbitrary proxying);
    ///  - path-traversal-proof key handling (shape-validated keys + canonicalized paths that
    ///    must stay under the cache directory);
    ///  - per-file size caps, atomic temp-file+rename writes, last-good-kept on failure;
    ///  - conditional GETs (ETag/Last-Modified) so the daily refresh is cheap for upstreams.
    /// </summary>
    public sealed class AssetCacheService
    {
        // Sent with every upstream fetch. A real browser UA matters for fonts.googleapis.com,
        // which serves woff2 @font-face CSS only to modern browsers (older UAs get ttf).
        private const string FetchUserAgent =
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

        // Depth-1 derived fetch caps (design: capped count and total bytes).
        private const int MaxDerivedPerEntry = 500;
        private const int MaxDerivedTotal = 2000;
        private const long RefreshTotalByteBudget = 256L * 1024 * 1024;

        private const string DerivedMapFileName = "derived-map.json";

        // Key shape: slash-separated segments of [A-Za-z0-9._@+-] that must START alphanumeric,
        // which structurally rules out "..", ".hidden" and empty segments before any file-system
        // path is even built.
        private static readonly Regex KeyShapeRegex = new(
            @"^[A-Za-z0-9][A-Za-z0-9._@+\-]*(/[A-Za-z0-9][A-Za-z0-9._@+\-]*)*$",
            RegexOptions.Compiled);

        // url(...) references in cached CSS; group 1 = raw reference (possibly quoted).
        private static readonly Regex CssUrlRegex = new(
            @"url\(\s*([^)]*?)\s*\)",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        private static readonly Dictionary<string, AssetDescriptor> StaticByKey =
            AssetCacheManifest.StaticAssets.ToDictionary(a => a.Key, StringComparer.Ordinal);

        private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<AssetCacheService> _logger;
        private readonly string? _cacheDirectoryOverride;
        private readonly ConcurrentDictionary<string, SemaphoreSlim> _keyLocks = new(StringComparer.Ordinal);
        private readonly object _derivedMapLock = new();
        private ConcurrentDictionary<string, DerivedAsset>? _derivedMap;

        public AssetCacheService(IHttpClientFactory httpClientFactory, ILogger<AssetCacheService> logger)
            : this(httpClientFactory, logger, cacheDirectoryOverride: null)
        {
        }

        /// <summary>Test seam: pins the cache directory instead of deriving it from the plugin instance.</summary>
        internal AssetCacheService(IHttpClientFactory httpClientFactory, ILogger<AssetCacheService> logger, string? cacheDirectoryOverride)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _cacheDirectoryOverride = cacheDirectoryOverride;
        }

        /// <summary>
        /// The on-disk cache root: a directory next to the plugin configuration, following the
        /// same layout as <see cref="JellyfinEnhanced.BrandingDirectory"/>. Empty when the plugin
        /// instance is not available yet.
        /// </summary>
        internal string CacheDirectory => _cacheDirectoryOverride ?? JellyfinEnhanced.AssetCacheDirectory;

        /// <summary>Classifies a requested key against the manifest. Never touches the network.</summary>
        internal ResolvedAsset Resolve(string? key)
        {
            var unknown = new ResolvedAsset(AssetKind.Unknown, key ?? string.Empty, null, "application/octet-stream", 0);
            if (string.IsNullOrWhiteSpace(key) || key.Length > 200 || !KeyShapeRegex.IsMatch(key))
            {
                return unknown;
            }

            foreach (var embedded in AssetCacheManifest.EmbeddedAssets)
            {
                if (string.Equals(embedded.Key, key, StringComparison.Ordinal))
                {
                    return new ResolvedAsset(AssetKind.Embedded, key, null, embedded.ContentType, 0, EmbeddedResourceName: embedded.ResourceName);
                }
            }

            if (StaticByKey.TryGetValue(key, out var descriptor))
            {
                return new ResolvedAsset(
                    AssetKind.Static,
                    descriptor.Key,
                    descriptor.UpstreamUrl,
                    descriptor.ContentType,
                    descriptor.MaxBytes,
                    descriptor.Rewrite,
                    descriptor.AllowedDerivedPrefixes);
            }

            foreach (var family in AssetCacheManifest.Families)
            {
                if (!key.StartsWith(family.KeyPrefix, StringComparison.Ordinal) ||
                    !key.EndsWith(family.KeySuffix, StringComparison.Ordinal))
                {
                    continue;
                }

                var param = key.Substring(family.KeyPrefix.Length, key.Length - family.KeyPrefix.Length - family.KeySuffix.Length);
                if (!family.ParamPattern.IsMatch(param))
                {
                    continue;
                }

                var url = string.Format(System.Globalization.CultureInfo.InvariantCulture, family.UrlTemplate, param);
                return new ResolvedAsset(AssetKind.Family, key, url, family.ContentType, family.MaxBytes);
            }

            if (DerivedMap.TryGetValue(key, out var derived))
            {
                // Derived assets inherit a generous image/font-sized cap; their URLs were
                // prefix-validated at registration time.
                return new ResolvedAsset(AssetKind.Derived, key, derived.Url, derived.ContentType, 8L * 1024 * 1024);
            }

            return unknown;
        }

        /// <summary>
        /// Canonicalizes the cache path for a key and proves it stays under the cache directory.
        /// The key must already have passed <see cref="Resolve"/> (shape-checked); this is the
        /// second, file-system-level traversal guard.
        /// </summary>
        internal bool TryGetSafeCachePath(string key, out string fullPath)
        {
            fullPath = string.Empty;
            var cacheDir = CacheDirectory;
            if (string.IsNullOrWhiteSpace(cacheDir) || string.IsNullOrWhiteSpace(key) || !KeyShapeRegex.IsMatch(key))
            {
                return false;
            }

            var cacheRoot = Path.GetFullPath(cacheDir);
            var candidate = Path.GetFullPath(Path.Combine(cacheRoot, key));
            if (!candidate.StartsWith(cacheRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            {
                return false;
            }

            fullPath = candidate;
            return true;
        }

        /// <summary>
        /// Ensures the asset is present on disk, fetching it from its allowlisted upstream when
        /// missing (or unconditionally re-validating when <paramref name="forceRefresh"/> is set,
        /// as the scheduled task does). Returns the cached file path, or null when the asset is
        /// unavailable (never cached and upstream unreachable). Existing copies are always kept
        /// on failure ("last good wins").
        /// </summary>
        internal async Task<string?> EnsureCachedAsync(ResolvedAsset asset, bool forceRefresh, CancellationToken cancellationToken)
        {
            if (asset.Kind is AssetKind.Unknown or AssetKind.Embedded || string.IsNullOrEmpty(asset.UpstreamUrl))
            {
                return null;
            }

            if (!TryGetSafeCachePath(asset.Key, out var path))
            {
                return null;
            }

            if (!forceRefresh && File.Exists(path))
            {
                return path;
            }

            var keyLock = _keyLocks.GetOrAdd(asset.Key, _ => new SemaphoreSlim(1, 1));
            await keyLock.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (!forceRefresh && File.Exists(path))
                {
                    return path; // Someone else fetched it while we waited.
                }

                await FetchAssetAsync(asset, path, cancellationToken).ConfigureAwait(false);
                // Whatever the outcome, serve the file when one exists: a fresh fetch and a
                // failed refresh over a last-good copy are both "serve the cached file".
                return File.Exists(path) ? path : null;
            }
            finally
            {
                keyLock.Release();
            }
        }

        /// <summary>
        /// Refreshes every manifest asset: all statics, every registered derived asset and every
        /// family member already cached on disk (families are demand-populated, so only known
        /// members are re-validated). One asset failing never aborts the rest.
        /// </summary>
        internal async Task<AssetRefreshSummary> RefreshAllAsync(IProgress<double>? progress, CancellationToken cancellationToken)
        {
            var work = new List<ResolvedAsset>();
            work.AddRange(AssetCacheManifest.StaticAssets.Select(a => Resolve(a.Key)));
            work.AddRange(EnumerateCachedFamilyKeys().Select(Resolve));

            int attempted = 0, succeeded = 0, notModified = 0, failed = 0;
            long bytesFetched = 0;

            // Two passes: statics/families first (pass 0 can grow the derived registry via CSS
            // rewrites), then the derived assets registered by pass 0 (depth 1, per the design).
            for (var pass = 0; pass < 2; pass++)
            {
                if (pass == 1)
                {
                    work = DerivedMap.Keys.OrderBy(k => k, StringComparer.Ordinal).Select(Resolve).ToList();
                }

                var total = Math.Max(1, work.Count);
                for (var i = 0; i < work.Count; i++)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var asset = work[i];
                    if (asset.Kind is AssetKind.Unknown or AssetKind.Embedded)
                    {
                        continue;
                    }

                    if (bytesFetched > RefreshTotalByteBudget)
                    {
                        _logger.LogWarning($"[Asset Cache] Refresh byte budget exceeded ({bytesFetched} bytes); leaving remaining assets for the next run.");
                        pass = 2;
                        break;
                    }

                    attempted++;
                    try
                    {
                        TryGetSafeCachePath(asset.Key, out var path);
                        var outcome = await FetchAssetAsync(asset, path, cancellationToken).ConfigureAwait(false);
                        switch (outcome)
                        {
                            case FetchOutcome.Fetched:
                                succeeded++;
                                bytesFetched += TryGetFileLength(path);
                                break;
                            case FetchOutcome.NotModified:
                                notModified++;
                                break;
                            default:
                                failed++;
                                break;
                        }
                    }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch (Exception ex)
                    {
                        failed++;
                        _logger.LogWarning($"[Asset Cache] Refresh failed for '{asset.Key}': {ex.Message}");
                    }

                    progress?.Report((pass * 50.0) + (50.0 * (i + 1) / total));
                }
            }

            progress?.Report(100);
            return new AssetRefreshSummary(attempted, succeeded, notModified, failed);
        }

        /// <summary>
        /// Rewrites every allowlisted url(...) reference in a CSS asset to a local, RELATIVE
        /// path (d/&lt;hash&gt;&lt;ext&gt; next to the CSS, so reverse-proxy sub-paths keep working) and
        /// returns the derived assets to register. References outside the entry's allowed
        /// prefixes — and data:/blob:/fragment references — are left untouched. Pure; testable.
        /// </summary>
        internal static (string Css, IReadOnlyList<DerivedAsset> Derived) RewriteCss(string css, ResolvedAsset asset)
        {
            var derived = new List<DerivedAsset>();
            var seen = new Dictionary<string, string>(StringComparer.Ordinal); // absolute url -> relative ref
            var entryDir = asset.Key.Contains('/', StringComparison.Ordinal)
                ? asset.Key[..asset.Key.LastIndexOf('/')]
                : string.Empty;

            var rewritten = CssUrlRegex.Replace(css, match =>
            {
                var raw = match.Groups[1].Value.Trim();
                var quote = string.Empty;
                if (raw.Length >= 2 && (raw[0] == '"' || raw[0] == '\'') && raw[^1] == raw[0])
                {
                    quote = raw[0].ToString();
                    raw = raw[1..^1].Trim();
                }

                var absolute = ResolveReference(raw, asset.UpstreamUrl);
                if (absolute == null || !IsAllowedDerivedUrl(absolute, asset.AllowedDerivedPrefixes))
                {
                    return match.Value;
                }

                if (!seen.TryGetValue(absolute, out var relativeRef))
                {
                    if (derived.Count >= MaxDerivedPerEntry)
                    {
                        return match.Value;
                    }

                    var fileName = DerivedFileName(absolute);
                    relativeRef = "d/" + fileName;
                    var key = string.IsNullOrEmpty(entryDir) ? "d/" + fileName : $"{entryDir}/d/{fileName}";
                    derived.Add(new DerivedAsset(key, absolute, AssetCacheManifest.ContentTypeForExtension(Path.GetExtension(fileName))));
                    seen[absolute] = relativeRef;
                }

                return $"url({quote}{relativeRef}{quote})";
            });

            return (rewritten, derived);
        }

        /// <summary>Opens an embedded asset's stream from the plugin assembly.</summary>
        internal static Stream? OpenEmbeddedAsset(ResolvedAsset asset)
        {
            if (asset.Kind != AssetKind.Embedded || asset.EmbeddedResourceName == null)
            {
                return null;
            }

            return typeof(AssetCacheService).Assembly.GetManifestResourceStream(asset.EmbeddedResourceName);
        }

        private enum FetchOutcome
        {
            Fetched,
            NotModified,
            Failed,
        }

        private ConcurrentDictionary<string, DerivedAsset> DerivedMap
        {
            get
            {
                var map = _derivedMap;
                if (map != null)
                {
                    return map;
                }

                lock (_derivedMapLock)
                {
                    _derivedMap ??= LoadDerivedMap();
                    return _derivedMap;
                }
            }
        }

        private ConcurrentDictionary<string, DerivedAsset> LoadDerivedMap()
        {
            var map = new ConcurrentDictionary<string, DerivedAsset>(StringComparer.Ordinal);
            try
            {
                var cacheDir = CacheDirectory;
                if (string.IsNullOrWhiteSpace(cacheDir))
                {
                    return map;
                }

                var mapPath = Path.Combine(cacheDir, DerivedMapFileName);
                if (!File.Exists(mapPath))
                {
                    return map;
                }

                var entries = JsonSerializer.Deserialize<List<DerivedAsset>>(File.ReadAllText(mapPath));
                foreach (var entry in entries ?? new List<DerivedAsset>())
                {
                    // Re-validate on load: the registry is data, not code — a tampered file must
                    // not be able to smuggle in a non-allowlisted upstream or shadow a real key.
                    // (Deliberately does NOT call Resolve here: Resolve reads DerivedMap, which
                    // is what this method is building.)
                    if (KeyShapeRegex.IsMatch(entry.Key) &&
                        !StaticByKey.ContainsKey(entry.Key) &&
                        IsAllowedDerivedUrl(entry.Url, FindDerivedPrefixesForKey(entry.Key)))
                    {
                        map.TryAdd(entry.Key, entry);
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[Asset Cache] Could not load derived-asset map (will rebuild on next refresh): {ex.Message}");
            }

            return map;
        }

        private void RegisterDerived(IReadOnlyList<DerivedAsset> derived)
        {
            if (derived.Count == 0)
            {
                return;
            }

            var map = DerivedMap;
            foreach (var asset in derived)
            {
                if (map.Count >= MaxDerivedTotal && !map.ContainsKey(asset.Key))
                {
                    _logger.LogWarning($"[Asset Cache] Derived-asset registry is full ({MaxDerivedTotal}); ignoring '{asset.Key}'.");
                    continue;
                }

                map[asset.Key] = asset;
            }

            try
            {
                var cacheDir = CacheDirectory;
                if (string.IsNullOrWhiteSpace(cacheDir))
                {
                    return;
                }

                lock (_derivedMapLock)
                {
                    Directory.CreateDirectory(cacheDir);
                    var mapPath = Path.Combine(cacheDir, DerivedMapFileName);
                    var payload = JsonSerializer.Serialize(map.Values.OrderBy(a => a.Key, StringComparer.Ordinal).ToList(), JsonOptions);
                    WriteAtomic(mapPath, Encoding.UTF8.GetBytes(payload));
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[Asset Cache] Could not persist derived-asset map: {ex.Message}");
            }
        }

        /// <summary>Derived prefixes are per-rewrite-entry; recover them from the derived key's entry directory.</summary>
        private static IReadOnlyList<string>? FindDerivedPrefixesForKey(string derivedKey)
        {
            foreach (var entry in AssetCacheManifest.StaticAssets)
            {
                if (!entry.Rewrite || entry.AllowedDerivedPrefixes == null || !entry.Key.Contains('/', StringComparison.Ordinal))
                {
                    continue;
                }

                var entryDir = entry.Key[..entry.Key.LastIndexOf('/')];
                if (derivedKey.StartsWith(entryDir + "/d/", StringComparison.Ordinal))
                {
                    return entry.AllowedDerivedPrefixes;
                }
            }

            return null;
        }

        private async Task<FetchOutcome> FetchAssetAsync(ResolvedAsset asset, string path, CancellationToken cancellationToken)
        {
            if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(asset.UpstreamUrl))
            {
                return FetchOutcome.Failed;
            }

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            var ct = timeout.Token;

            try
            {
                var client = PluginHttpClients.CreateAssetsClient(_httpClientFactory);
                using var request = new HttpRequestMessage(HttpMethod.Get, asset.UpstreamUrl);
                request.Headers.TryAddWithoutValidation("User-Agent", FetchUserAgent);

                var meta = ReadMeta(path);
                if (File.Exists(path) && meta != null)
                {
                    if (!string.IsNullOrEmpty(meta.ETag))
                    {
                        request.Headers.TryAddWithoutValidation("If-None-Match", meta.ETag);
                    }

                    if (!string.IsNullOrEmpty(meta.LastModified))
                    {
                        request.Headers.TryAddWithoutValidation("If-Modified-Since", meta.LastModified);
                    }
                }

                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
                if (response.StatusCode == HttpStatusCode.NotModified && File.Exists(path))
                {
                    WriteMeta(path, meta?.ETag, meta?.LastModified);
                    return FetchOutcome.NotModified;
                }

                if (!response.IsSuccessStatusCode)
                {
                    _logger.LogWarning($"[Asset Cache] Upstream returned {(int)response.StatusCode} for '{asset.Key}' ({asset.UpstreamUrl}); keeping last good copy if any.");
                    return FetchOutcome.Failed;
                }

                var declaredLength = response.Content.Headers.ContentLength;
                if (declaredLength.HasValue && declaredLength.Value > asset.MaxBytes)
                {
                    _logger.LogWarning($"[Asset Cache] '{asset.Key}' exceeds its size cap ({declaredLength.Value} > {asset.MaxBytes} bytes); rejected.");
                    return FetchOutcome.Failed;
                }

                byte[] content;
                await using (var upstream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false))
                {
                    content = await ReadWithCapAsync(upstream, asset.MaxBytes, ct).ConfigureAwait(false);
                }

                if (content.LongLength > asset.MaxBytes)
                {
                    _logger.LogWarning($"[Asset Cache] '{asset.Key}' exceeds its size cap (> {asset.MaxBytes} bytes); rejected.");
                    return FetchOutcome.Failed;
                }

                if (asset.Rewrite)
                {
                    var (css, derived) = RewriteCss(Encoding.UTF8.GetString(content), asset);
                    content = Encoding.UTF8.GetBytes(css);
                    RegisterDerived(derived);
                }

                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                WriteAtomic(path, content);
                WriteMeta(
                    path,
                    response.Headers.ETag?.ToString(),
                    response.Content.Headers.LastModified?.ToString("R"));
                return FetchOutcome.Fetched;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"[Asset Cache] Fetch failed for '{asset.Key}' ({asset.UpstreamUrl}): {ex.Message}");
                return FetchOutcome.Failed;
            }
        }

        private static async Task<byte[]> ReadWithCapAsync(Stream stream, long maxBytes, CancellationToken cancellationToken)
        {
            using var buffer = new MemoryStream();
            var chunk = new byte[81920];
            while (true)
            {
                var read = await stream.ReadAsync(chunk.AsMemory(0, chunk.Length), cancellationToken).ConfigureAwait(false);
                if (read == 0)
                {
                    break;
                }

                buffer.Write(chunk, 0, read);
                if (buffer.Length > maxBytes)
                {
                    // One byte over the cap is enough to reject; stop reading.
                    break;
                }
            }

            return buffer.ToArray();
        }

        private static void WriteAtomic(string path, byte[] content)
        {
            var temp = path + ".tmp-" + Guid.NewGuid().ToString("N");
            File.WriteAllBytes(temp, content);
            File.Move(temp, path, overwrite: true);
        }

        private sealed record AssetMeta(string? ETag, string? LastModified, DateTimeOffset FetchedUtc);

        private static string MetaPath(string path) => path + ".meta.json";

        private AssetMeta? ReadMeta(string path)
        {
            try
            {
                var metaPath = MetaPath(path);
                return File.Exists(metaPath)
                    ? JsonSerializer.Deserialize<AssetMeta>(File.ReadAllText(metaPath))
                    : null;
            }
            catch (Exception ex)
            {
                _logger.LogDebug($"[Asset Cache] Unreadable meta sidecar for '{path}': {ex.Message}");
                return null;
            }
        }

        private void WriteMeta(string path, string? etag, string? lastModified)
        {
            try
            {
                var meta = new AssetMeta(etag, lastModified, DateTimeOffset.UtcNow);
                WriteAtomic(MetaPath(path), Encoding.UTF8.GetBytes(JsonSerializer.Serialize(meta, JsonOptions)));
            }
            catch (Exception ex)
            {
                // Meta is an optimization (conditional GETs); losing it only costs bandwidth.
                _logger.LogDebug($"[Asset Cache] Could not write meta sidecar for '{path}': {ex.Message}");
            }
        }

        private IEnumerable<string> EnumerateCachedFamilyKeys()
        {
            var cacheDir = CacheDirectory;
            if (string.IsNullOrWhiteSpace(cacheDir))
            {
                yield break;
            }

            foreach (var family in AssetCacheManifest.Families)
            {
                var familyDir = Path.Combine(cacheDir, family.KeyPrefix.TrimEnd('/').Replace('/', Path.DirectorySeparatorChar));
                if (!Directory.Exists(familyDir))
                {
                    continue;
                }

                foreach (var file in Directory.EnumerateFiles(familyDir, "*" + family.KeySuffix))
                {
                    var name = Path.GetFileName(file);
                    var param = name[..^family.KeySuffix.Length];
                    if (family.ParamPattern.IsMatch(param))
                    {
                        yield return family.KeyPrefix + name;
                    }
                }
            }
        }

        private static string? ResolveReference(string reference, string? baseUrl)
        {
            if (string.IsNullOrEmpty(reference) ||
                reference.StartsWith("data:", StringComparison.OrdinalIgnoreCase) ||
                reference.StartsWith("blob:", StringComparison.OrdinalIgnoreCase) ||
                reference.StartsWith('#'))
            {
                return null;
            }

            if (reference.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                reference.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                return Uri.TryCreate(reference, UriKind.Absolute, out var abs) ? abs.ToString() : null;
            }

            // Relative reference: resolve against the entry's upstream URL, then apply the same
            // prefix allowlist as absolute references.
            if (!string.IsNullOrEmpty(baseUrl) &&
                Uri.TryCreate(baseUrl, UriKind.Absolute, out var baseUri) &&
                Uri.TryCreate(baseUri, reference, out var resolved))
            {
                return resolved.ToString();
            }

            return null;
        }

        private static bool IsAllowedDerivedUrl(string url, IReadOnlyList<string>? allowedPrefixes)
        {
            if (allowedPrefixes == null || allowedPrefixes.Count == 0)
            {
                return false;
            }

            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
                !string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase) ||
                !AssetCacheManifest.AllowedUpstreamHosts.Contains(uri.Host, StringComparer.OrdinalIgnoreCase))
            {
                return false;
            }

            return allowedPrefixes.Any(prefix => url.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
        }

        private static string DerivedFileName(string url)
        {
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(url)))[..16].ToLowerInvariant();
            var ext = string.Empty;
            if (Uri.TryCreate(url, UriKind.Absolute, out var uri))
            {
                var candidate = Path.GetExtension(uri.AbsolutePath);
                if (Regex.IsMatch(candidate, @"^\.[A-Za-z0-9]{1,8}$"))
                {
                    ext = candidate.ToLowerInvariant();
                }
            }

            return hash + ext;
        }

        private static long TryGetFileLength(string path)
        {
            try
            {
                return string.IsNullOrEmpty(path) || !File.Exists(path) ? 0 : new FileInfo(path).Length;
            }
            catch (IOException)
            {
                return 0;
            }
        }
    }
}
