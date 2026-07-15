using System.Security.Claims;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class SeerrUserStatusGenerationFenceTests
{
    [Fact]
    public async Task UserStatus_MasterDisabledByCapabilityCallback_DoesNotPublishLinkedState()
    {
        var user = new User("status-user", "provider", "password-provider");
        var config = new PluginConfiguration
        {
            SeerrEnabled = true,
            SeerrUrls = "http://seerr:5055",
            SeerrApiKey = "retained-key",
        };
        var provider = new FakePluginConfigProvider(config);
        var seerr = new CapabilityCallbackSeerrClient(
            new SeerrUser
            {
                Id = 42,
                JellyfinUserId = user.Id.ToString("N"),
                SourceUrl = "http://seerr:5055",
            },
            () => config.SeerrEnabled = false);
        var users = new StubUserManager(user);
        var factory = new RecordingHttpClientFactory(new RecordingHttpMessageHandler());
        var controller = new SeerrUserController(
            factory,
            NullLogger<SeerrUserController>.Instance,
            users,
            new SeerrCache(provider),
            provider,
            null!,
            null!,
            seerr)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(
                        new[] { new Claim("Jellyfin-UserId", user.Id.ToString()) },
                        "TestAuth")),
                },
            },
        };

        var result = Assert.IsType<OkObjectResult>(await controller.GetSeerrUserStatus());

        Assert.False(Read<bool>(result.Value, "active"));
        Assert.False(Read<bool>(result.Value, "userFound"));
        Assert.Equal("disabled", Read<string>(result.Value, "reason"));
        Assert.Equal(1, seerr.CapabilityCalls);
        Assert.Equal("retained-key", config.SeerrApiKey);
    }

    private static T Read<T>(object? value, string propertyName)
        => Assert.IsType<T>(value?.GetType().GetProperty(propertyName)?.GetValue(value));

    private sealed class CapabilityCallbackSeerrClient : ISeerrClient
    {
        private readonly SeerrUser _user;
        private readonly Action _capabilityCallback;

        public CapabilityCallbackSeerrClient(SeerrUser user, Action capabilityCallback)
        {
            _user = user;
            _capabilityCallback = capabilityCallback;
        }

        public int CapabilityCalls { get; private set; }

        public Task<SeerrUserResolution> ResolveSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(SeerrUserResolution.Found(_user));
        }

        public Task<SeerrUser?> GetSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true)
            => Task.FromResult<SeerrUser?>(_user);

        public Task<string?> GetSeerrUserId(string jellyfinUserId, bool allowAutoImport = true)
            => Task.FromResult<string?>(_user.Id.ToString());

        public bool IsImportBlocked(string jellyfinUserId, PluginConfiguration config) => false;

        public Task<bool> GetStatusActiveAsync() => Task.FromResult(true);

        public Task<Seerr4kCapability> GetSeerr4kCapabilityAsync(
            string jellyfinUserId,
            bool isAdmin = false)
        {
            CapabilityCalls++;
            _capabilityCallback();
            return Task.FromResult(new Seerr4kCapability(true, true, true, true));
        }

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
}
