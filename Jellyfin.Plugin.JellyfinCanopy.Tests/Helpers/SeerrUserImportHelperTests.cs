using System.Net;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Helpers;

public sealed class SeerrUserImportHelperTests
{
    private static readonly List<string> UserIds = new()
    {
        "11111111111111111111111111111111",
        "22222222222222222222222222222222",
    };

    [Fact]
    public async Task BulkImport_HttpFailureAfterDispatch_IsNotReplayedToAnotherDomain()
    {
        var handler = WithEmptyPreflight(request => Json(
            request.RequestUri!.Host == "first"
                ? new { error = "committed but response failed" }
                : new[] { new { id = 2 } },
            request.RequestUri.Host == "first"
                ? HttpStatusCode.InternalServerError
                : HttpStatusCode.OK));

        var result = await ImportAsync(handler, "http://first:5055", "http://second:5055");

        Assert.False(result.Succeeded);
        Assert.True(result.Reached);
        Assert.Equal("http://first:5055", result.SourceUrl);
        var post = Assert.Single(Posts(handler));
        Assert.Equal("first", post.Uri.Host);
    }

    [Fact]
    public async Task BulkImport_HtmlAfterDispatch_IsNotReplayedToAnotherDomain()
    {
        var handler = WithEmptyPreflight(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("<html>login</html>", Encoding.UTF8, "text/html"),
        });

        var result = await ImportAsync(handler, "http://first:5055", "http://second:5055");

        Assert.False(result.Succeeded);
        Assert.True(result.Reached);
        var post = Assert.Single(Posts(handler));
        Assert.Equal("first", post.Uri.Host);
    }

    [Fact]
    public async Task BulkImport_TimeoutAfterDispatch_IsIncompleteAndNotReplayed()
    {
        var handler = WithEmptyPreflight((_, _) =>
            throw new TaskCanceledException("response timed out"));

        var result = await ImportAsync(handler, "http://first:5055", "http://second:5055");

        Assert.False(result.Succeeded);
        Assert.True(result.Reached);
        Assert.Contains(result.Errors, error => error.Contains("commit state is unknown", StringComparison.Ordinal));
        var post = Assert.Single(Posts(handler));
        Assert.Equal("first", post.Uri.Host);
    }

    [Fact]
    public async Task BulkImport_AliasDuplicates_PreflightEachDomainOnceAndCaptureSuccessSource()
    {
        var handler = WithEmptyPreflight(_ => Json(new[] { new { id = 1 }, new { id = 2 } }));

        var result = await ImportAsync(
            handler,
            " HTTP://FIRST:80/ ",
            "http://first",
            "http://second");

        Assert.True(result.Succeeded);
        Assert.True(result.Reached);
        Assert.Equal(2, result.Imported);
        Assert.Equal("http://first", result.SourceUrl);
        Assert.Equal(
            new[]
            {
                "first", "first", "second", "second",
                "first", "first", "second", "second",
            },
            Gets(handler).Select(request => request.Uri.Host));
        var post = Assert.Single(Posts(handler));
        Assert.Equal("first", post.Uri.Host);
        Assert.Equal(UserIds, ImportedUserIds(post));
    }

    [Fact]
    public async Task BulkImport_UserMappedOnlyOnSecondDomain_IsExcludedFromFirstDomainBatch()
    {
        var handler = new ImportHandler(request =>
        {
            if (request.Method == HttpMethod.Get)
            {
                return request.RequestUri!.Host == "second"
                    ? UserPage(UserRow(71, UserIds[0]))
                    : UserPage();
            }

            return Json(new[] { new { id = 72 } });
        });

        var result = await ImportAsync(handler, "http://first:5055", "http://second:5055");

        Assert.True(result.Succeeded);
        Assert.Equal(1, result.Imported);
        var post = Assert.Single(Posts(handler));
        Assert.Equal("first", post.Uri.Host);
        Assert.Equal(new[] { UserIds[1] }, ImportedUserIds(post));
    }

    [Fact]
    public async Task BulkImport_LaterDomainPreflightFailure_SendsNoMutation()
    {
        var handler = new ImportHandler(request =>
            request.Method == HttpMethod.Get && request.RequestUri!.Host == "second"
                ? Json(new { error = "later domain unavailable" }, HttpStatusCode.BadGateway)
                : request.Method == HttpMethod.Get
                    ? UserPage()
                    : Json(new[] { new { id = 99 } }));

        var result = await ImportAsync(handler, "http://first:5055", "http://second:5055");

        Assert.False(result.Succeeded);
        Assert.Empty(Posts(handler));
        Assert.Equal(new[] { "first", "first", "second" }, Gets(handler).Select(request => request.Uri.Host));
        Assert.Contains(result.Errors, error => error.Contains("preflight was incomplete", StringComparison.Ordinal));
    }

    [Fact]
    public async Task BulkImport_UserMapChangesBetweenCompleteScans_SendsNoMutation()
    {
        var scan = 0;
        var handler = new ImportHandler(request =>
        {
            if (request.Method == HttpMethod.Get)
            {
                return Interlocked.Increment(ref scan) <= 2
                    ? UserPage()
                    : UserPage(UserRow(79, UserIds[0]));
            }

            return Json(new[] { new { id = 99 } });
        });

        var result = await ImportAsync(handler, "http://first:5055");

        Assert.False(result.Succeeded);
        Assert.Empty(Posts(handler));
        Assert.Equal(4, Gets(handler).Count());
        Assert.Contains(result.Errors, error => error.Contains("disagreed", StringComparison.Ordinal));
    }

    [Fact]
    public async Task BulkImport_SameUserMappedOnMultipleDomains_IsExcludedButDoesNotBlockOtherUsers()
    {
        var handler = new ImportHandler(request =>
        {
            if (request.Method == HttpMethod.Get)
            {
                return request.RequestUri!.Host == "first"
                    ? UserPage(UserRow(81, UserIds[0]))
                    : UserPage(UserRow(82, UserIds[0]));
            }

            return Json(new[] { new { id = 99 } });
        });

        var result = await ImportAsync(handler, "http://first:5055", "http://second:5055");

        Assert.True(result.Succeeded);
        var post = Assert.Single(Posts(handler));
        Assert.Equal("first", post.Uri.Host);
        Assert.Equal(new[] { UserIds[1] }, ImportedUserIds(post));
    }

    [Fact]
    public async Task BulkImport_AmbiguousOwnershipWithinOneDomain_SendsNoMutation()
    {
        var handler = new ImportHandler(request =>
        {
            if (request.Method == HttpMethod.Get)
            {
                return request.RequestUri!.Host == "first"
                    ? UserPage(UserRow(83, UserIds[0]), UserRow(84, UserIds[0]))
                    : UserPage();
            }

            return Json(new[] { new { id = 99 } });
        });

        var result = await ImportAsync(handler, "http://first:5055", "http://second:5055");

        Assert.False(result.Succeeded);
        Assert.Empty(Posts(handler));
        Assert.Contains(result.Errors, error => error.Contains("ambiguous ownership", StringComparison.Ordinal));
    }

    [Fact]
    public async Task BulkImport_OneSeerrIdClaimsMultipleJellyfinUsers_SendsNoMutation()
    {
        var handler = new ImportHandler(request => request.Method == HttpMethod.Get
            ? UserPage(UserRow(85, UserIds[0]), UserRow(85, UserIds[1]))
            : Json(new[] { new { id = 99 } }));

        var result = await ImportAsync(handler, "http://first:5055");

        Assert.False(result.Succeeded);
        Assert.Empty(Posts(handler));
        Assert.Contains(result.Errors, error => error.Contains("preflight was incomplete", StringComparison.Ordinal));
    }

    [Fact]
    public async Task BulkImport_MalformedLaterDomainUserMap_SendsNoMutation()
    {
        var handler = new ImportHandler(request =>
        {
            if (request.Method == HttpMethod.Get)
            {
                return request.RequestUri!.Host == "second"
                    ? UserPage(new { id = 91, jellyfinUserId = 42 })
                    : UserPage();
            }

            return Json(new[] { new { id = 99 } });
        });

        var result = await ImportAsync(handler, "http://first:5055", "http://second:5055");

        Assert.False(result.Succeeded);
        Assert.Empty(Posts(handler));
        Assert.Contains(result.Errors, error => error.Contains("malformed Jellyfin user id", StringComparison.Ordinal));
    }

    [Fact]
    public async Task BulkImport_NonGuidLinkedIdentity_SendsNoMutation()
    {
        var handler = new ImportHandler(request => request.Method == HttpMethod.Get
            ? UserPage(new { id = 91, jellyfinUserId = "not-a-guid" })
            : Json(new[] { new { id = 99 } }));

        var result = await ImportAsync(handler, "http://first:5055");

        Assert.False(result.Succeeded);
        Assert.Empty(Posts(handler));
        Assert.Contains(result.Errors, error => error.Contains("malformed Jellyfin user id", StringComparison.Ordinal));
    }

    [Fact]
    public async Task BulkImport_AllTargetsAlreadyMapped_SucceedsWithoutMutation()
    {
        var handler = new ImportHandler(request => request.RequestUri!.Host == "first"
            ? UserPage(UserRow(101, UserIds[0]))
            : UserPage(UserRow(102, UserIds[1])));

        var result = await ImportAsync(handler, "http://first:5055", "http://second:5055");

        Assert.True(result.Succeeded);
        Assert.Equal(0, result.Imported);
        Assert.Empty(Posts(handler));
    }

    [Fact]
    public async Task BulkImport_DispatchAuthorizationChangesAfterStableProof_SendsNoMutation()
    {
        var handler = WithEmptyPreflight(_ => Json(new[] { new { id = 99 } }));

        var result = await SeerrUserImportHelper.BulkImportAsync(
            UserIds,
            new[] { "http://first:5055" },
            "test-key",
            new ImportHttpClientFactory(handler),
            NullLogger.Instance,
            CancellationToken.None,
            canDispatch: static () => false);

        Assert.False(result.Succeeded);
        Assert.Equal(4, Gets(handler).Count());
        Assert.Empty(Posts(handler));
        Assert.Contains(
            result.Errors,
            error => error.Contains("authorization or configuration changed", StringComparison.Ordinal));
    }

    [Fact]
    public async Task BulkImport_CallerCancellationAfterDispatch_PropagatesWithoutReplay()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = WithEmptyPreflight(async (_, cancellationToken) =>
        {
            started.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("unreachable");
        });
        using var cancellation = new CancellationTokenSource();

        var import = ImportAsync(
            handler,
            cancellation.Token,
            "http://first:5055",
            "http://second:5055");
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => import);
        var post = Assert.Single(Posts(handler));
        Assert.Equal("first", post.Uri.Host);
    }

    private static ImportHandler WithEmptyPreflight(Func<HttpRequestMessage, HttpResponseMessage> post)
        => new(request => request.Method == HttpMethod.Get ? UserPage() : post(request));

    private static ImportHandler WithEmptyPreflight(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> post)
        => new((request, cancellationToken) => request.Method == HttpMethod.Get
            ? Task.FromResult(UserPage())
            : post(request, cancellationToken));

    private static IEnumerable<ImportHandler.CapturedRequest> Gets(ImportHandler handler)
        => handler.Requests.Where(request => request.Method == HttpMethod.Get);

    private static IEnumerable<ImportHandler.CapturedRequest> Posts(ImportHandler handler)
        => handler.Requests.Where(request => request.Method == HttpMethod.Post);

    private static List<string> ImportedUserIds(ImportHandler.CapturedRequest request)
    {
        using var body = JsonDocument.Parse(request.Body);
        return body.RootElement.GetProperty("jellyfinUserIds")
            .EnumerateArray()
            .Select(value => value.GetString()!)
            .ToList();
    }

    private static Task<SeerrUserImportHelper.BulkImportResult> ImportAsync(
        ImportHandler handler,
        params string[] urls)
        => ImportAsync(handler, CancellationToken.None, urls);

    private static Task<SeerrUserImportHelper.BulkImportResult> ImportAsync(
        ImportHandler handler,
        CancellationToken cancellationToken,
        params string[] urls)
        => SeerrUserImportHelper.BulkImportAsync(
            UserIds,
            urls,
            "test-key",
            new ImportHttpClientFactory(handler),
            NullLogger.Instance,
            cancellationToken);

    private static object UserRow(int id, string jellyfinUserId) => new
    {
        id,
        jellyfinUserId,
        permissions = 0,
    };

    private static HttpResponseMessage UserPage(params object[] results)
        => Json(new
        {
            page = 1,
            totalPages = results.Length == 0 ? 0 : 1,
            totalResults = results.Length,
            pageInfo = new
            {
                page = 1,
                pages = results.Length == 0 ? 0 : 1,
                pageSize = results.Length,
                results = results.Length,
            },
            results,
        });

    private static HttpResponseMessage Json(object body, HttpStatusCode status = HttpStatusCode.OK)
        => new(status)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
        };

    private sealed class ImportHttpClientFactory : IHttpClientFactory
    {
        private readonly HttpMessageHandler _handler;

        public ImportHttpClientFactory(HttpMessageHandler handler) => _handler = handler;

        public HttpClient CreateClient(string name) => new(_handler, disposeHandler: false);
    }

    private sealed class ImportHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _send;

        public ImportHandler(Func<HttpRequestMessage, HttpResponseMessage> send)
            : this((request, _) => Task.FromResult(send(request)))
        {
        }

        public ImportHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send)
            => _send = send;

        public sealed record CapturedRequest(HttpMethod Method, Uri Uri, string Body);

        public List<CapturedRequest> Requests { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var body = request.Content == null
                ? string.Empty
                : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add(new CapturedRequest(request.Method, request.RequestUri!, body));
            return await _send(request, cancellationToken);
        }
    }
}
