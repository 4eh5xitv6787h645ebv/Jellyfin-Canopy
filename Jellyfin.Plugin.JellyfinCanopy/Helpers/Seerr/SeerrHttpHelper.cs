using System;
using System.Buffers;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr
{
    public enum SeerrErrorCode
    {
        Ok = 0,
        Unreachable,
        Unauthorized,
        Forbidden,
        UserUnlinked,
        UserBlocked,
        HtmlResponse,
        UpstreamRedirect,
        Cloudflare5xx,
        UpstreamError,
        QuotaExceeded,
        AlreadyRequested,
        Blocklisted,
        ParseError,
        ResponseTooLarge,
        Timeout,
        UrlNotAllowed,
        ConfigInvalid,
    }

    // Message holds the technical text (URL, cf-ray, status) for admins/logs.
    // UserMessage is plain English for non-admin callers — never leaks the URL.
    public class SeerrError
    {
        public SeerrErrorCode Code { get; set; }
        public int HttpStatus { get; set; }
        public string Message { get; set; } = string.Empty;
        public string UserMessage { get; set; } = string.Empty;
        public string? CfRay { get; set; }
        public string? Url { get; set; }

        public object ToResponseShape() => new
        {
            error = true,
            code = Code.ToString(),
            httpStatus = HttpStatus,
            message = !string.IsNullOrEmpty(UserMessage) ? UserMessage : DefaultUserMessage(Code),
        };

        public object ToAdminResponseShape() => new
        {
            error = true,
            code = Code.ToString(),
            httpStatus = HttpStatus,
            message = Message,
            cfRay = CfRay,
            url = Url,
        };

        private static string DefaultUserMessage(SeerrErrorCode code) => code switch
        {
            SeerrErrorCode.Unreachable       => "Can't reach Seerr right now. Please try again in a moment.",
            SeerrErrorCode.Unauthorized      => "Seerr couldn't sign in. Ask your administrator to check the Seerr settings.",
            SeerrErrorCode.Forbidden         => "Seerr declined the request. Ask your administrator to check your account permissions.",
            SeerrErrorCode.UserUnlinked      => "Your Seerr account isn't linked yet. Sign in to Seerr once to enable requests.",
            SeerrErrorCode.UserBlocked       => "Your administrator has disabled Seerr for your account.",
            SeerrErrorCode.HtmlResponse      => "Seerr is unreachable. Ask your administrator to check the connection.",
            SeerrErrorCode.UpstreamRedirect  => "Seerr is unreachable. Ask your administrator to check the connection.",
            SeerrErrorCode.Cloudflare5xx     => "Seerr is having connection issues. Please try again in a moment.",
            SeerrErrorCode.UpstreamError     => "Seerr returned an error. Please try again in a moment.",
            SeerrErrorCode.QuotaExceeded     => "Your Seerr request quota has been reached.",
            SeerrErrorCode.AlreadyRequested  => "This title is already requested.",
            SeerrErrorCode.Blocklisted       => "This title is blocked by Seerr policy.",
            SeerrErrorCode.ParseError        => "Got an unexpected response from Seerr. Please try again in a moment.",
            SeerrErrorCode.ResponseTooLarge  => "Seerr returned too much data. Please try again in a moment.",
            SeerrErrorCode.Timeout           => "Seerr took too long to respond. Please try again in a moment.",
            SeerrErrorCode.UrlNotAllowed     => "Seerr is not configured correctly. Ask your administrator to check the Seerr URL.",
            SeerrErrorCode.ConfigInvalid     => "Seerr is not configured. Ask your administrator to set it up.",
            _                                => "Seerr is unavailable right now.",
        };

        public static string SanitizeMessage(string message)
        {
            if (string.IsNullOrEmpty(message)) return message;
            return System.Text.RegularExpressions.Regex.Replace(
                message,
                @"https?://(?:\[[^\]\s]+\]|[^\s)\]""'<>/]+)(?:[^\s)\]""'<>]*?)(?=[.,;:!?)\]""'>]*(?:\s|$))",
                "<seerr-url>",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase
            );
        }
    }

    /// <summary>
    /// Typed evidence that the opaque saved-generation fence rejected a request
    /// before transport <c>SendAsync</c> was invoked.
    /// </summary>
    internal sealed class SeerrDispatchNotAttemptedException : InvalidOperationException
    {
        internal SeerrDispatchNotAttemptedException()
            : base("The Seerr dispatch fence rejected the request before transport dispatch.")
        {
        }
    }

    public static class SeerrHttpHelper
    {
        public static string UserAgent { get; set; } = "JellyfinCanopy/unknown";

        // Named client registered with AllowAutoRedirect=false so a 302 to a
        // login URL is detected (UpstreamRedirect) instead of being followed
        // and producing a 200 + login-page HTML body.
        public const string NamedClient = "JellyfinCanopySeerr";

        public static HttpClient CreateClient(IHttpClientFactory factory)
        {
            try { return factory.CreateClient(NamedClient); }
            catch { return factory.CreateClient(); }
        }

        internal const int MaxBodyBytes = 8 * 1024 * 1024;
        internal const int MaxErrorBodyBytes = 64 * 1024;
        private const int ReadBufferBytes = 64 * 1024;
        private static readonly UTF8Encoding StrictUtf8 = new(false, true);

        public static HttpRequestMessage BuildRequest(
            HttpMethod method,
            string url,
            string apiKey,
            string? apiUserId = null,
            string? bodyJson = null)
        {
            var req = new HttpRequestMessage(method, url);
            req.Headers.UserAgent.ParseAdd(UserAgent);
            req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            req.Headers.Add("X-Api-Key", apiKey);
            if (!string.IsNullOrEmpty(apiUserId))
            {
                req.Headers.Add("X-Api-User", apiUserId);
            }
            if (bodyJson != null)
            {
                req.Content = new StringContent(bodyJson, Encoding.UTF8, "application/json");
            }
            return req;
        }

        public static bool IsJsonContentType(HttpResponseMessage response)
        {
            var ct = response.Content.Headers.ContentType?.MediaType;
            if (string.IsNullOrEmpty(ct)) return false;
            return ct.Equals("application/json", StringComparison.OrdinalIgnoreCase)
                || (ct.StartsWith("application/", StringComparison.OrdinalIgnoreCase) && ct.EndsWith("+json", StringComparison.OrdinalIgnoreCase));
        }

        internal static Task<HttpResponseMessage> SendResponseHeadersReadAsync(
            HttpClient httpClient,
            HttpRequestMessage request,
            SeerrDispatchFence dispatchFence,
            CancellationToken ct = default)
            => dispatchFence.CanDispatch(request.RequestUri)
                ? httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)
                : Task.FromException<HttpResponseMessage>(
                    new SeerrDispatchNotAttemptedException());

        public static Task<(string? Json, SeerrError? Error, int HttpStatus)> SendAndReadJsonAsync(
            HttpClient httpClient,
            HttpRequestMessage request,
            string url,
            SeerrDispatchFence dispatchFence,
            CancellationToken ct = default)
            => SendAndReadJsonCoreAsync(
                httpClient,
                request,
                url,
                MaxBodyBytes,
                dispatchFence,
                responseHeadersObserved: null,
                ct);

        internal static Task<(string? Json, SeerrError? Error, int HttpStatus)> SendAndReadJsonAsync(
            HttpClient httpClient,
            HttpRequestMessage request,
            string url,
            SeerrDispatchFence dispatchFence,
            Func<HttpResponseMessage, bool> responseHeadersObserved,
            CancellationToken ct = default)
            => SendAndReadJsonCoreAsync(
                httpClient,
                request,
                url,
                MaxBodyBytes,
                dispatchFence,
                responseHeadersObserved,
                ct);

        internal static Task<(string? Json, SeerrError? Error, int HttpStatus)> SendAndReadJsonAsync(
            HttpClient httpClient,
            HttpRequestMessage request,
            string url,
            int maxBodyBytes,
            SeerrDispatchFence dispatchFence,
            CancellationToken ct = default)
            => SendAndReadJsonCoreAsync(
                httpClient,
                request,
                url,
                maxBodyBytes,
                dispatchFence,
                responseHeadersObserved: null,
                ct);

        private static async Task<(string? Json, SeerrError? Error, int HttpStatus)> SendAndReadJsonCoreAsync(
            HttpClient httpClient,
            HttpRequestMessage request,
            string url,
            int maxBodyBytes,
            SeerrDispatchFence dispatchFence,
            Func<HttpResponseMessage, bool>? responseHeadersObserved,
            CancellationToken ct)
        {
            using var response = await SendResponseHeadersReadAsync(
                httpClient,
                request,
                dispatchFence,
                ct).ConfigureAwait(false);
            // This synchronous boundary runs immediately after the upstream
            // response headers arrive and before RequestAborted is observed by
            // the bounded body reader. Mutation owners can durably record a
            // confirmed 2xx side effect here without bypassing the shared
            // timeout, cancellation, content-type, and body-size protections.
            if (responseHeadersObserved?.Invoke(response) == false)
            {
                return (null, null, (int)response.StatusCode);
            }
            var (json, error) = await ReadResponseAsync(response, url, maxBodyBytes, ct).ConfigureAwait(false);
            return (json, error, (int)response.StatusCode);
        }

        /// <summary>
        /// Setup-only transport for an exact elevated endpoint validating
        /// caller-supplied, not-yet-saved credentials. Normal saved-integration
        /// traffic must use the fence-requiring overload above.
        /// </summary>
        internal static async Task<(string? Json, SeerrError? Error, int HttpStatus)> SendSetupAndReadJsonAsync(
            HttpClient httpClient,
            HttpRequestMessage request,
            string url,
            CancellationToken ct = default)
        {
            using var response = await httpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                ct).ConfigureAwait(false);
            var (json, error) = await ReadResponseAsync(response, url, MaxBodyBytes, ct).ConfigureAwait(false);
            return (json, error, (int)response.StatusCode);
        }

        internal static Task<(string? Json, SeerrError? Error)> ReadResponseAsync(
            HttpResponseMessage response,
            string url,
            CancellationToken ct = default)
            => ReadResponseAsync(response, url, MaxBodyBytes, ct);

        internal static async Task<(string? Json, SeerrError? Error)> ReadResponseAsync(
            HttpResponseMessage response,
            string url,
            int maxBodyBytes,
            CancellationToken ct = default)
        {
            ArgumentOutOfRangeException.ThrowIfNegative(maxBodyBytes);

            string? cfRay = null;
            if (response.Headers.TryGetValues("cf-ray", out var rays))
            {
                foreach (var r in rays) { cfRay = r; break; }
            }

            int status = (int)response.StatusCode;
            if (status >= 520 && status <= 530)
            {
                return (null, new SeerrError
                {
                    Code = SeerrErrorCode.Cloudflare5xx,
                    HttpStatus = status,
                    CfRay = cfRay,
                    Url = url,
                    Message = $"Cloudflare returned {status} for {url}. Check Cloudflare logs (cf-ray={cfRay ?? "n/a"}).",
                    UserMessage = "Seerr is having connection issues. Please try again in a moment."
                });
            }

            if (status >= 300 && status < 400 && response.Headers.Location != null)
            {
                return (null, new SeerrError
                {
                    Code = SeerrErrorCode.UpstreamRedirect,
                    HttpStatus = status,
                    CfRay = cfRay,
                    Url = url,
                    Message = $"Got redirect to {response.Headers.Location} — likely a reverse-proxy auth challenge. Configure your proxy to bypass auth for the Jellyfin server's IP.",
                    UserMessage = "Seerr is unreachable. Ask your administrator to check the connection."
                });
            }

            // HTML when JSON expected = reverse-proxy auth challenge intercepting
            // the request. Reject before reading or attempting to parse.
            if (!IsJsonContentType(response))
            {
                return (null, new SeerrError
                {
                    Code = SeerrErrorCode.HtmlResponse,
                    HttpStatus = status,
                    CfRay = cfRay,
                    Url = url,
                    Message = $"Seerr returned non-JSON response (Content-Type: {response.Content.Headers.ContentType?.MediaType ?? "n/a"}). This usually means Cloudflare, Pangolin, or another reverse-proxy intercepted the request. Configure your proxy to bypass auth challenges for the Jellyfin server's IP.",
                    UserMessage = "Seerr is unreachable. Ask your administrator to check the connection."
                });
            }

            // Error bodies are read through their own much smaller streaming
            // cap. Seerr uses the same 403 for permission, quota, and
            // blocklist failures; retaining only a bounded message long enough
            // to classify those outcomes lets body-blind native SDKs receive a
            // useful status/outcome without exposing the upstream body.
            if (!response.IsSuccessStatusCode)
            {
                var (errorBytes, observedErrorBytes) = await ReadBoundedBodyAsync(
                    response.Content,
                    MaxErrorBodyBytes,
                    ct).ConfigureAwait(false);
                if (errorBytes == null)
                {
                    return (null, ResponseTooLarge(
                        url,
                        status,
                        cfRay,
                        MaxErrorBodyBytes,
                        observedErrorBytes));
                }

                var upstreamMessage = TryReadErrorMessage(errorBytes);
                if (status == 401)
                {
                    return (null, new SeerrError
                    {
                        Code = SeerrErrorCode.Unauthorized,
                        HttpStatus = 401,
                        CfRay = cfRay,
                        Url = url,
                        Message = "Seerr rejected the API key. Check the key has not been rotated and matches the Seerr install.",
                        UserMessage = "Seerr couldn't sign in. Ask your administrator to check the Seerr settings."
                    });
                }

                if (status == 403)
                {
                    var classified = ClassifyRequestError(url, status, upstreamMessage);
                    return (null, new SeerrError
                    {
                        Code = classified,
                        HttpStatus = 403,
                        CfRay = cfRay,
                        Url = url,
                        Message = classified switch
                        {
                            SeerrErrorCode.QuotaExceeded => "Seerr rejected the request because its quota was exceeded.",
                            SeerrErrorCode.Blocklisted => "Seerr rejected the request because the media is blocklisted.",
                            _ => "Seerr returned 403. Common causes: API key rotated, user lacks permission, or CSRF protection enabled in Seerr.",
                        },
                        UserMessage = classified switch
                        {
                            SeerrErrorCode.QuotaExceeded => "Your Seerr request quota has been reached.",
                            SeerrErrorCode.Blocklisted => "This title is blocked by Seerr policy.",
                            _ => "Seerr declined the request. Ask your administrator to check your account permissions.",
                        },
                    });
                }

                var requestError = ClassifyRequestError(url, status, upstreamMessage);

                return (null, new SeerrError
                {
                    Code = requestError,
                    HttpStatus = status,
                    CfRay = cfRay,
                    Url = url,
                    Message = requestError == SeerrErrorCode.AlreadyRequested
                        ? $"Seerr reported that the media is already requested ({status}) at {url}."
                        : $"Seerr returned {status} from {url}.",
                    UserMessage = requestError == SeerrErrorCode.AlreadyRequested
                        ? "This title is already requested."
                        : "Seerr returned an error. Please try again in a moment."
                });
            }

            var (bodyBytes, observedBytes) = await ReadBoundedBodyAsync(
                response.Content,
                maxBodyBytes,
                ct).ConfigureAwait(false);
            if (bodyBytes == null)
            {
                return (null, ResponseTooLarge(url, status, cfRay, maxBodyBytes, observedBytes));
            }

            string bodyText;
            try
            {
                using var _ = JsonDocument.Parse(bodyBytes);
                bodyText = StrictUtf8.GetString(bodyBytes);
            }
            catch (Exception ex) when (ex is JsonException or DecoderFallbackException)
            {
                return (null, new SeerrError
                {
                    Code = SeerrErrorCode.ParseError,
                    HttpStatus = 502,
                    CfRay = cfRay,
                    Url = url,
                    Message = $"Failed to parse complete Seerr response JSON from {url}: {ex.Message}",
                    UserMessage = "Got an unexpected response from Seerr. Please try again in a moment."
                });
            }

            return (bodyText, null);
        }

        private static async Task<(byte[]? Bytes, long? ObservedBytes)> ReadBoundedBodyAsync(
            HttpContent content,
            int maximumBytes,
            CancellationToken cancellationToken)
        {
            var declaredLength = content.Headers.ContentLength;
            if (declaredLength > maximumBytes)
            {
                return (null, declaredLength);
            }

            var readBuffer = ArrayPool<byte>.Shared.Rent(Math.Min(ReadBufferBytes, maximumBytes + 1));
            try
            {
                using var body = new MemoryStream(
                    declaredLength.HasValue
                        ? Math.Min(checked((int)declaredLength.Value), ReadBufferBytes)
                        : Math.Min(8192, maximumBytes));
                using var stream = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
                while (true)
                {
                    var remainingWithSentinel = (long)maximumBytes + 1 - body.Length;
                    if (remainingWithSentinel <= 0)
                    {
                        return (null, body.Length);
                    }

                    var readSize = (int)Math.Min(readBuffer.Length, remainingWithSentinel);
                    var read = await stream.ReadAsync(
                        readBuffer.AsMemory(0, readSize),
                        cancellationToken).ConfigureAwait(false);
                    if (read == 0)
                    {
                        break;
                    }

                    body.Write(readBuffer, 0, read);
                }

                return body.Length > maximumBytes
                    ? (null, body.Length)
                    : (body.ToArray(), body.Length);
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(readBuffer);
            }
        }

        private static string? TryReadErrorMessage(byte[] body)
        {
            try
            {
                using var document = JsonDocument.Parse(body);
                return document.RootElement.ValueKind == JsonValueKind.Object
                    && document.RootElement.TryGetProperty("message", out var message)
                    && message.ValueKind == JsonValueKind.String
                        ? message.GetString()
                        : null;
            }
            catch (JsonException)
            {
                return null;
            }
        }

        private static SeerrErrorCode ClassifyRequestError(
            string url,
            int status,
            string? message)
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)
                || !string.Equals(
                    uri.AbsolutePath.TrimEnd('/'),
                    "/api/v1/request",
                    StringComparison.OrdinalIgnoreCase))
            {
                return status == 403
                    ? SeerrErrorCode.Forbidden
                    : SeerrErrorCode.UpstreamError;
            }

            if (status == 409)
            {
                return SeerrErrorCode.AlreadyRequested;
            }

            if (message?.Contains("quota", StringComparison.OrdinalIgnoreCase) == true
                && message.Contains("exceed", StringComparison.OrdinalIgnoreCase))
            {
                return SeerrErrorCode.QuotaExceeded;
            }

            if (message?.Contains("blocklist", StringComparison.OrdinalIgnoreCase) == true)
            {
                return SeerrErrorCode.Blocklisted;
            }

            return status == 403
                ? SeerrErrorCode.Forbidden
                : SeerrErrorCode.UpstreamError;
        }

        private static SeerrError ResponseTooLarge(
            string url,
            int status,
            string? cfRay,
            int maxBodyBytes,
            long? observedBytes) => new()
            {
                Code = SeerrErrorCode.ResponseTooLarge,
                HttpStatus = 502,
                CfRay = cfRay,
                Url = url,
                Message = $"Seerr response from {url} (upstream HTTP {status}) exceeded the {maxBodyBytes}-byte limit"
                    + (observedBytes.HasValue ? $" ({observedBytes.Value} bytes observed)." : "."),
                UserMessage = "Seerr returned too much data. Please try again in a moment."
            };

        public static (T? Result, SeerrError? Error) TryDeserialize<T>(string json, string url)
        {
            try
            {
                var result = JsonSerializer.Deserialize<T>(json);
                return (result, null);
            }
            catch (JsonException ex)
            {
                return (default, new SeerrError
                {
                    Code = SeerrErrorCode.ParseError,
                    HttpStatus = 0,
                    Url = url,
                    Message = $"Failed to parse Seerr response as {typeof(T).Name}: {ex.Message}",
                    UserMessage = "Got an unexpected response from Seerr. Please try again in a moment."
                });
            }
        }
    }
}
