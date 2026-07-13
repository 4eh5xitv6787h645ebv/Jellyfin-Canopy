using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    public sealed class TagCacheProjectionControllerTests
    {
        [Fact]
        public void FullSnapshot_ContentCursorIsCapturedBeforeCacheSelection()
        {
            using var harness = new Harness();
            var oldId = Guid.NewGuid().ToString("N");
            var newId = Guid.NewGuid().ToString("N");
            harness.Cache.SeedUserAccessCacheForTest(harness.User.Id.ToString("N"), oldId, newId);
            harness.Cache.SwapCacheAndCursorForTest(
                new Dictionary<string, TagCacheEntry>
                {
                    [oldId] = new TagCacheEntry { Type = "Movie", LastUpdated = 90 }
                },
                version: 7,
                lastModified: 100);

            // Reproduce the reconcile boundary exactly: GetCacheForUser already
            // captured the old dictionary, then the live cache and its cursor move.
            harness.Cache.OnAfterUserCacheSnapshotForTest = () =>
            {
                harness.Cache.OnAfterUserCacheSnapshotForTest = null;
                harness.Cache.SwapCacheAndCursorForTest(
                    new Dictionary<string, TagCacheEntry>
                    {
                        [newId] = new TagCacheEntry { Type = "Movie", LastUpdated = 200 }
                    },
                    version: 8,
                    lastModified: 200);
            };

            var payload = Payload(harness.Controller.GetTagCache(harness.User.Id));

            Assert.Equal(7, payload.GetProperty("version").GetInt64());
            Assert.Equal(100, payload.GetProperty("timestamp").GetInt64());
            Assert.True(payload.GetProperty("items").TryGetProperty(oldId, out _));
            Assert.False(payload.GetProperty("items").TryGetProperty(newId, out _));
            Assert.Equal(8, harness.Cache.Version);
            Assert.Equal(200, harness.Cache.LastModified);
        }

        [Fact]
        public void LegacySinceOnlyRequest_GetsFullPersonalizedSnapshot_WhileCursorClientGetsDelta()
        {
            using var harness = new Harness();
            var itemId = Guid.NewGuid().ToString("N");
            harness.Cache.SeedUserAccessCacheForTest(harness.User.Id.ToString("N"), itemId);
            harness.Cache.SwapCacheAndCursorForTest(
                new Dictionary<string, TagCacheEntry>
                {
                    [itemId] = new TagCacheEntry { Type = "Movie", LastUpdated = 10 }
                },
                version: 3,
                lastModified: 100);

            // An old bundled client sends only ?since=. Since it cannot identify
            // its watched-state revision, the safe compatibility response is full.
            var legacy = Payload(harness.Controller.GetTagCache(harness.User.Id, since: 50));
            Assert.False(legacy.GetProperty("projectionReset").GetBoolean());
            Assert.Equal(1, legacy.GetProperty("count").GetInt32());
            Assert.True(legacy.GetProperty("items").TryGetProperty(itemId, out _));

            // A new client carrying both cursor halves keeps the real content delta;
            // the old entry is correctly excluded by ?since=50.
            var current = harness.Projection.GetDelta(
                harness.User.Id,
                clientEpoch: null,
                clientRevision: null,
                requireCursor: false);
            var modern = Payload(harness.Controller.GetTagCache(
                harness.User.Id,
                since: 50,
                projectionEpoch: current.Epoch,
                projectionRevision: current.Revision));
            Assert.False(modern.GetProperty("projectionReset").GetBoolean());
            Assert.Equal(0, modern.GetProperty("count").GetInt32());
        }

        [Fact]
        public void ProjectionOnlyWithoutCursor_ResetsWithoutSelectingSharedCache()
        {
            using var harness = new Harness();
            var selections = 0;
            harness.Cache.OnAfterUserCacheSnapshotForTest = () => selections++;

            var payload = Payload(harness.Controller.GetTagCache(
                harness.User.Id,
                projectionOnly: true));

            Assert.True(payload.GetProperty("projectionReset").GetBoolean());
            Assert.True(payload.GetProperty("reset").GetBoolean());
            Assert.Equal(0, payload.GetProperty("count").GetInt32());
            Assert.Equal(0, selections);
        }

        [Fact]
        public void EmptyRouteUserId_UsesAuthorizedEffectiveUserForProjectionIdentity()
        {
            using var harness = new Harness();
            harness.Cache.SeedUserAccessCacheForTest(harness.User.Id.ToString("N"));
            harness.UserData.RaiseUserDataSaved(
                harness.User.Id,
                new StubMovie { Id = Guid.NewGuid() },
                MediaBrowser.Model.Entities.UserDataSaveReason.TogglePlayed);

            // UserHelper deliberately treats Guid.Empty as "the authenticated user".
            // Every downstream personalized operation must therefore use User.Id too.
            var payload = Payload(harness.Controller.GetTagCache(Guid.Empty));

            Assert.Equal(harness.User.Id.ToString("N"), payload.GetProperty("projectionUserId").GetString());
            Assert.Equal(1, payload.GetProperty("projectionRevision").GetInt64());
        }

        private static JsonElement Payload(IActionResult result)
        {
            var ok = Assert.IsType<OkObjectResult>(result);
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(ok.Value));
            return json.RootElement.Clone();
        }

        private sealed class Harness : IDisposable
        {
            private readonly string _tempDir;
            private readonly TagCacheProjectionRevisionService _projection;

            public Harness()
            {
                _tempDir = Path.Combine(
                    Path.GetTempPath(),
                    "jc-tagcache-projection-controller-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(_tempDir);

                User = new User("projection-controller", "Provider", "PasswordProvider");
                var users = new StubUserManager(User);
                var library = new CountingLibraryManager();
                UserData = new StubUserDataManager();
                var appPaths = new StubAppPaths(_tempDir);
                var config = new PluginConfiguration
                {
                    TagCacheServerMode = true,
                    SpoilerBlurEnabled = false
                };
                var configProvider = new FakePluginConfigProvider(config);
                var userConfig = new UserConfigurationManager(
                    appPaths,
                    NullLogger<UserConfigurationManager>.Instance);
                var markers = new SpoilerIdentityService(
                    users,
                    NullLogger<SpoilerIdentityService>.Instance);
                var identity = new RequestIdentityService(
                    new CountingSessionManager(),
                    users,
                    markers,
                    NullLogger<RequestIdentityService>.Instance);
                var resolver = new SpoilerUserResolver(
                    userConfig,
                    library,
                    NullLogger<SpoilerUserResolver>.Instance,
                    identity);

                Cache = new TagCacheService(
                    library,
                    appPaths,
                    NullLogger<TagCacheService>.Instance);
                _projection = new TagCacheProjectionRevisionService(
                    UserData,
                    NullLogger<TagCacheProjectionRevisionService>.Instance);
                Projection = _projection;
                Controller = new TagCacheController(
                    new RecordingHttpClientFactory(new HttpClientHandler()),
                    NullLogger<TagCacheController>.Instance,
                    users,
                    new SeerrCache(configProvider),
                    configProvider,
                    Cache,
                    library,
                    UserData,
                    resolver,
                    userConfig,
                    _projection);
                Controller.ControllerContext = new ControllerContext
                {
                    HttpContext = new DefaultHttpContext
                    {
                        User = new ClaimsPrincipal(new ClaimsIdentity(
                            new[] { new Claim("Jellyfin-UserId", User.Id.ToString()) },
                            "TestAuth"))
                    }
                };
            }

            public User User { get; }

            public TagCacheService Cache { get; }

            public TagCacheProjectionRevisionService Projection { get; }

            public StubUserDataManager UserData { get; }

            public TagCacheController Controller { get; }

            public void Dispose()
            {
                _projection.Dispose();
                Cache.Dispose();
                try
                {
                    Directory.Delete(_tempDir, recursive: true);
                }
                catch
                {
                    // Best-effort test cleanup.
                }
            }
        }
    }
}
