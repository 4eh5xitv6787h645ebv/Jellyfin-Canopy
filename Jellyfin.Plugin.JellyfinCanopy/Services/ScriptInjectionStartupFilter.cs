using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Primitives;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// Injects the Jellyfin Canopy client &lt;script&gt; tag into jellyfin-web's
    /// index.html at request time, via ASP.NET middleware registered through
    /// <see cref="Microsoft.AspNetCore.Hosting.IStartupFilter"/>.
    ///
    /// Jellyfin 12 serves index.html as a plain static file with no native
    /// script-injection hook, so the plugin injects its own script by running
    /// middleware ahead of the static-file handler. This keeps script injection
    /// self-contained and works on both Jellyfin 10.11 and 12, without writing to
    /// the web folder (the legacy on-disk rewrite needs a writable web folder /
    /// root container and is wiped on every jellyfin-web update).
    ///
    /// The filter is deliberately defensive and convergent:
    ///   - only ever touches the web index.html response;
    ///   - removes any legacy/stale Canopy-owned response tags and inserts exactly
    ///     one current bootstrap+loader pair;
    ///   - repeated rewrites are idempotent;
    ///   - on any error it serves the original response unchanged, never throwing
    ///     into the pipeline;
    ///   - can be disabled via the DisableScriptInjectionMiddleware config flag.
    /// </summary>
    public class ScriptInjectionStartupFilter : IStartupFilter
    {
        // PERF(S9): index.html is a hot host path. A warm request performs one
        // validator-only static-file revalidation plus O(1) bounded cache work; it
        // does not buffer or rewrite the shell again. A cold/changed representation
        // is capped at 2 MiB for caching and has roughly 4x transient body allocation
        // while decoding/rewriting/re-encoding. The process-wide singleton retains at
        // most 12 representations / 8 MiB, covering the three route spellings and
        // normal identity/gzip/br negotiation without scaling with users or requests.
        internal const int MaxCachedRepresentations = 12;
        internal const int MaxCachedBodyBytes = 8 * 1024 * 1024;
        internal const int MaxCacheableRepresentationBytes = 2 * 1024 * 1024;

        private readonly ILogger<ScriptInjectionStartupFilter> _logger;
        private readonly IPluginConfigProvider _configProvider;
        private readonly Func<string> _scriptTagProvider;
        private readonly object _cacheLock = new object();
        private readonly Dictionary<string, CachedRepresentation> _cache = new Dictionary<string, CachedRepresentation>(StringComparer.Ordinal);
        private readonly LinkedList<string> _leastRecentlyUsed = new LinkedList<string>();
        private int _cachedBodyBytes;
        private int _loggedOnce;

        public ScriptInjectionStartupFilter(ILogger<ScriptInjectionStartupFilter> logger, IPluginConfigProvider configProvider)
            : this(logger, configProvider, () => JellyfinCanopy.Instance!.BuildScriptTag())
        {
        }

        internal ScriptInjectionStartupFilter(
            ILogger<ScriptInjectionStartupFilter> logger,
            IPluginConfigProvider configProvider,
            Func<string> scriptTagProvider)
        {
            _logger = logger;
            _configProvider = configProvider;
            _scriptTagProvider = scriptTagProvider;
        }

        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
        {
            return app =>
            {
                // Registered before the rest of the pipeline (next(app)) so this runs
                // outermost — stripping Accept-Encoding below then reliably yields an
                // uncompressed response we can read and rewrite.
                app.Use(InvokeAsync);
                next(app);
            };
        }

        private async Task InvokeAsync(HttpContext context, Func<Task> nextMw)
        {
            if (!IsIndexRequest(context.Request.Path.Value))
            {
                await nextMw().ConfigureAwait(false);
                return;
            }

            // Only GET produces a body we can rewrite. HEAD/OPTIONS/etc. must pass
            // straight through so the host emits correct headers (buffering them would
            // compute a bogus Content-Length against an empty downstream body).
            if (!HttpMethods.IsGet(context.Request.Method))
            {
                await nextMw().ConfigureAwait(false);
                return;
            }

            var config = _configProvider.ConfigurationOrNull;
            if (config == null || config.DisableScriptInjectionMiddleware)
            {
                await nextMw().ConfigureAwait(false);
                return;
            }

            string scriptTags;
            try
            {
                scriptTags = _scriptTagProvider();
            }
            catch (Exception ex)
            {
                // The source response has not been claimed yet, so the host can still
                // serve its untouched shell if plugin state is unexpectedly unavailable.
                _logger.LogWarning($"Script injection middleware error (serving original HTML): {ex.Message}");
                await nextMw().ConfigureAwait(false);
                return;
            }

            var requestHeaders = context.Request.Headers;
            var clientIfNoneMatch = requestHeaders["If-None-Match"];
            var clientIfModifiedSince = requestHeaders["If-Modified-Since"];
            var originalRange = requestHeaders["Range"];
            var originalIfRange = requestHeaders["If-Range"];
            var hadIfNoneMatch = requestHeaders.ContainsKey("If-None-Match");
            var hadIfModifiedSince = requestHeaders.ContainsKey("If-Modified-Since");
            var hadRange = requestHeaders.ContainsKey("Range");
            var hadIfRange = requestHeaders.ContainsKey("If-Range");

            // Accept-Encoding deliberately stays untouched. Jellyfin's own response
            // compression middleware therefore selects the representation that lands
            // in our buffer; after injection we restore that same encoding and cache
            // the rewritten representation. Range is intentionally unsupported for a
            // rewritten app shell and is normalized to a complete response.
            requestHeaders.Remove("Range");
            requestHeaders.Remove("If-Range");

            var cacheKey = CreateCacheKey(
                context.Request.Path.Value ?? string.Empty,
                requestHeaders["Accept-Encoding"],
                scriptTags);
            var cached = GetCached(cacheKey);

            // Jellyfin's validator describes the source index, whereas browsers know
            // only the rewritten representation's validator. Translate a warm cache
            // entry back to its source validator so the static-file middleware can
            // return a bodyless 304. A cold request suppresses client validators just
            // for the downstream call: its transformed ETag cannot validate the source.
            if (cached != null)
            {
                SetOrRemove(requestHeaders, "If-None-Match", cached.SourceETag);
                SetOrRemove(requestHeaders, "If-Modified-Since", cached.SourceLastModified);
            }
            else
            {
                requestHeaders.Remove("If-None-Match");
                requestHeaders.Remove("If-Modified-Since");
            }

            var originalBody = context.Response.Body;
            using var buffer = new MemoryStream();
            context.Response.Body = buffer;
            try
            {
                await nextMw().ConfigureAwait(false);
            }
            catch
            {
                // A downstream failure is not ours to swallow. Discard the partially
                // buffered body (it was never written to the real stream) and rethrow:
                // the real response hasn't started, so the host's exception handler can
                // still render a clean error page. Flushing the partial buffer here would
                // commit a truncated, 200-looking response.
                context.Response.Body = originalBody;
                throw;
            }
            finally
            {
                RestoreHeader(requestHeaders, "If-None-Match", clientIfNoneMatch, hadIfNoneMatch);
                RestoreHeader(requestHeaders, "If-Modified-Since", clientIfModifiedSince, hadIfModifiedSince);
                RestoreHeader(requestHeaders, "Range", originalRange, hadRange);
                RestoreHeader(requestHeaders, "If-Range", originalIfRange, hadIfRange);
            }

            context.Response.Body = originalBody;
            buffer.Seek(0, SeekOrigin.Begin);

            if (context.Response.StatusCode == StatusCodes.Status304NotModified && cached != null)
            {
                await WriteCachedAsync(
                    context,
                    cached,
                    ClientValidatorsMatch(
                        clientIfNoneMatch,
                        clientIfModifiedSince,
                        cached,
                        allowIfModifiedSince: true),
                    originalBody).ConfigureAwait(false);
                return;
            }

            var isHtml = context.Response.StatusCode == 200
                && (context.Response.ContentType?.Contains("text/html", StringComparison.OrdinalIgnoreCase) ?? false);

            if (!isHtml)
            {
                // 304, redirects, non-HTML — pass straight through unchanged.
                await buffer.CopyToAsync(originalBody).ConfigureAwait(false);
                return;
            }

            var encodedSource = buffer.ToArray();
            CachedRepresentation? representation = null;
            try
            {
                if (!TryDecode(encodedSource, context.Response.Headers["Content-Encoding"], out var decodedSource))
                {
                    // A future host compression provider may introduce an encoding the
                    // plugin cannot safely rewrite. Preserve the exact host response
                    // rather than corrupting it or serving mismatched metadata.
                }
                else
                {
                    string html;
                    using (var decoded = new MemoryStream(decodedSource, writable: false))
                    using (var reader = new StreamReader(decoded, Encoding.UTF8, true, 1024, leaveOpen: false))
                    {
                        html = await reader.ReadToEndAsync().ConfigureAwait(false);
                    }

                    var bodyClose = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);

                    if (bodyClose >= 0)
                    {
                        // A legacy on-disk install may contribute only the classic
                        // loader, or an immutable stale URL, especially when the web
                        // root is no longer writable. Replace every owned response tag
                        // with the complete current bootstrap+loader pair atomically.
                        html = ReplaceOwnedScriptTags(html, scriptTags);

                        if (System.Threading.Interlocked.Exchange(ref _loggedOnce, 1) == 0)
                        {
                            _logger.LogInformation("Jellyfin Canopy: injected the client script via request-time middleware (IStartupFilter).");
                        }
                    }

                    var rewrittenUtf8 = Encoding.UTF8.GetBytes(html);
                    if (TryEncode(rewrittenUtf8, context.Response.Headers["Content-Encoding"], out var rewrittenBody))
                    {
                        representation = new CachedRepresentation(
                            cacheKey,
                            rewrittenBody,
                            CreateETag(rewrittenBody),
                            context.Response.Headers["ETag"].ToString(),
                            context.Response.Headers["Last-Modified"].ToString(),
                            "text/html;charset=utf-8",
                            context.Response.Headers["Content-Encoding"].ToString(),
                            context.Response.Headers["Cache-Control"].ToString(),
                            context.Response.Headers["Vary"].ToString());
                    }
                }
            }
            catch (Exception ex)
            {
                // Never break index.html — the original representation and all of its
                // host-selected headers are still intact.
                _logger.LogWarning($"Script injection middleware error (serving original HTML): {ex.Message}");
            }

            if (representation == null)
            {
                // Response writes sit outside the transform catch: a disconnect or
                // transport failure must propagate instead of attempting a second body.
                await originalBody.WriteAsync(
                    encodedSource.AsMemory(),
                    context.RequestAborted).ConfigureAwait(false);
                return;
            }

            PutCached(representation);
            await WriteCachedAsync(
                context,
                representation,
                ClientValidatorsMatch(
                    clientIfNoneMatch,
                    clientIfModifiedSince,
                    representation,
                    allowIfModifiedSince: cached != null),
                originalBody).ConfigureAwait(false);
        }

        private static string CreateCacheKey(string path, StringValues acceptEncoding, string scriptTags)
        {
            var material = Encoding.UTF8.GetBytes(path + "\0" + acceptEncoding.ToString() + "\0" + scriptTags);
            return Convert.ToHexString(SHA256.HashData(material));
        }

        private static string CreateETag(byte[] body) =>
            "\"jc-" + Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant() + "\"";

        private CachedRepresentation? GetCached(string key)
        {
            lock (_cacheLock)
            {
                if (!_cache.TryGetValue(key, out var cached))
                {
                    return null;
                }

                _leastRecentlyUsed.Remove(key);
                _leastRecentlyUsed.AddLast(key);
                return cached;
            }
        }

        private void PutCached(CachedRepresentation representation)
        {
            // Without a source validator, a later request cannot prove that the host
            // file is unchanged. Serve this request correctly but do not retain bytes
            // that could become stale.
            if (representation.Body.Length > MaxCacheableRepresentationBytes
                || (string.IsNullOrEmpty(representation.SourceETag)
                    && string.IsNullOrEmpty(representation.SourceLastModified)))
            {
                return;
            }

            lock (_cacheLock)
            {
                if (_cache.Remove(representation.Key, out var replaced))
                {
                    _cachedBodyBytes -= replaced.Body.Length;
                    _leastRecentlyUsed.Remove(representation.Key);
                }

                while (_cache.Count >= MaxCachedRepresentations
                    || (_cachedBodyBytes + representation.Body.Length > MaxCachedBodyBytes
                        && _leastRecentlyUsed.First != null))
                {
                    var oldestKey = _leastRecentlyUsed.First!.Value;
                    _leastRecentlyUsed.RemoveFirst();
                    if (_cache.Remove(oldestKey, out var oldest))
                    {
                        _cachedBodyBytes -= oldest.Body.Length;
                    }
                }

                _cache[representation.Key] = representation;
                _leastRecentlyUsed.AddLast(representation.Key);
                _cachedBodyBytes += representation.Body.Length;
            }
        }

        private static async Task WriteCachedAsync(
            HttpContext context,
            CachedRepresentation representation,
            bool notModified,
            Stream responseBody)
        {
            context.Response.StatusCode = notModified
                ? StatusCodes.Status304NotModified
                : StatusCodes.Status200OK;
            context.Response.ContentType = representation.ContentType;
            SetOrRemove(context.Response.Headers, "Content-Encoding", representation.ContentEncoding);
            SetOrRemove(context.Response.Headers, "Cache-Control", representation.CacheControl);
            SetOrRemove(context.Response.Headers, "Vary", representation.Vary);
            SetOrRemove(context.Response.Headers, "Last-Modified", representation.SourceLastModified);
            context.Response.Headers["ETag"] = representation.ETag;
            context.Response.Headers.Remove("Accept-Ranges");
            context.Response.Headers.Remove("Content-Range");

            if (notModified)
            {
                context.Response.ContentLength = null;
                return;
            }

            context.Response.ContentLength = representation.Body.Length;
            await responseBody.WriteAsync(
                representation.Body.AsMemory(),
                context.RequestAborted).ConfigureAwait(false);
        }

        private static bool ClientValidatorsMatch(
            StringValues ifNoneMatch,
            StringValues ifModifiedSince,
            CachedRepresentation representation,
            bool allowIfModifiedSince)
        {
            if (!StringValues.IsNullOrEmpty(ifNoneMatch))
            {
                return IfNoneMatchSatisfied(ifNoneMatch, representation.ETag);
            }

            // Last-Modified comes from Jellyfin's source file. It is safe for the
            // transformed representation only when this exact script-generation key
            // was already cached; a cold generation may have changed while the source
            // file timestamp stayed constant, so its first request must return 200.
            if (!allowIfModifiedSince
                || StringValues.IsNullOrEmpty(ifModifiedSince)
                || string.IsNullOrEmpty(representation.SourceLastModified)
                || !DateTimeOffset.TryParse(
                    ifModifiedSince.ToString(),
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out var requestedDate)
                || !DateTimeOffset.TryParse(
                    representation.SourceLastModified,
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out var lastModified))
            {
                return false;
            }

            return lastModified <= requestedDate;
        }

        private static bool IfNoneMatchSatisfied(StringValues header, string etag)
        {
            var bare = Unweaken(etag);
            foreach (var value in header)
            {
                if (string.IsNullOrEmpty(value))
                {
                    continue;
                }

                foreach (var candidate in value.Split(',').Select(part => part.Trim()))
                {
                    if (candidate == "*"
                        || string.Equals(Unweaken(candidate), bare, StringComparison.Ordinal))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private static string Unweaken(string etag) =>
            etag.StartsWith("W/", StringComparison.Ordinal) ? etag.Substring(2) : etag;

        private static bool TryDecode(byte[] body, StringValues contentEncoding, out byte[] decoded)
        {
            decoded = body;
            var encodings = ParseEncodings(contentEncoding);
            for (var index = encodings.Count - 1; index >= 0; index--)
            {
                if (!TryTransform(decoded, encodings[index], decompress: true, out decoded))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool TryEncode(byte[] body, StringValues contentEncoding, out byte[] encoded)
        {
            encoded = body;
            foreach (var encoding in ParseEncodings(contentEncoding))
            {
                if (!TryTransform(encoded, encoding, decompress: false, out encoded))
                {
                    return false;
                }
            }

            return true;
        }

        private static List<string> ParseEncodings(StringValues contentEncoding) =>
            contentEncoding
                .SelectMany(value => (value ?? string.Empty).Split(','))
                .Select(value => value.Trim())
                .Where(value => value.Length > 0 && !value.Equals("identity", StringComparison.OrdinalIgnoreCase))
                .ToList();

        private static bool TryTransform(byte[] source, string encoding, bool decompress, out byte[] transformed)
        {
            transformed = source;
            if (!encoding.Equals("gzip", StringComparison.OrdinalIgnoreCase)
                && !encoding.Equals("br", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            using var input = new MemoryStream(source, writable: false);
            using var output = new MemoryStream();
            if (decompress)
            {
                using Stream decoder = encoding.Equals("gzip", StringComparison.OrdinalIgnoreCase)
                    ? new GZipStream(input, CompressionMode.Decompress)
                    : new BrotliStream(input, CompressionMode.Decompress);
                decoder.CopyTo(output);
            }
            else
            {
                using (Stream encoder = encoding.Equals("gzip", StringComparison.OrdinalIgnoreCase)
                    ? new GZipStream(output, CompressionLevel.Fastest, leaveOpen: true)
                    : new BrotliStream(output, CompressionLevel.Fastest, leaveOpen: true))
                {
                    input.CopyTo(encoder);
                }
            }

            transformed = output.ToArray();
            return true;
        }

        private static void SetOrRemove(IHeaderDictionary headers, string name, string? value)
        {
            if (string.IsNullOrEmpty(value))
            {
                headers.Remove(name);
            }
            else
            {
                headers[name] = value;
            }
        }

        private static void RestoreHeader(
            IHeaderDictionary headers,
            string name,
            StringValues originalValue,
            bool existed)
        {
            if (existed)
            {
                headers[name] = originalValue;
            }
            else
            {
                headers.Remove(name);
            }
        }

        private sealed class CachedRepresentation
        {
            public CachedRepresentation(
                string key,
                byte[] body,
                string etag,
                string sourceETag,
                string sourceLastModified,
                string contentType,
                string contentEncoding,
                string cacheControl,
                string vary)
            {
                Key = key;
                Body = body;
                ETag = etag;
                SourceETag = sourceETag;
                SourceLastModified = sourceLastModified;
                ContentType = contentType;
                ContentEncoding = contentEncoding;
                CacheControl = cacheControl;
                Vary = vary;
            }

            public string Key { get; }

            public byte[] Body { get; }

            public string ETag { get; }

            public string SourceETag { get; }

            public string SourceLastModified { get; }

            public string ContentType { get; }

            public string ContentEncoding { get; }

            public string CacheControl { get; }

            public string Vary { get; }
        }

        internal static string ReplaceOwnedScriptTags(string html, string currentTags)
        {
            var bodyClose = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
            if (bodyClose < 0)
            {
                return html;
            }

            var scrubbed = JellyfinCanopy.OwnScriptTagRegex().Replace(html, string.Empty);
            bodyClose = scrubbed.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
            return scrubbed.Substring(0, bodyClose)
                + currentTags
                + "\n"
                + scrubbed.Substring(bodyClose);
        }

        // Matches the web app shell however it is requested: bare "/web", "/web/"
        // (SPA serve), and explicit "/web/index.html". EndsWith keeps this correct
        // when Jellyfin is hosted under a base-url prefix (e.g. /jellyfin/web/).
        private static bool IsIndexRequest(string? path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return false;
            }

            return path.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase)
                || path.EndsWith("/web/", StringComparison.OrdinalIgnoreCase)
                || path.Equals("/web", StringComparison.OrdinalIgnoreCase);
        }
    }
}
