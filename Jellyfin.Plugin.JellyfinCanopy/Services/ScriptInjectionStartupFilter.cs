using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
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
        // does not buffer or rewrite the shell again. Four fixed admission stripes
        // single-flight each representation key and bound aggregate cold/source-change
        // work. Encoded buffering and decoded/re-encoded transforms stop at 2 MiB
        // before replaying the untouched host response. The singleton retains at most
        // 12 representations / 8 MiB, covering the three route spellings and normal
        // identity/gzip/br negotiation without scaling with users or requests.
        internal const int MaxCachedRepresentations = 12;
        internal const int MaxCachedBodyBytes = 8 * 1024 * 1024;
        internal const int MaxCacheableRepresentationBytes = 2 * 1024 * 1024;
        internal const int MaxTransformBodyBytes = MaxCacheableRepresentationBytes;
        internal const int RepresentationGateCount = 4;

        private readonly ILogger<ScriptInjectionStartupFilter> _logger;
        private readonly IPluginConfigProvider _configProvider;
        private readonly Func<string> _scriptTagProvider;
        private readonly object _cacheLock = new object();
        private readonly Dictionary<string, CachedRepresentation> _cache = new Dictionary<string, CachedRepresentation>(StringComparer.Ordinal);
        private readonly LinkedList<string> _leastRecentlyUsed = new LinkedList<string>();
        private readonly SemaphoreSlim[] _representationGates = Enumerable
            .Range(0, RepresentationGateCount)
            .Select(_ => new SemaphoreSlim(1, 1))
            .ToArray();
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
                // outermost and captures the representation selected by Jellyfin's
                // compression/static-file middleware.
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

            var isHead = HttpMethods.IsHead(context.Request.Method);
            if (!HttpMethods.IsGet(context.Request.Method) && !isHead)
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

            var cacheKey = CreateCacheKey(
                context.Request.Path.Value ?? string.Empty,
                context.Request.Headers["Accept-Encoding"],
                scriptTags);
            var representationGate = _representationGates[cacheKey[0] % RepresentationGateCount];
            await representationGate.WaitAsync(context.RequestAborted).ConfigureAwait(false);
            var ownsRepresentationGate = true;
            var cached = GetCached(cacheKey);

            try
            {
                var requestHeaders = context.Request.Headers;
                var originalMethod = context.Request.Method;
                var clientIfMatch = requestHeaders["If-Match"];
                var clientIfNoneMatch = requestHeaders["If-None-Match"];
                var originalIfUnmodifiedSince = requestHeaders["If-Unmodified-Since"];
                var originalIfModifiedSince = requestHeaders["If-Modified-Since"];
                var originalRange = requestHeaders["Range"];
                var originalIfRange = requestHeaders["If-Range"];
                var hadIfMatch = requestHeaders.ContainsKey("If-Match");
                var hadIfNoneMatch = requestHeaders.ContainsKey("If-None-Match");
                var hadIfUnmodifiedSince = requestHeaders.ContainsKey("If-Unmodified-Since");
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
                requestHeaders.Remove("If-Match");
                requestHeaders.Remove("If-Unmodified-Since");

                // Jellyfin's validators describe the source index, whereas browsers
                // know only the rewritten representation. Translate a warm entry back
                // to source validators for a bodyless host revalidation. A cold request
                // suppresses client validators because they cannot validate the source.
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
                using var buffer = new BoundedMemoryStream(MaxTransformBodyBytes);
                var transformLimitExceeded = false;
                context.Response.Body = buffer;
                try
                {
                    await nextMw().ConfigureAwait(false);
                }
                catch (BodyLimitExceededException)
                {
                    // Nothing reached the transport. Restore the untouched request and
                    // replay it below so the host owns fallback validators and streaming.
                    transformLimitExceeded = true;
                }
                finally
                {
                    context.Response.Body = originalBody;
                    context.Request.Method = originalMethod;
                    RestoreHeader(requestHeaders, "If-Match", clientIfMatch, hadIfMatch);
                    RestoreHeader(requestHeaders, "If-None-Match", clientIfNoneMatch, hadIfNoneMatch);
                    RestoreHeader(
                        requestHeaders,
                        "If-Unmodified-Since",
                        originalIfUnmodifiedSince,
                        hadIfUnmodifiedSince);
                    RestoreHeader(
                        requestHeaders,
                        "If-Modified-Since",
                        originalIfModifiedSince,
                        hadIfModifiedSince);
                    RestoreHeader(requestHeaders, "Range", originalRange, hadRange);
                    RestoreHeader(requestHeaders, "If-Range", originalIfRange, hadIfRange);
                }

                // A canceled static-file send can be swallowed by ASP.NET Core.
                // Cancellation must terminate cache admission and must never trigger a
                // second response producer.
                if (context.RequestAborted.IsCancellationRequested)
                {
                    return;
                }

                if (transformLimitExceeded)
                {
                    context.Response.Clear();
                    ReleaseRepresentationGate(ref ownsRepresentationGate, representationGate);
                    await nextMw().ConfigureAwait(false);
                    return;
                }

                var encodedSource = buffer.ToArray();

                if (context.Response.StatusCode == StatusCodes.Status304NotModified && cached != null)
                {
                    ReleaseRepresentationGate(ref ownsRepresentationGate, representationGate);
                    await WriteRepresentationAsync(
                        context,
                        cached,
                        EvaluateClientPreconditions(clientIfMatch, clientIfNoneMatch, cached),
                        writeBody: !isHead,
                        originalBody).ConfigureAwait(false);
                    return;
                }

                if (isHead)
                {
                    if (context.Response.StatusCode != StatusCodes.Status200OK)
                    {
                        context.Response.Clear();
                        ReleaseRepresentationGate(ref ownsRepresentationGate, representationGate);
                        await nextMw().ConfigureAwait(false);
                        return;
                    }

                    // HEAD never downloads the shell just to derive a transformed ETag.
                    // A warm unchanged source used the cached 304 path above. A cold or
                    // changed source has no safe transformed metadata yet: evict the old
                    // entry and omit source validators/length rather than letting caches
                    // merge source metadata into a later injected GET.
                    RemoveCached(cacheKey);
                    context.Response.Headers.Remove("ETag");
                    context.Response.Headers.Remove("Last-Modified");
                    context.Response.Headers.Remove("Accept-Ranges");
                    context.Response.Headers.Remove("Content-Range");
                    context.Response.ContentLength = null;
                    context.Response.StatusCode = EvaluateMetadataOnlyHeadPrecondition(
                        clientIfMatch,
                        clientIfNoneMatch);
                    return;
                }

                var isHtml = context.Response.StatusCode == StatusCodes.Status200OK
                    && (context.Response.ContentType?.Contains("text/html", StringComparison.OrdinalIgnoreCase) ?? false);

                if (!isHtml)
                {
                    context.Response.Clear();
                    ReleaseRepresentationGate(ref ownsRepresentationGate, representationGate);
                    await nextMw().ConfigureAwait(false);
                    return;
                }

                CachedRepresentation? representation = null;
                try
                {
                    if (!TryDecode(encodedSource, context.Response.Headers["Content-Encoding"], out var decodedSource))
                    {
                        // A future host compression provider or a representation whose
                        // decoded size exceeds the cap cannot be safely rewritten.
                    }
                    else
                    {
                        string html;
                        using (var decoded = new MemoryStream(decodedSource, writable: false))
                        using (var reader = new StreamReader(decoded, Encoding.UTF8, true, 1024, leaveOpen: false))
                        {
                            html = await reader.ReadToEndAsync().ConfigureAwait(false);
                        }

                        // A missing closing body is also the signature of the partial
                        // SendFileAsync result seen on disconnect. Never cache it.
                        if (html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            html = ReplaceOwnedScriptTags(html, scriptTags);

                            if (Interlocked.Exchange(ref _loggedOnce, 1) == 0)
                            {
                                _logger.LogInformation("Jellyfin Canopy: injected the client script via request-time middleware (IStartupFilter).");
                            }

                            if (Encoding.UTF8.GetByteCount(html) <= MaxTransformBodyBytes)
                            {
                                var rewrittenUtf8 = Encoding.UTF8.GetBytes(html);
                                if (TryEncode(
                                    rewrittenUtf8,
                                    context.Response.Headers["Content-Encoding"],
                                    out var rewrittenBody))
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
                    }
                }
                catch (Exception ex)
                {
                    // Never break index.html — the original representation and all of
                    // its host-selected headers are still intact.
                    _logger.LogWarning($"Script injection middleware error (serving original HTML): {ex.Message}");
                }

                if (representation == null)
                {
                    // The buffered response is still uncommitted. Replay with the
                    // original request so unknown encodings, malformed HTML, and decoded
                    // size limits retain the host's complete conditional semantics.
                    context.Response.Clear();
                    ReleaseRepresentationGate(ref ownsRepresentationGate, representationGate);
                    await nextMw().ConfigureAwait(false);
                    return;
                }

                if (context.RequestAborted.IsCancellationRequested)
                {
                    return;
                }

                PutCached(representation);
                ReleaseRepresentationGate(ref ownsRepresentationGate, representationGate);
                await WriteRepresentationAsync(
                    context,
                    representation,
                    EvaluateClientPreconditions(clientIfMatch, clientIfNoneMatch, representation),
                    writeBody: !isHead,
                    originalBody).ConfigureAwait(false);
            }
            finally
            {
                ReleaseRepresentationGate(ref ownsRepresentationGate, representationGate);
            }
        }

        private static string CreateCacheKey(string path, StringValues acceptEncoding, string scriptTags)
        {
            var material = Encoding.UTF8.GetBytes(
                path + "\0" + CanonicalizeAcceptEncoding(acceptEncoding) + "\0" + scriptTags);
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

        private void RemoveCached(string key)
        {
            lock (_cacheLock)
            {
                if (_cache.Remove(key, out var cached))
                {
                    _cachedBodyBytes -= cached.Body.Length;
                    _leastRecentlyUsed.Remove(key);
                }
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

        private static async Task WriteRepresentationAsync(
            HttpContext context,
            CachedRepresentation representation,
            ClientPrecondition precondition,
            bool writeBody,
            Stream responseBody)
        {
            context.Response.StatusCode = precondition switch
            {
                ClientPrecondition.NotModified => StatusCodes.Status304NotModified,
                ClientPrecondition.Failed => StatusCodes.Status412PreconditionFailed,
                _ => StatusCodes.Status200OK,
            };
            context.Response.ContentType = representation.ContentType;
            SetOrRemove(context.Response.Headers, "Content-Encoding", representation.ContentEncoding);
            SetOrRemove(context.Response.Headers, "Cache-Control", representation.CacheControl);
            SetOrRemove(context.Response.Headers, "Vary", representation.Vary);
            // The source timestamp cannot describe the injected representation:
            // script generation can change while index.html does not. Publishing it
            // would let an IMS-only client validate a stale generation. The strong,
            // body-derived ETag is the transformed representation's validator.
            context.Response.Headers.Remove("Last-Modified");
            context.Response.Headers["ETag"] = representation.ETag;
            context.Response.Headers.Remove("Accept-Ranges");
            context.Response.Headers.Remove("Content-Range");

            if (precondition != ClientPrecondition.ShouldProcess)
            {
                context.Response.ContentLength = null;
                return;
            }

            context.Response.ContentLength = representation.Body.Length;
            if (writeBody)
            {
                await responseBody.WriteAsync(
                    representation.Body.AsMemory(),
                    context.RequestAborted).ConfigureAwait(false);
            }
        }

        private static ClientPrecondition EvaluateClientPreconditions(
            StringValues ifMatch,
            StringValues ifNoneMatch,
            CachedRepresentation representation)
        {
            if (!StringValues.IsNullOrEmpty(ifMatch)
                && !IfMatchSatisfied(ifMatch, representation.ETag))
            {
                return ClientPrecondition.Failed;
            }

            if (!StringValues.IsNullOrEmpty(ifNoneMatch))
            {
                return IfNoneMatchSatisfied(ifNoneMatch, representation.ETag)
                    ? ClientPrecondition.NotModified
                    : ClientPrecondition.ShouldProcess;
            }

            return ClientPrecondition.ShouldProcess;
        }

        private static int EvaluateMetadataOnlyHeadPrecondition(
            StringValues ifMatch,
            StringValues ifNoneMatch)
        {
            if (!StringValues.IsNullOrEmpty(ifMatch) && !HeaderContainsWildcard(ifMatch))
            {
                return StatusCodes.Status412PreconditionFailed;
            }

            return !StringValues.IsNullOrEmpty(ifNoneMatch) && HeaderContainsWildcard(ifNoneMatch)
                ? StatusCodes.Status304NotModified
                : StatusCodes.Status200OK;
        }

        private static bool HeaderContainsWildcard(StringValues header) =>
            header
                .SelectMany(value => (value ?? string.Empty).Split(','))
                .Any(value => value.Trim() == "*");

        private static bool IfMatchSatisfied(StringValues header, string etag)
        {
            foreach (var value in header)
            {
                if (string.IsNullOrEmpty(value))
                {
                    continue;
                }

                foreach (var candidate in value.Split(',').Select(part => part.Trim()))
                {
                    if (candidate == "*"
                        || (!candidate.StartsWith("W/", StringComparison.OrdinalIgnoreCase)
                            && string.Equals(candidate, etag, StringComparison.Ordinal)))
                    {
                        return true;
                    }
                }
            }

            return false;
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
            etag.StartsWith("W/", StringComparison.OrdinalIgnoreCase) ? etag.Substring(2) : etag;

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
            using var output = new BoundedMemoryStream(MaxTransformBodyBytes);
            try
            {
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
            }
            catch (BodyLimitExceededException)
            {
                return false;
            }

            transformed = output.ToArray();
            return true;
        }

        private static string CanonicalizeAcceptEncoding(StringValues acceptEncoding)
        {
            var qualities = new Dictionary<string, decimal>(StringComparer.Ordinal);
            foreach (var token in acceptEncoding.SelectMany(value => (value ?? string.Empty).Split(',')))
            {
                var segments = token.Split(';');
                var coding = segments[0].Trim().ToLowerInvariant();
                if (coding != "br" && coding != "gzip" && coding != "identity" && coding != "*")
                {
                    continue;
                }

                var quality = 1m;
                var valid = true;
                for (var index = 1; index < segments.Length; index++)
                {
                    var pair = segments[index].Split(new[] { '=' }, 2);
                    if (pair.Length != 2
                        || !pair[0].Trim().Equals("q", StringComparison.OrdinalIgnoreCase)
                        || !decimal.TryParse(
                            pair[1].Trim(),
                            NumberStyles.AllowDecimalPoint,
                            CultureInfo.InvariantCulture,
                            out quality)
                        || quality < 0
                        || quality > 1)
                    {
                        valid = false;
                        break;
                    }
                }

                if (valid && (!qualities.TryGetValue(coding, out var previous) || quality > previous))
                {
                    qualities[coding] = quality;
                }
            }

            // Only relative quality order, zero exclusion, and presence can affect
            // identity/gzip/Brotli negotiation. Collapsing absolute q values to ranks
            // yields a finite semantic key space instead of one cache variant per
            // attacker-chosen decimal spelling.
            var ranks = qualities.Values
                .Where(value => value > 0)
                .Distinct()
                .OrderByDescending(value => value)
                .Select((value, index) => (Value: value, Rank: index))
                .ToDictionary(pair => pair.Value, pair => pair.Rank);
            return string.Join(
                ";",
                new[] { "br", "gzip", "identity", "*" }.Select(coding =>
                {
                    if (!qualities.TryGetValue(coding, out var quality))
                    {
                        return coding + "=missing";
                    }

                    return quality == 0
                        ? coding + "=zero"
                        : coding + "=rank" + ranks[quality].ToString(CultureInfo.InvariantCulture);
                }));
        }

        private static void ReleaseRepresentationGate(
            ref bool ownsRepresentationGate,
            SemaphoreSlim representationGate)
        {
            if (ownsRepresentationGate)
            {
                ownsRepresentationGate = false;
                representationGate.Release();
            }
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

        private enum ClientPrecondition
        {
            ShouldProcess,
            NotModified,
            Failed,
        }

        private sealed class BoundedMemoryStream : MemoryStream
        {
            private readonly int _limit;

            public BoundedMemoryStream(int limit)
            {
                _limit = limit;
            }

            public override void Write(byte[] buffer, int offset, int count)
            {
                EnsureCapacityFor(count);
                base.Write(buffer, offset, count);
            }

            public override void Write(ReadOnlySpan<byte> buffer)
            {
                EnsureCapacityFor(buffer.Length);
                base.Write(buffer);
            }

            public override void WriteByte(byte value)
            {
                EnsureCapacityFor(1);
                base.WriteByte(value);
            }

            public override Task WriteAsync(
                byte[] buffer,
                int offset,
                int count,
                CancellationToken cancellationToken)
            {
                cancellationToken.ThrowIfCancellationRequested();
                Write(buffer, offset, count);
                return Task.CompletedTask;
            }

            public override ValueTask WriteAsync(
                ReadOnlyMemory<byte> buffer,
                CancellationToken cancellationToken = default)
            {
                cancellationToken.ThrowIfCancellationRequested();
                Write(buffer.Span);
                return ValueTask.CompletedTask;
            }

            private void EnsureCapacityFor(int count)
            {
                if (count > _limit - Position)
                {
                    throw new BodyLimitExceededException();
                }
            }
        }

        private sealed class BodyLimitExceededException : Exception
        {
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
