using System.Net;
using System.Reflection;
using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class SeerrScanTriggerControllerTests
{
    [Fact]
    public void ManualEndpoint_RequiresElevationPolicy()
    {
        var method = typeof(SeerrScanTriggerController).GetMethod(
            nameof(SeerrScanTriggerController.TriggerSeerrRecentlyAddedScan),
            BindingFlags.Public | BindingFlags.Instance);

        var authorize = Assert.Single(method!.GetCustomAttributes<AuthorizeAttribute>());
        Assert.Equal(Policies.RequiresElevation, authorize.Policy);
    }

    [Fact]
    public async Task ManualEndpoint_UsesOwnedWorkerAndReportsSuccess()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse(
            "/api/v1/settings/jobs/jellyfin-recently-added-scan/run",
            "{}");
        using var service = CreateService(handler, "http://localhost:5055", "key");
        var controller = CreateController(service);

        var action = await controller.TriggerSeerrRecentlyAddedScan(
            "http://localhost:5055/",
            "key");

        Assert.IsType<OkObjectResult>(action);
        var request = Assert.Single(handler.Sent);
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("/api/v1/settings/jobs/jellyfin-recently-added-scan/run", request.Path);
        Assert.Equal("{}", request.Body);
    }

    [Fact]
    public async Task ManualEndpoint_PreservesTypedUpstreamStatus()
    {
        using var service = CreateService(
            new JsonFailureHandler(HttpStatusCode.Unauthorized),
            "http://localhost:5055",
            "bad-key");
        var controller = CreateController(service);

        var action = await controller.TriggerSeerrRecentlyAddedScan(
            "http://localhost:5055",
            "bad-key");

        var result = Assert.IsType<ObjectResult>(action);
        Assert.Equal(StatusCodes.Status401Unauthorized, result.StatusCode);
    }

    [Fact]
    public async Task CurrentManualEndpoint_DispatchesAllDomainsInOneOwnedBatch()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse(
            "/api/v1/settings/jobs/jellyfin-recently-added-scan/run",
            "{}");
        using var service = CreateService(
            handler,
            "http://localhost:5055,http://127.0.0.1:5055",
            "key");
        var controller = CreateController(service);

        var action = await controller.TriggerSeerrRecentlyAddedScan(
            url: null,
            apiKey: "key",
            urls: "http://localhost:5055,http://127.0.0.1:5055");

        Assert.IsType<OkObjectResult>(action);
        Assert.Equal(2, handler.Sent.Count);
    }

    [Fact]
    public async Task ManualEndpoint_ServiceStopping_ReturnsServiceUnavailable()
    {
        var service = CreateService(
            new JsonFailureHandler(HttpStatusCode.OK),
            "http://localhost:5055",
            "key");
        service.Dispose();
        var controller = CreateController(service);

        var action = await controller.TriggerSeerrRecentlyAddedScan(
            "http://localhost:5055",
            "key");

        var result = Assert.IsType<ObjectResult>(action);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, result.StatusCode);
    }

    private static SeerrScanTriggerService CreateService(
        HttpMessageHandler handler,
        string urls,
        string apiKey)
        => new(
            new CountingLibraryManager(),
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrScanTriggerService>.Instance,
            new FakePluginConfigProvider(new PluginConfiguration
            {
                SeerrEnabled = true,
                SeerrUrls = urls,
                SeerrApiKey = apiKey,
            }));

    private static SeerrScanTriggerController CreateController(SeerrScanTriggerService service)
        => new(service, NullLogger<SeerrScanTriggerController>.Instance)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext(),
            },
        };

    private sealed class JsonFailureHandler : HttpMessageHandler
    {
        private readonly HttpStatusCode _statusCode;

        public JsonFailureHandler(HttpStatusCode statusCode) => _statusCode = statusCode;

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => Task.FromResult(new HttpResponseMessage(_statusCode)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json"),
            });
    }
}
