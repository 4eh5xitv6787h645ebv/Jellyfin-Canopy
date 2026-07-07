using System.Net;
using System.Text;
using Jellyfin.Plugin.JellyfinElevate.Helpers.Jellyseerr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Helpers;

/// <summary>
/// Covers the pure response-classification and message-sanitization logic in
/// <see cref="SeerrHttpHelper"/> / <see cref="SeerrError"/>. These paths decide
/// what error text reaches non-admin users, so URL leaking is the key concern.
/// </summary>
public class SeerrHttpHelperTests
{
    private static HttpResponseMessage JsonResponse(HttpStatusCode status, string body = "{}")
    {
        return new HttpResponseMessage(status)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
    }

    [Fact]
    public async Task ReadResponseAsync_SuccessJson_ReturnsBodyWithoutError()
    {
        using var response = JsonResponse(HttpStatusCode.OK, """{"ok":true}""");

        var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, "http://seerr/api");

        Assert.Null(error);
        Assert.Equal("""{"ok":true}""", json);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, SeerrErrorCode.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden, SeerrErrorCode.Forbidden)]
    [InlineData(HttpStatusCode.InternalServerError, SeerrErrorCode.UpstreamError)]
    public async Task ReadResponseAsync_ErrorStatuses_MapToExpectedCodes(HttpStatusCode status, SeerrErrorCode expected)
    {
        using var response = JsonResponse(status);

        var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, "http://seerr/api");

        Assert.Null(json);
        Assert.NotNull(error);
        Assert.Equal(expected, error!.Code);
        Assert.Equal((int)status, error.HttpStatus);
    }

    [Fact]
    public async Task ReadResponseAsync_HtmlBody_IsClassifiedAsHtmlResponse()
    {
        // A reverse proxy intercepting the request returns 200 + HTML login page;
        // this must be rejected, not parsed as JSON.
        using var response = new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("<html>login</html>", Encoding.UTF8, "text/html"),
        };

        var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, "http://seerr/api");

        Assert.Null(json);
        Assert.Equal(SeerrErrorCode.HtmlResponse, error!.Code);
    }

    [Fact]
    public async Task ReadResponseAsync_RedirectWithLocation_IsUpstreamRedirect()
    {
        using var response = JsonResponse(HttpStatusCode.Found);
        response.Headers.Location = new Uri("http://proxy/login");

        var (_, error) = await SeerrHttpHelper.ReadResponseAsync(response, "http://seerr/api");

        Assert.Equal(SeerrErrorCode.UpstreamRedirect, error!.Code);
    }

    [Fact]
    public async Task ReadResponseAsync_CloudflareStatus_IsCloudflare5xxWithCfRay()
    {
        using var response = JsonResponse((HttpStatusCode)522);
        response.Headers.Add("cf-ray", "abc123-LHR");

        var (_, error) = await SeerrHttpHelper.ReadResponseAsync(response, "http://seerr/api");

        Assert.Equal(SeerrErrorCode.Cloudflare5xx, error!.Code);
        Assert.Equal("abc123-LHR", error.CfRay);
    }

    [Theory]
    [InlineData("application/json", true)]
    [InlineData("application/problem+json", true)]
    [InlineData("text/html", false)]
    [InlineData("text/plain", false)]
    public void IsJsonContentType_ClassifiesMediaTypes(string mediaType, bool expected)
    {
        using var response = new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("x", Encoding.UTF8, mediaType),
        };

        Assert.Equal(expected, SeerrHttpHelper.IsJsonContentType(response));
    }

    [Fact]
    public void TryDeserialize_InvalidJson_ReturnsParseErrorNotException()
    {
        var (result, error) = SeerrHttpHelper.TryDeserialize<Dictionary<string, string>>("{broken", "http://seerr/api");

        Assert.Null(result);
        Assert.Equal(SeerrErrorCode.ParseError, error!.Code);
    }
}

/// <summary>Sanitization of admin-facing messages before they reach non-admin users.</summary>
public class SeerrErrorSanitizeTests
{
    [Theory]
    [InlineData("Seerr returned 502 from http://192.168.0.84:5056/api/v1/status.",
                "Seerr returned 502 from <seerr-url>.")]
    [InlineData("redirect to https://seerr.example.com/login detected",
                "redirect to <seerr-url> detected")]
    [InlineData("no urls here", "no urls here")]
    [InlineData("", "")]
    public void SanitizeMessage_ReplacesUrlsAndPreservesPunctuation(string input, string expected)
    {
        Assert.Equal(expected, SeerrError.SanitizeMessage(input));
    }

    [Fact]
    public void ToResponseShape_UsesUserMessageNeverTechnicalMessage()
    {
        var error = new SeerrError
        {
            Code = SeerrErrorCode.UpstreamError,
            HttpStatus = 502,
            Message = "Seerr returned 502 from http://internal-host:5055/api.",
            UserMessage = "Seerr returned an error. Please try again in a moment.",
        };

        var shape = error.ToResponseShape();
        var messageProp = shape.GetType().GetProperty("message")!.GetValue(shape) as string;

        Assert.DoesNotContain("internal-host", messageProp);
        Assert.Equal(error.UserMessage, messageProp);
    }
}
