using System;
using System.IO;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Serves the locally cached third-party assets (fonts, icons, flags, theme CSS, data files)
    /// at /JellyfinEnhanced/assets/{key} so browsers never talk to a CDN. See
    /// <see cref="AssetCacheService"/> for the manifest/allowlist and the population strategy.
    ///
    /// Anonymous on purpose: these assets are exactly as public as the injected client script
    /// itself, and several (fonts, login-adjacent styles) load pre-login. The route is
    /// traversal-proof — keys are shape-validated and classified against the manifest before any
    /// file-system path is built, and the resolved path must stay under the cache directory.
    /// </summary>
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class AssetsController : ControllerBase
    {
        // Matches the ~24h refresh cadence of RefreshCachedAssetsTask: clients may cache an
        // asset for a day; the next request after that picks up whatever the task refreshed.
        private const string CacheControlValue = "public, max-age=86400";

        private readonly AssetCacheService _assetCache;
        private readonly ILogger<AssetsController> _logger;

        public AssetsController(AssetCacheService assetCache, ILogger<AssetsController> logger)
        {
            _assetCache = assetCache;
            _logger = logger;
        }

        [HttpGet("assets/{**key}")]
        public async Task<ActionResult> GetAsset(string key)
        {
            var asset = _assetCache.Resolve(key);
            if (asset.Kind == AssetKind.Unknown)
            {
                return NotFound();
            }

            if (asset.Kind == AssetKind.Embedded)
            {
                return ServeEmbedded(asset);
            }

            // ON-DEMAND fallback: when the scheduled task hasn't populated the cache yet (first
            // boot), this fetches-and-caches inline once, per-key-locked inside the service.
            // If upstream is unreachable and no last-good copy exists → 404; every client-side
            // consumer degrades gracefully (system-font stacks, onerror-hidden images).
            string? path;
            try
            {
                path = await _assetCache.EnsureCachedAsync(asset, forceRefresh: false, HttpContext.RequestAborted).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return NotFound();
            }

            if (path == null || !System.IO.File.Exists(path))
            {
                _logger.LogWarning($"[Asset Cache] Asset '{asset.Key}' is not cached and upstream is unreachable; returning 404.");
                return NotFound();
            }

            var info = new FileInfo(path);
            var etag = $"\"{info.Length:x}-{info.LastWriteTimeUtc.Ticks:x}\"";
            if (NotModified(etag))
            {
                return StatusCode(StatusCodes.Status304NotModified);
            }

            SetCacheHeaders(etag);
            return PhysicalFile(path, asset.ContentType);
        }

        private ActionResult ServeEmbedded(ResolvedAsset asset)
        {
            var stream = AssetCacheService.OpenEmbeddedAsset(asset);
            if (stream == null)
            {
                _logger.LogError($"[Asset Cache] Embedded asset resource missing: {asset.EmbeddedResourceName}");
                return NotFound();
            }

            // Embedded content only changes with the plugin build; version it accordingly.
            var etag = $"\"emb-{JellyfinEnhanced.Instance?.Version?.ToString() ?? "unknown"}\"";
            if (NotModified(etag))
            {
                stream.Dispose();
                return StatusCode(StatusCodes.Status304NotModified);
            }

            SetCacheHeaders(etag);
            return new FileStreamResult(stream, asset.ContentType);
        }

        private bool NotModified(string etag)
        {
            var ifNoneMatch = Request.Headers.IfNoneMatch;
            foreach (var candidate in ifNoneMatch)
            {
                if (candidate != null && candidate.Contains(etag, StringComparison.Ordinal))
                {
                    SetCacheHeaders(etag);
                    return true;
                }
            }

            return false;
        }

        private void SetCacheHeaders(string etag)
        {
            Response.Headers.CacheControl = CacheControlValue;
            Response.Headers.ETag = etag;
        }
    }
}
