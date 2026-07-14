using System.Net;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class SeerrScanTriggerServiceTests
{
    [Fact]
    public void ParseUrls_NormalizesDocumentedSeparatorsAndDeduplicatesAliases()
    {
        var urls = SeerrScanTriggerService.ParseUrls(
            " http://first:5055/\r\nhttp://second:5055, http://first:5055\nhttp://second:5055/ ");

        Assert.Equal(new[] { "http://first:5055", "http://second:5055" }, urls);
    }

    [Fact]
    public void ParseUrls_PreservesPathCaseAsDistinctIdentityDomains()
    {
        var urls = SeerrScanTriggerService.ParseUrls(
            "http://seerr:5055/Tenant,http://seerr:5055/tenant");

        Assert.Equal(
            new[] { "http://seerr:5055/Tenant", "http://seerr:5055/tenant" },
            urls);
    }

    [Fact]
    public async Task ScheduledDispatch_FeatureDisabledBeforeTimerFires_DoesNotPost()
    {
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = false,
            TriggerSeerrScanOnItemAdded = false,
            SeerrUrls = "http://first:5055",
            SeerrApiKey = "key",
        });
        var handler = new SwitchingHandler();
        using var service = CreateService(provider, handler);

        var results = await service.DispatchAsync(batchSize: 1);

        Assert.Empty(results);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task MultiDomainDispatch_ConfigChangesDuringFirstPost_StopsRemainingDomains()
    {
        var provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = true,
            TriggerSeerrScanOnItemAdded = true,
            SeerrUrls = "http://first:5055,http://second:5055",
            SeerrApiKey = "key-a",
        });
        var handler = new SwitchingHandler(() => provider.Current = new PluginConfiguration
        {
            SeerrEnabled = true,
            TriggerSeerrScanOnItemAdded = true,
            SeerrUrls = "http://replacement:5055",
            SeerrApiKey = "key-b",
        });
        using var service = CreateService(provider, handler);

        var results = await service.DispatchAsync(batchSize: 1);

        Assert.Single(results);
        var request = Assert.Single(handler.Requests);
        Assert.Equal("first", request.Host);
        Assert.Equal("key-a", request.ApiKey);
    }

    private static SeerrScanTriggerService CreateService(
        FakePluginConfigProvider provider,
        HttpMessageHandler handler)
        => new(
            new CountingLibraryManager(),
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrScanTriggerService>.Instance,
            provider);

    private sealed class SwitchingHandler : HttpMessageHandler
    {
        private readonly Action? _onFirstRequest;

        public SwitchingHandler(Action? onFirstRequest = null)
        {
            _onFirstRequest = onFirstRequest;
        }

        public List<CapturedRequest> Requests { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var apiKey = request.Headers.TryGetValues("X-Api-Key", out var values)
                ? values.SingleOrDefault()
                : null;
            Requests.Add(new CapturedRequest(request.RequestUri!.Host, apiKey));
            if (Requests.Count == 1)
            {
                _onFirstRequest?.Invoke();
            }

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{}"),
            });
        }
    }

    private sealed record CapturedRequest(string Host, string? ApiKey);
}
