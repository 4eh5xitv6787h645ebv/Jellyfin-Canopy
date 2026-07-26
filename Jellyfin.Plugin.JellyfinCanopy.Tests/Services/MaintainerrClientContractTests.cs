using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services.Maintainerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class MaintainerrClientContractTests
{
    private const string BaseUrl = "http://127.0.0.1:6246/maintainerr";
    private const string MachineId = "0123456789abcdef0123456789abcdef";

    [Fact]
    public void EndpointBuilder_PreservesBasePathAndPinsOneBasedCollectionQuery()
    {
        Assert.True(MaintainerrClient.TryBuildEndpoint(
            BaseUrl,
            MaintainerrClient.MaintainerrEndpoint.CollectionContent,
            [42, 1, 25, "deleteSoonest", "asc"],
            out var target,
            out _));

        Assert.Equal(
            $"{BaseUrl}/api/collections/media/42/content/1?size=25&sort=deleteSoonest&sortOrder=asc",
            target.AbsoluteUri);
        Assert.False(MaintainerrClient.TryBuildEndpoint(
            BaseUrl,
            MaintainerrClient.MaintainerrEndpoint.CollectionContent,
            [42, 0, 25, "deleteSoonest", "asc"],
            out _,
            out _));
        Assert.False(MaintainerrClient.TryBuildEndpoint(
            BaseUrl,
            MaintainerrClient.MaintainerrEndpoint.CollectionContent,
            [42, 1, 51, "deleteSoonest", "asc"],
            out _,
            out _));
        Assert.False(MaintainerrClient.TryBuildEndpoint(
            BaseUrl,
            MaintainerrClient.MaintainerrEndpoint.CollectionContent,
            [42, 1, 25, "title", "asc"],
            out _,
            out _));
        Assert.True(MaintainerrClient.TryBuildEndpoint(
            BaseUrl,
            MaintainerrClient.MaintainerrEndpoint.CollectionContent,
            [42, 20_000, 50, "deleteSoonest", "asc"],
            out _,
            out _));
        Assert.False(MaintainerrClient.TryBuildEndpoint(
            BaseUrl,
            MaintainerrClient.MaintainerrEndpoint.CollectionContent,
            [42, 20_001, 50, "deleteSoonest", "asc"],
            out _,
            out _));
        Assert.False(MaintainerrClient.TryBuildEndpoint(
            BaseUrl,
            MaintainerrClient.MaintainerrEndpoint.CollectionContent,
            [42, 1_000_001, 1, "deleteSoonest", "asc"],
            out _,
            out _));
    }

    [Fact]
    public void EndpointInventory_IsTheExactClosedGetOnlyV318Contract()
    {
        const string itemId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        var expected = new Dictionary<
            MaintainerrClient.MaintainerrEndpoint,
            (object[] RouteValues, string SpecPath, string PathAndQuery, int MaximumBytes, bool AllowHtml, bool Optional)>
        {
            [MaintainerrClient.MaintainerrEndpoint.HealthReady] =
                ([], "/api/health/ready", "/maintainerr/api/health/ready", MaintainerrClient.SmallResponseBytes, false, false),
            [MaintainerrClient.MaintainerrEndpoint.AppStatus] =
                ([], "/api/app/status", "/maintainerr/api/app/status", MaintainerrClient.SmallResponseBytes, true, false),
            [MaintainerrClient.MaintainerrEndpoint.MediaServerType] =
                ([], "/api/media-server/type", "/maintainerr/api/media-server/type", MaintainerrClient.SmallResponseBytes, false, false),
            [MaintainerrClient.MaintainerrEndpoint.MediaServerIdentity] =
                ([], "/api/media-server", "/maintainerr/api/media-server", MaintainerrClient.SmallResponseBytes, false, false),
            [MaintainerrClient.MaintainerrEndpoint.StorageMetrics] =
                ([], "/api/storage-metrics", "/maintainerr/api/storage-metrics", MaintainerrClient.LargeResponseBytes, false, true),
            [MaintainerrClient.MaintainerrEndpoint.OverlayStatus] =
                ([], "/api/overlays/status", "/maintainerr/api/overlays/status", MaintainerrClient.SmallResponseBytes, false, true),
            [MaintainerrClient.MaintainerrEndpoint.RuleCount] =
                ([], "/api/rules/count", "/maintainerr/api/rules/count", MaintainerrClient.SmallResponseBytes, false, true),
            [MaintainerrClient.MaintainerrEndpoint.RuleExecutionStatus] =
                ([], "/api/rules/execute/status", "/maintainerr/api/rules/execute/status", MaintainerrClient.SmallResponseBytes, false, true),
            [MaintainerrClient.MaintainerrEndpoint.Collections] =
                ([], "/api/collections", "/maintainerr/api/collections", MaintainerrClient.LargeResponseBytes, false, false),
            [MaintainerrClient.MaintainerrEndpoint.CollectionContent] =
                ([42, 1, 25, "deleteSoonest", "asc"], string.Empty, "/maintainerr/api/collections/media/42/content/1?size=25&sort=deleteSoonest&sortOrder=asc", MaintainerrClient.LargeResponseBytes, false, true),
            [MaintainerrClient.MaintainerrEndpoint.ItemStatus] =
                ([itemId], string.Empty, $"/maintainerr/api/media-server/meta/{itemId}/maintainerr-status", MaintainerrClient.SmallResponseBytes, false, false),
        };

        Assert.Equal(
            Enum.GetValues<MaintainerrClient.MaintainerrEndpoint>(),
            expected.Keys);
        foreach (var (endpoint, contract) in expected)
        {
            Assert.True(MaintainerrClient.TryBuildEndpoint(
                BaseUrl,
                endpoint,
                contract.RouteValues,
                out var target,
                out var spec));
            Assert.Equal(contract.SpecPath, spec.Path);
            Assert.Equal(contract.PathAndQuery, target.PathAndQuery);
            Assert.Equal(contract.MaximumBytes, spec.MaximumBytes);
            Assert.Equal(contract.AllowHtml, spec.AllowTextHtmlJson);
            Assert.Equal(contract.Optional, spec.Optional);
        }

        var allowedPaths = expected.Values.Select(contract => contract.PathAndQuery).ToArray();
        Assert.DoesNotContain(allowedPaths, path => path.EndsWith("/api/settings", StringComparison.Ordinal));
        Assert.DoesNotContain(allowedPaths, path => path.EndsWith("/api/rules", StringComparison.Ordinal));
        Assert.DoesNotContain(allowedPaths, path => path.Contains("/api/logs", StringComparison.Ordinal));
        Assert.DoesNotContain(allowedPaths, path => path.Contains("/api/collections/collection/", StringComparison.Ordinal));
        Assert.DoesNotContain(allowedPaths, path => path.EndsWith("/api/rules/execute", StringComparison.Ordinal));
        Assert.DoesNotContain(allowedPaths, path => path.Contains("/delete", StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData("/collections/1", true)]
    [InlineData("/collections/42/exclusions", true)]
    [InlineData("/collections/0", false)]
    [InlineData("/collections/1/rules", false)]
    [InlineData("/collections/%31", false)]
    [InlineData("/collections/%252e%252e", false)]
    [InlineData("/collections/1/%2565xclusions", false)]
    [InlineData("//evil.example/collections/1", false)]
    public void ItemStatusDeepLink_UsesClosedRouteAllowlist(string path, bool expected)
        => Assert.Equal(expected, MaintainerrClient.IsAllowedStatusTarget(path));

    [Fact]
    public async Task Dashboard_CachesSuccess_AndBoundedRefreshNeverForwardsRefreshQuery()
    {
        var handler = new RoutingHandler(SuccessResponse);
        var provider = Provider();
        var client = Client(handler, provider);

        var first = await client.GetDashboardAsync(null, forceRefresh: false, CancellationToken.None);
        Assert.True(first.IsSuccess);
        var firstCount = handler.Requests.Count;

        var cached = await client.GetDashboardAsync(null, forceRefresh: false, CancellationToken.None);
        var throttledRefresh = await client.GetDashboardAsync(null, forceRefresh: true, CancellationToken.None);
        Assert.True(cached.IsSuccess);
        Assert.True(throttledRefresh.IsSuccess);
        Assert.Equal(firstCount, handler.Requests.Count);

        await Task.Delay(MaintainerrClient.DashboardRefreshMinimumInterval + TimeSpan.FromMilliseconds(100));
        var refreshed = await client.GetDashboardAsync(null, forceRefresh: true, CancellationToken.None);
        Assert.True(refreshed.IsSuccess);
        Assert.True(handler.Requests.Count > firstCount);
        Assert.All(handler.Requests, request =>
        {
            Assert.Equal(HttpMethod.Get, request.Method);
            Assert.DoesNotContain("refresh", request.PathAndQuery, StringComparison.OrdinalIgnoreCase);
            Assert.False(request.HasAuthorization);
            Assert.False(request.HasApiKey);
            Assert.False(request.HasCookie);
        });
        Assert.All(handler.Requests, request => Assert.StartsWith("/maintainerr/api/", request.PathAndQuery));
    }

    [Fact]
    public async Task Dashboard_RefreshThrottleIsGenerationOwned()
    {
        var handler = new RoutingHandler(SuccessResponse);
        var provider = Provider();
        var client = Client(handler, provider);
        Assert.True((await client.GetDashboardAsync(null, false, CancellationToken.None)).IsSuccess);
        var firstCount = handler.Requests.Count;

        provider.Current = EnabledConfiguration();
        Assert.True((await client.GetDashboardAsync(null, true, CancellationToken.None)).IsSuccess);

        Assert.True(handler.Requests.Count > firstCount);
    }

    [Fact]
    public async Task Dashboard_FailureBackoffPublishesOnlyExplicitError()
    {
        var handler = new RoutingHandler(request =>
            request.RequestUri!.AbsolutePath.EndsWith("/api/health/ready", StringComparison.Ordinal)
                ? Json("{}", HttpStatusCode.InternalServerError)
                : SuccessResponse(request));
        var client = Client(handler, Provider());

        var first = await client.GetDashboardAsync(null, false, CancellationToken.None);
        var firstCount = handler.Requests.Count;
        var second = await client.GetDashboardAsync(null, false, CancellationToken.None);

        Assert.False(first.IsSuccess);
        Assert.Equal(MaintainerrErrorCode.UpstreamError, first.Error);
        Assert.False(second.IsSuccess);
        Assert.Equal(first.Error, second.Error);
        Assert.Equal(firstCount, handler.Requests.Count);
        Assert.Null(second.Value);
    }

    [Fact]
    public async Task Dashboard_CollectionCapPlusOneUsesFailureBackoffWithoutPartialPublication()
    {
        var collections = "["
            + string.Join(
                ',',
                Enumerable.Range(1, 501).Select(id =>
                    $$"""
                    {"id":{{id}},"title":"Collection {{id}}","type":"movie","isActive":true,
                    "mediaCount":1,"manualCollection":false,"handledMediaAmount":0,
                    "lastDurationInSeconds":0,"totalSizeBytes":0,"handledMediaSizeBytes":0}
                    """))
            + "]";
        var handler = new RoutingHandler(request =>
            request.RequestUri!.AbsolutePath.EndsWith("/api/collections", StringComparison.Ordinal)
                ? Json(collections)
                : SuccessResponse(request));
        var client = Client(handler, Provider());

        var first = await client.GetDashboardAsync(null, false, CancellationToken.None);
        var firstCollectionAttempts = handler.Requests.Count(request =>
            request.PathAndQuery.EndsWith("/api/collections", StringComparison.Ordinal));
        var second = await client.GetDashboardAsync(null, false, CancellationToken.None);

        Assert.Equal(MaintainerrErrorCode.TooLarge, first.Error);
        Assert.Null(first.Value);
        Assert.Equal(first.Error, second.Error);
        Assert.Null(second.Value);
        Assert.Equal(1, firstCollectionAttempts);
        Assert.Equal(
            firstCollectionAttempts,
            handler.Requests.Count(request =>
                request.PathAndQuery.EndsWith("/api/collections", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task DisabledSubFeatures_ReturnDisabledWithoutUpstreamRequests()
    {
        var handler = new RoutingHandler(SuccessResponse);
        var pageConfiguration = EnabledConfiguration();
        pageConfiguration.MaintainerrPageEnabled = false;
        var pageClient = Client(handler, new FakePluginConfigProvider(pageConfiguration));

        var dashboard = await pageClient.GetDashboardAsync(
            null,
            false,
            CancellationToken.None);
        var content = await pageClient.GetCollectionContentAsync(
            1,
            1,
            25,
            "deleteSoonest",
            "asc",
            CancellationToken.None);

        var itemConfiguration = EnabledConfiguration();
        itemConfiguration.MaintainerrItemStatusEnabled = false;
        var itemClient = Client(handler, new FakePluginConfigProvider(itemConfiguration));
        var item = await itemClient.GetItemStatusAsync(
            Guid.NewGuid().ToString(),
            MaintainerrCallerRole.Administrator,
            null,
            CancellationToken.None);

        Assert.Equal(MaintainerrErrorCode.Disabled, dashboard.Error);
        Assert.Equal(MaintainerrErrorCode.Disabled, content.Error);
        Assert.Equal(MaintainerrErrorCode.Disabled, item.Error);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task RegularUserOptInOff_ReturnsDisabledWithoutUpstreamRequests()
    {
        var handler = new RoutingHandler(SuccessResponse);
        var configuration = EnabledConfiguration();
        configuration.MaintainerrItemStatusForUsers = false;

        var result = await Client(handler, new FakePluginConfigProvider(configuration))
            .GetItemStatusAsync(
                Guid.NewGuid().ToString(),
                MaintainerrCallerRole.RegularUser,
                "https://jellyfin.example",
                CancellationToken.None);

        Assert.Equal(MaintainerrErrorCode.Disabled, result.Error);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task Dashboard_CancelsSharedUpstreamOnlyAfterLastWaiterLeaves()
    {
        var handler = new BlockingHandler();
        var client = Client(handler, Provider());
        using var firstCancellation = new CancellationTokenSource();
        using var secondCancellation = new CancellationTokenSource();

        var first = client.GetDashboardAsync(null, false, firstCancellation.Token);
        var second = client.GetDashboardAsync(null, false, secondCancellation.Token);
        await handler.Started.Task.WaitAsync(TimeSpan.FromSeconds(2));

        firstCancellation.Cancel();
        Assert.Equal(MaintainerrErrorCode.Canceled, (await first).Error);
        Assert.False(handler.Canceled.Task.IsCompleted);

        secondCancellation.Cancel();
        Assert.Equal(MaintainerrErrorCode.Canceled, (await second).Error);
        await handler.Canceled.Task.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task UpstreamAdmission_BoundsRunningAndWaitingWorkAndRejectsOverflowWithoutDispatch()
    {
        var handler = new BlockingHandler();
        var client = Client(handler, Provider());
        using var cancellation = new CancellationTokenSource();

        var admittedOperations = MaintainerrClient.MaximumAdmittedUpstreamRequests
            / MaintainerrClient.MaximumConcurrentUpstreamRequests;
        var admitted = Enumerable.Range(0, admittedOperations)
            .Select(_ => client.TestAsync(BaseUrl, cancellation.Token))
            .ToArray();
        await handler.Started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal(MaintainerrClient.MaximumConcurrentUpstreamRequests, handler.StartedCount);

        var overflow = await client.TestAsync(BaseUrl, CancellationToken.None)
            .WaitAsync(TimeSpan.FromSeconds(2));

        Assert.Equal(MaintainerrErrorCode.Throttled, overflow.Error);
        Assert.Equal(MaintainerrClient.MaximumConcurrentUpstreamRequests, handler.StartedCount);

        cancellation.Cancel();
        var canceled = await Task.WhenAll(admitted).WaitAsync(TimeSpan.FromSeconds(2));
        Assert.All(canceled, result => Assert.Equal(MaintainerrErrorCode.Canceled, result.Error));
    }

    [Fact]
    public async Task DashboardAndItemStatus_UseOneDeadlineAcrossSequentialPhases()
    {
        var timings = new MaintainerrClient.MaintainerrClientTimings(
            RequestDeadline: TimeSpan.FromSeconds(2),
            TestOperationDeadline: TimeSpan.FromMilliseconds(300),
            ItemStatusOperationDeadline: TimeSpan.FromMilliseconds(180),
            DashboardOperationDeadline: TimeSpan.FromMilliseconds(220),
            DashboardCacheTtl: TimeSpan.FromSeconds(1),
            DashboardRefreshMinimumInterval: TimeSpan.FromMilliseconds(20),
            DashboardFailureBackoffTtl: TimeSpan.FromMilliseconds(20));
        var handler = new AsyncRoutingHandler(async (request, cancellationToken) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/api/health/ready", StringComparison.Ordinal)
                || path.EndsWith("/api/app/status", StringComparison.Ordinal)
                || path.EndsWith("/api/media-server/type", StringComparison.Ordinal))
            {
                await Task.Delay(TimeSpan.FromMilliseconds(80), cancellationToken);
                return SuccessResponse(request);
            }

            if (path.EndsWith("/api/media-server", StringComparison.Ordinal))
            {
                return SuccessResponse(request);
            }

            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("A total deadline failed to cancel the upstream.");
        });
        var client = Client(handler, Provider(), timings);
        var stopwatch = Stopwatch.StartNew();

        var dashboard = await client.GetDashboardAsync(null, false, CancellationToken.None);
        var item = await client.GetItemStatusAsync(
            Guid.NewGuid().ToString(),
            MaintainerrCallerRole.Administrator,
            null,
            CancellationToken.None);

        stopwatch.Stop();
        Assert.Equal(MaintainerrErrorCode.Timeout, dashboard.Error);
        Assert.Equal(MaintainerrErrorCode.Timeout, item.Error);
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task Dashboard_ProjectsUnavailableSectionsWithoutFakeEmptyData()
    {
        var handler = new RoutingHandler(request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/api/storage-metrics", StringComparison.Ordinal))
            {
                return Json("""{"collectionSummary":{},"cleanupTotals":{}}""");
            }

            if (path.EndsWith("/api/rules/execute/status", StringComparison.Ordinal))
            {
                return Json("""{"pendingRuleGroupIds":[],"queue":[]}""");
            }

            if (path.EndsWith("/api/overlays/status", StringComparison.Ordinal))
            {
                return Json("""{"status":"future-state","lastRun":null}""");
            }

            return SuccessResponse(request);
        });
        var result = await Client(handler, Provider())
            .GetDashboardAsync(null, false, CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.Equal("unavailable", result.Value!.Storage.State);
        Assert.Equal("malformed_body", result.Value.Storage.Error);
        Assert.Null(result.Value.Storage.CollectionSummary);
        Assert.Equal("partial", result.Value.Rules.State);
        Assert.Equal(2, result.Value.Rules.Count);
        Assert.Null(result.Value.Rules.ProcessingQueue);
        Assert.Equal("unavailable", result.Value.Overlays.State);
        Assert.Null(result.Value.Overlays.Status);

        var json = JsonSerializer.Serialize(result.Value);
        Assert.DoesNotContain("\"collectionSummary\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"processingQueue\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"status\":\"future-state\"", json, StringComparison.Ordinal);
    }

    [Fact]
    public void RulesUnavailable_PrefersRealFailureOverUnsupportedInEitherOrder()
    {
        var unsupportedCount = MaintainerrClientResult<int>.Failure(MaintainerrErrorCode.Unsupported);
        var failedCount = MaintainerrClientResult<int>.Failure(MaintainerrErrorCode.UpstreamError);
        var unsupportedStatus = MaintainerrClientResult<Jellyfin.Plugin.JellyfinCanopy.Model.Maintainerr.MaintainerrRulesSummary>
            .Failure(MaintainerrErrorCode.Unsupported);
        var failedStatus = MaintainerrClientResult<Jellyfin.Plugin.JellyfinCanopy.Model.Maintainerr.MaintainerrRulesSummary>
            .Failure(MaintainerrErrorCode.UpstreamError);

        var countUnsupported = MaintainerrClient.BuildRulesSummary(unsupportedCount, failedStatus);
        var statusUnsupported = MaintainerrClient.BuildRulesSummary(failedCount, unsupportedStatus);

        Assert.Equal("unavailable", countUnsupported.State);
        Assert.Equal("upstream_error", countUnsupported.Error);
        Assert.Equal("unavailable", statusUnsupported.State);
        Assert.Equal("upstream_error", statusUnsupported.Error);
    }

    [Fact]
    public async Task Dashboard_RejectsCollectionIntegersBeyondJavascriptSafeRange()
    {
        var oversized = (MaintainerrClient.MaximumSafeJsonInteger + 1).ToString(
            System.Globalization.CultureInfo.InvariantCulture);
        var handler = new RoutingHandler(request =>
            request.RequestUri!.AbsolutePath.EndsWith("/api/collections", StringComparison.Ordinal)
                ? Json(
                    $$"""
                    [{"id":1,"title":"Unsafe","type":"movie","isActive":true,"mediaCount":1,
                    "manualCollection":false,"handledMediaAmount":0,"lastDurationInSeconds":0,
                    "totalSizeBytes":{{oversized}},"handledMediaSizeBytes":0}]
                    """)
                : SuccessResponse(request));

        var result = await Client(handler, Provider())
            .GetDashboardAsync(null, false, CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(MaintainerrErrorCode.MalformedResponse, result.Error);
    }

    [Fact]
    public async Task Dashboard_RejectsMissingRequiredCollectionCounters()
    {
        var handler = new RoutingHandler(request =>
            request.RequestUri!.AbsolutePath.EndsWith("/api/collections", StringComparison.Ordinal)
                ? Json(
                    """
                    [{"id":1,"title":"Drifted","type":"movie","isActive":true,"mediaCount":1,
                    "manualCollection":false,"lastDurationInSeconds":0,"handledMediaSizeBytes":0}]
                    """)
                : SuccessResponse(request));

        var result = await Client(handler, Provider())
            .GetDashboardAsync(null, false, CancellationToken.None);

        Assert.Equal(MaintainerrErrorCode.MalformedResponse, result.Error);
        Assert.Null(result.Value);
    }

    [Fact]
    public async Task Dashboard_NotReadyIsBusinessFailureWithoutEmptyData()
    {
        var handler = new RoutingHandler(request =>
            request.RequestUri!.AbsolutePath.EndsWith("/api/health/ready", StringComparison.Ordinal)
                ? Json(
                    """{"status":"degraded","database":"unreachable"}""",
                    HttpStatusCode.ServiceUnavailable)
                : SuccessResponse(request));

        var result = await Client(handler, Provider())
            .GetDashboardAsync(null, false, CancellationToken.None);

        Assert.Equal(MaintainerrErrorCode.NotReady, result.Error);
        Assert.Null(result.Value);
    }

    [Fact]
    public async Task CollectionPage_RejectsItemsBeyondDeclaredTotal()
    {
        var handler = new RoutingHandler(request =>
            request.RequestUri!.AbsolutePath.Contains("/api/collections/media/", StringComparison.Ordinal)
                ? Json("""{"totalSize":0,"items":[{"id":1,"mediaData":{"title":"One","type":"movie"}}]}""")
                : SuccessResponse(request));

        var result = await Client(handler, Provider()).GetCollectionContentAsync(
            1,
            1,
            25,
            "deleteSoonest",
            "asc",
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(MaintainerrErrorCode.MalformedResponse, result.Error);
    }

    [Theory]
    [InlineData(1, 2, 1, """[]""")]
    [InlineData(2, 2, 3, """[]""")]
    [InlineData(2, 2, 3, """[{"id":3,"mediaData":{"title":"Three","type":"movie"}},{"id":4,"mediaData":{"title":"Four","type":"movie"}}]""")]
    [InlineData(2, 2, 0, """[]""")]
    public async Task CollectionPage_RejectsFalseEmptyAndRowsBeyondTheDeclaredRemainder(
        int page,
        int size,
        int totalSize,
        string items)
    {
        var handler = new RoutingHandler(request =>
            request.RequestUri!.AbsolutePath.Contains("/api/collections/media/", StringComparison.Ordinal)
                ? Json($$"""{"totalSize":{{totalSize}},"items":{{items}}}""")
                : SuccessResponse(request));

        var result = await Client(handler, Provider()).GetCollectionContentAsync(
            1,
            page,
            size,
            "deleteSoonest",
            "asc",
            CancellationToken.None);

        Assert.Equal(MaintainerrErrorCode.MalformedResponse, result.Error);
        Assert.Null(result.Value);
    }

    [Fact]
    public async Task CollectionPage_RejectsTotalBeyondTheAcceptedPaginationEnvelope()
    {
        var handler = new RoutingHandler(request =>
            request.RequestUri!.AbsolutePath.Contains("/api/collections/media/", StringComparison.Ordinal)
                ? Json("""{"totalSize":1000001,"items":[]}""")
                : SuccessResponse(request));

        var result = await Client(handler, Provider()).GetCollectionContentAsync(
            1,
            1,
            25,
            "deleteSoonest",
            "asc",
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(MaintainerrErrorCode.MalformedResponse, result.Error);
    }

    [Fact]
    public async Task ItemStatus_RejectsUnboundedMachineIdentityBeforeStatusRequest()
    {
        var handler = new RoutingHandler(request =>
            request.RequestUri!.AbsolutePath.EndsWith("/api/media-server", StringComparison.Ordinal)
                ? Json($$"""{"machineId":"{{new string('x', 257)}}"}""")
                : SuccessResponse(request));
        var result = await Client(handler, Provider()).GetItemStatusAsync(
            Guid.NewGuid().ToString(),
            MaintainerrCallerRole.Administrator,
            null,
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(MaintainerrErrorCode.MalformedResponse, result.Error);
        Assert.DoesNotContain(
            handler.Requests,
            request => request.PathAndQuery.Contains("maintainerr-status", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("not-a-url")]
    [InlineData("ftp://127.0.0.1:6246")]
    [InlineData("http://user:password@127.0.0.1:6246")]
    [InlineData("http://127.0.0.1:6246?query=1")]
    [InlineData("http://127.0.0.1:6246/#fragment")]
    public async Task Test_RejectsInvalidUnsavedUrlsBeforeDispatch(string candidateUrl)
    {
        var handler = new RoutingHandler(SuccessResponse);

        var result = await Client(handler, Provider()).TestAsync(
            candidateUrl,
            CancellationToken.None);

        Assert.Equal(MaintainerrErrorCode.InvalidConfiguration, result.Error);
        Assert.Empty(handler.Requests);
    }

    [Theory]
    [InlineData("malformed", MaintainerrErrorCode.MalformedResponse, 0)]
    [InlineData("login-html", MaintainerrErrorCode.WrongService, 200)]
    [InlineData("redirect", MaintainerrErrorCode.Redirect, 302)]
    [InlineData("upstream-401", MaintainerrErrorCode.UpstreamError, 401)]
    [InlineData("upstream-500", MaintainerrErrorCode.UpstreamError, 500)]
    [InlineData("oversized", MaintainerrErrorCode.ResponseTooLarge, 200)]
    public async Task Test_MapsTransportAndBodyFailuresWithoutRawData(
        string mode,
        MaintainerrErrorCode expected,
        int expectedStatus)
    {
        var handler = new RoutingHandler(request =>
        {
            if (!request.RequestUri!.AbsolutePath.EndsWith("/api/health/ready", StringComparison.Ordinal))
            {
                return SuccessResponse(request);
            }

            return mode switch
            {
                "malformed" => Json("{"),
                "login-html" => Json(
                    "<html><body>private-login-marker</body></html>",
                    mediaType: "text/html"),
                "redirect" => Json("{}", HttpStatusCode.Found),
                "upstream-401" => Json("{}", HttpStatusCode.Unauthorized),
                "upstream-500" => Json("{}", HttpStatusCode.InternalServerError),
                "oversized" => Json(new string('x', MaintainerrClient.SmallResponseBytes + 1)),
                _ => throw new ArgumentOutOfRangeException(nameof(mode)),
            };
        });

        var result = await Client(handler, Provider()).TestAsync(
            BaseUrl,
            CancellationToken.None);

        Assert.Equal(expected, result.Error);
        Assert.Equal(expectedStatus, result.UpstreamStatus);
        Assert.Null(result.Value);
    }

    [Fact]
    public async Task TransportFailureLogs_ArePerEndpointRateBoundedAndRedacted()
    {
        const string exceptionSecret = "transport-exception-secret";
        var clock = new ManualTimeProvider(
            new DateTimeOffset(2026, 7, 26, 0, 0, 0, TimeSpan.Zero));
        var logger = new CapturingLogger<MaintainerrClient>();
        var failHealth = true;
        var handler = new RoutingHandler(request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if ((failHealth
                    && path.EndsWith("/api/health/ready", StringComparison.Ordinal))
                || (!failHealth
                    && path.EndsWith("/api/app/status", StringComparison.Ordinal)))
            {
                throw new HttpRequestException(exceptionSecret);
            }

            return SuccessResponse(request);
        });
        var client = new MaintainerrClient(
            new HandlerFactory(handler),
            Provider(),
            new MaintainerrHostIdentity(MachineId),
            logger,
            MaintainerrClient.MaintainerrClientTimings.Default,
            clock);

        for (var attempt = 0; attempt < 5; attempt++)
        {
            var failure = await client.TestAsync(BaseUrl, CancellationToken.None);
            Assert.Equal(MaintainerrErrorCode.UpstreamError, failure.Error);
        }

        var first = Assert.Single(logger.Entries);
        Assert.Equal(LogLevel.Debug, first.Level);
        Assert.Contains("HealthReady", first.Message, StringComparison.Ordinal);
        Assert.Null(first.Exception);

        clock.Advance(MaintainerrClient.TransportLogMinimumInterval - TimeSpan.FromMilliseconds(1));
        Assert.Equal(
            MaintainerrErrorCode.UpstreamError,
            (await client.TestAsync(BaseUrl, CancellationToken.None)).Error);
        Assert.Single(logger.Entries);

        failHealth = false;
        Assert.Equal(
            MaintainerrErrorCode.UpstreamError,
            (await client.TestAsync(BaseUrl, CancellationToken.None)).Error);
        Assert.Equal(2, logger.Entries.Count);
        Assert.Contains(
            logger.Entries,
            entry => entry.Message.Contains("AppStatus", StringComparison.Ordinal));

        failHealth = true;
        clock.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal(
            MaintainerrErrorCode.UpstreamError,
            (await client.TestAsync(BaseUrl, CancellationToken.None)).Error);
        Assert.Equal(3, logger.Entries.Count);
        Assert.All(logger.Entries, entry =>
        {
            Assert.DoesNotContain(BaseUrl, entry.Message, StringComparison.Ordinal);
            Assert.DoesNotContain(exceptionSecret, entry.Message, StringComparison.Ordinal);
            Assert.Null(entry.Exception);
        });
    }

    [Fact]
    public void DashboardMapperFailureLogs_AreRateBoundedAndRedacted()
    {
        var clock = new ManualTimeProvider(
            new DateTimeOffset(2026, 7, 26, 0, 0, 0, TimeSpan.Zero));
        var logger = new CapturingLogger<MaintainerrClient>();
        var client = new MaintainerrClient(
            new HandlerFactory(new RoutingHandler(SuccessResponse)),
            Provider(),
            new MaintainerrHostIdentity(MachineId),
            logger,
            MaintainerrClient.MaintainerrClientTimings.Default,
            clock);

        for (var attempt = 0; attempt < 5; attempt++)
        {
            client.LogDashboardMapperFailure();
        }

        var first = Assert.Single(logger.Entries);
        Assert.Equal(LogLevel.Debug, first.Level);
        Assert.Contains("dashboard mapper", first.Message, StringComparison.Ordinal);
        Assert.Contains("Unexpected", first.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(BaseUrl, first.Message, StringComparison.Ordinal);
        Assert.Null(first.Exception);

        clock.Advance(MaintainerrClient.TransportLogMinimumInterval - TimeSpan.FromMilliseconds(1));
        client.LogDashboardMapperFailure();
        Assert.Single(logger.Entries);

        clock.Advance(TimeSpan.FromMilliseconds(1));
        client.LogDashboardMapperFailure();
        Assert.Equal(2, logger.Entries.Count);
        Assert.All(logger.Entries, entry => Assert.Null(entry.Exception));
    }

    [Fact]
    public async Task Test_CallerCancellationAndOperationDeadlineRemainDistinct()
    {
        var timings = new MaintainerrClient.MaintainerrClientTimings(
            RequestDeadline: TimeSpan.FromSeconds(2),
            TestOperationDeadline: TimeSpan.FromMilliseconds(80),
            ItemStatusOperationDeadline: TimeSpan.FromSeconds(1),
            DashboardOperationDeadline: TimeSpan.FromSeconds(1),
            DashboardCacheTtl: TimeSpan.FromSeconds(1),
            DashboardRefreshMinimumInterval: TimeSpan.FromMilliseconds(20),
            DashboardFailureBackoffTtl: TimeSpan.FromMilliseconds(20));
        var canceledHandler = new BlockingHandler();
        using var callerCancellation = new CancellationTokenSource();

        var canceledTask = Client(canceledHandler, Provider(), timings).TestAsync(
            BaseUrl,
            callerCancellation.Token);
        await canceledHandler.Started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        callerCancellation.Cancel();
        var canceled = await canceledTask;

        var timeoutHandler = new BlockingHandler();
        var timedOut = await Client(timeoutHandler, Provider(), timings).TestAsync(
            BaseUrl,
            CancellationToken.None);

        Assert.Equal(MaintainerrErrorCode.Canceled, canceled.Error);
        Assert.Equal(MaintainerrErrorCode.Timeout, timedOut.Error);
    }

    [Theory]
    [InlineData(MachineId, true, null)]
    [InlineData("fedcba9876543210fedcba9876543210", false, "identity_mismatch")]
    [InlineData(null, false, "identity_unknown")]
    public async Task Test_ReportsSameMismatchedAndUnknownIdentity(
        string? machineId,
        bool expectedMatch,
        string? expectedWarning)
    {
        var handler = new RoutingHandler(request =>
            request.RequestUri!.AbsolutePath.EndsWith("/api/media-server", StringComparison.Ordinal)
                ? Json(JsonSerializer.Serialize(new { machineId, additiveField = "ignored" }))
                : SuccessResponse(request));

        var result = await Client(handler, Provider()).TestAsync(
            BaseUrl,
            CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.Equal(expectedMatch, result.Value!.IdentityMatch);
        Assert.Equal(expectedWarning, result.Value.IdentityWarning);
        Assert.Equal(expectedMatch, result.Value.Ok);
        Assert.Equal(expectedMatch, result.Value.Capabilities["itemStatus"]);
    }

    [Fact]
    public async Task Test_NonJellyfinAndDegradedReadinessAreExplicit()
    {
        var nonJellyfinHandler = new RoutingHandler(request =>
            request.RequestUri!.AbsolutePath.EndsWith("/api/media-server/type", StringComparison.Ordinal)
                ? Json("""{"type":"plex","futureField":true}""")
                : SuccessResponse(request));
        var degradedHandler = new RoutingHandler(request =>
            request.RequestUri!.AbsolutePath.EndsWith("/api/health/ready", StringComparison.Ordinal)
                ? Json(
                    """{"status":"degraded","database":"unreachable","futureField":true}""",
                    HttpStatusCode.ServiceUnavailable)
                : SuccessResponse(request));

        var nonJellyfin = await Client(nonJellyfinHandler, Provider()).TestAsync(
            BaseUrl,
            CancellationToken.None);
        var degraded = await Client(degradedHandler, Provider()).TestAsync(
            BaseUrl,
            CancellationToken.None);

        Assert.True(nonJellyfin.IsSuccess);
        Assert.False(nonJellyfin.Value!.JellyfinMode);
        Assert.False(nonJellyfin.Value.Capable);
        Assert.Equal("wrong_service", nonJellyfin.Value.Error);
        Assert.True(degraded.IsSuccess);
        Assert.False(degraded.Value!.Ready);
        Assert.False(degraded.Value.Capable);
        Assert.Equal("not_ready", degraded.Value.Error);
    }

    [Theory]
    [InlineData("3.18.0", true)]
    [InlineData("3.18.7", true)]
    [InlineData("3.18.0-e2e", true)]
    [InlineData("3.18.0+build.42", true)]
    [InlineData("3.17.9", false)]
    [InlineData("3.19.0", false)]
    [InlineData("4.0.0", false)]
    [InlineData("3.18", false)]
    [InlineData("unknown", false)]
    public void VersionCompatibility_IsPinnedToReviewedV318Line(
        string version,
        bool expected)
        => Assert.Equal(expected, MaintainerrClient.IsSupportedV318Version(version));

    [Fact]
    public async Task UnsupportedVersionReportsNoCompatibleCapabilitiesAndBlocksDashboard()
    {
        var handler = new RoutingHandler(request =>
            request.RequestUri!.AbsolutePath.EndsWith("/api/app/status", StringComparison.Ordinal)
                ? Json("""{"status":1,"version":"3.19.0"}""", mediaType: "text/html")
                : SuccessResponse(request));
        var client = Client(handler, Provider());

        var test = await client.TestAsync(BaseUrl, CancellationToken.None);
        var dashboard = await client.GetDashboardAsync(
            null,
            false,
            CancellationToken.None);

        Assert.True(test.IsSuccess);
        Assert.False(test.Value!.Capable);
        Assert.False(test.Value.Ok);
        Assert.Equal("unsupported", test.Value.Error);
        Assert.All(test.Value.Capabilities, capability => Assert.False(capability.Value));
        Assert.Equal(MaintainerrErrorCode.Unsupported, dashboard.Error);
        Assert.Null(dashboard.Value);
        Assert.DoesNotContain(
            handler.Requests,
            request => request.PathAndQuery.EndsWith(
                "/api/collections",
                StringComparison.Ordinal));
    }

    [Fact]
    public async Task Dashboard_Optional404sDegradeSectionsWithoutFailingCollections()
    {
        var handler = new RoutingHandler(request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/api/storage-metrics", StringComparison.Ordinal)
                || path.EndsWith("/api/rules/count", StringComparison.Ordinal)
                || path.EndsWith("/api/rules/execute/status", StringComparison.Ordinal)
                || path.EndsWith("/api/overlays/status", StringComparison.Ordinal))
            {
                return Json("{}", HttpStatusCode.NotFound);
            }

            return SuccessResponse(request);
        });

        var result = await Client(handler, Provider()).GetDashboardAsync(
            null,
            false,
            CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.Empty(result.Value!.Collections);
        Assert.True(result.Value.Status.Degraded);
        Assert.Equal("unsupported", result.Value.Storage.State);
        Assert.Equal("unsupported", result.Value.Rules.State);
        Assert.Equal("unsupported", result.Value.Overlays.State);
    }

    [Fact]
    public async Task CollectionContent_404IsANamedUnsupportedCapability()
    {
        var handler = new RoutingHandler(request =>
            request.RequestUri!.AbsolutePath.Contains(
                "/api/collections/media/",
                StringComparison.Ordinal)
                ? Json("{}", HttpStatusCode.NotFound)
                : SuccessResponse(request));

        var result = await Client(handler, Provider()).GetCollectionContentAsync(
            1,
            1,
            25,
            "deleteSoonest",
            "asc",
            CancellationToken.None);

        Assert.Equal(MaintainerrErrorCode.Unsupported, result.Error);
        Assert.Null(result.Value);
    }

    [Fact]
    public async Task Dashboard_AdditiveV318FieldsAndNullOptionalsNeverEscapeProjection()
    {
        const string secretSentinel = "maintainerr-secret-sentinel";
        var handler = new RoutingHandler(request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/api/collections", StringComparison.Ordinal))
            {
                return Json(
                    """
                    [{
                      "id":1,"title":"Reviewed collection","type":"movie","isActive":true,
                      "mediaCount":2,"deleteAfterDays":null,"manualCollection":false,
                      "handledMediaAmount":0,"lastDurationInSeconds":0,
                      "totalSizeBytes":null,"handledMediaSizeBytes":0,
                      "description":"__SENTINEL__",
                      "ruleGroup":{"notificationAgent":{"options":{"token":"__SENTINEL__"}}},
                      "media":[{"path":"/mnt/__SENTINEL__"}]
                    }]
                    """.Replace("__SENTINEL__", secretSentinel, StringComparison.Ordinal));
            }

            if (path.EndsWith("/api/rules/execute/status", StringComparison.Ordinal))
            {
                return Json(
                    """
                    {"processingQueue":false,"executingRuleGroupId":null,
                     "pendingRuleGroupIds":[],"queue":[],
                     "notificationOptions":{"webhook":"__SENTINEL__"},
                     "arrDiskPath":"/mnt/__SENTINEL__"}
                    """.Replace("__SENTINEL__", secretSentinel, StringComparison.Ordinal));
            }

            return SuccessResponse(request);
        });

        var result = await Client(handler, Provider()).GetDashboardAsync(
            "https://jellyfin.example",
            false,
            CancellationToken.None);

        Assert.True(result.IsSuccess);
        var collection = Assert.Single(result.Value!.Collections);
        Assert.Null(collection.DeleteAfterDays);
        Assert.Null(collection.TotalSizeBytes);
        var projected = JsonSerializer.Serialize(result.Value);
        Assert.DoesNotContain(secretSentinel, projected, StringComparison.Ordinal);
        Assert.DoesNotContain("notification", projected, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("arrDiskPath", projected, StringComparison.Ordinal);
        Assert.All(handler.Requests, request => Assert.Equal(HttpMethod.Get, request.Method));
        Assert.DoesNotContain(
            handler.Requests,
            request => request.PathAndQuery.Equals(
                "/maintainerr/api/rules",
                StringComparison.Ordinal));
    }

    [Fact]
    public async Task ItemStatus_KeepsHostileLabelsAsDataAndOmitsUnapprovedTargets()
    {
        var handler = new RoutingHandler(request =>
            request.RequestUri!.AbsolutePath.Contains(
                "/api/media-server/meta/",
                StringComparison.Ordinal)
                ? Json(
                    """
                    {
                      "excludedFrom":[
                        {"label":"<img src=x onerror=alert(1)>","targetPath":"https://evil.example/collections/1"},
                        {"label":"Safe label","targetPath":"/collections/1/exclusions"}
                      ],
                      "manuallyAddedTo":[],
                      "unknownSecret":{"token":"discard-me"}
                    }
                    """)
                : SuccessResponse(request));

        var result = await Client(handler, Provider()).GetItemStatusAsync(
            Guid.NewGuid().ToString(),
            MaintainerrCallerRole.Administrator,
            "https://jellyfin.example",
            CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.Equal("<img src=x onerror=alert(1)>", result.Value!.ExcludedFrom[0].Label);
        Assert.Null(result.Value.ExcludedFrom[0].Href);
        Assert.Equal(
            "http://127.0.0.1:6246/maintainerr/collections/1/exclusions",
            result.Value.ExcludedFrom[1].Href);
        Assert.DoesNotContain("discard-me", JsonSerializer.Serialize(result.Value), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(256, true)]
    [InlineData(257, false)]
    public async Task ItemStatus_LabelBoundMatchesTheClientContract(
        int labelLength,
        bool expectedSuccess)
    {
        var label = new string('x', labelLength);
        var handler = new RoutingHandler(request =>
            request.RequestUri!.AbsolutePath.Contains(
                "/api/media-server/meta/",
                StringComparison.Ordinal)
                ? Json(JsonSerializer.Serialize(new
                {
                    excludedFrom = new[] { new { label } },
                    manuallyAddedTo = Array.Empty<object>(),
                }))
                : SuccessResponse(request));

        var result = await Client(handler, Provider()).GetItemStatusAsync(
            Guid.NewGuid().ToString(),
            MaintainerrCallerRole.Administrator,
            null,
            CancellationToken.None);

        Assert.Equal(expectedSuccess, result.IsSuccess);
        if (expectedSuccess)
        {
            Assert.Equal(label, Assert.Single(result.Value!.ExcludedFrom).Label);
        }
        else
        {
            Assert.Equal(MaintainerrErrorCode.MalformedResponse, result.Error);
        }
    }

    [Theory]
    [InlineData(0, 1, 25, "deleteSoonest", "asc")]
    [InlineData(1, 0, 25, "deleteSoonest", "asc")]
    [InlineData(1, 1, 0, "deleteSoonest", "asc")]
    [InlineData(1, 1, 51, "deleteSoonest", "asc")]
    [InlineData(1, 20_001, 50, "deleteSoonest", "asc")]
    [InlineData(1, 1_000_001, 1, "deleteSoonest", "asc")]
    [InlineData(1, 1, 25, "unknown", "asc")]
    [InlineData(1, 1, 25, "title", "asc")]
    [InlineData(1, 1, 25, "deleteSoonest", "sideways")]
    public async Task CollectionContent_InvalidRouteOrQueryNeverDispatches(
        int collectionId,
        int page,
        int size,
        string sort,
        string sortOrder)
    {
        var handler = new RoutingHandler(SuccessResponse);

        var result = await Client(handler, Provider()).GetCollectionContentAsync(
            collectionId,
            page,
            size,
            sort,
            sortOrder,
            CancellationToken.None);

        Assert.Equal(MaintainerrErrorCode.InvalidConfiguration, result.Error);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task Dashboard_ConfigChangeDuringFetchPublishesNoValueOrOldCache()
    {
        var provider = Provider();
        var changed = false;
        var handler = new RoutingHandler(request =>
        {
            if (!changed
                && request.RequestUri!.AbsolutePath.EndsWith(
                    "/api/collections",
                    StringComparison.Ordinal))
            {
                changed = true;
                var replacement = EnabledConfiguration();
                replacement.MaintainerrExternalUrl = "https://new-generation.example";
                provider.Current = replacement;
            }

            return SuccessResponse(request);
        });
        var client = Client(handler, provider);

        var stale = await client.GetDashboardAsync(null, false, CancellationToken.None);
        var firstAttemptCount = handler.Requests.Count;
        var current = await client.GetDashboardAsync(null, false, CancellationToken.None);

        Assert.Equal(MaintainerrErrorCode.ConfigurationChanged, stale.Error);
        Assert.Null(stale.Value);
        Assert.True(current.IsSuccess);
        Assert.True(handler.Requests.Count > firstAttemptCount);
        Assert.Equal(
            "https://new-generation.example/overview",
            current.Value!.Links!.Overview);
    }

    [Fact]
    public async Task Dashboard_SuccessCacheExpiresAndReloadsWithinConfiguredBound()
    {
        var timings = new MaintainerrClient.MaintainerrClientTimings(
            RequestDeadline: TimeSpan.FromSeconds(1),
            TestOperationDeadline: TimeSpan.FromSeconds(1),
            ItemStatusOperationDeadline: TimeSpan.FromSeconds(1),
            DashboardOperationDeadline: TimeSpan.FromSeconds(1),
            DashboardCacheTtl: TimeSpan.FromMilliseconds(40),
            DashboardRefreshMinimumInterval: TimeSpan.FromMilliseconds(10),
            DashboardFailureBackoffTtl: TimeSpan.FromMilliseconds(10));
        var handler = new RoutingHandler(SuccessResponse);
        var client = Client(handler, Provider(), timings);

        Assert.True((await client.GetDashboardAsync(null, false, CancellationToken.None)).IsSuccess);
        var firstCount = handler.Requests.Count;
        Assert.True((await client.GetDashboardAsync(null, false, CancellationToken.None)).IsSuccess);
        Assert.Equal(firstCount, handler.Requests.Count);

        await Task.Delay(TimeSpan.FromMilliseconds(80));
        Assert.True((await client.GetDashboardAsync(null, false, CancellationToken.None)).IsSuccess);
        Assert.True(handler.Requests.Count > firstCount);
    }

    private static MaintainerrClient Client(
        HttpMessageHandler handler,
        FakePluginConfigProvider provider)
        => new(
            new HandlerFactory(handler),
            provider,
            new MaintainerrHostIdentity(MachineId),
            NullLogger<MaintainerrClient>.Instance);

    private static MaintainerrClient Client(
        HttpMessageHandler handler,
        FakePluginConfigProvider provider,
        MaintainerrClient.MaintainerrClientTimings timings)
        => new(
            new HandlerFactory(handler),
            provider,
            new MaintainerrHostIdentity(MachineId),
            NullLogger<MaintainerrClient>.Instance,
            timings);

    private static FakePluginConfigProvider Provider()
        => new(EnabledConfiguration());

    private static PluginConfiguration EnabledConfiguration()
        => new()
        {
            MaintainerrEnabled = true,
            MaintainerrUrl = BaseUrl,
            MaintainerrPageEnabled = true,
            MaintainerrItemStatusEnabled = true,
        };

    private static HttpResponseMessage SuccessResponse(HttpRequestMessage request)
    {
        var path = request.RequestUri!.AbsolutePath;
        if (path.EndsWith("/api/health/ready", StringComparison.Ordinal))
        {
            return Json("""{"status":"ok","database":"ok"}""");
        }

        if (path.EndsWith("/api/app/status", StringComparison.Ordinal))
        {
            return Json("""{"status":1,"version":"3.18.0"}""", mediaType: "text/html");
        }

        if (path.EndsWith("/api/media-server/type", StringComparison.Ordinal))
        {
            return Json("""{"type":"jellyfin"}""");
        }

        if (path.EndsWith("/api/media-server", StringComparison.Ordinal))
        {
            return Json($$"""{"machineId":"{{MachineId}}"}""");
        }

        if (path.EndsWith("/api/collections", StringComparison.Ordinal))
        {
            return Json("[]");
        }

        if (path.EndsWith("/api/storage-metrics", StringComparison.Ordinal))
        {
            return Json(
                """
                {
                  "generatedAt":"2026-07-26T00:00:00.0000000+00:00",
                  "collectionSummary":{
                    "reclaimableCount":0,"activeSizeBytes":0,"reclaimableSizedCount":0,
                    "inactiveCount":0,"totalCollectionCount":0,"movieSizeBytes":0,
                    "showSizeBytes":0,"seasonSizeBytes":0,"episodeSizeBytes":0,
                    "reclaimableMovieCount":0,"reclaimableShowCount":0,
                    "reclaimableSeasonCount":0,"reclaimableEpisodeCount":0,
                    "reclaimableUsingFallback":false
                  },
                  "cleanupTotals":{
                    "itemsHandled":0,"moviesHandled":0,"showsHandled":0,"seasonsHandled":0,
                    "episodesHandled":0,"bytesHandled":0,"movieBytesHandled":0,
                    "showBytesHandled":0,"seasonBytesHandled":0,"episodeBytesHandled":0
                  }
                }
                """);
        }

        if (path.EndsWith("/api/rules/count", StringComparison.Ordinal))
        {
            return Json("2");
        }

        if (path.EndsWith("/api/rules/execute/status", StringComparison.Ordinal))
        {
            return Json(
                """{"processingQueue":false,"executingRuleGroupId":null,"pendingRuleGroupIds":[],"queue":[]}""");
        }

        if (path.EndsWith("/api/overlays/status", StringComparison.Ordinal))
        {
            return Json("""{"status":"idle","lastRun":null}""");
        }

        if (path.Contains("/api/media-server/meta/", StringComparison.Ordinal))
        {
            return Json("""{"excludedFrom":[],"manuallyAddedTo":[]}""");
        }

        return Json("{}", HttpStatusCode.NotFound);
    }

    private static HttpResponseMessage Json(
        string body,
        HttpStatusCode status = HttpStatusCode.OK,
        string mediaType = "application/json")
    {
        var content = new StringContent(body, Encoding.UTF8);
        content.Headers.ContentType = new MediaTypeHeaderValue(mediaType)
        {
            CharSet = "utf-8",
        };
        return new HttpResponseMessage(status) { Content = content };
    }

    private sealed class HandlerFactory : IHttpClientFactory
    {
        private readonly HttpMessageHandler _handler;

        public HandlerFactory(HttpMessageHandler handler)
        {
            _handler = handler;
        }

        public HttpClient CreateClient(string name)
        {
            Assert.Equal(Jellyfin.Plugin.JellyfinCanopy.Helpers.PluginHttpClients.MaintainerrClient, name);
            return new HttpClient(_handler, disposeHandler: false);
        }
    }

    private sealed class RoutingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _response;

        public RoutingHandler(Func<HttpRequestMessage, HttpResponseMessage> response)
        {
            _response = response;
        }

        public ConcurrentQueue<CapturedRequest> Requests { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Requests.Enqueue(new CapturedRequest(
                request.Method,
                request.RequestUri!.PathAndQuery,
                request.Headers.Authorization != null,
                request.Headers.Contains("X-Api-Key"),
                request.Headers.Contains("Cookie")));
            return Task.FromResult(_response(request));
        }
    }

    private sealed class BlockingHandler : HttpMessageHandler
    {
        private int _started;

        public int StartedCount => Volatile.Read(ref _started);

        public TaskCompletionSource Started { get; } = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource Canceled { get; } = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            if (Interlocked.Increment(ref _started) >= 4)
            {
                Started.TrySetResult();
            }

            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                throw new InvalidOperationException("The blocking handler unexpectedly resumed.");
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                Canceled.TrySetResult();
                throw;
            }
        }
    }

    private sealed class AsyncRoutingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _response;

        public AsyncRoutingHandler(
            Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> response)
        {
            _response = response;
        }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => _response(request, cancellationToken);
    }

    private sealed class ManualTimeProvider : TimeProvider
    {
        private DateTimeOffset _now;

        public ManualTimeProvider(DateTimeOffset now) => _now = now;

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan amount) => _now += amount;
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<CapturedLogEntry> Entries { get; } = new();

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull
            => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
            => Entries.Add(new CapturedLogEntry(logLevel, formatter(state, exception), exception));
    }

    private sealed record CapturedLogEntry(
        LogLevel Level,
        string Message,
        Exception? Exception);

    private sealed record CapturedRequest(
        HttpMethod Method,
        string PathAndQuery,
        bool HasAuthorization,
        bool HasApiKey,
        bool HasCookie);
}
