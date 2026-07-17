using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public class SeerrQuotaSourceAffinityTests
{
    private const string JellyfinUserId = "11111111-1111-1111-1111-111111111111";
    private const string SourceA = "http://source-a:5055";
    private const string SourceB = "http://source-b:5055";
    private static readonly DateTime StableNow = DateTime.UtcNow;

    [Fact]
    public async Task GetQuota_ReusesResolvedUserAndPinsHistoryToItsSource()
    {
        var handler = new RecordingHandler(_ =>
            RequestHistory(
                requestedBy: 7,
                mediaType: "movie"));
        var seerr = new PinnedQuotaClient(
            new SeerrUser { Id = 7, SourceUrl = SourceA },
            QuotaBody());
        var controller = BuildController(handler, seerr);

        var result = await controller.GetSeerrQuota();

        Assert.IsType<ContentResult>(result);
        Assert.Equal(1, seerr.ResolveCalls);
        Assert.Equal(0, seerr.GenericProxyCalls);
        Assert.Equal(1, seerr.PinnedProxyCalls);
        Assert.Same(seerr.ResolvedUser, seerr.ProxiedUser);
        Assert.Equal(2, handler.Requests.Count);
        var historyRequest = handler.Requests[0];
        Assert.Equal("source-a", historyRequest.Uri.Host);
        Assert.Equal("/api/v1/user/7/requests", historyRequest.Uri.AbsolutePath);
        Assert.Equal("100", QueryValue(historyRequest.Uri, "take"));
        Assert.Equal("0", QueryValue(historyRequest.Uri, "skip"));
        Assert.Null(QueryValue(historyRequest.Uri, "requestedBy"));
        Assert.Null(QueryValue(historyRequest.Uri, "mediaType"));
        Assert.Null(QueryValue(historyRequest.Uri, "sortDirection"));
        Assert.Equal("7", historyRequest.ApiUser);
        Assert.DoesNotContain(handler.Requests, request => request.Uri.Host == "source-b");
    }

    [Fact]
    public async Task GetQuota_ConfigChangesDuringHistoryProjection_RejectsOldGenerationOutput()
    {
        var provider = new FakePluginConfigProvider(Configuration());
        var handler = new RecordingHandler(_ =>
        {
            var replacement = Configuration();
            replacement.SeerrUrls = SourceB;
            replacement.SeerrApiKey = "replacement-key";
            provider.Current = replacement;
            return RequestHistory(requestedBy: 7, mediaType: "movie");
        });
        var seerr = new PinnedQuotaClient(
            new SeerrUser { Id = 7, SourceUrl = SourceA },
            QuotaBody());
        var controller = BuildController(handler, seerr, provider);

        var result = Assert.IsType<ObjectResult>(await controller.GetSeerrQuota());

        Assert.Equal(409, result.StatusCode);
        var body = JsonNode.Parse(JsonSerializer.Serialize(result.Value))!.AsObject();
        Assert.Equal("quota_configuration_changed", (string?)body["code"]);
        Assert.All(handler.Requests, request => Assert.Equal("source-a", request.Uri.Host));
    }

    [Theory]
    [InlineData(8, "movie")]
    [InlineData(7, "music")]
    public async Task GetQuota_UpstreamRowOutsideRequestedUserOrType_OmitsOnlyResetProjection(
        int requestedBy,
        string mediaType)
    {
        var handler = new RecordingHandler(_ =>
            RequestHistory(requestedBy, mediaType));
        var seerr = new PinnedQuotaClient(
            new SeerrUser { Id = 7, SourceUrl = SourceA },
            QuotaBody());
        var controller = BuildController(handler, seerr);

        AssertResetProjectionUnavailable(await controller.GetSeerrQuota());
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task GetQuota_MalformedScopedRow_OmitsOnlyResetProjection()
    {
        var handler = new RecordingHandler(_ => Json(new
        {
            results = new[]
            {
                new
                {
                    id = 1,
                    type = "movie",
                    status = 2,
                    createdAt = DateTime.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
                },
            },
            pageInfo = new { page = 1, pages = 1, results = 1 },
        }));
        var seerr = new PinnedQuotaClient(
            new SeerrUser { Id = 7, SourceUrl = SourceA },
            QuotaBody());
        var controller = BuildController(handler, seerr);

        AssertResetProjectionUnavailable(await controller.GetSeerrQuota());
    }

    [Theory]
    [InlineData("{\"tv\":null}")]
    [InlineData("{\"movie\":\"invalid\",\"tv\":null}")]
    [InlineData("{\"movie\":{\"limit\":5,\"days\":7,\"restricted\":false},\"tv\":null}")]
    [InlineData("{\"movie\":{\"limit\":5,\"used\":1,\"days\":7,\"remaining\":4},\"tv\":null}")]
    [InlineData("{\"movie\":{\"limit\":5,\"used\":\"1\",\"days\":7,\"remaining\":4,\"restricted\":false},\"tv\":null}")]
    [InlineData("{\"movie\":{\"limit\":5,\"used\":-1,\"days\":7,\"restricted\":false},\"tv\":null}")]
    [InlineData("{\"movie\":{\"limit\":-1,\"used\":1,\"days\":7,\"remaining\":4,\"restricted\":false},\"tv\":null}")]
    [InlineData("{\"movie\":{\"limit\":5,\"used\":1,\"days\":-1,\"remaining\":4,\"restricted\":false},\"tv\":null}")]
    [InlineData("{\"movie\":{\"limit\":5,\"used\":1,\"days\":7,\"remaining\":-1,\"restricted\":false},\"tv\":null}")]
    public async Task GetQuota_MalformedQuotaSide_FailsClosed(string quotaBody)
    {
        var handler = new RecordingHandler(_ => throw new InvalidOperationException("History must not be fetched."));
        var seerr = new PinnedQuotaClient(
            new SeerrUser { Id = 7, SourceUrl = SourceA },
            quotaBody);
        var controller = BuildController(handler, seerr);

        var result = await controller.GetSeerrQuota();

        var failure = Assert.IsType<ObjectResult>(result);
        Assert.Equal(502, failure.StatusCode);
        var body = JsonNode.Parse(JsonSerializer.Serialize(failure.Value))!.AsObject();
        Assert.Equal("quota_projection_invalid", (string?)body["code"]);
        Assert.Empty(handler.Requests);
    }

    [Theory]
    [InlineData("{\"movie\":{\"limit\":5,\"used\":1,\"days\":7,\"remaining\":4,\"restricted\":true},\"tv\":null}")]
    [InlineData("{\"movie\":{\"limit\":5,\"used\":5,\"days\":7,\"remaining\":0,\"restricted\":false},\"tv\":null}")]
    [InlineData("{\"movie\":{\"limit\":0,\"used\":1,\"days\":7,\"restricted\":false},\"tv\":null}")]
    [InlineData("{\"movie\":{\"limit\":0,\"used\":0,\"days\":7,\"remaining\":0,\"restricted\":false},\"tv\":null}")]
    [InlineData("{\"movie\":{\"limit\":5,\"used\":1,\"days\":7,\"remaining\":3,\"restricted\":false},\"tv\":null}")]
    public async Task GetQuota_CrossFieldInconsistency_OmitsProjectionWithoutFetchingHistory(
        string quotaBody)
    {
        var handler = new RecordingHandler(_ =>
            throw new InvalidOperationException("History must not be fetched."));
        var seerr = new PinnedQuotaClient(
            new SeerrUser { Id = 7, SourceUrl = SourceA },
            quotaBody);
        var controller = BuildController(handler, seerr);

        var result = Assert.IsType<ContentResult>(await controller.GetSeerrQuota());

        var expected = JsonNode.Parse(quotaBody)!.AsObject();
        var body = JsonNode.Parse(result.Content!)!.AsObject();
        Assert.False((bool?)body["resetProjectionComplete"]);
        Assert.True(JsonNode.DeepEquals(expected["movie"], body["movie"]));
        Assert.True(JsonNode.DeepEquals(expected["tv"], body["tv"]));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task GetQuota_PositiveUsageWithoutCountableHistory_PreservesBaseQuota()
    {
        var handler = new RecordingHandler(_ => Json(new
        {
            results = Array.Empty<object>(),
            pageInfo = new { page = 1, pages = 1, results = 0 },
        }));
        var seerr = new PinnedQuotaClient(
            new SeerrUser { Id = 7, SourceUrl = SourceA },
            QuotaBody());
        var controller = BuildController(handler, seerr);

        AssertResetProjectionUnavailable(await controller.GetSeerrQuota());
    }

    [Fact]
    public async Task GetQuota_IncompleteHistory_PreservesBaseQuotaWithoutReset()
    {
        var handler = new RecordingHandler(_ => Json(
            new { error = "temporary history failure" },
            HttpStatusCode.BadGateway));
        var seerr = new PinnedQuotaClient(
            new SeerrUser { Id = 7, SourceUrl = SourceA },
            QuotaBody());
        var controller = BuildController(handler, seerr);

        AssertResetProjectionUnavailable(await controller.GetSeerrQuota());
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task GetQuota_IgnoreQuotaIsNotAnExemptionAndOldestRequestSetsReset()
    {
        var exemptCreatedAt = DateTime.UtcNow.AddDays(-2);
        var countingCreatedAt = DateTime.UtcNow.AddDays(-1);
        var handler = new RecordingHandler(_ => Json(new
        {
            results = new object[]
            {
                RequestRow(1, exemptCreatedAt, ignoreQuota: true),
                RequestRow(2, countingCreatedAt, ignoreQuota: false),
            },
            pageInfo = new { page = 1, pages = 1, results = 2 },
        }));
        var seerr = new PinnedQuotaClient(
            new SeerrUser { Id = 7, SourceUrl = SourceA },
            QuotaBody(movieUsed: 2, movieLimit: 2));
        var controller = BuildController(handler, seerr);

        var result = Assert.IsType<ContentResult>(await controller.GetSeerrQuota());

        var body = JsonNode.Parse(result.Content!)!.AsObject();
        Assert.True((bool?)body["resetProjectionComplete"]);
        var actual = DateTime.Parse(
            (string)body["movie"]!["nextResetAt"]!,
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.RoundtripKind);
        Assert.Equal(exemptCreatedAt.AddDays(7), actual);
    }

    [Fact]
    public async Task GetQuota_MovieUsageAboveLoweredLimitWaitsForEnoughExpiriesToOpenSlot()
    {
        var oldest = DateTime.UtcNow.AddDays(-3);
        var slotOpening = DateTime.UtcNow.AddDays(-2);
        var newest = DateTime.UtcNow.AddDays(-1);
        var handler = new RecordingHandler(_ => Json(new
        {
            results = new object[]
            {
                RequestRow(1, oldest, ignoreQuota: false),
                RequestRow(2, slotOpening, ignoreQuota: false),
                RequestRow(3, newest, ignoreQuota: false),
            },
            pageInfo = new { page = 1, pages = 1, results = 3 },
        }));
        var quota = JsonSerializer.Serialize(new
        {
            movie = new { limit = 2, used = 3, days = 7, remaining = 0, restricted = true },
            tv = (object?)null,
        });
        var controller = BuildController(
            handler,
            new PinnedQuotaClient(new SeerrUser { Id = 7, SourceUrl = SourceA }, quota));

        var result = Assert.IsType<ContentResult>(await controller.GetSeerrQuota());
        var body = JsonNode.Parse(result.Content!)!.AsObject();

        Assert.True((bool?)body["resetProjectionComplete"]);
        Assert.Equal(
            slotOpening.AddDays(7),
            DateTime.Parse((string)body["movie"]!["nextResetAt"]!, null, System.Globalization.DateTimeStyles.RoundtripKind));
    }

    [Fact]
    public async Task GetQuota_TvUsageAboveLoweredLimitAccumulatesSeasonUnitsByRequestExpiry()
    {
        var oldest = DateTime.UtcNow.AddDays(-3);
        var slotOpening = DateTime.UtcNow.AddDays(-2);
        var newest = DateTime.UtcNow.AddDays(-1);
        var handler = new RecordingHandler(_ => Json(new
        {
            results = new object[]
            {
                TvRequestRow(1, oldest, 2),
                TvRequestRow(2, slotOpening, 2),
                TvRequestRow(3, newest, 1),
            },
            pageInfo = new { page = 1, pages = 1, results = 3 },
        }));
        var quota = JsonSerializer.Serialize(new
        {
            movie = (object?)null,
            tv = new { limit = 3, used = 5, days = 7, remaining = 0, restricted = true },
        });
        var controller = BuildController(
            handler,
            new PinnedQuotaClient(new SeerrUser { Id = 7, SourceUrl = SourceA }, quota));

        var result = Assert.IsType<ContentResult>(await controller.GetSeerrQuota());
        var body = JsonNode.Parse(result.Content!)!.AsObject();

        Assert.True((bool?)body["resetProjectionComplete"]);
        Assert.Equal(
            slotOpening.AddDays(7),
            DateTime.Parse((string)body["tv"]!["nextResetAt"]!, null, System.Globalization.DateTimeStyles.RoundtripKind));
    }

    [Fact]
    public async Task GetQuota_NonBooleanIgnoreQuotaIsIgnoredLikeOfficialSeerr()
    {
        var createdAt = DateTime.UtcNow;
        var handler = new RecordingHandler(_ => Json(new
        {
            results = new[]
            {
                new
                {
                    id = 1,
                    type = "movie",
                    status = 2,
                    ignoreQuota = "true",
                    createdAt = createdAt.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
                    requestedBy = new { id = 7 },
                    media = new { mediaType = "movie" },
                },
            },
            pageInfo = new { page = 1, pages = 1, results = 1 },
        }));
        var seerr = new PinnedQuotaClient(
            new SeerrUser { Id = 7, SourceUrl = SourceA },
            QuotaBody());
        var controller = BuildController(handler, seerr);

        var result = Assert.IsType<ContentResult>(await controller.GetSeerrQuota());
        var body = JsonNode.Parse(result.Content!)!.AsObject();
        Assert.True((bool?)body["resetProjectionComplete"]);
        Assert.NotNull(body["movie"]!["nextResetAt"]);
    }

    [Fact]
    public async Task GetQuota_RemainingCapacityPublishesNoFutureEligibilityAndSkipsHistory()
    {
        var handler = new RecordingHandler(_ =>
            throw new InvalidOperationException("History must not be fetched for an unrestricted quota."));
        var quota = JsonSerializer.Serialize(new
        {
            movie = new { limit = 5, used = 4, days = 7, remaining = 1, restricted = false },
            tv = (object?)null,
        });
        var controller = BuildController(
            handler,
            new PinnedQuotaClient(new SeerrUser { Id = 7, SourceUrl = SourceA }, quota));

        var result = Assert.IsType<ContentResult>(await controller.GetSeerrQuota());
        var body = JsonNode.Parse(result.Content!)!.AsObject();

        Assert.True((bool?)body["resetProjectionComplete"]);
        Assert.False(Assert.IsType<JsonObject>(body["movie"]).ContainsKey("nextResetAt"));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task GetQuota_SharedFullHistoryFiltersTypesLocallyAndCountsTvSeasons()
    {
        var movieCreatedAt = DateTime.UtcNow.AddDays(-2);
        var tvCreatedAt = DateTime.UtcNow.AddDays(-1);
        var handler = new RecordingHandler(_ => Json(new
        {
            results = new object[]
            {
                new
                {
                    id = 1,
                    type = "movie",
                    status = 2,
                    createdAt = movieCreatedAt.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
                    requestedBy = new { id = 7 },
                    // Generic /request hides blocklisted media. The user-history
                    // endpoint retains it and quota still counts the request.
                    media = new { mediaType = "movie", status = 6 },
                },
                new
                {
                    id = 2,
                    type = "tv",
                    status = 2,
                    createdAt = tvCreatedAt.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
                    requestedBy = new { id = 7 },
                    seasons = new[] { new { id = 10 }, new { id = 11 }, new { id = 12 } },
                    media = new { mediaType = "tv", status = 6 },
                },
            },
            pageInfo = new { page = 1, pages = 1, results = 2 },
        }));
        var seerr = new PinnedQuotaClient(
            new SeerrUser { Id = 7, SourceUrl = SourceA },
            BothQuotaBody(movieUsed: 1, tvUsed: 3));
        var controller = BuildController(handler, seerr);

        var result = Assert.IsType<ContentResult>(await controller.GetSeerrQuota());
        var body = JsonNode.Parse(result.Content!)!.AsObject();

        Assert.True((bool?)body["resetProjectionComplete"]);
        Assert.Equal(2, handler.Requests.Count);
        Assert.Equal(
            movieCreatedAt.AddDays(7),
            DateTime.Parse((string)body["movie"]!["nextResetAt"]!, null, System.Globalization.DateTimeStyles.RoundtripKind));
        Assert.Equal(
            tvCreatedAt.AddDays(7),
            DateTime.Parse((string)body["tv"]!["nextResetAt"]!, null, System.Globalization.DateTimeStyles.RoundtripKind));
    }

    [Fact]
    public async Task GetQuota_TvSeasonCountMismatch_OmitsProjection()
    {
        var handler = new RecordingHandler(_ => Json(new
        {
            results = new[]
            {
                new
                {
                    id = 1,
                    type = "tv",
                    status = 2,
                    createdAt = DateTime.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
                    requestedBy = new { id = 7 },
                    seasons = new[] { new { id = 10 }, new { id = 11 } },
                },
            },
            pageInfo = new { page = 1, pages = 1, results = 1 },
        }));
        var seerr = new PinnedQuotaClient(
            new SeerrUser { Id = 7, SourceUrl = SourceA },
            TvQuotaBody(tvUsed: 3));
        var controller = BuildController(handler, seerr);

        var result = Assert.IsType<ContentResult>(await controller.GetSeerrQuota());
        var body = JsonNode.Parse(result.Content!)!.AsObject();

        Assert.False((bool?)body["resetProjectionComplete"]);
        Assert.False(Assert.IsType<JsonObject>(body["tv"]).ContainsKey("nextResetAt"));
    }

    [Fact]
    public async Task GetQuota_DeclinedAndExpiredBoundaryRowsDoNotContribute()
    {
        var now = DateTime.UtcNow;
        var activeCreatedAt = now.AddDays(-1);
        var handler = new RecordingHandler(_ => Json(new
        {
            results = new object[]
            {
                RequestRow(1, now.AddDays(-8), ignoreQuota: false),
                new
                {
                    id = 2,
                    type = "movie",
                    status = 3,
                    createdAt = now.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
                    requestedBy = new { id = 7 },
                },
                RequestRow(3, activeCreatedAt, ignoreQuota: false),
            },
            pageInfo = new { page = 1, pages = 1, results = 3 },
        }));
        var seerr = new PinnedQuotaClient(
            new SeerrUser { Id = 7, SourceUrl = SourceA },
            QuotaBody());
        var controller = BuildController(handler, seerr);

        var result = Assert.IsType<ContentResult>(await controller.GetSeerrQuota());
        var body = JsonNode.Parse(result.Content!)!.AsObject();

        Assert.True((bool?)body["resetProjectionComplete"]);
        Assert.Equal(
            activeCreatedAt.AddDays(7),
            DateTime.Parse((string)body["movie"]!["nextResetAt"]!, null, System.Globalization.DateTimeStyles.RoundtripKind));
    }

    [Fact]
    public async Task GetQuota_MissingPinnedSourceDoesNotFailOver()
    {
        var handler = new RecordingHandler(_ => throw new InvalidOperationException("History must not be fetched."));
        var seerr = new PinnedQuotaClient(
            new SeerrUser { Id = 7, SourceUrl = null },
            QuotaBody());
        var controller = BuildController(handler, seerr);

        var result = Assert.IsType<ObjectResult>(await controller.GetSeerrQuota());
        Assert.Equal(502, result.StatusCode);
        var body = JsonNode.Parse(JsonSerializer.Serialize(result.Value))!.AsObject();
        Assert.Equal("source_affinity_unavailable", (string?)body["code"]);
        Assert.Empty(handler.Requests);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(99)]
    public async Task GetQuota_StatusOutsideSeerrEnum_OmitsOnlyResetProjection(int status)
    {
        var handler = new RecordingHandler(_ => Json(new
        {
            results = new[]
            {
                new
                {
                    id = 1,
                    type = "movie",
                    status,
                    createdAt = StableNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
                    requestedBy = new { id = 7 },
                    media = new { mediaType = "movie" },
                },
            },
            pageInfo = new { page = 1, pages = 1, results = 1 },
        }));
        var seerr = new PinnedQuotaClient(
            new SeerrUser { Id = 7, SourceUrl = SourceA },
            QuotaBody());
        var controller = BuildController(handler, seerr);

        AssertResetProjectionUnavailable(await controller.GetSeerrQuota());
    }

    [Fact]
    public async Task PartialRequestSettings_UsesResolvedLaterSourceWithoutFirstSourceFallback()
    {
        var handler = new RecordingHandler(request =>
        {
            Assert.Equal("source-b", request.RequestUri!.Host);
            Assert.Equal("/api/v1/settings/main", request.RequestUri.AbsolutePath);
            return Json(new { partialRequestsEnabled = true, enableSpecialEpisodes = false });
        });
        var seerr = new PinnedQuotaClient(
            new SeerrUser { Id = 7, SourceUrl = SourceB },
            QuotaBody());
        var controller = BuildController(handler, seerr);

        var result = Assert.IsType<OkObjectResult>(await controller.GetSeerrPartialRequestsSetting());
        var body = JsonNode.Parse(JsonSerializer.Serialize(result.Value))!.AsObject();

        Assert.True((bool?)body["partialRequestsEnabled"]);
        Assert.False((bool?)body["enableSpecialEpisodes"]);
        var request = Assert.Single(handler.Requests);
        Assert.Equal("source-b", request.Uri.Host);
    }

    [Fact]
    public async Task PartialRequestSettings_MissingResolvedSourceFailsClosedWithoutHttp()
    {
        var handler = new RecordingHandler(_ => throw new InvalidOperationException("HTTP must not be attempted."));
        var controller = BuildController(
            handler,
            new PinnedQuotaClient(new SeerrUser { Id = 7, SourceUrl = null }, QuotaBody()));

        var failure = Assert.IsType<ObjectResult>(await controller.GetSeerrPartialRequestsSetting());
        Assert.Equal(502, failure.StatusCode);
        var body = JsonNode.Parse(JsonSerializer.Serialize(failure.Value))!.AsObject();
        Assert.Equal("source_affinity_unavailable", (string?)body["code"]);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task PreResolvedProxy_FreshlyRevalidatesBindingThenUsesPinnedSource()
    {
        var handler = new RecordingHandler(request =>
        {
            if (request.RequestUri!.AbsolutePath == "/api/v1/user/7")
            {
                Assert.Equal("source-a", request.RequestUri.Host);
                return Json(new
                {
                    id = 7,
                    jellyfinUserId = JellyfinUserId,
                    permissions = 0,
                });
            }

            Assert.Equal("source-a", request.RequestUri.Host);
            Assert.Equal("/api/v1/user/7/quota", request.RequestUri.AbsolutePath);
            return Json(new { movie = (object?)null, tv = (object?)null });
        });
        var provider = new FakePluginConfigProvider(Configuration());
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            userManager: null!,
            new SeerrCache(provider),
            provider,
            new PassthroughParentalFilter(),
            null!);
        var resolvedUser = new SeerrUser { Id = 7, SourceUrl = SourceA };

        var result = await client.ProxyRequestAsync(
            "/api/v1/user/7/quota",
            HttpMethod.Get,
            content: null,
            new SeerrCaller(JellyfinUserId, IsAdmin: false),
            resolvedUser);

        Assert.IsType<ContentResult>(result);
        Assert.Equal(2, handler.Requests.Count);
        Assert.Single(handler.Requests, request => request.Uri.AbsolutePath == "/api/v1/user/7");
        var request = Assert.Single(
            handler.Requests,
            request => request.Uri.AbsolutePath == "/api/v1/user/7/quota");
        Assert.Equal("source-a", request.Uri.Host);
        Assert.Equal("7", request.ApiUser);
    }

    [Fact]
    public async Task PreResolvedProxy_SameSourceIdReboundToDifferentJellyfinUser_DoesNotReadQuota()
    {
        var handler = new RecordingHandler(request =>
        {
            if (request.RequestUri!.AbsolutePath != "/api/v1/user/7")
            {
                throw new InvalidOperationException("A stale same-source binding must not read user-local quota.");
            }

            return Json(new
            {
                id = 7,
                jellyfinUserId = "22222222-2222-2222-2222-222222222222",
                permissions = 0,
            });
        });
        var provider = new FakePluginConfigProvider(Configuration());
        var cache = new SeerrCache(provider);
        cache.UserCache[JellyfinUserId.Replace("-", string.Empty)] = (
            new SeerrUser
            {
                Id = 7,
                SourceUrl = SourceA,
                JellyfinUserId = JellyfinUserId.Replace("-", string.Empty),
            },
            DateTime.UtcNow,
            provider.ConfigurationRevision,
            SeerrClient.BuildConfigurationIdentity(provider.Current!));
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            userManager: null!,
            cache,
            provider,
            new PassthroughParentalFilter(),
            null!);

        var result = await client.ProxyRequestAsync(
            "/api/v1/user/7/quota",
            HttpMethod.Get,
            content: null,
            new SeerrCaller(JellyfinUserId, IsAdmin: false),
            new SeerrUser { Id = 7, SourceUrl = SourceA });

        var failure = Assert.IsType<ObjectResult>(result);
        Assert.Equal(409, failure.StatusCode);
        Assert.DoesNotContain(
            handler.Requests,
            request => request.Uri.AbsolutePath == "/api/v1/user/7/quota");
        Assert.DoesNotContain(JellyfinUserId.Replace("-", string.Empty), cache.UserCache.Keys);
    }

    [Fact]
    public async Task PreResolvedProxy_UnconfiguredSource_FailsClosedWithoutHttp()
    {
        var handler = new RecordingHandler(_ => throw new InvalidOperationException("HTTP must not be attempted."));
        var provider = new FakePluginConfigProvider(Configuration());
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            userManager: null!,
            new SeerrCache(provider),
            provider,
            new PassthroughParentalFilter(),
            null!);

        var result = await client.ProxyRequestAsync(
            "/api/v1/user/7/quota",
            HttpMethod.Get,
            content: null,
            new SeerrCaller(JellyfinUserId, IsAdmin: false),
            new SeerrUser { Id = 7, SourceUrl = "http://removed-source:5055" });

        var failure = Assert.IsType<ObjectResult>(result);
        Assert.Equal(502, failure.StatusCode);
        var body = JsonNode.Parse(JsonSerializer.Serialize(failure.Value))!.AsObject();
        Assert.Equal("source_affinity_unavailable", (string?)body["code"]);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task PreResolvedProxy_PathCaseMismatchFailsClosedWithoutHttp()
    {
        var handler = new RecordingHandler(_ => throw new InvalidOperationException("HTTP must not be attempted."));
        var config = Configuration();
        config.SeerrUrls = "http://source-a:5055/tenant";
        var provider = new FakePluginConfigProvider(config);
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            userManager: null!,
            new SeerrCache(provider),
            provider,
            new PassthroughParentalFilter(),
            null!);

        var result = await client.ProxyRequestAsync(
            "/api/v1/user/7/quota",
            HttpMethod.Get,
            content: null,
            new SeerrCaller(JellyfinUserId, IsAdmin: false),
            new SeerrUser { Id = 7, SourceUrl = "http://source-a:5055/Tenant" });

        var failure = Assert.IsType<ObjectResult>(result);
        Assert.Equal(502, failure.StatusCode);
        var body = JsonNode.Parse(JsonSerializer.Serialize(failure.Value))!.AsObject();
        Assert.Equal("source_affinity_unavailable", (string?)body["code"]);
        Assert.Empty(handler.Requests);
    }

    private static SeerrProxyController BuildController(
        RecordingHandler handler,
        PinnedQuotaClient seerr,
        FakePluginConfigProvider? provider = null)
    {
        provider ??= new FakePluginConfigProvider(Configuration());
        var controller = new SeerrProxyController(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrProxyController>.Instance,
            new StubUserManager(),
            new SeerrCache(provider),
            provider,
            seerr,
            parentalFilter: null!,
            spoilerPending: null!);
        var identity = new ClaimsIdentity(
            new[] { new Claim("Jellyfin-UserId", JellyfinUserId) },
            "TestAuth");
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(identity) },
        };
        return controller;
    }

    private static JsonObject AssertResetProjectionUnavailable(IActionResult result)
    {
        var content = Assert.IsType<ContentResult>(result);
        var body = JsonNode.Parse(content.Content!)!.AsObject();
        Assert.False((bool?)body["resetProjectionComplete"]);
        var movie = Assert.IsType<JsonObject>(body["movie"]);
        Assert.Equal(1, (int?)movie["used"]);
        Assert.False(movie.ContainsKey("nextResetAt"));
        return body;
    }

    private static PluginConfiguration Configuration() => new()
    {
        SeerrEnabled = true,
        SeerrUrls = $"{SourceA}\n{SourceB}",
        SeerrApiKey = "test-key",
    };

    private static string QuotaBody(int movieUsed = 1, int movieLimit = 1)
        => JsonSerializer.Serialize(new
        {
            movie = new
            {
                limit = movieLimit,
                used = movieUsed,
                days = 7,
                remaining = Math.Max(0, movieLimit - movieUsed),
                restricted = movieUsed >= movieLimit,
            },
            tv = (object?)null,
        });

    private static string TvQuotaBody(int tvUsed)
        => JsonSerializer.Serialize(new
        {
            movie = (object?)null,
            tv = new
            {
                limit = tvUsed,
                used = tvUsed,
                days = 7,
                remaining = 0,
                restricted = true,
            },
        });

    private static string BothQuotaBody(int movieUsed, int tvUsed)
        => JsonSerializer.Serialize(new
        {
            movie = new
            {
                limit = movieUsed,
                used = movieUsed,
                days = 7,
                remaining = 0,
                restricted = true,
            },
            tv = new
            {
                limit = tvUsed,
                used = tvUsed,
                days = 7,
                remaining = 0,
                restricted = true,
            },
        });

    private static object RequestRow(int id, DateTime createdAt, bool ignoreQuota)
        => new
        {
            id,
            type = "movie",
            status = 2,
            ignoreQuota,
            createdAt = createdAt.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
            requestedBy = new { id = 7 },
            media = new { mediaType = "movie" },
        };

    private static object TvRequestRow(int id, DateTime createdAt, int seasonCount)
        => new
        {
            id,
            type = "tv",
            status = 2,
            createdAt = createdAt.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
            requestedBy = new { id = 7 },
            seasons = Enumerable.Range(1, seasonCount).Select(seasonId => new { id = seasonId }).ToArray(),
            media = new { mediaType = "tv" },
        };

    private static HttpResponseMessage RequestHistory(
        int requestedBy,
        string mediaType)
        => Json(new
        {
            results = new[]
            {
                new
                {
                    id = 1,
                    type = mediaType,
                    status = 2,
                    createdAt = StableNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
                    requestedBy = new { id = requestedBy },
                },
            },
            pageInfo = new { page = 1, pages = 1, results = 1 },
        });

    private static HttpResponseMessage Json(object body, HttpStatusCode status = HttpStatusCode.OK)
        => new(status)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
        };

    private static string? QueryValue(Uri uri, string name)
    {
        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            if (parts.Length == 2 && string.Equals(parts[0], name, StringComparison.Ordinal))
            {
                return Uri.UnescapeDataString(parts[1]);
            }
        }

        return null;
    }

    private sealed record CapturedRequest(Uri Uri, string? ApiUser);

    private sealed class RecordingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _route;

        public RecordingHandler(Func<HttpRequestMessage, HttpResponseMessage> route) => _route = route;

        public List<CapturedRequest> Requests { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var apiUser = request.Headers.TryGetValues("X-Api-User", out var values)
                ? values.SingleOrDefault()
                : null;
            Requests.Add(new CapturedRequest(request.RequestUri!, apiUser));
            return Task.FromResult(_route(request));
        }
    }

    private sealed class PinnedQuotaClient : ISeerrClient
    {
        private readonly string _quotaBody;

        public PinnedQuotaClient(SeerrUser resolvedUser, string quotaBody)
        {
            ResolvedUser = resolvedUser;
            _quotaBody = quotaBody;
        }

        public SeerrUser ResolvedUser { get; }

        public SeerrUser? ProxiedUser { get; private set; }

        public int ResolveCalls { get; private set; }

        public int GenericProxyCalls { get; private set; }

        public int PinnedProxyCalls { get; private set; }

        public Task<SeerrUserResolution> ResolveSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ResolveCalls++;
            return Task.FromResult(SeerrUserResolution.Found(ResolvedUser));
        }

        public Task<IActionResult> ProxyRequestAsync(
            string apiPath,
            HttpMethod method,
            string? content,
            SeerrCaller caller)
        {
            GenericProxyCalls++;
            throw new InvalidOperationException("Quota must use the pre-resolved proxy overload.");
        }

        public Task<IActionResult> ProxyRequestAsync(
            string apiPath,
            HttpMethod method,
            string? content,
            SeerrCaller caller,
            SeerrUser resolvedUser)
        {
            PinnedProxyCalls++;
            ProxiedUser = resolvedUser;
            return Task.FromResult<IActionResult>(new ContentResult
            {
                Content = _quotaBody,
                ContentType = "application/json",
            });
        }

        public Task<SeerrUser?> GetSeerrUser(string jellyfinUserId, bool bypassCache = false, bool allowAutoImport = true)
            => throw new NotImplementedException();

        public Task<string?> GetSeerrUserId(string jellyfinUserId, bool allowAutoImport = true)
            => throw new NotImplementedException();

        public bool IsImportBlocked(string jellyfinUserId, PluginConfiguration config)
            => throw new NotImplementedException();

        public Task<bool> GetStatusActiveAsync() => throw new NotImplementedException();

        public Task<Seerr4kCapability> GetSeerr4kCapabilityAsync(string jellyfinUserId, bool isAdmin = false)
            => throw new NotImplementedException();

        public void EvictMediaDetailCache(int tmdbId, string mediaType)
        {
        }

        public Task<List<WatchlistItem>?> GetWatchlistForUser(string seerrUserId)
            => throw new NotImplementedException();

        public Task<List<WatchlistItem>?> GetRequestsForUser(string seerrUserId)
            => throw new NotImplementedException();
    }

    private sealed class PassthroughParentalFilter : ISeerrParentalFilter
    {
        public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
            => Task.FromResult(new SeerrParentalResult(false, json));

        public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
            => Task.FromResult(false);

        public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
            => Task.FromResult(false);
    }
}
