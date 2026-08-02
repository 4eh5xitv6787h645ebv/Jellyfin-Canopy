using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services.Discovery;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class ServiceDiscoveryServiceTests
{
    private static PluginConfiguration Config(
        string? sonarrInstances = null,
        string? radarrInstances = null,
        string? bazarrUrl = null,
        string? seerrUrls = null,
        string? maintainerrUrl = null)
    {
        var config = new PluginConfiguration();
        if (sonarrInstances != null) config.SonarrInstances = sonarrInstances;
        if (radarrInstances != null) config.RadarrInstances = radarrInstances;
        if (bazarrUrl != null) config.BazarrUrl = bazarrUrl;
        if (seerrUrls != null) config.SeerrUrls = seerrUrls;
        if (maintainerrUrl != null) config.MaintainerrUrl = maintainerrUrl;
        return config;
    }

    private static string Instances(params string[] urls)
        => JsonSerializer.Serialize(urls.Select((url, i) => new Model.Arr.ArrInstance
        {
            InstanceId = $"id-{i}",
            Name = $"instance-{i}",
            Url = url,
            ApiKey = "test-key-never-probed",
        }).ToList());

    // ── Candidate building ───────────────────────────────────────────────────

    [Fact]
    public void BuildCandidates_IncludesWellKnownAndGenericHosts()
    {
        var candidates = ServiceDiscoveryService.BuildCandidates(Config());

        Assert.Contains(candidates, c => c is { Service: "sonarr", Host: "sonarr", Port: 8989 });
        Assert.Contains(candidates, c => c is { Service: "radarr", Host: "radarr", Port: 7878 });
        Assert.Contains(candidates, c => c is { Service: "bazarr", Host: "bazarr", Port: 6767 });
        Assert.Contains(candidates, c => c is { Service: "seerr", Host: "jellyseerr", Port: 5055 });
        Assert.Contains(candidates, c => c is { Service: "seerr", Host: "overseerr", Port: 5055 });
        Assert.Contains(candidates, c => c is { Service: "maintainerr", Host: "maintainerr", Port: 6246 });
        Assert.Contains(candidates, c => c is { Service: "sonarr", Host: "127.0.0.1", Port: 8989 });
        Assert.Contains(candidates, c => c is { Service: "maintainerr", Host: "172.17.0.1", Port: 6246 });
        Assert.True(candidates.Count <= ServiceDiscoveryService.MaxCandidates);
        Assert.Equal(candidates.Count, candidates.Distinct().Count());
    }

    [Fact]
    public void BuildCandidates_OmitsEndpointsAlreadyConfiguredForTheSameService()
    {
        var config = Config(
            sonarrInstances: Instances("http://sonarr:8989"),
            maintainerrUrl: "http://maintainerr:6246/");

        var candidates = ServiceDiscoveryService.BuildCandidates(config);

        Assert.DoesNotContain(candidates, c => c is { Service: "sonarr", Host: "sonarr", Port: 8989 });
        Assert.DoesNotContain(candidates, c => c is { Service: "maintainerr", Host: "maintainerr", Port: 6246 });
        // The same host is still probed for *sibling* services (cross-pollination).
        Assert.Contains(candidates, c => c is { Service: "radarr", Host: "sonarr", Port: 7878 });
        Assert.Contains(candidates, c => c is { Service: "sonarr", Host: "maintainerr", Port: 8989 });
    }

    [Fact]
    public void BuildCandidates_TreatsCaseAndTrailingSlashVariantsAsConfigured()
    {
        var config = Config(bazarrUrl: "HTTP://Bazarr:6767/");

        var candidates = ServiceDiscoveryService.BuildCandidates(config);

        Assert.DoesNotContain(candidates, c => c is { Service: "bazarr", Host: "bazarr", Port: 6767 });
    }

    [Fact]
    public void BuildCandidates_CrossPollinatesConfiguredHostsAcrossServices()
    {
        var config = Config(seerrUrls: "http://media.internal:5055\nnot a url\n");

        var candidates = ServiceDiscoveryService.BuildCandidates(config);

        Assert.Contains(candidates, c => c is { Service: "sonarr", Host: "media.internal", Port: 8989 });
        Assert.Contains(candidates, c => c is { Service: "radarr", Host: "media.internal", Port: 7878 });
        Assert.Contains(candidates, c => c is { Service: "maintainerr", Host: "media.internal", Port: 6246 });
        // The configured seerr endpoint itself is not re-probed.
        Assert.DoesNotContain(candidates, c => c is { Service: "seerr", Host: "media.internal", Port: 5055 });
        Assert.DoesNotContain(candidates, c => c.Host.Contains(' '));
    }

    [Fact]
    public void BuildCandidates_EnforcesTheOverallCap()
    {
        var manyHosts = string.Join('\n', Enumerable.Range(0, 30).Select(i => $"http://host-{i}.lan:5055"));
        var candidates = ServiceDiscoveryService.BuildCandidates(Config(seerrUrls: manyHosts));

        Assert.Equal(ServiceDiscoveryService.MaxCandidates, candidates.Count);
    }

    // ── Probing ──────────────────────────────────────────────────────────────

    private sealed class Fixture
    {
        public RecordingHttpMessageHandler Handler { get; } = new();
        public HashSet<string> BlockedHosts { get; } = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, IPAddress> Resolves { get; } = new(StringComparer.OrdinalIgnoreCase);

        public ServiceDiscoveryService Build(PluginConfiguration config)
        {
            var factory = new RecordingHttpClientFactory(Handler);
            return new ServiceDiscoveryService(
                factory,
                new FakePluginConfigProvider(config),
                NullLogger<ServiceDiscoveryService>.Instance,
                (url, _) => Task.FromResult(!BlockedHosts.Contains(new Uri(url).Host)),
                (host, _) => Resolves.TryGetValue(host, out var ip)
                    ? Task.FromResult(new[] { ip })
                    : throw new SocketException((int)SocketError.HostNotFound));
        }

        public void Respond(string url, string body, HttpStatusCode status = HttpStatusCode.OK, string contentType = "text/html")
        {
            var target = new Uri(url);
            var previous = Handler.ResponseFactory;
            Handler.ResponseFactory = request =>
            {
                if (request.RequestUri != null
                    && string.Equals(request.RequestUri.Host, target.Host, StringComparison.OrdinalIgnoreCase)
                    && request.RequestUri.Port == target.Port
                    && request.RequestUri.AbsolutePath == target.AbsolutePath)
                {
                    return new HttpResponseMessage(status)
                    {
                        Content = new StringContent(body, Encoding.UTF8, contentType),
                    };
                }

                return previous?.Invoke(request);
            };
        }
    }

    [Fact]
    public async Task Discover_ConfirmsArrServicesByServedTitle()
    {
        var fixture = new Fixture();
        fixture.Resolves["sonarr"] = IPAddress.Parse("10.0.0.2");
        fixture.Resolves["radarr"] = IPAddress.Parse("10.0.0.3");
        fixture.Respond("http://sonarr:8989/", "<!doctype html><html><head><title>Sonarr</title></head></html>");
        fixture.Respond("http://radarr:7878/", "<!doctype html><html><head><title>Grafana</title></head></html>");

        var results = await fixture.Build(Config()).DiscoverAsync();

        Assert.Contains(results, r => r is { Service: "sonarr", Url: "http://sonarr:8989" });
        // A reachable page whose title is not the expected product is not confirmed.
        Assert.DoesNotContain(results, r => r.Service == "radarr");
    }

    [Fact]
    public async Task Discover_ConfirmsStatusJsonServices_EvenWithHtmlContentType()
    {
        var fixture = new Fixture();
        fixture.Resolves["jellyseerr"] = IPAddress.Parse("10.0.0.4");
        fixture.Resolves["maintainerr"] = IPAddress.Parse("10.0.0.5");
        fixture.Respond("http://jellyseerr:5055/api/v1/status", "{\"version\":\"2.7.3\",\"initialized\":true}", contentType: "application/json");
        // Maintainerr serves its status JSON with a text/html content type.
        fixture.Respond("http://maintainerr:6246/api/app/status", "{\"version\":\"3.18.0\",\"status\":1}", contentType: "text/html");

        var results = await fixture.Build(Config()).DiscoverAsync();

        Assert.Contains(results, r => r is { Service: "seerr", Url: "http://jellyseerr:5055" });
        Assert.Contains(results, r => r is { Service: "maintainerr", Url: "http://maintainerr:6246" });
    }

    [Fact]
    public async Task Discover_RejectsNonOkAndNonJsonStatusBodies()
    {
        var fixture = new Fixture();
        fixture.Resolves["jellyseerr"] = IPAddress.Parse("10.0.0.4");
        fixture.Resolves["maintainerr"] = IPAddress.Parse("10.0.0.5");
        fixture.Respond("http://jellyseerr:5055/api/v1/status", "{\"version\":\"1.0\"}", HttpStatusCode.Unauthorized, "application/json");
        fixture.Respond("http://maintainerr:6246/api/app/status", "<html>login</html>");

        var results = await fixture.Build(Config()).DiscoverAsync();

        Assert.Empty(results);
    }

    [Fact]
    public async Task Discover_DeduplicatesAliasesOfTheSameEndpoint()
    {
        // "media" is cross-pollinated from the configured Radarr instance and is
        // the same container as the well-known "sonarr" alias.
        var fixture = new Fixture();
        var sharedIp = IPAddress.Parse("10.0.0.9");
        fixture.Resolves["sonarr"] = sharedIp;
        fixture.Resolves["media"] = sharedIp;
        fixture.Resolves["radarr"] = IPAddress.Parse("10.0.0.10");
        var title = "<title>Sonarr</title>";
        fixture.Respond("http://sonarr:8989/", title);
        fixture.Respond("http://media:8989/", title);

        var config = Config(radarrInstances: Instances("http://media:7878"));
        var results = await fixture.Build(config).DiscoverAsync();

        var sonarrHits = results.Where(r => r.Service == "sonarr").ToList();
        var hit = Assert.Single(sonarrHits);
        // The well-known Docker DNS name wins over the alias of the same endpoint.
        Assert.Equal("http://sonarr:8989", hit.Url);
    }

    [Fact]
    public async Task Discover_NeverAttachesCredentialsToProbes()
    {
        var fixture = new Fixture();
        fixture.Resolves["sonarr"] = IPAddress.Parse("10.0.0.2");
        fixture.Respond("http://sonarr:8989/", "<title>Sonarr</title>");

        var config = Config(radarrInstances: Instances("http://radarr-configured:7878"));
        config.SeerrApiKey = "seerr-secret";
        config.SonarrApiKey = "sonarr-secret";

        var results = await fixture.Build(config).DiscoverAsync();

        Assert.NotEmpty(results);
        Assert.NotEmpty(fixture.Handler.Requests);
        Assert.Empty(fixture.Handler.ApiKeyHeaders);
        Assert.All(fixture.Handler.Requests, request =>
        {
            Assert.Null(request.Headers.Authorization);
            Assert.False(request.Headers.Contains("X-Api-Key"));
            Assert.False(request.Headers.Contains("X-Arr-ApiKey"));
        });
    }

    [Fact]
    public async Task Discover_SkipsGuardBlockedCandidatesWithoutProbing()
    {
        var fixture = new Fixture();
        fixture.Resolves["sonarr"] = IPAddress.Parse("10.0.0.2");
        fixture.BlockedHosts.Add("sonarr");
        fixture.Respond("http://sonarr:8989/", "<title>Sonarr</title>");

        var results = await fixture.Build(Config()).DiscoverAsync();

        Assert.DoesNotContain(results, r => r.Service == "sonarr");
        Assert.DoesNotContain(
            fixture.Handler.Requests,
            r => string.Equals(r.RequestUri?.Host, "sonarr", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Discover_UnresolvableAndFailingCandidatesDoNotFailTheScan()
    {
        var fixture = new Fixture();
        // Only one candidate resolves at all; every probe to it throws.
        fixture.Resolves["radarr"] = IPAddress.Parse("10.0.0.3");
        fixture.Resolves["jellyseerr"] = IPAddress.Parse("10.0.0.4");
        fixture.Handler.ResponseFactory = request =>
            string.Equals(request.RequestUri?.Host, "radarr", StringComparison.OrdinalIgnoreCase)
                ? throw new HttpRequestException("connection refused")
                : null;
        fixture.Respond("http://jellyseerr:5055/api/v1/status", "{\"version\":\"2.7.3\"}", contentType: "application/json");

        var results = await fixture.Build(Config()).DiscoverAsync();

        var hit = Assert.Single(results);
        Assert.Equal(new DiscoveredService("seerr", "http://jellyseerr:5055"), hit);
    }

    [Fact]
    public async Task Discover_NeverFollowsCrossOriginRedirects()
    {
        // A hostile responder on the well-known sonarr candidate redirects to a
        // different private host and to a different port on the same host; the
        // scan must not request either destination and must not confirm.
        var fixture = new Fixture();
        fixture.Resolves["sonarr"] = IPAddress.Parse("10.0.0.2");
        fixture.Resolves["radarr"] = IPAddress.Parse("10.0.0.3");
        fixture.Resolves["internal-target"] = IPAddress.Parse("10.0.0.50");
        var previous = fixture.Handler.ResponseFactory;
        fixture.Handler.ResponseFactory = request =>
        {
            var uri = request.RequestUri!;
            if (string.Equals(uri.Host, "sonarr", StringComparison.OrdinalIgnoreCase))
            {
                var redirect = new HttpResponseMessage(HttpStatusCode.Redirect);
                redirect.Headers.Location = new Uri("http://internal-target:8080/admin/action");
                return redirect;
            }

            if (string.Equals(uri.Host, "radarr", StringComparison.OrdinalIgnoreCase))
            {
                var redirect = new HttpResponseMessage(HttpStatusCode.Redirect);
                redirect.Headers.Location = new Uri("http://radarr:9999/");
                return redirect;
            }

            return previous?.Invoke(request);
        };

        var results = await fixture.Build(Config()).DiscoverAsync();

        Assert.Empty(results);
        Assert.DoesNotContain(
            fixture.Handler.Requests,
            r => string.Equals(r.RequestUri?.Host, "internal-target", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(fixture.Handler.Requests, r => r.RequestUri?.Port == 9999);
    }

    [Fact]
    public async Task Discover_FollowsBoundedSameOriginRedirects()
    {
        // The supported case: an arr UI answering an anonymous probe with a
        // same-origin redirect to its login page.
        var fixture = new Fixture();
        fixture.Resolves["sonarr"] = IPAddress.Parse("10.0.0.2");
        fixture.Resolves["radarr"] = IPAddress.Parse("10.0.0.3");
        var previous = fixture.Handler.ResponseFactory;
        fixture.Handler.ResponseFactory = request =>
        {
            var uri = request.RequestUri!;
            if (string.Equals(uri.Host, "sonarr", StringComparison.OrdinalIgnoreCase))
            {
                if (uri.AbsolutePath == "/login")
                {
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent("<title>Sonarr</title>", Encoding.UTF8, "text/html"),
                    };
                }

                var redirect = new HttpResponseMessage(HttpStatusCode.Redirect);
                redirect.Headers.Location = new Uri("/login", UriKind.Relative);
                return redirect;
            }

            if (string.Equals(uri.Host, "radarr", StringComparison.OrdinalIgnoreCase))
            {
                // An endless same-origin redirect loop must stay bounded.
                var redirect = new HttpResponseMessage(HttpStatusCode.Redirect);
                redirect.Headers.Location = new Uri("/", UriKind.Relative);
                return redirect;
            }

            return previous?.Invoke(request);
        };

        var results = await fixture.Build(Config()).DiscoverAsync();

        Assert.Contains(results, r => r is { Service: "sonarr", Url: "http://sonarr:8989" });
        Assert.DoesNotContain(results, r => r.Service == "radarr");
        var radarrRequests = fixture.Handler.Requests
            .Count(r => string.Equals(r.RequestUri?.Host, "radarr", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(ServiceDiscoveryService.MaxRedirects + 1, radarrRequests);
    }

    [Theory]
    [InlineData("http://sonarr:8989/", "http://sonarr:8989/login", true)]
    [InlineData("http://sonarr:8989/", "https://sonarr:8989/login", true)]
    [InlineData("https://sonarr:8989/", "http://sonarr:8989/login", false)]
    [InlineData("http://sonarr:8989/", "http://sonarr:9999/", false)]
    [InlineData("http://sonarr:8989/", "http://other:8989/", false)]
    [InlineData("http://sonarr:8989/", "ftp://sonarr:8989/", false)]
    public void SameOriginRedirectPolicy_IsExactHostPortWithOptionalHttpsUpgrade(
        string current, string target, bool allowed)
    {
        Assert.Equal(
            allowed,
            ServiceDiscoveryService.IsSameOriginRedirectTarget(new Uri(current), new Uri(target)));
    }

    [Fact]
    public async Task Discover_ConcurrentCallsShareOneScan()
    {
        var fixture = new Fixture();
        fixture.Resolves["sonarr"] = IPAddress.Parse("10.0.0.2");
        fixture.Respond("http://sonarr:8989/", "<title>Sonarr</title>");

        // Hold the scan open at the guard so the second call provably joins the
        // still-in-flight first scan instead of starting a fresh one.
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var factory = new RecordingHttpClientFactory(fixture.Handler);
        var service = new ServiceDiscoveryService(
            factory,
            new FakePluginConfigProvider(Config()),
            NullLogger<ServiceDiscoveryService>.Instance,
            async (_, _) => { await gate.Task; return true; },
            (host, _) => fixture.Resolves.TryGetValue(host, out var ip)
                ? Task.FromResult(new[] { ip })
                : throw new SocketException((int)SocketError.HostNotFound));

        var first = service.DiscoverAsync();
        var second = service.DiscoverAsync();
        Assert.Same(first, second);

        gate.SetResult();
        var results = await first;
        Assert.Contains(results, r => r is { Service: "sonarr", Url: "http://sonarr:8989" });
    }

    // ── Seerr arr import ─────────────────────────────────────────────────────

    [Fact]
    public void ParseSeerrArrSettings_ProjectsHostPortSslAndBasePathToInstances()
    {
        var json = """
        [
          {"id":0,"name":"Sonarr HD","hostname":"sonarr","port":8989,"apiKey":"key-hd","useSsl":false,"baseUrl":""},
          {"id":1,"name":"Sonarr 4K","hostname":"sonarr4k.example.com","port":443,"apiKey":"key-4k","useSsl":true,"baseUrl":"/sonarr"}
        ]
        """;

        var parsed = ServiceDiscoveryService.ParseSeerrArrSettings("sonarr", json);

        Assert.Collection(
            parsed,
            first =>
            {
                Assert.Equal("sonarr", first.Service);
                Assert.Equal("Sonarr HD", first.Name);
                Assert.Equal("http://sonarr:8989", first.Url);
                Assert.Equal("key-hd", first.ApiKey);
            },
            second =>
            {
                Assert.Equal("Sonarr 4K", second.Name);
                Assert.Equal("https://sonarr4k.example.com/sonarr", second.Url);
                Assert.Equal("key-4k", second.ApiKey);
            });
    }

    [Theory]
    // Missing key, missing hostname, unusable port, and hostile URL shapes are
    // all dropped rather than reaching configuration.
    [InlineData("""[{"name":"No key","hostname":"sonarr","port":8989,"useSsl":false}]""")]
    [InlineData("""[{"name":"No host","port":8989,"apiKey":"k","useSsl":false}]""")]
    [InlineData("""[{"name":"Bad host","hostname":"so narr","port":8989,"apiKey":"k"}]""")]
    [InlineData("""[{"name":"Creds","hostname":"user:pass@sonarr","port":8989,"apiKey":"k"}]""")]
    [InlineData("""{"not":"an array"}""")]
    [InlineData("not json at all")]
    public void ParseSeerrArrSettings_DropsUnusableServers(string json)
        => Assert.Empty(ServiceDiscoveryService.ParseSeerrArrSettings("sonarr", json));

    [Fact]
    public async Task ImportFromSeerr_ReadsBothServicesAndSurvivesOneFailing()
    {
        var fixture = new Fixture();
        var service = fixture.Build(Config());
        var requested = new List<string>();

        var imported = await service.ImportArrInstancesFromSeerrAsync(
            (path, _) =>
            {
                requested.Add(path);
                if (path.EndsWith("radarr", StringComparison.Ordinal))
                {
                    throw new InvalidOperationException("seerr unavailable");
                }

                return Task.FromResult<IActionResult>(new ContentResult
                {
                    StatusCode = 200,
                    Content = """[{"name":"TV","hostname":"sonarr","port":8989,"apiKey":"k"}]""",
                });
            },
            CancellationToken.None);

        Assert.Equal(new[] { "/api/v1/settings/sonarr", "/api/v1/settings/radarr" }, requested);
        var only = Assert.Single(imported);
        Assert.Equal(new ImportedArrInstance("sonarr", "TV", "http://sonarr:8989", "k"), only);
    }

    [Fact]
    public async Task ImportFromSeerr_IgnoresNonSuccessProxyResults()
    {
        var fixture = new Fixture();
        var service = fixture.Build(Config());

        var imported = await service.ImportArrInstancesFromSeerrAsync(
            (_, _) => Task.FromResult<IActionResult>(new ObjectResult(new { error = true })
            {
                StatusCode = 403,
            }),
            CancellationToken.None);

        Assert.Empty(imported);
    }

    [Fact]
    public async Task Discover_ReturnsEmptyWhenPluginConfigurationUnavailable()
    {
        var fixture = new Fixture();
        var factory = new RecordingHttpClientFactory(fixture.Handler);
        var service = new ServiceDiscoveryService(
            factory,
            new FakePluginConfigProvider(null),
            NullLogger<ServiceDiscoveryService>.Instance,
            (_, _) => Task.FromResult(true),
            (_, _) => Task.FromResult(new[] { IPAddress.Parse("10.0.0.2") }));

        var results = await service.DiscoverAsync();

        Assert.Empty(results);
        Assert.Empty(fixture.Handler.Requests);
    }
}
