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
    [Theory]
    [InlineData(ConfigurationMutation.MasterDisabled)]
    [InlineData(ConfigurationMutation.UrlAndKeyChanged)]
    [InlineData(ConfigurationMutation.RevisionChanged)]
    public async Task UserStatus_ConfigurationChangesDuringCapabilityAwait_DoesNotPublishLinkedState(
        ConfigurationMutation mutation)
    {
        var user = new User("status-user", "provider", "password-provider");
        var config = new PluginConfiguration
        {
            SeerrEnabled = true,
            SeerrUrls = "http://seerr:5055",
            SeerrApiKey = "retained-key",
        };
        var provider = new FakePluginConfigProvider(config);
        var seerr = new BlockingSeerrClient(
            new SeerrUser
            {
                Id = 42,
                JellyfinUserId = user.Id.ToString("N"),
                SourceUrl = "http://seerr:5055",
            },
            BlockedStage.Capability);
        var controller = BuildController(user, provider, seerr);

        var pending = controller.GetSeerrUserStatus();
        await seerr.CapabilityStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Mutate(provider, config, mutation);
        seerr.ReleaseCapability();
        var result = Assert.IsType<OkObjectResult>(await pending);

        AssertInactive(result);
        Assert.Equal(1, seerr.ResolutionCalls);
        Assert.Equal(1, seerr.CapabilityCalls);
    }

    [Theory]
    [InlineData(ConfigurationMutation.MasterDisabled)]
    [InlineData(ConfigurationMutation.UrlAndKeyChanged)]
    [InlineData(ConfigurationMutation.RevisionChanged)]
    public async Task UserStatus_ConfigurationChangesDuringResolutionAwait_DoesNotStartCapabilityOrPublishLinkedState(
        ConfigurationMutation mutation)
    {
        var user = new User("status-resolution-user", "provider", "password-provider");
        var config = new PluginConfiguration
        {
            SeerrEnabled = true,
            SeerrUrls = "http://seerr:5055",
            SeerrApiKey = "retained-key",
        };
        var provider = new FakePluginConfigProvider(config);
        var seerr = new BlockingSeerrClient(
            new SeerrUser
            {
                Id = 43,
                JellyfinUserId = user.Id.ToString("N"),
                SourceUrl = "http://seerr:5055",
            },
            BlockedStage.Resolution);
        var controller = BuildController(user, provider, seerr);

        var pending = controller.GetSeerrUserStatus();
        await seerr.ResolutionStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Mutate(provider, config, mutation);
        seerr.ReleaseResolution();
        var result = Assert.IsType<OkObjectResult>(await pending);

        AssertInactive(result);
        Assert.Equal(1, seerr.ResolutionCalls);
        Assert.Equal(0, seerr.CapabilityCalls);
    }

    private static void AssertInactive(OkObjectResult result)
    {
        Assert.False(Read<bool>(result.Value, "active"));
        Assert.False(Read<bool>(result.Value, "userFound"));
        Assert.Equal("disabled", Read<string>(result.Value, "reason"));
        Assert.Null(result.Value?.GetType().GetProperty("seerrUserId"));
        Assert.Null(result.Value?.GetType().GetProperty("movie4kEnabled"));
        Assert.Null(result.Value?.GetType().GetProperty("series4kEnabled"));
        Assert.Null(result.Value?.GetType().GetProperty("canRequest4kMovie"));
        Assert.Null(result.Value?.GetType().GetProperty("canRequest4kTv"));
    }

    private static void Mutate(
        FakePluginConfigProvider provider,
        PluginConfiguration original,
        ConfigurationMutation mutation)
    {
        switch (mutation)
        {
            case ConfigurationMutation.MasterDisabled:
                original.SeerrEnabled = false;
                break;
            case ConfigurationMutation.UrlAndKeyChanged:
                original.SeerrUrls = "http://replacement:5055";
                original.SeerrApiKey = "replacement-key";
                break;
            case ConfigurationMutation.RevisionChanged:
                provider.Current = new PluginConfiguration
                {
                    SeerrEnabled = true,
                    SeerrUrls = original.SeerrUrls,
                    SeerrApiKey = original.SeerrApiKey,
                };
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(mutation));
        }
    }

    private static SeerrUserController BuildController(
        User user,
        FakePluginConfigProvider provider,
        ISeerrClient seerr)
    {
        var users = new StubUserManager(user);
        var factory = new RecordingHttpClientFactory(new RecordingHttpMessageHandler());
        return new SeerrUserController(
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
    }

    private static T Read<T>(object? value, string propertyName)
        => Assert.IsType<T>(value?.GetType().GetProperty(propertyName)?.GetValue(value));

    public enum ConfigurationMutation
    {
        MasterDisabled,
        UrlAndKeyChanged,
        RevisionChanged,
    }

    private enum BlockedStage
    {
        Resolution,
        Capability,
    }

    private sealed class BlockingSeerrClient : ISeerrClient
    {
        private readonly SeerrUser _user;
        private readonly BlockedStage _blockedStage;
        private readonly TaskCompletionSource<bool> _releaseResolution = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> _releaseCapability = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public BlockingSeerrClient(
            SeerrUser user,
            BlockedStage blockedStage)
        {
            _user = user;
            _blockedStage = blockedStage;
        }

        public TaskCompletionSource<bool> ResolutionStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource<bool> CapabilityStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int ResolutionCalls { get; private set; }

        public int CapabilityCalls { get; private set; }

        public async Task<SeerrUserResolution> ResolveSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ResolutionCalls++;
            if (_blockedStage == BlockedStage.Resolution)
            {
                ResolutionStarted.TrySetResult(true);
                await _releaseResolution.Task.WaitAsync(cancellationToken);
            }

            return SeerrUserResolution.Found(_user);
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

        public async Task<Seerr4kCapability> GetSeerr4kCapabilityAsync(
            string jellyfinUserId,
            bool isAdmin = false)
        {
            CapabilityCalls++;
            if (_blockedStage == BlockedStage.Capability)
            {
                CapabilityStarted.TrySetResult(true);
                await _releaseCapability.Task;
            }

            return new Seerr4kCapability(true, true, true, true);
        }

        public void ReleaseResolution() => _releaseResolution.TrySetResult(true);

        public void ReleaseCapability() => _releaseCapability.TrySetResult(true);

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
