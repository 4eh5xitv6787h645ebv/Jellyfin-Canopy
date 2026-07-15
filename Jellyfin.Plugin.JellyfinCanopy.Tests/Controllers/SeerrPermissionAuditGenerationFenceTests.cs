using System.Text.Json;
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

public sealed class SeerrPermissionAuditGenerationFenceTests
{
    [Fact]
    public async Task PermissionAudit_DisabledDuringResolverAwait_PublishesNoPartialAudit()
    {
        var fixture = CreateFixture();
        var pending = fixture.Controller.GetPermissionAudit();
        await fixture.Seerr.FirstResolutionStarted.WaitAsync(TimeSpan.FromSeconds(5));

        fixture.OriginalConfiguration.SeerrEnabled = false;
        fixture.Seerr.ReleaseFirstResolution();

        var unavailable = Assert.IsType<ObjectResult>(
            await pending.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(503, unavailable.StatusCode);
        AssertTypedFailure(unavailable.Value, "seerr_disabled", fixture.Users);
        Assert.Equal(1, fixture.Seerr.ResolutionCalls);
    }

    [Fact]
    public async Task PermissionAudit_ConfigurationReplacedDuringResolverAwait_PublishesNoPartialAudit()
    {
        var fixture = CreateFixture();
        var pending = fixture.Controller.GetPermissionAudit();
        await fixture.Seerr.FirstResolutionStarted.WaitAsync(TimeSpan.FromSeconds(5));

        fixture.Provider.Current = Configuration();
        fixture.Seerr.ReleaseFirstResolution();

        var conflict = Assert.IsType<ConflictObjectResult>(
            await pending.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(409, conflict.StatusCode);
        AssertTypedFailure(conflict.Value, "audit_configuration_changed", fixture.Users);
        Assert.Equal(1, fixture.Seerr.ResolutionCalls);
    }

    private static void AssertTypedFailure(
        object? value,
        string expectedCode,
        IReadOnlyList<User> users)
    {
        var body = JsonSerializer.SerializeToElement(value);
        Assert.True(body.GetProperty("error").GetBoolean());
        Assert.False(body.GetProperty("active").GetBoolean());
        Assert.Equal(expectedCode, body.GetProperty("code").GetString());
        Assert.False(body.TryGetProperty("permissions", out _));
        Assert.False(body.TryGetProperty("results", out _));

        var serialized = body.GetRawText();
        foreach (var user in users)
        {
            Assert.DoesNotContain(user.Username, serialized, StringComparison.Ordinal);
            Assert.DoesNotContain(user.Id.ToString("N"), serialized, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static Fixture CreateFixture()
    {
        var users = new[]
        {
            new User("audit-first", "provider", "password-provider"),
            new User("audit-second", "provider", "password-provider"),
        };
        var configuration = Configuration();
        var provider = new FakePluginConfigProvider(configuration);
        var seerr = new BlockingAuditSeerrClient();
        var userManager = new StubUserManager(users);
        var factory = new RecordingHttpClientFactory(new RecordingHttpMessageHandler());
        var controller = new SeerrUserController(
            factory,
            NullLogger<SeerrUserController>.Instance,
            userManager,
            new SeerrCache(provider),
            provider,
            userDataManager: null!,
            libraryManager: null!,
            seerr)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext(),
            },
        };

        return new Fixture(controller, provider, configuration, seerr, users);
    }

    private static PluginConfiguration Configuration()
        => new()
        {
            SeerrEnabled = true,
            SeerrUrls = "http://seerr:5055",
            SeerrApiKey = "audit-key",
            SeerrEnable4KRequests = true,
            SeerrShowAdvanced = true,
        };

    private sealed record Fixture(
        SeerrUserController Controller,
        FakePluginConfigProvider Provider,
        PluginConfiguration OriginalConfiguration,
        BlockingAuditSeerrClient Seerr,
        IReadOnlyList<User> Users);

    private sealed class BlockingAuditSeerrClient : ISeerrClient
    {
        private readonly TaskCompletionSource _firstResolutionStarted =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _releaseFirstResolution =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _resolutionCalls;

        public Task FirstResolutionStarted => _firstResolutionStarted.Task;

        public int ResolutionCalls => Volatile.Read(ref _resolutionCalls);

        public void ReleaseFirstResolution() => _releaseFirstResolution.TrySetResult();

        public async Task<SeerrUserResolution> ResolveSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true,
            CancellationToken cancellationToken = default)
        {
            var call = Interlocked.Increment(ref _resolutionCalls);
            if (call == 1)
            {
                _firstResolutionStarted.TrySetResult();
                await _releaseFirstResolution.Task.WaitAsync(cancellationToken);
            }

            return SeerrUserResolution.Found(new SeerrUser
            {
                Id = 100 + call,
                JellyfinUserId = jellyfinUserId,
                Permissions = SeerrPermission.ADMIN,
                SourceUrl = "http://seerr:5055",
            });
        }

        public Task<SeerrUser?> GetSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true)
            => throw new NotImplementedException();

        public Task<string?> GetSeerrUserId(string jellyfinUserId, bool allowAutoImport = true)
            => throw new NotImplementedException();

        public bool IsImportBlocked(string jellyfinUserId, PluginConfiguration config) => false;

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
}
