using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Data;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class CalendarRequesterTagFallbackControllerTests
{
    private const string EmptyCollection =
        """{"results":[],"pageInfo":{"page":1,"pages":0,"pageSize":0,"results":0}}""";

    [Fact]
    public async Task Snapshot_FallbackOnly_ProjectsAllowlistedCallerKey()
    {
        var fixture = Fixture.Create(
            seerrEnabled: false,
            taggedItems: new[] { Movie(101, "canopy-requester:caller") });

        var body = SuccessBody(await fixture.Controller.GetCompleteUserRequestSnapshot(userOnly: true));

        AssertEnvelope(body, (101, "movie"));
        Assert.Empty(fixture.Handler.Sent);
    }

    [Fact]
    public async Task Snapshot_ForeignSeerrOwner_SuppressesCallerTagForSameMedia()
    {
        var fixture = Fixture.Create(
            taggedItems: new[] { Movie(201, "canopy-requester:caller") },
            requestBodies: new Dictionary<string, string>
            {
                ["seerr-a"] = Collection(Row(1, ownerId: 99, tmdbId: 201)),
            });

        var body = SuccessBody(await fixture.Controller.GetCompleteUserRequestSnapshot(userOnly: true));

        AssertEnvelope(body);
        Assert.DoesNotContain(
            fixture.Handler.Requests,
            request => request.Headers.Contains("X-Api-User"));
    }

    [Fact]
    public async Task Snapshot_CallerSeerrOwner_WinsOverForeignTag()
    {
        var fixture = Fixture.Create(
            taggedItems: new[] { Movie(202, "canopy-requester:other") },
            includeOtherMapping: true,
            requestBodies: new Dictionary<string, string>
            {
                ["seerr-a"] = Collection(Row(2, ownerId: 7, tmdbId: 202)),
            });

        var body = SuccessBody(await fixture.Controller.GetCompleteUserRequestSnapshot(userOnly: true));

        AssertEnvelope(body, (202, "movie"));
    }

    [Fact]
    public async Task Snapshot_SharedSeerrOwnership_IncludesCallerKey()
    {
        var fixture = Fixture.Create(
            requestBodies: new Dictionary<string, string>
            {
                ["seerr-a"] = Collection(
                    Row(1, 7, 212),
                    Row(2, 8, 212)),
            });

        var body = SuccessBody(
            await fixture.Controller.GetCompleteUserRequestSnapshot(userOnly: true));

        AssertEnvelope(body, (212, "movie"));
    }

    [Fact]
    public async Task Snapshot_NoSeerrOwner_AllowsCallerTagFallback()
    {
        var fixture = Fixture.Create(
            taggedItems: new[] { Movie(203, "canopy-requester:caller") });

        var body = SuccessBody(await fixture.Controller.GetCompleteUserRequestSnapshot(userOnly: true));

        AssertEnvelope(body, (203, "movie"));
    }

    [Fact]
    public async Task Snapshot_ConclusiveUnlinkedUser_ScansEverySourceBeforeUsingTags()
    {
        var fixture = Fixture.Create(
            resolution: SeerrUserResolution.NotFound(),
            sourceHosts: new[] { "seerr-a", "seerr-b" },
            taggedItems: new[] { Movie(204, "canopy-requester:caller") },
            requestBodies: new Dictionary<string, string>
            {
                ["seerr-a"] = EmptyCollection,
                ["seerr-b"] = Collection(Row(3, ownerId: 88, tmdbId: 204)),
            });

        var body = SuccessBody(await fixture.Controller.GetCompleteUserRequestSnapshot(userOnly: true));

        AssertEnvelope(body);
        Assert.Equal(
            new[] { "seerr-a", "seerr-a", "seerr-b", "seerr-b" },
            fixture.Handler.Requests.Select(request => request.RequestUri!.Host));
    }

    [Fact]
    public async Task Snapshot_AnyUnlinkedSourceFailure_RejectsWithoutTagPrefix()
    {
        var fixture = Fixture.Create(
            resolution: SeerrUserResolution.NotFound(),
            sourceHosts: new[] { "seerr-a", "seerr-b" },
            taggedItems: new[] { Movie(205, "canopy-requester:caller") },
            requestBodies: new Dictionary<string, string>
            {
                ["seerr-a"] = EmptyCollection,
            });

        var result = Assert.IsType<ObjectResult>(
            await fixture.Controller.GetCompleteUserRequestSnapshot(userOnly: true));
        var body = Body(result.Value);

        Assert.Equal(502, result.StatusCode);
        Assert.Equal("upstream_collection_incomplete", (string?)body["code"]);
        Assert.Empty(Assert.IsType<JsonArray>(body["requests"]));
    }

    [Theory]
    [InlineData(SeerrUserResolutionStatus.Incomplete)]
    [InlineData(SeerrUserResolutionStatus.Unavailable)]
    public async Task Snapshot_IndeterminateSeerrIdentity_RejectsWithoutTagPrefix(
        SeerrUserResolutionStatus status)
    {
        var fixture = Fixture.Create(
            resolution: new SeerrUserResolution(status),
            taggedItems: new[] { Movie(206, "canopy-requester:caller") });

        var result = Assert.IsType<ObjectResult>(
            await fixture.Controller.GetCompleteUserRequestSnapshot(userOnly: true));
        var body = Body(result.Value);

        Assert.Equal(502, result.StatusCode);
        Assert.Equal("user_lookup_incomplete", (string?)body["code"]);
        Assert.Empty(Assert.IsType<JsonArray>(body["requests"]));
        Assert.Equal(0, fixture.Library.GetItemsResultCallCount);
    }

    [Fact]
    public async Task Snapshot_SeerrIdentityChangesBeforePublication_Returns409()
    {
        var fixture = Fixture.Create(
            resolutionFactory: call => SeerrUserResolution.Found(new SeerrUser
            {
                Id = call == 1 ? 7 : 8,
                Permissions = SeerrPermission.NONE,
                SourceUrl = "http://seerr-a:5055",
            }),
            taggedItems: new[] { Movie(207, "canopy-requester:caller") });

        var result = Assert.IsType<ObjectResult>(
            await fixture.Controller.GetCompleteUserRequestSnapshot(userOnly: true));
        var body = Body(result.Value);

        Assert.Equal(409, result.StatusCode);
        Assert.Equal("read_identity_changed", (string?)body["code"]);
        Assert.Empty(Assert.IsType<JsonArray>(body["requests"]));
    }

    [Fact]
    public async Task Snapshot_FallbackConfigurationChangesDuringTagScan_Returns409()
    {
        var fixture = Fixture.Create(
            seerrEnabled: false,
            taggedItems: new[] { Movie(208, "canopy-requester:caller") });
        var changed = false;
        fixture.Library.GetItemsResultHook = query =>
        {
            if (!changed)
            {
                changed = true;
                fixture.Provider.Current = new PluginConfiguration
                {
                    CalendarRequesterTagFallbackEnabled = false,
                };
            }

            var items = fixture.TaggedItems.Skip(query.StartIndex ?? 0)
                .Take(query.Limit ?? CalendarRequesterTagResolver.LibraryPageSize)
                .ToArray();
            return new QueryResult<BaseItem>(query.StartIndex, fixture.TaggedItems.Count, items);
        };

        var result = Assert.IsType<ObjectResult>(
            await fixture.Controller.GetCompleteUserRequestSnapshot(userOnly: true));
        var body = Body(result.Value);

        Assert.Equal(409, result.StatusCode);
        Assert.Equal("read_configuration_changed", (string?)body["code"]);
        Assert.False(body.ContainsKey("requests"));
    }

    [Fact]
    public async Task Snapshot_JellyfinAccessPolicyChangesDuringTagScan_Returns409()
    {
        var fixture = Fixture.Create(
            seerrEnabled: false,
            taggedItems: new[] { Movie(209, "canopy-requester:caller") });
        var calls = 0;
        fixture.Library.GetItemsResultHook = query =>
        {
            calls++;
            if (calls == 2)
            {
                var updated = new User(
                    fixture.Caller.Username,
                    fixture.Caller.AuthenticationProviderId,
                    fixture.Caller.PasswordResetProviderId)
                {
                    Id = fixture.Caller.Id,
                    InternalId = fixture.Caller.InternalId,
                    MaxParentalRatingScore = 5,
                };
                updated.OnSavingChanges();
                fixture.UserManager.ReplaceUser(updated);
            }

            var items = fixture.TaggedItems.Skip(query.StartIndex ?? 0)
                .Take(query.Limit ?? CalendarRequesterTagResolver.LibraryPageSize)
                .ToArray();
            return new QueryResult<BaseItem>(query.StartIndex, fixture.TaggedItems.Count, items);
        };

        var result = Assert.IsType<ObjectResult>(
            await fixture.Controller.GetCompleteUserRequestSnapshot(userOnly: true));
        var body = Body(result.Value);

        Assert.Equal(409, result.StatusCode);
        Assert.Equal("read_identity_changed", (string?)body["code"]);
        Assert.Empty(Assert.IsType<JsonArray>(body["requests"]));
    }

    [Fact]
    public async Task Snapshot_OrdinaryJellyfinActivityWrite_DoesNotInvalidateAccessSnapshot()
    {
        var fixture = Fixture.Create(
            seerrEnabled: false,
            taggedItems: new[] { Movie(211, "canopy-requester:caller") });
        var calls = 0;
        fixture.Library.GetItemsResultHook = query =>
        {
            calls++;
            if (calls == 2)
            {
                var updated = new User(
                    fixture.Caller.Username,
                    fixture.Caller.AuthenticationProviderId,
                    fixture.Caller.PasswordResetProviderId)
                {
                    Id = fixture.Caller.Id,
                    InternalId = fixture.Caller.InternalId,
                    LastActivityDate = DateTime.UtcNow,
                };
                updated.OnSavingChanges();
                fixture.UserManager.ReplaceUser(updated);
            }

            var items = fixture.TaggedItems.Skip(query.StartIndex ?? 0)
                .Take(query.Limit ?? CalendarRequesterTagResolver.LibraryPageSize)
                .ToArray();
            return new QueryResult<BaseItem>(query.StartIndex, fixture.TaggedItems.Count, items);
        };

        var body = SuccessBody(
            await fixture.Controller.GetCompleteUserRequestSnapshot(userOnly: true));

        AssertEnvelope(body, (211, "movie"));
    }

    [Fact]
    public async Task Snapshot_UnlinkedSourceCountOverBound_RejectsBeforeNetworkOrTagScan()
    {
        var fixture = Fixture.Create(
            resolution: SeerrUserResolution.NotFound(),
            sourceHosts: Enumerable.Range(1, 9).Select(index => $"seerr-{index}").ToArray(),
            taggedItems: new[] { Movie(210, "canopy-requester:caller") });

        var result = Assert.IsType<ObjectResult>(
            await fixture.Controller.GetCompleteUserRequestSnapshot(userOnly: true));
        var body = Body(result.Value);

        Assert.Equal(502, result.StatusCode);
        Assert.Equal("source_bound_exceeded", (string?)body["code"]);
        Assert.Empty(Assert.IsType<JsonArray>(body["requests"]));
        Assert.Empty(fixture.Handler.Sent);
        Assert.Equal(0, fixture.Library.GetItemsResultCallCount);
    }

    private static JsonObject SuccessBody(IActionResult result)
        => Body(Assert.IsType<OkObjectResult>(result).Value);

    private static JsonObject Body(object? value)
        => JsonNode.Parse(JsonSerializer.Serialize(value))!.AsObject();

    private static void AssertEnvelope(JsonObject body, params (int TmdbId, string Type)[] expected)
    {
        Assert.Equal(
            new[] { "complete", "requestKeyCount", "requests" },
            body.Select(property => property.Key).OrderBy(key => key, StringComparer.Ordinal));
        Assert.True((bool?)body["complete"]);
        Assert.Equal(expected.Length, (int?)body["requestKeyCount"]);

        var rows = Assert.IsType<JsonArray>(body["requests"]);
        Assert.Equal(expected.Length, rows.Count);
        for (var index = 0; index < expected.Length; index++)
        {
            var row = Assert.IsType<JsonObject>(rows[index]);
            Assert.Equal(
                new[] { "tmdbId", "type" },
                row.Select(property => property.Key).OrderBy(key => key, StringComparer.Ordinal));
            Assert.Equal(expected[index].TmdbId, (int?)row["tmdbId"]);
            Assert.Equal(expected[index].Type, (string?)row["type"]);
        }
    }

    private static string Collection(params string[] rows)
        => $$"""
            {
              "results": [{{string.Join(',', rows)}}],
              "pageInfo": {
                "page": 1,
                "pages": {{(rows.Length == 0 ? 0 : 1)}},
                "pageSize": {{rows.Length}},
                "results": {{rows.Length}}
              }
            }
            """;

    private static string Row(int requestId, int ownerId, int tmdbId, string type = "movie")
        => $$"""
            {
              "id": {{requestId}},
              "type": "{{type}}",
              "requestedBy": { "id": {{ownerId}} },
              "media": { "tmdbId": {{tmdbId}}, "mediaType": "{{type}}" }
            }
            """;

    private static Movie Movie(int tmdbId, params string[] tags)
    {
        var movie = new Movie
        {
            Id = Guid.NewGuid(),
            Tags = tags,
        };
        movie.ProviderIds["Tmdb"] = tmdbId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return movie;
    }

    private sealed class Fixture
    {
        private Fixture(
            ArrRequestsController controller,
            RecordingHttpMessageHandler handler,
            FakePluginConfigProvider provider,
            CountingLibraryManager library,
            IReadOnlyList<BaseItem> taggedItems,
            User caller,
            StubUserManager userManager)
        {
            Controller = controller;
            Handler = handler;
            Provider = provider;
            Library = library;
            TaggedItems = taggedItems;
            Caller = caller;
            UserManager = userManager;
        }

        public ArrRequestsController Controller { get; }

        public RecordingHttpMessageHandler Handler { get; }

        public FakePluginConfigProvider Provider { get; }

        public CountingLibraryManager Library { get; }

        public IReadOnlyList<BaseItem> TaggedItems { get; }

        public User Caller { get; }

        public StubUserManager UserManager { get; }

        public static Fixture Create(
            bool seerrEnabled = true,
            SeerrUserResolution? resolution = null,
            Func<int, SeerrUserResolution>? resolutionFactory = null,
            IReadOnlyList<string>? sourceHosts = null,
            IReadOnlyList<BaseItem>? taggedItems = null,
            IReadOnlyDictionary<string, string>? requestBodies = null,
            bool includeOtherMapping = false)
        {
            sourceHosts ??= new[] { "seerr-a" };
            taggedItems ??= Array.Empty<BaseItem>();
            requestBodies ??= sourceHosts.ToDictionary(host => host, _ => EmptyCollection);

            var caller = new User("caller", "provider", "password-provider");
            var other = new User("other", "provider", "password-provider");
            var users = includeOtherMapping ? new[] { caller, other } : new[] { caller };
            var userManager = new StubUserManager(users);
            var mappings = $"{caller.Id:D}=caller";
            if (includeOtherMapping)
            {
                mappings += $"\n{other.Id:D}=other";
            }

            var config = new PluginConfiguration
            {
                SeerrEnabled = seerrEnabled,
                SeerrUrls = string.Join('\n', sourceHosts.Select(host => $"http://{host}:5055")),
                SeerrApiKey = seerrEnabled ? "key" : string.Empty,
                CalendarRequesterTagFallbackEnabled = true,
                CalendarRequesterTagPrefix = "canopy-requester:",
                CalendarRequesterTagMappings = mappings,
            };
            var provider = new FakePluginConfigProvider(config);
            var handler = new RecordingHttpMessageHandler
            {
                ResponseFactory = request =>
                {
                    if (request.RequestUri?.AbsolutePath != "/api/v1/request")
                    {
                        return null;
                    }

                    if (!requestBodies.TryGetValue(request.RequestUri.Host, out var body))
                    {
                        return new HttpResponseMessage(HttpStatusCode.BadGateway)
                        {
                            Content = new StringContent("{}", Encoding.UTF8, "application/json"),
                        };
                    }

                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent(body, Encoding.UTF8, "application/json"),
                    };
                },
            };
            var factory = new RecordingHttpClientFactory(handler);
            var library = new CountingLibraryManager
            {
                ConfigureUserAccessHook = (_, resolvedUser) => Assert.Same(caller, resolvedUser),
                GetItemsResultHook = query =>
                {
                    var items = taggedItems.Skip(query.StartIndex ?? 0)
                        .Take(query.Limit ?? CalendarRequesterTagResolver.LibraryPageSize)
                        .ToArray();
                    return new QueryResult<BaseItem>(query.StartIndex, taggedItems.Count, items);
                },
            };
            var resolver = new CalendarRequesterTagResolver(library, userManager);
            var seerrCache = new SeerrCache(provider);
            var seerr = new SequencedSeerrClient(
                resolutionFactory ?? (_ => resolution ?? SeerrUserResolution.Found(new SeerrUser
                {
                    Id = 7,
                    Permissions = SeerrPermission.NONE,
                    SourceUrl = "http://seerr-a:5055",
                })));
            var controller = new ArrRequestsController(
                factory,
                NullLogger<ArrRequestsController>.Instance,
                userManager,
                seerrCache,
                provider,
                seerr,
                new ArrFetchService(factory, NullLogger<ArrFetchService>.Instance),
                new StubItemLookupService(),
                new PassthroughParentalFilter(),
                calendarRequesterTags: resolver);
            controller.ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(
                        new[] { new Claim("Jellyfin-UserId", caller.Id.ToString()) },
                        "TestAuth")),
                },
            };

            return new Fixture(
                controller,
                handler,
                provider,
                library,
                taggedItems,
                caller,
                userManager);
        }
    }

    private sealed class SequencedSeerrClient : ISeerrClient
    {
        private readonly Func<int, SeerrUserResolution> _resolutionFactory;
        private int _resolutionCalls;

        public SequencedSeerrClient(Func<int, SeerrUserResolution> resolutionFactory)
            => _resolutionFactory = resolutionFactory;

        public Task<SeerrUser?> GetSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true)
            => Task.FromResult(_resolutionFactory(++_resolutionCalls).User);

        public Task<SeerrUserResolution> ResolveSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(_resolutionFactory(++_resolutionCalls));
        }

        public Task<string?> GetSeerrUserId(string jellyfinUserId, bool allowAutoImport = true)
            => throw new NotImplementedException();

        public bool IsImportBlocked(string jellyfinUserId, PluginConfiguration config)
            => throw new NotImplementedException();

        public Task<bool> GetStatusActiveAsync() => throw new NotImplementedException();

        public Task<Seerr4kCapability> GetSeerr4kCapabilityAsync(
            string jellyfinUserId,
            bool isAdmin = false)
            => throw new NotImplementedException();

        public void EvictMediaDetailCache(int tmdbId, string mediaType)
        {
        }

        public Task<IActionResult> ProxyRequestAsync(
            string apiPath,
            HttpMethod method,
            string? content,
            SeerrCaller caller)
            => throw new NotImplementedException();

        public Task<List<WatchlistItem>?> GetWatchlistForUser(string seerrUserId)
            => throw new NotImplementedException();

        public Task<List<WatchlistItem>?> GetRequestsForUser(string seerrUserId)
            => throw new NotImplementedException();
    }

    private sealed class PassthroughParentalFilter : ISeerrParentalFilter
    {
        public Task<SeerrParentalResult> ApplyAsync(
            string json,
            string apiPath,
            SeerrCaller caller)
            => Task.FromResult(new SeerrParentalResult(false, json));

        public Task<bool> IsBlockedAsync(
            string mediaType,
            int tmdbId,
            SeerrCaller caller)
            => Task.FromResult(false);

        public Task<bool> IsTmdbProxyPathBlockedAsync(
            string tmdbApiPath,
            SeerrCaller caller)
            => Task.FromResult(false);
    }
}
