using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
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
        public void LegacySinceOnlyRequest_GetsFullSnapshot_WhileProjectionAwareTimestampClientGetsDelta()
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

            // The immediately preceding projection-aware client still carries a
            // timestamp rather than a content cursor. Keep that bounded migration
            // shape until its next full load installs the revision protocol.
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

        [Fact]
        public void RemovalOnlyContentDelta_ReturnsAuthorizedTombstoneAndLaterRevision()
        {
            using var harness = new Harness();
            var itemId = Guid.NewGuid().ToString("N");
            harness.Cache.SeedUserAccessCacheForTest(harness.User.Id.ToString("N"), itemId);
            harness.Cache.SeedEntryForTest(itemId, new TagCacheEntry { Type = "Movie" });

            var full = Payload(harness.Controller.GetTagCache(harness.User.Id));
            var projectionEpoch = full.GetProperty("projectionEpoch").GetString();
            var projectionRevision = full.GetProperty("projectionRevision").GetInt64();
            var contentEpoch = full.GetProperty("contentEpoch").GetString();
            var contentRevision = full.GetProperty("contentRevision").GetInt64();
            Assert.True(full.GetProperty("items").TryGetProperty(itemId, out _));

            harness.Cache.PublishRemovalForTest(itemId);
            var delta = Payload(harness.Controller.GetTagCache(
                harness.User.Id,
                contentEpoch: contentEpoch,
                contentRevision: contentRevision,
                projectionEpoch: projectionEpoch,
                projectionRevision: projectionRevision));

            Assert.False(delta.GetProperty("reset").GetBoolean());
            Assert.Equal(contentRevision + 1, delta.GetProperty("contentRevision").GetInt64());
            Assert.Equal(new[] { itemId }, delta.GetProperty("removedIds").EnumerateArray().Select(static id => id.GetString()));
            Assert.Equal(0, delta.GetProperty("count").GetInt32());
            Assert.Empty(delta.GetProperty("items").EnumerateObject());
        }

        [Fact]
        public void ProjectionOnlyRow_EstablishesAuthorizationForLaterContentTombstone()
        {
            using var harness = new Harness();
            var movie = new StubMovie { Id = Guid.NewGuid() };
            var itemId = movie.Id.ToString("N");
            harness.Cache.SeedUserAccessCacheForTest(harness.User.Id.ToString("N"));

            var full = Payload(harness.Controller.GetTagCache(harness.User.Id));
            harness.Library.GetItemByIdUserHook = (id, user) =>
                id == movie.Id && ReferenceEquals(user, harness.User) ? movie : null;
            harness.Cache.SeedEntryForTest(itemId, new TagCacheEntry { Type = "Movie" });
            harness.UserData.RaiseUserDataSaved(
                harness.User.Id,
                movie,
                MediaBrowser.Model.Entities.UserDataSaveReason.TogglePlayed);

            var projected = Payload(harness.Controller.GetTagCache(
                harness.User.Id,
                projectionEpoch: full.GetProperty("projectionEpoch").GetString(),
                projectionRevision: full.GetProperty("projectionRevision").GetInt64(),
                projectionOnly: true));
            Assert.True(projected.GetProperty("items").TryGetProperty(itemId, out _));

            harness.Cache.PublishRemovalForTest(itemId);
            var removed = Payload(harness.Controller.GetTagCache(
                harness.User.Id,
                contentEpoch: full.GetProperty("contentEpoch").GetString(),
                contentRevision: full.GetProperty("contentRevision").GetInt64(),
                projectionEpoch: projected.GetProperty("projectionEpoch").GetString(),
                projectionRevision: projected.GetProperty("projectionRevision").GetInt64()));

            Assert.Equal(
                new[] { itemId },
                removed.GetProperty("removedIds").EnumerateArray().Select(static id => id.GetString()));
        }

        [Fact]
        public void PolicyChangeObservedBeforePublication_ReturnsFailClosedCurrentGenerationReset()
        {
            using var harness = new Harness();
            var itemId = Guid.NewGuid().ToString("N");
            harness.Cache.SeedUserAccessCacheForTest(harness.User.Id.ToString("N"), itemId);
            harness.Cache.SeedEntryForTest(itemId, new TagCacheEntry { Type = "Movie" });
            var oldEpoch = harness.Cache.GetCurrentContentControl(harness.User).Epoch;

            harness.Cache.OnAfterUserCacheSnapshotForTest = () =>
            {
                harness.Cache.OnAfterUserCacheSnapshotForTest = null;
                var updated = new User(
                    harness.User.Username,
                    harness.User.AuthenticationProviderId,
                    harness.User.PasswordResetProviderId)
                {
                    Id = harness.User.Id,
                };
                updated.OnSavingChanges();
                harness.Users.ReplaceUser(updated);
            };

            var payload = Payload(harness.Controller.GetTagCache(harness.User.Id));

            Assert.True(payload.GetProperty("contentReset").GetBoolean());
            Assert.True(payload.GetProperty("reset").GetBoolean());
            Assert.Equal(0, payload.GetProperty("count").GetInt32());
            Assert.Empty(payload.GetProperty("items").EnumerateObject());
            Assert.NotEqual(oldEpoch, payload.GetProperty("contentEpoch").GetString());
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
                Users = new StubUserManager(User);
                Library = new CountingLibraryManager();
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
                    Users,
                    NullLogger<SpoilerIdentityService>.Instance);
                var identity = new RequestIdentityService(
                    new CountingSessionManager(),
                    Users,
                    markers,
                    NullLogger<RequestIdentityService>.Instance);
                var resolver = new SpoilerUserResolver(
                    userConfig,
                    Library,
                    NullLogger<SpoilerUserResolver>.Instance,
                    identity);

                Cache = new TagCacheService(
                    Library,
                    appPaths,
                    NullLogger<TagCacheService>.Instance);
                _projection = new TagCacheProjectionRevisionService(
                    UserData,
                    NullLogger<TagCacheProjectionRevisionService>.Instance);
                Projection = _projection;
                Controller = new TagCacheController(
                    new RecordingHttpClientFactory(new HttpClientHandler()),
                    NullLogger<TagCacheController>.Instance,
                    Users,
                    new SeerrCache(configProvider),
                    configProvider,
                    Cache,
                    Library,
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

            public StubUserManager Users { get; }

            public TagCacheService Cache { get; }

            public CountingLibraryManager Library { get; }

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
