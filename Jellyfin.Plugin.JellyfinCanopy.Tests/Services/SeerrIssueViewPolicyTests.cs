using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

/// <summary>
/// Pins the issue-read preflight in <see cref="SeerrClient.ProxyRequestAsyncCore"/>.
/// Seerr enforces per-issue ownership on the <c>/api/v1/issue</c> list and
/// <c>/api/v1/issue/{id}</c> detail routes (issue.ts: a caller lacking
/// VIEW_ISSUES/MANAGE_ISSUES is scoped to <c>createdBy = self</c> on the list and
/// 403'd on a foreign detail), so a CREATE_ISSUES-only reporter must be admitted
/// through Canopy's local gate to read THEIR OWN issues — without becoming a
/// global view. A caller holding none of CREATE/VIEW/MANAGE stays locally 403'd
/// before any upstream dispatch, and VIEW_ISSUES/MANAGE_ISSUES behavior is
/// unchanged.
/// </summary>
public class SeerrIssueViewPolicyTests
{
    private const string UserId = "3f2504e04f8941d39a0c0305e82c3301";
    private const string ListPath = "/api/v1/issue?take=20&skip=0&filter=all&sort=added";
    private const string DetailPath = "/api/v1/issue/5";

    private static PluginConfiguration Config() => new()
    {
        SeerrEnabled = true,
        SeerrUrls = "http://seerr:5055",
        SeerrApiKey = "test-key",
    };

    private static (SeerrClient client, RecordingHttpMessageHandler handler) NewClient()
    {
        var handler = new RecordingHttpMessageHandler();
        var provider = new FakePluginConfigProvider(Config());
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            null!,
            new SeerrCache(provider),
            provider,
            new PassthroughParentalFilter());
        return (client, handler);
    }

    private static void SeedUser(RecordingHttpMessageHandler handler, long permissions)
        => handler.AddResponse(
            "/api/v1/user",
            $"{{\"results\":[{{\"id\":42,\"jellyfinUserId\":\"{UserId}\",\"permissions\":{permissions}}}],\"pageInfo\":{{\"page\":1,\"pages\":1,\"results\":1}}}}");

    private static string? GetCode(object? value)
        => value?.GetType().GetProperty("code")?.GetValue(value) as string;

    private static bool DispatchedIssueRead(RecordingHttpMessageHandler handler)
        => handler.Sent.Any(r =>
            r.Method == HttpMethod.Get
            && r.Path.StartsWith("/api/v1/issue", System.StringComparison.Ordinal));

    // ── CREATE_ISSUES-only is admitted so Seerr can enforce ownership ─────────

    [Theory]
    [InlineData(ListPath)]
    [InlineData(DetailPath)]
    public async Task CreateIssuesOnly_IssueRead_PassesPreflightAndDispatches(string apiPath)
    {
        var (client, handler) = NewClient();
        SeedUser(handler, (long)SeerrPermission.CREATE_ISSUES);
        handler.AddResponse("/api/v1/issue", "{\"results\":[]}");
        handler.AddResponse("/api/v1/issue/5", "{\"id\":5}");

        var result = await client.ProxyRequestAsync(
            apiPath, HttpMethod.Get, null, new SeerrCaller(UserId, false));

        // The read reached Seerr (which owns the ownership call) rather than being
        // stopped by Canopy's local no_issue_view_permission gate.
        Assert.True(DispatchedIssueRead(handler));
        Assert.NotEqual("no_issue_view_permission", GetCode((result as ObjectResult)?.Value));
    }

    [Fact]
    public async Task CreateIssuesOnly_IssueDetail_CarriesPinnedUserIdentitySoSeerrEnforcesOwnership()
    {
        var (client, handler) = NewClient();
        SeedUser(handler, (long)SeerrPermission.CREATE_ISSUES);
        // Seerr denies a foreign issue itself; Canopy must surface that, proving
        // local admission did not turn into a global view.
        handler.AddResponse("/api/v1/issue/9", "{\"message\":\"forbidden\"}", HttpStatusCode.Forbidden);

        var result = await client.ProxyRequestAsync(
            "/api/v1/issue/9", HttpMethod.Get, null, new SeerrCaller(UserId, false));

        var dispatched = handler.Requests.Single(r =>
            r.RequestUri!.AbsolutePath == "/api/v1/issue/9");
        Assert.True(dispatched.Headers.TryGetValues("X-Api-User", out var apiUser));
        Assert.Equal("42", apiUser!.Single());
        // Seerr's 403 is preserved rather than replaced by a local decision.
        var obj = Assert.IsType<ObjectResult>(result);
        Assert.Equal(403, obj.StatusCode);
    }

    // ── None of CREATE/VIEW/MANAGE remains a local 403 before dispatch ────────

    [Theory]
    [InlineData(ListPath)]
    [InlineData(DetailPath)]
    public async Task NoIssuePermission_IssueRead_LocallyRejectedBeforeDispatch(string apiPath)
    {
        var (client, handler) = NewClient();
        // REQUEST_MOVIE only — a real permission, but none of the issue bits.
        SeedUser(handler, (long)SeerrPermission.REQUEST_MOVIE);
        handler.AddResponse("/api/v1/issue", "{\"results\":[]}");

        var result = await client.ProxyRequestAsync(
            apiPath, HttpMethod.Get, null, new SeerrCaller(UserId, false));

        var obj = Assert.IsType<ObjectResult>(result);
        Assert.Equal(403, obj.StatusCode);
        Assert.Equal("no_issue_view_permission", GetCode(obj.Value));
        Assert.False(DispatchedIssueRead(handler));
    }

    // ── VIEW_ISSUES / MANAGE_ISSUES semantics are unchanged ───────────────────

    [Theory]
    [InlineData((long)SeerrPermission.VIEW_ISSUES)]
    [InlineData((long)SeerrPermission.MANAGE_ISSUES)]
    public async Task ViewOrManageIssues_IssueList_StillDispatches(long permissions)
    {
        var (client, handler) = NewClient();
        SeedUser(handler, permissions);
        handler.AddResponse("/api/v1/issue", "{\"results\":[]}");

        var result = await client.ProxyRequestAsync(
            ListPath, HttpMethod.Get, null, new SeerrCaller(UserId, false));

        Assert.IsNotType<ObjectResult>(result);
        Assert.True(DispatchedIssueRead(handler));
    }

    // ── The media-detail relation is UNFILTERED, so it stays VIEW/MANAGE-only ──

    [Fact]
    public async Task CreateIssuesOnly_MediaDetailRelation_StaysLocallyRejectedBeforeDispatch()
    {
        var (client, handler) = NewClient();
        handler.AddResponse(
            "/api/v1/user/42",
            $"{{\"id\":42,\"jellyfinUserId\":\"{UserId}\",\"permissions\":{(long)SeerrPermission.CREATE_ISSUES}}}");
        handler.AddResponse(
            "/api/v1/movie/100",
            "{\"mediaInfo\":{\"id\":1,\"tmdbId\":100,\"mediaType\":\"movie\",\"issues\":[]}}");

        var result = await client.ProxyFreshMediaDetailAsync(
            100,
            "movie",
            new SeerrCaller(UserId, false),
            new SeerrUser { Id = 42, SourceUrl = "http://seerr:5055", Permissions = SeerrPermission.CREATE_ISSUES });

        var obj = Assert.IsType<ObjectResult>(result);
        Assert.Equal(403, obj.StatusCode);
        Assert.Equal("no_issue_view_permission", GetCode(obj.Value));
        Assert.DoesNotContain(handler.Sent, r => r.Path == "/api/v1/movie/100");
    }

    [Fact]
    public async Task ViewIssues_MediaDetailRelation_StillDispatches()
    {
        var (client, handler) = NewClient();
        handler.AddResponse(
            "/api/v1/user/42",
            $"{{\"id\":42,\"jellyfinUserId\":\"{UserId}\",\"permissions\":{(long)SeerrPermission.VIEW_ISSUES}}}");
        handler.AddResponse(
            "/api/v1/movie/100",
            "{\"mediaInfo\":{\"id\":1,\"tmdbId\":100,\"mediaType\":\"movie\",\"issues\":[]}}");

        var result = await client.ProxyFreshMediaDetailAsync(
            100,
            "movie",
            new SeerrCaller(UserId, false),
            new SeerrUser { Id = 42, SourceUrl = "http://seerr:5055", Permissions = SeerrPermission.VIEW_ISSUES });

        Assert.IsNotType<ObjectResult>(result);
        Assert.Contains(handler.Sent, r => r.Path == "/api/v1/movie/100");
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
