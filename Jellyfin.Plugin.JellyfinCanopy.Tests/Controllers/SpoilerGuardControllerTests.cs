using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.EventHandlers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    /// <summary>
    /// HTTP-surface coverage for the Spoiler Guard controller + its shared pending
    /// service: the display-name sanitizer, the per-dict entry cap (413) and pending
    /// cap (429) decisions, promoter-gate reconciliation on the full-state save,
    /// promote-vs-pending outcomes with a stubbed library lookup, and the
    /// health-endpoint's non-admin own-events-only visibility.
    /// </summary>
    public class SpoilerGuardControllerTests
    {
        private const string SpoilerFile = "spoilerblur.json";

        private sealed class Harness : IDisposable
        {
            public required string Dir { get; init; }
            public required UserConfigurationManager Mgr { get; init; }
            public required CountingLibraryManager Lib { get; init; }
            public required SpoilerPendingService Pending { get; init; }
            public required SpoilerSeerrPendingPromoter Promoter { get; init; }
            public required SpoilerGuardController Controller { get; init; }
            public required StubUserDataManager UserData { get; init; }
            public required User User { get; init; }

            public void Dispose()
            {
                Promoter.StopAsync(CancellationToken.None).GetAwaiter().GetResult();
                try { Directory.Delete(Dir, recursive: true); } catch { /* best-effort */ }
            }
        }

        private static Harness Build(
            PluginConfiguration? cfg = null,
            bool includeUserInManager = true,
            ISpoilerGuardItemActionOwner? itemActionOwner = null)
        {
            var dir = Path.Combine(Path.GetTempPath(), "jc-sg-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);

            var mgr = new UserConfigurationManager(new StubAppPaths(dir), NullLogger<UserConfigurationManager>.Instance);
            var lib = new CountingLibraryManager();
            var user = new User("sg", "Prov", "PwProv");
            var userManager = includeUserInManager ? new StubUserManager(user) : new StubUserManager();
            var provider = new FakePluginConfigProvider(cfg);
            var pending = new SpoilerPendingService(mgr, lib, userManager, NullLogger<SpoilerPendingService>.Instance);
            var promoter = new SpoilerSeerrPendingPromoter(
                lib,
                userManager,
                mgr,
                provider,
                pending,
                NullLogger<SpoilerSeerrPendingPromoter>.Instance);
            promoter.StartAsync(CancellationToken.None).GetAwaiter().GetResult();
            promoter.ReplayCompletionForTest.GetAwaiter().GetResult();
            var sessions = new CountingSessionManager();
            var requestIdentity = new RequestIdentityService(
                sessions,
                userManager,
                new SpoilerIdentityService(userManager, NullLogger<SpoilerIdentityService>.Instance),
                NullLogger<RequestIdentityService>.Instance);
            var resolver = new SpoilerUserResolver(mgr, lib, NullLogger<SpoilerUserResolver>.Instance, requestIdentity);
            var userData = new StubUserDataManager();

            var controller = new SpoilerGuardController(
                new RecordingHttpClientFactory(new HttpClientHandler()),
                NullLogger<SpoilerGuardController>.Instance,
                userManager,
                new SeerrCache(provider),
                provider,
                mgr,
                lib,
                itemActionOwner ?? new SpoilerGuardItemActionOwner(mgr),
                pending,
                resolver,
                userData);

            var identity = new ClaimsIdentity(new[] { new Claim("Jellyfin-UserId", user.Id.ToString()) }, "TestAuth");
            controller.ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(identity) },
            };

            return new Harness { Dir = dir, Mgr = mgr, Lib = lib, Pending = pending, Promoter = promoter, Controller = controller, UserData = userData, User = user };
        }

        // ─── Display-name sanitizer ───────────────────────────────────────────────

        [Fact]
        public void Sanitize_NullOrEmpty_ReturnsEmpty()
        {
            Assert.Equal(string.Empty, SpoilerPendingService.SanitizePendingDisplayName(null));
            Assert.Equal(string.Empty, SpoilerPendingService.SanitizePendingDisplayName(string.Empty));
        }

        [Fact]
        public void Sanitize_StripsControlAndFormatChars_IncludingRtlOverride()
        {
            // U+0000 (Control) is removed; U+202E RIGHT-TO-LEFT OVERRIDE (Format) is removed.
            Assert.Equal("ab", SpoilerPendingService.SanitizePendingDisplayName("a\u0000b"));
            Assert.Equal("evil.exe", SpoilerPendingService.SanitizePendingDisplayName("\u202Eevil.exe"));
        }

        [Fact]
        public void Sanitize_NewlinesAndTabsBecomeSpaces()
        {
            Assert.Equal("a b c", SpoilerPendingService.SanitizePendingDisplayName("a\nb\tc"));
        }

        [Fact]
        public void Sanitize_CapsAt200_SurrogateSafe()
        {
            // 250 plain chars → capped to 200.
            Assert.Equal(200, SpoilerPendingService.SanitizePendingDisplayName(new string('a', 250)).Length);

            // 199 plain chars + a surrogate pair straddling the 200th slot: the cap
            // must back off to 199 rather than emit a lone high surrogate.
            var raw = new string('a', 199) + "😀"; // 199 + emoji (2 UTF-16 units)
            var result = SpoilerPendingService.SanitizePendingDisplayName(raw);
            Assert.Equal(new string('a', 199), result);
        }

        // ─── Full-state save: per-dict cap (413) + gate reconciliation ────────────

        [Fact]
        public void SaveUserSpoilerBlur_OverCap_Returns413()
        {
            using var h = Build();
            var payload = new UserSpoilerBlur();
            for (var i = 0; i < 1001; i++)
            {
                var k = Guid.NewGuid().ToString("N");
                payload.Series[k] = new SpoilerBlurSeriesEntry { SeriesId = k };
            }

            var result = h.Controller.SaveUserSpoilerBlur(h.User.Id.ToString(), payload);

            var obj = Assert.IsType<ObjectResult>(result);
            Assert.Equal(413, obj.StatusCode);
        }

        [Fact]
        public void SaveUserSpoilerBlur_ReconcilesPromoterGate_RegisterThenUnregister()
        {
            using var h = Build();
            var userId = h.User.Id;
            const string keyA = "tv:101";
            const string keyB = "movie:202";

            // First save registers both pending keys in the promoter's instance gate.
            var first = new UserSpoilerBlur();
            first.PendingTmdb[keyA] = new SpoilerBlurPendingEntry { MediaType = "tv", TmdbId = "101" };
            first.PendingTmdb[keyB] = new SpoilerBlurPendingEntry { MediaType = "movie", TmdbId = "202" };
            var r1 = h.Controller.SaveUserSpoilerBlur(userId.ToString(), first);
            Assert.IsType<OkObjectResult>(r1);
            Assert.True(h.Promoter.IsKeyRegisteredForTest(keyA));
            Assert.True(h.Promoter.IsKeyRegisteredForTest(keyB));
            Assert.Equal(
                1,
                h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                    userId.ToString("N"),
                    SpoilerFile).OverridesRevision);

            // Second save drops keyB → it is unregistered; keyA survives.
            var second = new UserSpoilerBlur { OverridesRevision = 1 };
            second.PendingTmdb[keyA] = new SpoilerBlurPendingEntry { MediaType = "tv", TmdbId = "101" };
            var r2 = h.Controller.SaveUserSpoilerBlur(userId.ToString(), second);
            Assert.IsType<OkObjectResult>(r2);
            Assert.True(h.Promoter.IsKeyRegisteredForTest(keyA));
            Assert.False(h.Promoter.IsKeyRegisteredForTest(keyB));
            Assert.Equal(
                2,
                h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                    userId.ToString("N"),
                    SpoilerFile).OverridesRevision);

            var stale = new UserSpoilerBlur { OverridesRevision = 1 };
            stale.PendingTmdb[keyA] = new SpoilerBlurPendingEntry
            {
                MediaType = "tv",
                TmdbId = "101"
            };
            Assert.IsType<ConflictObjectResult>(
                h.Controller.SaveUserSpoilerBlur(userId.ToString(), stale));

            // Cleanup keeps the harness state explicit before disposal.
            h.Promoter.UnregisterPending(keyA, userId);
        }

        [Fact]
        public void SaveUserSpoilerBlur_MalformedOverrideEntryIsRejectedWithoutWrite()
        {
            using var h = Build();
            var userKey = h.User.Id.ToString("N");
            h.Mgr.SaveUserConfiguration(userKey, SpoilerFile, new UserSpoilerBlur
            {
                OverridesRevision = 3,
                Prefs = new SpoilerBlurUserPrefs { Revision = 2, HideTags = true }
            });
            var path = Path.Combine(
                h.Dir,
                "configurations",
                "Jellyfin.Plugin.JellyfinCanopy",
                userKey,
                SpoilerFile);
            var before = File.ReadAllBytes(path);
            var key = Guid.NewGuid().ToString("N");
            var payload = new UserSpoilerBlur
            {
                OverridesRevision = 3,
                Prefs = new SpoilerBlurUserPrefs { Revision = 2, HideTags = false },
                Series = new Dictionary<string, SpoilerBlurSeriesEntry>
                {
                    [key] = new()
                    {
                        SeriesId = Guid.NewGuid().ToString("N"),
                        SeriesName = "Mismatched"
                    }
                }
            };

            Assert.IsType<BadRequestObjectResult>(
                h.Controller.SaveUserSpoilerBlur(h.User.Id.ToString(), payload));
            Assert.Equal(before, File.ReadAllBytes(path));
            var stored = h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                userKey,
                SpoilerFile);
            Assert.Equal(3, stored.OverridesRevision);
            Assert.True(stored.Prefs.HideTags);
        }

        [Fact]
        public void LegacyFullSave_CrossUserAuditNamesActorAndTargetWithoutContentOrMedia()
        {
            const string mediaSecret = "SPOILER-MEDIA-CONTENT-MUST-NOT-APPEAR";
            using var h = Build();
            var admin = new User("spoiler-admin", "Provider", "PasswordProvider");
            admin.SetPermission(
                Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator,
                true);
            var userManager = new StubUserManager(admin, h.User);
            var provider = new FakePluginConfigProvider(new PluginConfiguration
            {
                SpoilerBlurEnabled = true
            });
            var pending = new SpoilerPendingService(
                h.Mgr,
                h.Lib,
                userManager,
                NullLogger<SpoilerPendingService>.Instance);
            var requestIdentity = new RequestIdentityService(
                new CountingSessionManager(),
                userManager,
                new SpoilerIdentityService(
                    userManager,
                    NullLogger<SpoilerIdentityService>.Instance),
                NullLogger<RequestIdentityService>.Instance);
            var logger = new CollectingLogger<SpoilerGuardController>();
            var controller = new SpoilerGuardController(
                new RecordingHttpClientFactory(new HttpClientHandler()),
                logger,
                userManager,
                new SeerrCache(provider),
                provider,
                h.Mgr,
                h.Lib,
                new SpoilerGuardItemActionOwner(h.Mgr),
                pending,
                new SpoilerUserResolver(
                    h.Mgr,
                    h.Lib,
                    NullLogger<SpoilerUserResolver>.Instance,
                    requestIdentity),
                new StubUserDataManager());
            controller.ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(
                        new[]
                        {
                            new Claim("Jellyfin-UserId", admin.Id.ToString()),
                            new Claim(ClaimTypes.Role, "Administrator")
                        },
                        "TestAuth"))
                }
            };
            var seriesId = CapacityGuid(4_901).ToString("N");
            var userKey = h.User.Id.ToString("N");
            h.Mgr.SaveUserConfiguration(userKey, SpoilerFile, new UserSpoilerBlur
            {
                OverridesRevision = 6,
                Prefs = new SpoilerBlurUserPrefs
                {
                    Revision = 4,
                    HideTags = false
                }
            });

            Assert.IsType<OkObjectResult>(
                controller.SaveUserSpoilerBlur(
                    userKey,
                    new UserSpoilerBlur
                    {
                        OverridesRevision = 6,
                        Prefs = new SpoilerBlurUserPrefs
                        {
                            Revision = 4,
                            HideTags = true
                        },
                        Series = new Dictionary<string, SpoilerBlurSeriesEntry>
                        {
                            [seriesId] = new()
                            {
                                SeriesId = seriesId,
                                SeriesName = mediaSecret
                            }
                        }
                    }));

            var text = string.Join('\n', logger.Messages);
            Assert.Contains(
                $"Admin {admin.Username} ({admin.Id:N}) saved {SpoilerFile} for target " +
                $"{h.User.Username} ({userKey}) at revision " +
                "prefsRevision=5,overridesRevision=7.",
                text);
            Assert.DoesNotContain(mediaSecret, text, StringComparison.Ordinal);
            Assert.DoesNotContain("series=", text, StringComparison.Ordinal);
            Assert.DoesNotContain("hash", text, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void DirectSeriesMovieCollectionAndPendingWritersAdvanceOverrideRevisionOnce()
        {
            using var h = Build(new PluginConfiguration { SpoilerBlurEnabled = true });
            var seriesId = Guid.NewGuid();
            var movieId = Guid.NewGuid();
            var collectionId = Guid.NewGuid();
            h.Lib.GetItemByIdUserHook = (id, _) =>
                id == seriesId ? new Series { Id = seriesId, Name = "Series" }
                : id == movieId ? new Movie { Id = movieId, Name = "Movie" }
                : id == collectionId ? new BoxSet { Id = collectionId, Name = "Collection" }
                : null;
            h.Lib.GetItemListHook = _ => Array.Empty<BaseItem>();
            var userKey = h.User.Id.ToString("N");

            Assert.IsType<OkObjectResult>(
                h.Controller.EnableSpoilerBlurForSeries(seriesId.ToString()));
            Assert.Equal(1, Revision());
            Assert.IsType<OkObjectResult>(
                h.Controller.EnableSpoilerBlurForSeries(seriesId.ToString()));
            Assert.Equal(1, Revision());

            Assert.IsType<OkObjectResult>(
                h.Controller.EnableSpoilerBlurForMovie(movieId.ToString()));
            Assert.Equal(2, Revision());
            Assert.IsType<OkObjectResult>(
                h.Controller.EnableSpoilerBlurForCollection(collectionId.ToString()));
            Assert.Equal(3, Revision());
            Assert.IsType<OkObjectResult>(
                h.Controller.EnableSpoilerBlurPending("tv", "9876", "Pending"));
            Assert.Equal(4, Revision());

            Assert.IsType<OkObjectResult>(
                h.Controller.DisableSpoilerBlurForSeries(seriesId.ToString()));
            Assert.Equal(5, Revision());
            Assert.IsType<OkObjectResult>(
                h.Controller.DisableSpoilerBlurForMovie(movieId.ToString()));
            Assert.Equal(6, Revision());
            Assert.IsType<OkObjectResult>(
                h.Controller.DisableSpoilerBlurForCollection(collectionId.ToString()));
            Assert.Equal(7, Revision());
            Assert.IsType<OkObjectResult>(
                h.Controller.DisableSpoilerBlurPending("tv", "9876"));
            Assert.Equal(8, Revision());

            long Revision()
                => h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                    userKey,
                    SpoilerFile).OverridesRevision;

            h.Promoter.UnregisterPending("tv:9876", h.User.Id);
        }

        [Fact]
        public void DirectLibraryNameWriters_BoundRenamesAndFallbacksForAdminRead()
        {
            using var h = Build(new PluginConfiguration { SpoilerBlurEnabled = true });
            var seriesId = Guid.NewGuid();
            var movieId = Guid.NewGuid();
            var collectionId = Guid.NewGuid();
            var longName = new string('n', 700);
            h.Lib.GetItemByIdUserHook = (id, scopedUser) =>
            {
                Assert.Same(h.User, scopedUser);
                return id == seriesId ? new Series { Id = id, Name = longName }
                    : id == movieId ? new Movie { Id = id, Name = longName }
                    : id == collectionId ? new BoxSet { Id = id, Name = longName }
                    : null;
            };
            var userKey = h.User.Id.ToString("N");
            var seriesKey = seriesId.ToString("N");
            h.Mgr.SaveUserConfiguration(userKey, SpoilerFile, new UserSpoilerBlur
            {
                OverridesRevision = 4,
                Series = new Dictionary<string, SpoilerBlurSeriesEntry>
                {
                    [seriesKey] = new()
                    {
                        SeriesId = seriesKey,
                        SeriesName = "Before rename"
                    }
                }
            });

            Assert.IsType<OkObjectResult>(
                h.Controller.EnableSpoilerBlurForSeries(seriesId.ToString()));
            Assert.IsType<OkObjectResult>(
                h.Controller.EnableSpoilerBlurForMovie(movieId.ToString()));
            Assert.IsType<OkObjectResult>(
                h.Controller.EnableSpoilerBlurForCollection(collectionId.ToString()));

            var stored = h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                userKey,
                SpoilerFile);
            Assert.Equal(512, stored.Series[seriesKey].SeriesName.Length);
            Assert.Equal(
                512,
                stored.Movies[movieId.ToString("N")].MovieName.Length);
            Assert.Equal(
                512,
                stored.Collections[collectionId.ToString("N")]
                    .CollectionName.Length);
            Assert.IsType<OkObjectResult>(
                h.Controller.GetTargetSpoilerGuardOverrides(userKey));
        }

        [Fact]
        public void DirectWriter_InvalidCoResidentPrefsFailClosedWithoutDiskMutation()
        {
            using var h = Build(new PluginConfiguration { SpoilerBlurEnabled = true });
            var seriesId = Guid.NewGuid();
            h.Lib.GetItemByIdUserHook = (id, _) =>
                id == seriesId
                    ? new Series { Id = id, Name = "Must not persist" }
                    : null;
            var userKey = h.User.Id.ToString("N");
            h.Mgr.SaveUserConfiguration(userKey, SpoilerFile, new UserSpoilerBlur
            {
                Prefs = new SpoilerBlurUserPrefs { Revision = -1 }
            });
            var before = File.ReadAllBytes(SpoilerPath(h));

            var result = Assert.IsType<ObjectResult>(
                h.Controller.EnableSpoilerBlurForSeries(seriesId.ToString()));

            Assert.Equal(StatusCodes.Status503ServiceUnavailable, result.StatusCode);
            Assert.Equal(before, File.ReadAllBytes(SpoilerPath(h)));
        }

        [Fact]
        public void LegacyMetadata_GetFirstIsDetachedThenOverrideMutationRepairsOnce()
        {
            using var h = Build(new PluginConfiguration { SpoilerBlurEnabled = true });
            var seriesId = Guid.NewGuid();
            var movieId = Guid.NewGuid();
            var collectionId = Guid.NewGuid();
            var seriesKey = seriesId.ToString("N");
            var movieKey = movieId.ToString("N");
            var collectionKey = collectionId.ToString("N");
            var userKey = h.User.Id.ToString("N");
            h.Mgr.SaveUserConfiguration(userKey, SpoilerFile, new UserSpoilerBlur
            {
                OverridesRevision = 7,
                Prefs = new SpoilerBlurUserPrefs { Revision = 3 },
                Series = new Dictionary<string, SpoilerBlurSeriesEntry>
                {
                    [seriesKey] = new()
                    {
                        SeriesId = seriesKey,
                        SeriesName = new string('s', 700)
                    }
                },
                Movies = new Dictionary<string, SpoilerBlurMovieEntry>
                {
                    [movieKey] = new()
                    {
                        MovieId = movieKey,
                        MovieName = new string('m', 700)
                    }
                },
                Collections =
                    new Dictionary<string, SpoilerBlurCollectionEntry>
                    {
                        [collectionKey] = new()
                        {
                            CollectionId = collectionKey,
                            CollectionName = new string('c', 700)
                        }
                    }
            });
            var beforeGet = File.ReadAllBytes(SpoilerPath(h));

            var self = Assert.IsType<OkObjectResult>(
                h.Controller.GetUserSpoilerBlur(userKey));
            var selfView = Assert.IsType<UserSpoilerBlur>(self.Value);
            Assert.Equal(512, selfView.Series[seriesKey].SeriesName.Length);
            Assert.Equal(512, selfView.Movies[movieKey].MovieName.Length);
            Assert.Equal(
                512,
                selfView.Collections[collectionKey].CollectionName.Length);
            Assert.IsType<OkObjectResult>(
                h.Controller.GetTargetSpoilerGuardPreferences(userKey));
            Assert.IsType<OkObjectResult>(
                h.Controller.GetTargetSpoilerGuardOverrides(userKey));
            var selfPrefs = Assert.IsType<OkObjectResult>(
                h.Controller.GetSpoilerBlurUserPrefs());
            Assert.Equal(
                3,
                Assert.IsType<SpoilerBlurUserPrefs>(
                    selfPrefs.Value).Revision);
            Assert.Equal(beforeGet, File.ReadAllBytes(SpoilerPath(h)));
            var stillLegacy =
                h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                    userKey,
                    SpoilerFile);
            Assert.Equal(7, stillLegacy.OverridesRevision);
            Assert.Equal(700, stillLegacy.Series[seriesKey].SeriesName.Length);

            h.Controller.Request.Headers.IfMatch = "\"3\"";
            var targetPrefs = Assert.IsType<OkObjectResult>(
                h.Controller.SaveTargetSpoilerGuardPreferences(
                    userKey,
                    new SpoilerBlurUserPrefs
                    {
                        Revision = 3,
                        HideTags = false
                    }));
            var afterTargetPrefs =
                h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                    userKey,
                    SpoilerFile);
            Assert.Equal(4, afterTargetPrefs.Prefs.Revision);
            Assert.False(afterTargetPrefs.Prefs.HideTags);
            Assert.Equal(7, afterTargetPrefs.OverridesRevision);
            Assert.Equal(
                700,
                afterTargetPrefs.Series[seriesKey].SeriesName.Length);

            var prefsOnly = Assert.IsType<OkObjectResult>(
                h.Controller.SetSpoilerBlurUserPrefs(
                    new SpoilerBlurUserPrefs
                    {
                        Revision = 4,
                        HideTags = false,
                        HideCast = true
                    }));
            var afterSelfPrefs =
                h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                    userKey,
                    SpoilerFile);
            Assert.Equal(5, afterSelfPrefs.Prefs.Revision);
            Assert.True(afterSelfPrefs.Prefs.HideCast);
            Assert.Equal(7, afterSelfPrefs.OverridesRevision);
            Assert.Equal(
                700,
                afterSelfPrefs.Series[seriesKey].SeriesName.Length);
            Assert.Equal(
                700,
                afterSelfPrefs.Movies[movieKey].MovieName.Length);
            Assert.Equal(
                700,
                afterSelfPrefs.Collections[collectionKey].CollectionName.Length);

            Assert.IsType<OkObjectResult>(
                h.Controller.DisableSpoilerBlurForMovie(movieId.ToString()));
            var repaired =
                h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                    userKey,
                    SpoilerFile);
            Assert.Equal(8, repaired.OverridesRevision);
            Assert.DoesNotContain(movieKey, repaired.Movies.Keys);
            Assert.Equal(512, repaired.Series[seriesKey].SeriesName.Length);
            Assert.Equal(
                512,
                repaired.Collections[collectionKey].CollectionName.Length);
            Assert.Equal(5, repaired.Prefs.Revision);
            Assert.True(PersistedPayloadPolicy.Validate(repaired).IsValid);
        }

        [Fact]
        public async Task ConcurrentSeriesEnablesAt999CommitExactlyOneEntry()
        {
            using var h = Build(new PluginConfiguration { SpoilerBlurEnabled = true });
            var userKey = h.User.Id.ToString("N");
            var firstNewId = CapacityGuid(2_001);
            var secondNewId = CapacityGuid(2_002);
            h.Lib.GetItemByIdUserHook = (id, scopedUser) =>
            {
                Assert.Same(h.User, scopedUser);
                return id == firstNewId || id == secondNewId
                    ? new Series { Id = id, Name = $"Series {id:N}" }
                    : null;
            };
            h.Mgr.SaveUserConfiguration(userKey, SpoilerFile, new UserSpoilerBlur
            {
                OverridesRevision = 41,
                Series = BuildSeriesOverrides(
                    PersistedPayloadPolicy.MaximumSpoilerEntriesPerDictionary - 1)
            });

            var results = await Task.WhenAll(
                Task.Run(() => h.Controller.EnableSpoilerBlurForSeries(firstNewId.ToString())),
                Task.Run(() => h.Controller.EnableSpoilerBlurForSeries(secondNewId.ToString())));

            Assert.Single(results, static result => result is OkObjectResult);
            var rejected = Assert.Single(
                results,
                static result => result is ObjectResult { StatusCode: 429 });
            var error = JsonSerializer.SerializeToElement(
                Assert.IsType<ObjectResult>(rejected).Value);
            Assert.Equal(
                "spoiler_override_cap_exceeded",
                error.GetProperty("code").GetString());
            Assert.Equal("series", error.GetProperty("category").GetString());

            var stored = h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                userKey,
                SpoilerFile);
            Assert.Equal(
                PersistedPayloadPolicy.MaximumSpoilerEntriesPerDictionary,
                stored.Series.Count);
            Assert.Equal(42, stored.OverridesRevision);
            Assert.Equal(
                1,
                new[] { firstNewId, secondNewId }.Count(
                    id => stored.Series.ContainsKey(id.ToString("N"))));
        }

        [Fact]
        public void DirectWritersAtCapAllowExistingUpdateButRejectNewMovieAndCollection()
        {
            using var h = Build(new PluginConfiguration { SpoilerBlurEnabled = true });
            var userKey = h.User.Id.ToString("N");
            var existingSeriesId = CapacityGuid(1);
            var newMovieId = CapacityGuid(3_001);
            var newCollectionId = CapacityGuid(3_002);
            h.Lib.GetItemByIdUserHook = (id, scopedUser) =>
            {
                Assert.Same(h.User, scopedUser);
                return id == existingSeriesId
                    ? new Series { Id = id, Name = "Renamed at capacity" }
                    : id == newMovieId
                        ? new Movie { Id = id, Name = "Rejected movie" }
                        : id == newCollectionId
                            ? new BoxSet { Id = id, Name = "Rejected collection" }
                            : null;
            };
            h.Mgr.SaveUserConfiguration(userKey, SpoilerFile, new UserSpoilerBlur
            {
                OverridesRevision = 17,
                Series = BuildSeriesOverrides(
                    PersistedPayloadPolicy.MaximumSpoilerEntriesPerDictionary),
                Movies = BuildMovieOverrides(
                    PersistedPayloadPolicy.MaximumSpoilerEntriesPerDictionary),
                Collections = BuildCollectionOverrides(
                    PersistedPayloadPolicy.MaximumSpoilerEntriesPerDictionary)
            });

            Assert.IsType<OkObjectResult>(
                h.Controller.EnableSpoilerBlurForSeries(existingSeriesId.ToString()));
            var afterAllowedUpdate = File.ReadAllBytes(SpoilerPath(h));
            Assert.Equal(
                "Renamed at capacity",
                h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                    userKey,
                    SpoilerFile).Series[existingSeriesId.ToString("N")].SeriesName);

            var movie = Assert.IsType<ObjectResult>(
                h.Controller.EnableSpoilerBlurForMovie(newMovieId.ToString()));
            var collection = Assert.IsType<ObjectResult>(
                h.Controller.EnableSpoilerBlurForCollection(newCollectionId.ToString()));

            Assert.Equal(StatusCodes.Status429TooManyRequests, movie.StatusCode);
            Assert.Equal(StatusCodes.Status429TooManyRequests, collection.StatusCode);
            Assert.Equal("movies", JsonSerializer.SerializeToElement(movie.Value)
                .GetProperty("category").GetString());
            Assert.Equal("collections", JsonSerializer.SerializeToElement(collection.Value)
                .GetProperty("category").GetString());
            Assert.Equal(afterAllowedUpdate, File.ReadAllBytes(SpoilerPath(h)));
            var stored = h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                userKey,
                SpoilerFile);
            Assert.Equal(18, stored.OverridesRevision);
            Assert.Equal(1000, stored.Series.Count);
            Assert.Equal(1000, stored.Movies.Count);
            Assert.Equal(1000, stored.Collections.Count);
            Assert.DoesNotContain(newMovieId.ToString("N"), stored.Movies.Keys);
            Assert.DoesNotContain(newCollectionId.ToString("N"), stored.Collections.Keys);
        }

        [Fact]
        public async Task DelayedOverrideRemovalGateReconcileCannotUnregisterNewerReAdd()
        {
            using var h = Build();
            const string pendingKey = "tv:4242";
            var userKey = h.User.Id.ToString("N");
            h.Mgr.SaveUserConfiguration(userKey, SpoilerFile, new UserSpoilerBlur
            {
                OverridesRevision = 1,
                PendingTmdb = new Dictionary<string, SpoilerBlurPendingEntry>
                {
                    [pendingKey] = new()
                    {
                        MediaType = "tv",
                        TmdbId = "4242",
                        DisplayName = "Original"
                    }
                }
            });
            h.Promoter.RegisterPending(pendingKey, h.User.Id);
            h.Controller.Request.Headers.IfMatch = "\"1\"";
            using var removalCommitted = new ManualResetEventSlim();
            using var allowDelayedReconcile = new ManualResetEventSlim();
            var firstReconcile = 0;
            h.Pending.BeforeAuthoritativeGateReconcileForTests =
                (observedUser, keys) =>
                {
                    if (observedUser == userKey
                        && keys.Contains(pendingKey, StringComparer.OrdinalIgnoreCase)
                        && Interlocked.CompareExchange(ref firstReconcile, 1, 0) == 0)
                    {
                        removalCommitted.Set();
                        if (!allowDelayedReconcile.Wait(TimeSpan.FromSeconds(10)))
                        {
                            throw new TimeoutException("Timed out releasing delayed gate reconciliation.");
                        }
                    }
                };

            Task<IActionResult>? removal = null;
            try
            {
                removal = Task.Run(() =>
                    h.Controller.SaveTargetSpoilerGuardOverrides(
                        userKey,
                        new SpoilerGuardOverrides { Revision = 1 }));
                Assert.True(removalCommitted.Wait(TimeSpan.FromSeconds(10)));

                h.Mgr.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey,
                    SpoilerFile,
                    state =>
                    {
                        state.PendingTmdb[pendingKey] = new SpoilerBlurPendingEntry
                        {
                            MediaType = "tv",
                            TmdbId = "4242",
                            DisplayName = "Newer re-add"
                        };
                        SpoilerGuardOverridesRevision.Advance(state);
                        return 1;
                    });
                h.Pending.ReconcilePendingKeys(
                    userKey,
                    new[] { pendingKey });
                Assert.True(h.Promoter.IsKeyRegisteredForTest(pendingKey));

                allowDelayedReconcile.Set();
                Assert.IsType<OkObjectResult>(await removal);

                var stored = h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                    userKey,
                    SpoilerFile);
                Assert.Equal(3, stored.OverridesRevision);
                Assert.Equal(
                    "Newer re-add",
                    stored.PendingTmdb[pendingKey].DisplayName);
                Assert.True(h.Promoter.IsKeyRegisteredForTest(pendingKey));
            }
            finally
            {
                allowDelayedReconcile.Set();
                if (removal != null)
                {
                    try { await removal; } catch { /* asserted on the primary path */ }
                }
                h.Pending.BeforeAuthoritativeGateReconcileForTests = null;
                h.Promoter.UnregisterPending(pendingKey, h.User.Id);
            }
        }

        [Fact]
        public async Task FirstPlayEventWriterAdvancesOverrideRevisionOnlyOnInsert()
        {
            using var h = Build();
            var seriesId = Guid.NewGuid();
            var longName = new string('e', 700);
            h.Lib.GetItemByIdNonGenericHook = id =>
                id == seriesId
                    ? new Series { Id = seriesId, Name = longName }
                    : null;
            h.Lib.GetItemListHook = _ => Array.Empty<BaseItem>();
            var provider = new FakePluginConfigProvider(new PluginConfiguration
            {
                SpoilerBlurEnabled = true,
                SpoilerAutoEnableOnFirstPlay = true
            });
            var consumer = new SpoilerAutoEnableOnFirstPlayConsumer(
                h.Mgr,
                h.Lib,
                new StubUserManager(h.User),
                provider,
                NullLogger<SpoilerAutoEnableOnFirstPlayConsumer>.Instance);
            var args = new PlaybackStartEventArgs
            {
                Item = new Episode
                {
                    Id = Guid.NewGuid(),
                    SeriesId = seriesId,
                    IndexNumber = 1,
                    ParentIndexNumber = 1
                },
                Session = new SessionInfo(null!, NullLogger.Instance)
                {
                    UserId = h.User.Id
                }
            };

            await consumer.OnEvent(args);
            var first = h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                h.User.Id.ToString("N"),
                SpoilerFile);
            Assert.Equal(1, first.OverridesRevision);
            Assert.True(first.Series.ContainsKey(seriesId.ToString("N")));
            Assert.Equal(
                512,
                first.Series[seriesId.ToString("N")].SeriesName.Length);

            await consumer.OnEvent(args);
            var second = h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                h.User.Id.ToString("N"),
                SpoilerFile);
            Assert.Equal(1, second.OverridesRevision);
            Assert.Single(second.Series);
        }

        [Fact]
        public async Task FirstPlayEventAtSeriesCapIsAnExactNoOp()
        {
            using var h = Build();
            var newSeriesId = CapacityGuid(4_201);
            h.Lib.GetItemByIdNonGenericHook = id =>
                id == newSeriesId
                    ? new Series { Id = id, Name = "Must not be appended" }
                    : null;
            h.Lib.GetItemListHook = _ => Array.Empty<BaseItem>();
            var provider = new FakePluginConfigProvider(new PluginConfiguration
            {
                SpoilerBlurEnabled = true,
                SpoilerAutoEnableOnFirstPlay = true
            });
            var consumer = new SpoilerAutoEnableOnFirstPlayConsumer(
                h.Mgr,
                h.Lib,
                new StubUserManager(h.User),
                provider,
                NullLogger<SpoilerAutoEnableOnFirstPlayConsumer>.Instance);
            var userKey = h.User.Id.ToString("N");
            h.Mgr.SaveUserConfiguration(userKey, SpoilerFile, new UserSpoilerBlur
            {
                OverridesRevision = 31,
                Series = BuildSeriesOverrides(
                    PersistedPayloadPolicy.MaximumSpoilerEntriesPerDictionary)
            });
            var before = File.ReadAllBytes(SpoilerPath(h));
            SpoilerUserResolver.SeedUserStateCacheForTest(userKey);
            var args = new PlaybackStartEventArgs
            {
                Item = new Episode
                {
                    Id = Guid.NewGuid(),
                    SeriesId = newSeriesId,
                    IndexNumber = 1,
                    ParentIndexNumber = 1
                },
                Session = new SessionInfo(null!, NullLogger.Instance)
                {
                    UserId = h.User.Id
                }
            };

            await consumer.OnEvent(args);

            Assert.Equal(before, File.ReadAllBytes(SpoilerPath(h)));
            var stored = h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                userKey,
                SpoilerFile);
            Assert.Equal(1000, stored.Series.Count);
            Assert.Equal(31, stored.OverridesRevision);
            Assert.DoesNotContain(newSeriesId.ToString("N"), stored.Series.Keys);
            Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(userKey));
        }

        // ─── Pending cap (429) via the HTTP endpoint ──────────────────────────────

        [Fact]
        public void EnableSpoilerBlurPending_AtCap_Returns429()
        {
            using var h = Build(new PluginConfiguration { SpoilerBlurEnabled = true });
            h.Lib.GetItemListHook = _ => Array.Empty<BaseItem>(); // nothing resolves in library

            // Pre-seed the store at the cap so a NEW tmdb is rejected.
            var state = new UserSpoilerBlur();
            for (var i = 0; i < SpoilerPendingService.MaxPendingTmdbPerUser; i++)
            {
                var key = $"tv:{100000 + i}";
                state.PendingTmdb[key] = new SpoilerBlurPendingEntry { MediaType = "tv", TmdbId = (100000 + i).ToString() };
            }
            h.Mgr.SaveUserConfiguration(h.User.Id.ToString("N"), SpoilerFile, state);

            var result = h.Controller.EnableSpoilerBlurPending("tv", "999999");

            var obj = Assert.IsType<ObjectResult>(result);
            Assert.Equal(429, obj.StatusCode);
            var json = JsonSerializer.Serialize(obj.Value);
            Assert.Contains("pending_cap_exceeded", json);
        }

        [Fact]
        public void EnableSpoilerBlurPending_ResolvedSeriesAtOverrideCapReturns429AndRetainsPending()
        {
            using var h = Build(new PluginConfiguration { SpoilerBlurEnabled = true });
            var seriesId = CapacityGuid(4_001);
            const string pendingKey = "tv:424242";
            h.Lib.GetItemListHook = _ =>
                new List<BaseItem> { new Series { Id = seriesId, Name = "Resolved show" } };
            var userKey = h.User.Id.ToString("N");
            h.Mgr.SaveUserConfiguration(userKey, SpoilerFile, new UserSpoilerBlur
            {
                OverridesRevision = 12,
                Series = BuildSeriesOverrides(
                    PersistedPayloadPolicy.MaximumSpoilerEntriesPerDictionary),
                PendingTmdb = new Dictionary<string, SpoilerBlurPendingEntry>
                {
                    [pendingKey] = new()
                    {
                        MediaType = "tv",
                        TmdbId = "424242",
                        DisplayName = "Still pending"
                    }
                }
            });
            var before = File.ReadAllBytes(SpoilerPath(h));
            h.Promoter.RegisterPending(pendingKey, h.User.Id);

            try
            {
                var result = Assert.IsType<ObjectResult>(
                    h.Controller.EnableSpoilerBlurPending("tv", "424242"));

                Assert.Equal(StatusCodes.Status429TooManyRequests, result.StatusCode);
                var error = JsonSerializer.SerializeToElement(result.Value);
                Assert.Equal(
                    "spoiler_override_cap_exceeded",
                    error.GetProperty("code").GetString());
                Assert.Equal("series", error.GetProperty("category").GetString());
                Assert.Equal(before, File.ReadAllBytes(SpoilerPath(h)));
                var stored = h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                    userKey,
                    SpoilerFile);
                Assert.Equal(1000, stored.Series.Count);
                Assert.True(stored.PendingTmdb.ContainsKey(pendingKey));
                Assert.Equal(12, stored.OverridesRevision);
                Assert.True(
                    h.Promoter.IsKeyRegisteredForTest(pendingKey));
            }
            finally
            {
                h.Promoter.UnregisterPending(pendingKey, h.User.Id);
            }
        }

        [Fact]
        public void EnableSpoilerBlurPending_MasterSwitchOff_Returns503()
        {
            using var h = Build(new PluginConfiguration { SpoilerBlurEnabled = false });
            var result = h.Controller.EnableSpoilerBlurPending("tv", "123");
            var obj = Assert.IsType<ObjectResult>(result);
            Assert.Equal(503, obj.StatusCode);
        }

        [Fact]
        public void EnableSpoilerBlurPending_BadMediaType_Returns400()
        {
            using var h = Build(new PluginConfiguration { SpoilerBlurEnabled = true });
            var result = h.Controller.EnableSpoilerBlurPending("book", "123");
            Assert.IsType<BadRequestObjectResult>(result);
        }

        // ─── AddPending promote-vs-pending outcomes (stubbed lookup) ──────────────

        [Fact]
        public void AddPending_ResolvesToSeries_PromotesToSeries()
        {
            using var h = Build();
            var seriesId = Guid.NewGuid();
            var longName = new string('s', 700);
            h.Lib.GetItemListHook = _ =>
                new List<BaseItem> { new Series { Id = seriesId, Name = longName } };

            var res = h.Pending.AddPending(h.User.Id, h.User, "tv", "555", null);

            Assert.Equal("series", res.Promoted);
            Assert.Equal(seriesId.ToString("N"), res.JellyfinId);

            var stored = h.Mgr.GetUserConfiguration<UserSpoilerBlur>(h.User.Id.ToString("N"), SpoilerFile);
            Assert.True(stored.Series.ContainsKey(seriesId.ToString("N")));
            Assert.Equal(
                512,
                stored.Series[seriesId.ToString("N")].SeriesName.Length);
            Assert.Empty(stored.PendingTmdb);
            Assert.Equal(1, stored.OverridesRevision);
            Assert.IsType<OkObjectResult>(
                h.Controller.GetTargetSpoilerGuardOverrides(
                    h.User.Id.ToString("N")));
        }

        [Fact]
        public void AddPending_ResolvesToMovie_PromotesToMovie()
        {
            using var h = Build();
            var movieId = Guid.NewGuid();
            var longName = new string('m', 700);
            h.Lib.GetItemListHook = _ =>
                new List<BaseItem> { new Movie { Id = movieId, Name = longName } };

            var res = h.Pending.AddPending(h.User.Id, h.User, "movie", "777", null);

            Assert.Equal("movie", res.Promoted);
            Assert.Equal(movieId.ToString("N"), res.JellyfinId);
            Assert.Equal(
                1,
                h.Mgr.GetUserConfiguration<UserSpoilerBlur>(
                    h.User.Id.ToString("N"),
                    SpoilerFile).OverridesRevision);
            Assert.Equal(
                512,
                h.Mgr.GetUserConfiguration<UserSpoilerBlur>(
                    h.User.Id.ToString("N"),
                    SpoilerFile).Movies[movieId.ToString("N")].MovieName.Length);
            Assert.IsType<OkObjectResult>(
                h.Controller.GetTargetSpoilerGuardOverrides(
                    h.User.Id.ToString("N")));
        }

        [Theory]
        [InlineData(true)]
        [InlineData(false)]
        public void AddPending_ToctouPromotionBoundsLibraryName(bool isSeries)
        {
            using var h = Build();
            var itemId = Guid.NewGuid();
            var longName = new string(isSeries ? 't' : 'f', 700);
            var lookups = 0;
            h.Lib.GetItemListHook = _ =>
            {
                if (Interlocked.Increment(ref lookups) == 1)
                {
                    return Array.Empty<BaseItem>();
                }

                return new BaseItem[]
                {
                    isSeries
                        ? new Series { Id = itemId, Name = longName }
                        : new Movie { Id = itemId, Name = longName }
                };
            };

            var result = h.Pending.AddPending(
                h.User.Id,
                h.User,
                isSeries ? "tv" : "movie",
                isSeries ? "919191" : "929292",
                "Pending");

            Assert.Equal(isSeries ? "series" : "movie", result.Promoted);
            var stored = h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                h.User.Id.ToString("N"),
                SpoilerFile);
            var persistedName = isSeries
                ? stored.Series[itemId.ToString("N")].SeriesName
                : stored.Movies[itemId.ToString("N")].MovieName;
            Assert.Equal(512, persistedName.Length);
            Assert.IsType<OkObjectResult>(
                h.Controller.GetTargetSpoilerGuardOverrides(
                    h.User.Id.ToString("N")));
        }

        [Theory]
        [InlineData(true)]
        [InlineData(false)]
        public void AddPending_ResolvedDestinationAtCapNeverPersists1001AndRetainsPending(
            bool isSeries)
        {
            using var h = Build();
            var itemId = CapacityGuid(isSeries ? 4_101 : 4_102);
            var pendingKey = isSeries ? "tv:515151" : "movie:616161";
            h.Lib.GetItemListHook = _ => new List<BaseItem>
            {
                isSeries
                    ? new Series { Id = itemId, Name = "Resolved series" }
                    : new Movie { Id = itemId, Name = "Resolved movie" }
            };
            var state = new UserSpoilerBlur
            {
                OverridesRevision = 23,
                PendingTmdb = new Dictionary<string, SpoilerBlurPendingEntry>
                {
                    [pendingKey] = new()
                    {
                        MediaType = isSeries ? "tv" : "movie",
                        TmdbId = isSeries ? "515151" : "616161",
                        DisplayName = "Retain me"
                    }
                }
            };
            if (isSeries)
            {
                state.Series = BuildSeriesOverrides(
                    PersistedPayloadPolicy.MaximumSpoilerEntriesPerDictionary);
            }
            else
            {
                state.Movies = BuildMovieOverrides(
                    PersistedPayloadPolicy.MaximumSpoilerEntriesPerDictionary);
            }
            var userKey = h.User.Id.ToString("N");
            h.Mgr.SaveUserConfiguration(userKey, SpoilerFile, state);
            var before = File.ReadAllBytes(SpoilerPath(h));
            h.Promoter.RegisterPending(pendingKey, h.User.Id);

            try
            {
                var result = h.Pending.AddPending(
                    h.User.Id,
                    h.User,
                    isSeries ? "tv" : "movie",
                    isSeries ? "515151" : "616161",
                    "Submitted");

                Assert.Equal("cap-exceeded", result.Promoted);
                Assert.Equal(isSeries ? "series" : "movies", result.CapacityCategory);
                Assert.False(result.WroteSomething);
                Assert.Equal(before, File.ReadAllBytes(SpoilerPath(h)));
                var stored = h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                    userKey,
                    SpoilerFile);
                Assert.Equal(23, stored.OverridesRevision);
                Assert.True(stored.PendingTmdb.ContainsKey(pendingKey));
                Assert.Equal(
                    1000,
                    isSeries ? stored.Series.Count : stored.Movies.Count);
                Assert.DoesNotContain(
                    itemId.ToString("N"),
                    isSeries ? stored.Series.Keys : stored.Movies.Keys);
            }
            finally
            {
                h.Promoter.UnregisterPending(pendingKey, h.User.Id);
            }
        }

        [Fact]
        public void AddPending_NotInLibrary_RecordsPending()
        {
            using var h = Build();
            h.Lib.GetItemListHook = _ => Array.Empty<BaseItem>();

            var res = h.Pending.AddPending(h.User.Id, h.User, "tv", "888", "My Show");

            Assert.Equal("pending", res.Promoted);
            Assert.Null(res.JellyfinId);

            var stored = h.Mgr.GetUserConfiguration<UserSpoilerBlur>(h.User.Id.ToString("N"), SpoilerFile);
            Assert.True(stored.PendingTmdb.ContainsKey("tv:888"));
            Assert.Equal("My Show", stored.PendingTmdb["tv:888"].DisplayName);
            Assert.Equal(1, stored.OverridesRevision);

            // The recorded pending key primes the promoter gate; clean it up.
            h.Promoter.UnregisterPending("tv:888", h.User.Id);
        }

        [Fact]
        public void AddPending_PendingOnlyPath_InvalidatesCachedEnforcementState()
        {
            // BI-SEC-010 FINAL-F4: a successful pending-only RMW proves spoilerblur.json
            // is readable/valid again, so it must invalidate any cached FailClosed/stale
            // enforcement state (parity with the promotion branches), not leave it
            // lingering for up to the cache TTL.
            using var h = Build();
            h.Lib.GetItemListHook = _ => Array.Empty<BaseItem>();
            var userKey = h.User.Id.ToString("N");

            SpoilerUserResolver.SeedUserStateCacheForTest(userKey);
            Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(userKey));

            var res = h.Pending.AddPending(h.User.Id, h.User, "tv", "999", "My Show");
            Assert.Equal("pending", res.Promoted);

            Assert.False(SpoilerUserResolver.IsUserStateCachedForTest(userKey));

            h.Promoter.UnregisterPending("tv:999", h.User.Id);
        }

        // ─── Health endpoint: non-admin sees only own corruption events ───────────

        [Fact]
        public void GetSpoilerBlurHealth_NonAdmin_SeesOnlyOwnEvents()
        {
            // includeUserInManager: false ⇒ IsAdminUser() falls through to false.
            using var h = Build(includeUserInManager: false);

            var meKey = h.User.Id.ToString("N");
            var otherKey = Guid.NewGuid().ToString("N");
            SpoilerUserResolver.RecordCorruption(meKey, "me", "mine");
            SpoilerUserResolver.RecordCorruption(otherKey, "other", "theirs");

            try
            {
                var ok = Assert.IsType<OkObjectResult>(h.Controller.GetSpoilerBlurHealth());
                var json = JsonSerializer.Serialize(ok.Value);
                Assert.Contains(meKey, json);
                Assert.DoesNotContain(otherKey, json);
                Assert.Contains("\"healthy\":false", json);
            }
            finally
            {
                SpoilerUserResolver.ClearCorruption(meKey);
                SpoilerUserResolver.ClearCorruption(otherKey);
            }
        }

        [Fact]
        public void CorruptionBanner_RepeatedMarkerHitsKeepFirstEvent()
        {
            var userKey = Guid.NewGuid().ToString("N");
            try
            {
                SpoilerUserResolver.RecordCorruption(userKey, "user", "first marker hit");
                var first = SpoilerUserResolver.GetCorruptionLog()[userKey];

                SpoilerUserResolver.RecordCorruption(userKey, "changed", "retry");
                var afterRetry = SpoilerUserResolver.GetCorruptionLog()[userKey];

                Assert.Same(first, afterRetry);
                Assert.Equal("first marker hit", afterRetry.Reason);
            }
            finally
            {
                SpoilerUserResolver.ClearCorruption(userKey);
            }
        }

        // ─── F4: movie scope probe endpoint ───────────────────────────────────────

        [Fact]
        public void GetMovieSpoilerScope_BadGuid_Returns400()
        {
            using var h = Build();
            Assert.IsType<BadRequestObjectResult>(h.Controller.GetMovieSpoilerScope("not-a-guid"));
        }

        [Fact]
        public void GetMovieSpoilerScope_NotInScope_ReturnsInScopeFalse()
        {
            using var h = Build();
            var ok = Assert.IsType<OkObjectResult>(h.Controller.GetMovieSpoilerScope(Guid.NewGuid().ToString()));
            var json = JsonSerializer.Serialize(ok.Value);
            Assert.Contains("\"inScope\":false", json);
            Assert.Contains("\"played\":false", json);
        }

        [Fact]
        public void GetMovieSpoilerScope_DirectlyOptedIn_ReturnsInScopeTrue_WithPlayedState()
        {
            using var h = Build();
            var movieId = Guid.NewGuid();

            // Opt the movie in directly so IsMovieInSpoilerScope is true without a
            // library collection walk.
            var state = new UserSpoilerBlur();
            state.Movies[movieId.ToString("N")] = new SpoilerBlurMovieEntry { MovieId = movieId.ToString("N") };
            h.Mgr.SaveUserConfiguration(h.User.Id.ToString("N"), SpoilerFile, state);

            var movie = new Movie { Id = movieId, Name = "Film" };
            h.Lib.GetItemByIdUserHook = (_, _) => movie;
            h.UserData.GetUserDataHook = (_, _) => new UserItemData { Key = "k", Played = true };

            var ok = Assert.IsType<OkObjectResult>(h.Controller.GetMovieSpoilerScope(movieId.ToString()));
            var json = JsonSerializer.Serialize(ok.Value);
            Assert.Contains("\"inScope\":true", json);
            Assert.Contains("\"played\":true", json);
        }

        // ─── F5: promoter promotes an accessible TMDB duplicate ───────────────────

        [Fact]
        public void PromoteForUser_EventItemInaccessible_PromotesAccessibleTmdbDuplicate()
        {
            using var h = Build();
            const string pendingKey = "tv:555";
            var state = new UserSpoilerBlur();
            state.PendingTmdb[pendingKey] = new SpoilerBlurPendingEntry { MediaType = "tv", TmdbId = "555" };
            h.Mgr.SaveUserConfiguration(h.User.Id.ToString("N"), SpoilerFile, state);

            var eventItemId = Guid.NewGuid();   // library duplicate the user can't access
            var dupId = Guid.NewGuid();         // accessible duplicate (same TMDB id)
            var longName = new string('d', 700);
            h.Lib.GetItemByIdUserHook = (_, _) => null;                                    // event item not visible
            h.Lib.GetItemListHook = _ =>
                new List<BaseItem> { new Series { Id = dupId, Name = longName } };

            var outcome = h.Promoter.PromoteForUser(h.User.Id, eventItemId, pendingKey, "Orig", isSeries: true);

            Assert.Equal(SpoilerSeerrPendingPromoter.PromotionOutcome.Promoted, outcome);
            var stored = h.Mgr.GetUserConfiguration<UserSpoilerBlur>(h.User.Id.ToString("N"), SpoilerFile);
            Assert.True(stored.Series.ContainsKey(dupId.ToString("N")));            // promoted the ACCESSIBLE dup
            Assert.False(stored.Series.ContainsKey(eventItemId.ToString("N")));
            Assert.Equal(
                512,
                stored.Series[dupId.ToString("N")].SeriesName.Length);
            Assert.Empty(stored.PendingTmdb);
            Assert.Equal(1, stored.OverridesRevision);
        }

        [Theory]
        [InlineData(true)]
        [InlineData(false)]
        public void PromoteForUser_DestinationAtCapReturnsStillPendingWithoutMutation(
            bool isSeries)
        {
            using var h = Build();
            var promoter = h.Promoter;
            var itemId = CapacityGuid(isSeries ? 4_301 : 4_302);
            var pendingKey = isSeries ? "tv:717171" : "movie:818181";
            h.Lib.GetItemByIdUserHook = (id, scopedUser) =>
            {
                Assert.Equal(itemId, id);
                Assert.Same(h.User, scopedUser);
                return isSeries
                    ? new Series { Id = id, Name = "Series at cap" }
                    : new Movie { Id = id, Name = "Movie at cap" };
            };
            var state = new UserSpoilerBlur
            {
                OverridesRevision = 37,
                PendingTmdb = new Dictionary<string, SpoilerBlurPendingEntry>
                {
                    [pendingKey] = new()
                    {
                        MediaType = isSeries ? "tv" : "movie",
                        TmdbId = isSeries ? "717171" : "818181",
                        DisplayName = "Still pending"
                    }
                }
            };
            if (isSeries)
            {
                state.Series = BuildSeriesOverrides(
                    PersistedPayloadPolicy.MaximumSpoilerEntriesPerDictionary);
            }
            else
            {
                state.Movies = BuildMovieOverrides(
                    PersistedPayloadPolicy.MaximumSpoilerEntriesPerDictionary);
            }
            var userKey = h.User.Id.ToString("N");
            h.Mgr.SaveUserConfiguration(userKey, SpoilerFile, state);
            var before = File.ReadAllBytes(SpoilerPath(h));
            SpoilerUserResolver.SeedUserStateCacheForTest(userKey);
            promoter.RegisterPending(pendingKey, h.User.Id);

            try
            {
                var outcome = promoter.PromoteForUser(
                    h.User.Id,
                    itemId,
                    pendingKey,
                    isSeries ? "Series at cap" : "Movie at cap",
                    isSeries);

                Assert.Equal(
                    SpoilerSeerrPendingPromoter.PromotionOutcome.StillPending,
                    outcome);
                Assert.Equal(before, File.ReadAllBytes(SpoilerPath(h)));
                var stored = h.Mgr.GetUserConfigurationStrict<UserSpoilerBlur>(
                    userKey,
                    SpoilerFile);
                Assert.Equal(37, stored.OverridesRevision);
                Assert.True(stored.PendingTmdb.ContainsKey(pendingKey));
                Assert.Equal(
                    1000,
                    isSeries ? stored.Series.Count : stored.Movies.Count);
                Assert.DoesNotContain(
                    itemId.ToString("N"),
                    isSeries ? stored.Series.Keys : stored.Movies.Keys);
                Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(userKey));
                Assert.True(
                    promoter.IsKeyRegisteredForTest(pendingKey));
            }
            finally
            {
                promoter.UnregisterPending(pendingKey, h.User.Id);
            }
        }

        // ─── F7: controller writes invalidate the cross-request state cache ───────

        [Fact]
        public void EnableSpoilerBlurForSeries_InvalidatesUserStateCache()
        {
            using var h = Build();
            var seriesId = Guid.NewGuid();
            h.Lib.GetItemByIdUserHook = (_, _) => new Series { Id = seriesId, Name = "Show" };
            var userKey = h.User.Id.ToString("N");

            SpoilerUserResolver.SeedUserStateCacheForTest(userKey);
            Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(userKey));

            Assert.IsType<OkObjectResult>(h.Controller.EnableSpoilerBlurForSeries(seriesId.ToString()));
            Assert.False(SpoilerUserResolver.IsUserStateCachedForTest(userKey));
        }

        [Fact]
        public void InstalledItemRoutes_InvokeSharedOwnerExactlyOnceAfterAdmission()
        {
            var owner = new RecordingItemActionOwner();
            using var h = Build(itemActionOwner: owner);
            var seriesId = Guid.NewGuid();
            var movieId = Guid.NewGuid();
            h.Lib.GetItemByIdUserHook = (id, _) =>
                id == seriesId ? new Series { Id = id, Name = "Series" }
                : id == movieId ? new Movie { Id = id, Name = "Movie" }
                : null;

            Assert.IsType<OkObjectResult>(
                h.Controller.EnableSpoilerBlurForSeries(seriesId.ToString()));
            Assert.IsType<OkObjectResult>(
                h.Controller.DisableSpoilerBlurForSeries(seriesId.ToString()));
            Assert.IsType<OkObjectResult>(
                h.Controller.EnableSpoilerBlurForMovie(movieId.ToString()));
            Assert.IsType<OkObjectResult>(
                h.Controller.DisableSpoilerBlurForMovie(movieId.ToString()));

            Assert.Collection(
                owner.Calls,
                call => AssertCall(call, h.User.Id, seriesId, SpoilerGuardItemKind.Series, enabled: true),
                call => AssertCall(call, h.User.Id, seriesId, SpoilerGuardItemKind.Series, enabled: false),
                call => AssertCall(call, h.User.Id, movieId, SpoilerGuardItemKind.Movie, enabled: true),
                call => AssertCall(call, h.User.Id, movieId, SpoilerGuardItemKind.Movie, enabled: false));

            Assert.IsType<NotFoundObjectResult>(
                h.Controller.EnableSpoilerBlurForMovie(Guid.NewGuid().ToString()));
            Assert.Equal(4, owner.Calls.Count);

            static void AssertCall(
                ItemActionCall call,
                Guid userId,
                Guid itemId,
                SpoilerGuardItemKind kind,
                bool enabled)
            {
                Assert.Equal(userId, call.Actor.UserId);
                Assert.Equal(itemId, call.Item.ItemId);
                Assert.Equal(kind, call.Item.Kind);
                Assert.Equal(enabled, call.Configuration.Enabled);
                Assert.Null(call.Configuration.ExpectedOverridesRevision);
            }
        }

        private static Guid CapacityGuid(int index)
            => new(index, 0, 0, new byte[8]);

        private static Dictionary<string, SpoilerBlurSeriesEntry> BuildSeriesOverrides(
            int count)
        {
            var entries = new Dictionary<string, SpoilerBlurSeriesEntry>(
                count,
                StringComparer.OrdinalIgnoreCase);
            for (var index = 1; index <= count; index++)
            {
                var key = CapacityGuid(index).ToString("N");
                entries[key] = new SpoilerBlurSeriesEntry
                {
                    SeriesId = key,
                    SeriesName = $"Series {index}"
                };
            }

            return entries;
        }

        private static Dictionary<string, SpoilerBlurMovieEntry> BuildMovieOverrides(
            int count)
        {
            var entries = new Dictionary<string, SpoilerBlurMovieEntry>(
                count,
                StringComparer.OrdinalIgnoreCase);
            for (var index = 1; index <= count; index++)
            {
                var key = CapacityGuid(index).ToString("N");
                entries[key] = new SpoilerBlurMovieEntry
                {
                    MovieId = key,
                    MovieName = $"Movie {index}"
                };
            }

            return entries;
        }

        private static Dictionary<string, SpoilerBlurCollectionEntry>
            BuildCollectionOverrides(int count)
        {
            var entries = new Dictionary<string, SpoilerBlurCollectionEntry>(
                count,
                StringComparer.OrdinalIgnoreCase);
            for (var index = 1; index <= count; index++)
            {
                var key = CapacityGuid(index).ToString("N");
                entries[key] = new SpoilerBlurCollectionEntry
                {
                    CollectionId = key,
                    CollectionName = $"Collection {index}"
                };
            }

            return entries;
        }

        private static string SpoilerPath(Harness harness)
            => Path.Combine(
                harness.Dir,
                "configurations",
                "Jellyfin.Plugin.JellyfinCanopy",
                harness.User.Id.ToString("N"),
                SpoilerFile);

        private sealed class CollectingLogger<T> : ILogger<T>
        {
            public List<string> Messages { get; } = new();

            public IDisposable? BeginScope<TState>(TState state)
                where TState : notnull
                => null;

            public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
                => Messages.Add(formatter(state, exception));
        }

        private sealed record ItemActionCall(
            SpoilerGuardActorProjection Actor,
            SpoilerGuardItemProjection Item,
            SpoilerGuardItemConfiguration Configuration);

        private sealed class RecordingItemActionOwner : ISpoilerGuardItemActionOwner
        {
            public List<ItemActionCall> Calls { get; } = new();

            public SpoilerGuardItemState GetState(
                SpoilerGuardActorProjection actor,
                SpoilerGuardItemProjection item)
                => new(enabled: false, overridesRevision: 0);

            public SpoilerGuardItemActionResult Configure(
                SpoilerGuardActorProjection actor,
                SpoilerGuardItemProjection item,
                SpoilerGuardItemConfiguration configuration)
            {
                Calls.Add(new ItemActionCall(actor, item, configuration));
                return SpoilerGuardItemActionResult.Configured(
                    configuration.Enabled,
                    changed: true,
                    removed: !configuration.Enabled,
                    revision: Calls.Count);
            }
        }
    }
}
