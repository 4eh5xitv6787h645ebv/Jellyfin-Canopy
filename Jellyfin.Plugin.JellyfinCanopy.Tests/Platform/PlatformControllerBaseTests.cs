using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Claims;
using System.Text;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>
    /// Adversarial evidence for the first-party actor boundary. Every value a caller can
    /// shape is present in these requests; only the authenticated Jellyfin user claim and
    /// a fresh host lookup are allowed to establish authority.
    /// </summary>
    public class PlatformControllerBaseTests
    {
        private sealed class ProbeController : PlatformControllerBase
        {
            public PlatformActor ExposedActor => Actor;
        }

        private sealed class StubHost : IPlatformHost
        {
            public StubHost(Func<Guid, HostUser?> findUser)
            {
                Users = new StubUsers(findUser);
            }

            public IHostUsers Users { get; }

            public IHostLibrary Library { get; } = new StubLibrary();

            public IHostSessions Sessions { get; } = new StubSessions();

            public IHostPlugins Plugins { get; } = new StubPlugins();
        }

        private sealed class StubUsers : IHostUsers
        {
            private readonly Func<Guid, HostUser?> _find;

            public StubUsers(Func<Guid, HostUser?> find) => _find = find;

            public HostUser? Find(Guid id) => _find(id);

            public IReadOnlyList<HostUser> All() => Array.Empty<HostUser>();
        }

        private sealed class StubLibrary : IHostLibrary
        {
            public HostItem? Find(Guid id) => null;

            public HostItemAccessResult FindAccessible(Guid userId, Guid itemId) =>
                HostItemAccessResult.NotAccessible;

            public IReadOnlyList<HostItem> ChildrenOf(Guid id) => Array.Empty<HostItem>();
        }

        private sealed class StubSessions : IHostSessions
        {
            public IReadOnlyList<HostSession> Active() => Array.Empty<HostSession>();

            public IReadOnlyList<HostSession> ForUser(Guid userId) => Array.Empty<HostSession>();
        }

        private sealed class StubPlugins : IHostPlugins
        {
            public IReadOnlyList<HostPlugin> Installed() => Array.Empty<HostPlugin>();

            public HostPlugin? Find(Guid id) => null;
        }

        private sealed class EmptyAuthenticationService : IAuthenticationService
        {
            public Task<AuthenticateResult> AuthenticateAsync(HttpContext context, string? scheme) =>
                Task.FromResult(AuthenticateResult.NoResult());

            public Task ChallengeAsync(HttpContext context, string? scheme, AuthenticationProperties? properties)
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return Task.CompletedTask;
            }

            public Task ForbidAsync(HttpContext context, string? scheme, AuthenticationProperties? properties)
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                return Task.CompletedTask;
            }

            public Task SignInAsync(
                HttpContext context,
                string? scheme,
                ClaimsPrincipal principal,
                AuthenticationProperties? properties) => throw new NotSupportedException();

            public Task SignOutAsync(
                HttpContext context,
                string? scheme,
                AuthenticationProperties? properties) => throw new NotSupportedException();
        }

        private sealed record RunResult(ResourceExecutingContext Context, bool Continued, PlatformActor? Actor);

        private static ClaimsPrincipal Principal(params Claim[] claims)
        {
            var allClaims = claims.ToList();
            if (!allClaims.Any(claim => string.Equals(
                claim.Type,
                "Jellyfin-IsApiKey",
                StringComparison.OrdinalIgnoreCase)))
            {
                allClaims.Add(new Claim("Jellyfin-IsApiKey", bool.FalseString));
            }

            return new ClaimsPrincipal(new ClaimsIdentity(allClaims, "JellyfinTestAuthentication"));
        }

        private static DefaultHttpContext Request(ClaimsPrincipal principal)
        {
            return new DefaultHttpContext
            {
                User = principal,
            };
        }

        private static async Task<RunResult> RunAsync(
            HttpContext http,
            Func<Guid, HostUser?>? findUser = null,
            IEnumerable<object>? endpointMetadata = null)
        {
            var descriptor = new ActionDescriptor
            {
                EndpointMetadata = endpointMetadata?.ToList() ?? new List<object>(),
            };
            var context = new ResourceExecutingContext(
                new ActionContext(http, new RouteData(), descriptor),
                new List<IFilterMetadata>(),
                new List<IValueProviderFactory>());
            var continued = false;

            await new PlatformActorBoundaryFilter(new StubHost(findUser ?? (_ => null)))
                .OnResourceExecutionAsync(context, () =>
                {
                    continued = true;
                    return Task.FromResult(new ResourceExecutedContext(context, new List<IFilterMetadata>()));
                });

            PlatformActor? actor = null;
            var isAnonymous = endpointMetadata?.Any(metadata => metadata is IAllowAnonymous) == true;
            if (continued && !isAnonymous)
            {
                actor = new ProbeController
                {
                    ControllerContext = new ControllerContext
                    {
                        HttpContext = http,
                        RouteData = context.RouteData,
                    },
                }.ExposedActor;
            }

            return new RunResult(context, continued, actor);
        }

        private static async Task ExecuteThroughPlatformResultFilterAsync(ActionResult result, HttpContext http)
        {
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddMvcCore();
            services.AddSingleton<IAuthenticationService>(new EmptyAuthenticationService());
            using var provider = services.BuildServiceProvider();
            http.RequestServices = provider;
            http.Response.Body = new MemoryStream();

            var action = new ActionContext(http, new RouteData(), new ActionDescriptor());
            var filters = new List<IFilterMetadata>();
            var context = new ResultExecutingContext(action, filters, result, new object());
            await new PlatformJsonResultFilter().OnResultExecutionAsync(context, async () =>
            {
                await context.Result.ExecuteResultAsync(action);
                return new ResultExecutedContext(action, filters, context.Result, new object());
            });
        }

        [Fact]
        public async Task ActorUsesTheAuthenticatedClaimAndFreshHostElevation()
        {
            var userId = Guid.NewGuid();
            var calls = 0;
            HostUser? Find(Guid requested)
            {
                calls++;
                return new HostUser(requested, "current", true);
            }

            var http = Request(Principal(
                new Claim("Jellyfin-UserId", userId.ToString("N")),
                new Claim("Jellyfin-Client", " Android TV "),
                new Claim("Jellyfin-DeviceId", " living-room-tv ")));

            var result = await RunAsync(http, Find);

            Assert.True(result.Continued);
            Assert.NotNull(result.Actor);
            Assert.Equal(userId, result.Actor!.UserId);
            Assert.True(result.Actor.IsElevated);
            Assert.Equal("Android TV", result.Actor.ClientName);
            Assert.Equal("living-room-tv", result.Actor.DeviceId);
            Assert.Equal(PlatformCorrelation.For(http), result.Actor.CorrelationId);
            Assert.Equal(1, calls);
        }

        [Fact]
        public async Task ForgedRequestSourcesCannotReplaceTheAuthenticatedUser()
        {
            var real = Guid.NewGuid();
            var forged = Guid.NewGuid();
            var http = Request(Principal(new Claim("Jellyfin-UserId", real.ToString())));
            http.Request.Headers["Jellyfin-UserId"] = forged.ToString();
            http.Request.Headers["X-Jellyfin-User-Id"] = forged.ToString();
            http.Request.Headers["X-Emby-Authorization"] = $"MediaBrowser UserId=\"{forged}\"";
            http.Request.Headers.Cookie = $"jellyfin-userid={forged}; marker={forged}";
            http.Request.QueryString = new QueryString($"?userId={forged}&client=admin");
            http.Request.RouteValues["userId"] = forged.ToString();
            http.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes($"{{\"UserId\":\"{forged}\"}}"));
            http.Request.ContentLength = http.Request.Body.Length;
            http.Items["RequestIdentityService"] = forged;
            http.Items["JellyfinCanopy.UserMarker"] = forged;

            var result = await RunAsync(http, id => new HostUser(id, "real", false));

            Assert.True(result.Continued);
            Assert.Equal(real, result.Actor!.UserId);
            Assert.False(result.Actor.IsElevated);
        }

        [Fact]
        public async Task RoleAndAttributionClaimsCannotElevateANonAdministrator()
        {
            var userId = Guid.NewGuid();
            var result = await RunAsync(
                Request(Principal(
                    new Claim("Jellyfin-UserId", userId.ToString()),
                    new Claim(ClaimTypes.Role, "Administrator"),
                    new Claim("Jellyfin-Client", "administrator"),
                    new Claim("Jellyfin-DeviceId", "administrator"))),
                id => new HostUser(id, "non-admin", false));

            Assert.True(result.Continued);
            Assert.False(result.Actor!.IsElevated);
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("not-a-boolean")]
        [InlineData("True")]
        public async Task ApiKeyOrUnprovenFirstPartyStatusFailsClosed(string? raw)
        {
            var userId = Guid.NewGuid();
            var claims = new List<Claim> { new("Jellyfin-UserId", userId.ToString()) };
            if (raw is not null)
            {
                claims.Add(new Claim("Jellyfin-IsApiKey", raw));
            }

            var principal = raw is null
                ? new ClaimsPrincipal(new ClaimsIdentity(claims, "JellyfinTestAuthentication"))
                : Principal(claims.ToArray());
            var result = await RunAsync(
                Request(principal),
                _ => throw new InvalidOperationException("API/service actors must not query the first-party user seam"));

            Assert.False(result.Continued);
            Assert.IsType<ForbidResult>(result.Context.Result);
        }

        [Fact]
        public async Task DuplicateApiKeyClaimsFailClosed()
        {
            var userId = Guid.NewGuid();
            var result = await RunAsync(
                Request(Principal(
                    new Claim("Jellyfin-UserId", userId.ToString()),
                    new Claim("Jellyfin-IsApiKey", bool.FalseString),
                    new Claim("jellyfin-isapikey", bool.FalseString))),
                _ => throw new InvalidOperationException("ambiguous actor class must not query host"));

            Assert.False(result.Continued);
            Assert.IsType<ForbidResult>(result.Context.Result);
        }

        [Fact]
        public async Task CurrentHostPermissionCanElevateWithoutARoleClaim()
        {
            var userId = Guid.NewGuid();
            var result = await RunAsync(
                Request(Principal(new Claim("Jellyfin-UserId", userId.ToString()))),
                id => new HostUser(id, "admin", true));

            Assert.True(result.Actor!.IsElevated);
        }

        [Fact]
        public async Task SameIpDoesNotMergeTwoAuthenticatedUsers()
        {
            var userA = Guid.NewGuid();
            var userB = Guid.NewGuid();
            var requestA = Request(Principal(new Claim("Jellyfin-UserId", userA.ToString())));
            var requestB = Request(Principal(new Claim("Jellyfin-UserId", userB.ToString())));
            requestA.Connection.RemoteIpAddress = IPAddress.Parse("192.0.2.10");
            requestB.Connection.RemoteIpAddress = IPAddress.Parse("192.0.2.10");

            var resultA = await RunAsync(requestA, id => new HostUser(id, "a", false));
            var resultB = await RunAsync(requestB, id => new HostUser(id, "b", false));

            Assert.Equal(userA, resultA.Actor!.UserId);
            Assert.Equal(userB, resultB.Actor!.UserId);
            Assert.NotEqual(resultA.Actor.UserId, resultB.Actor.UserId);
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("not-a-guid")]
        [InlineData("00000000-0000-0000-0000-000000000000")]
        public async Task MissingMalformedOrEmptyIdentityFailsClosed(string? raw)
        {
            var principal = raw is null
                ? Principal()
                : Principal(new Claim("Jellyfin-UserId", raw));

            var result = await RunAsync(Request(principal), _ => throw new InvalidOperationException("must not query host"));

            Assert.False(result.Continued);
            Assert.IsType<ForbidResult>(result.Context.Result);
        }

        [Fact]
        public async Task ConflictingOrDuplicateAuthoritativeClaimsFailClosed()
        {
            var userA = Guid.NewGuid();
            var userB = Guid.NewGuid();

            foreach (var claims in new[]
            {
                new[] { new Claim("Jellyfin-UserId", userA.ToString()), new Claim("Jellyfin-UserId", userA.ToString()) },
                new[] { new Claim("Jellyfin-UserId", userA.ToString()), new Claim("jellyfin-userid", userB.ToString()) },
            })
            {
                var result = await RunAsync(Request(Principal(claims)));

                Assert.False(result.Continued);
                Assert.IsType<ForbidResult>(result.Context.Result);
            }
        }

        [Fact]
        public async Task DeletedOrMismatchedCurrentUserFailsClosed()
        {
            var userId = Guid.NewGuid();
            var request = Request(Principal(new Claim("Jellyfin-UserId", userId.ToString())));

            var deleted = await RunAsync(request, _ => null);
            var mismatched = await RunAsync(
                Request(Principal(new Claim("Jellyfin-UserId", userId.ToString()))),
                _ => new HostUser(Guid.NewGuid(), "wrong", true));

            Assert.False(deleted.Continued);
            Assert.IsType<ForbidResult>(deleted.Context.Result);
            Assert.False(mismatched.Continued);
            Assert.IsType<ForbidResult>(mismatched.Context.Result);
        }

        [Fact]
        public async Task ElevationIsReReadForEveryRequestAndExistingActorsStayImmutable()
        {
            var userId = Guid.NewGuid();
            var elevated = false;
            HostUser? Find(Guid id) => new(id, "current", elevated);

            var first = await RunAsync(
                Request(Principal(new Claim("Jellyfin-UserId", userId.ToString()))),
                Find);
            elevated = true;
            var second = await RunAsync(
                Request(Principal(new Claim("Jellyfin-UserId", userId.ToString()))),
                Find);

            Assert.False(first.Actor!.IsElevated);
            Assert.True(second.Actor!.IsElevated);
            Assert.False(first.Actor.IsElevated);
        }

        [Fact]
        public async Task AttributionIsBoundedAndAmbiguityOrControlTextIsDiscarded()
        {
            var userId = Guid.NewGuid();
            var result = await RunAsync(
                Request(Principal(
                    new Claim("Jellyfin-UserId", userId.ToString()),
                    new Claim("Jellyfin-Client", new string('c', PlatformActorBoundaryFilter.MaxClientNameBytes + 1)),
                    new Claim("Jellyfin-DeviceId", "good"),
                    new Claim("jellyfin-deviceid", "ambiguous"))),
                id => new HostUser(id, "user", false));

            Assert.True(result.Continued);
            Assert.Null(result.Actor!.ClientName);
            Assert.Null(result.Actor.DeviceId);

            var controls = await RunAsync(
                Request(Principal(
                    new Claim("Jellyfin-UserId", userId.ToString()),
                    new Claim("Jellyfin-Client", "client\nforged-log"),
                    new Claim("Jellyfin-DeviceId", "device\u2028forged-log"))),
                id => new HostUser(id, "user", false));

            Assert.Null(controls.Actor!.ClientName);
            Assert.Null(controls.Actor.DeviceId);
        }

        [Fact]
        public async Task AttributionLimitsAreUtf8ByteBoundsNotCharacterCounts()
        {
            var userId = Guid.NewGuid();
            var accepted = await RunAsync(
                Request(Principal(
                    new Claim("Jellyfin-UserId", userId.ToString()),
                    new Claim("Jellyfin-Client", new string('c', PlatformActorBoundaryFilter.MaxClientNameBytes)),
                    new Claim("Jellyfin-DeviceId", new string('d', PlatformActorBoundaryFilter.MaxDeviceIdBytes)))),
                id => new HostUser(id, "user", false));
            var rejected = await RunAsync(
                Request(Principal(
                    new Claim("Jellyfin-UserId", userId.ToString()),
                    new Claim("Jellyfin-Client", new string('\u00e9', (PlatformActorBoundaryFilter.MaxClientNameBytes / 2) + 1)),
                    new Claim("Jellyfin-DeviceId", new string('\u00e9', (PlatformActorBoundaryFilter.MaxDeviceIdBytes / 2) + 1)))),
                id => new HostUser(id, "user", false));

            Assert.Equal(PlatformActorBoundaryFilter.MaxClientNameBytes, accepted.Actor!.ClientName!.Length);
            Assert.Equal(PlatformActorBoundaryFilter.MaxDeviceIdBytes, accepted.Actor.DeviceId!.Length);
            Assert.Null(rejected.Actor!.ClientName);
            Assert.Null(rejected.Actor.DeviceId);
        }

        [Fact]
        public async Task UnauthenticatedDirectInvocationFailsClosedWithoutAnEnvelope()
        {
            var result = await RunAsync(Request(new ClaimsPrincipal(new ClaimsIdentity())));

            Assert.False(result.Continued);
            Assert.IsType<UnauthorizedResult>(result.Context.Result);
            Assert.False(result.Context.Result is ObjectResult);
        }

        [Fact]
        public async Task ExplicitAnonymousDiscoveryBypassesActorResolution()
        {
            var result = await RunAsync(
                Request(new ClaimsPrincipal(new ClaimsIdentity())),
                _ => throw new InvalidOperationException("anonymous discovery has no actor"),
                new object[] { new AllowAnonymousAttribute() });

            Assert.True(result.Continued);
            Assert.Null(result.Context.Result);
            Assert.Null(result.Actor);
        }

        [Fact]
        public async Task ActorRejectionsRemainZeroByteThroughThePlatformResultFilter()
        {
            var unauthenticated = await RunAsync(Request(new ClaimsPrincipal(new ClaimsIdentity())));
            var userId = Guid.NewGuid();
            var deletedUser = await RunAsync(
                Request(Principal(new Claim("Jellyfin-UserId", userId.ToString()))),
                _ => null);

            foreach (var rejected in new[] { unauthenticated, deletedUser })
            {
                await ExecuteThroughPlatformResultFilterAsync(
                    Assert.IsAssignableFrom<ActionResult>(rejected.Context.Result),
                    rejected.Context.HttpContext);

                var expected = rejected.Context.Result is UnauthorizedResult
                    ? StatusCodes.Status401Unauthorized
                    : StatusCodes.Status403Forbidden;
                Assert.Equal(expected, rejected.Context.HttpContext.Response.StatusCode);
                Assert.Equal(0, rejected.Context.HttpContext.Response.Body.Length);
                Assert.Null(rejected.Context.HttpContext.Response.ContentType);
                Assert.False(rejected.Context.HttpContext.Response.Headers.ContainsKey(PlatformCorrelation.HeaderName));
            }
        }
    }
}
