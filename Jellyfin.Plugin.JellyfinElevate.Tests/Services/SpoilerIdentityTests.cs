using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Claims;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Services;
using Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Services
{
    /// <summary>
    /// Unit coverage for the tagged-image-URL identity scheme: marker
    /// mint/parse/resolve (SpoilerIdentityService), DTO stamping incl.
    /// ImageBlurHashes re-keying (SpoilerIdentityTagFilter.StampItem), and
    /// the resolver's marker tier ordering (ClaimsPrincipal > marker > IP).
    /// </summary>
    public class SpoilerIdentityTests
    {
        private static SpoilerIdentityService NewService(params User[] users)
            => new(new StubUserManager(users), NullLogger<SpoilerIdentityService>.Instance);

        // ─── marker mint / parse ──────────────────────────────────────────────

        [Fact]
        public void MintMarker_IsStableLowercase12Hex()
        {
            var svc = NewService();
            var id = Guid.NewGuid();
            var m1 = svc.MintMarker(id);
            var m2 = svc.MintMarker(id);
            Assert.Equal(m1, m2);
            Assert.Equal(12, m1.Length);
            Assert.Matches("^[0-9a-f]{12}$", m1);
        }

        [Fact]
        public void AppendAndParse_RoundTrips_AndAppendIsIdempotent()
        {
            var svc = NewService();
            var marker = svc.MintMarker(Guid.NewGuid());

            var stamped = SpoilerIdentityService.AppendMarker("b6573ea6698cb3435816e0c90f75c26d", marker);
            Assert.EndsWith("-jeu" + marker, stamped, StringComparison.Ordinal);

            // Idempotent: a second stamp must not double-append.
            Assert.Same(stamped, SpoilerIdentityService.AppendMarker(stamped, marker));

            Assert.True(SpoilerIdentityService.TryParseMarker(stamped, out var baseTag, out var parsed));
            Assert.Equal("b6573ea6698cb3435816e0c90f75c26d", baseTag);
            Assert.Equal(marker, parsed);
        }

        [Fact]
        public void AppendMarker_ComposesWithCacheBustPrefix()
        {
            var svc = NewService();
            var marker = svc.MintMarker(Guid.NewGuid());

            // The strip filter's "sb-{8hex}-" prefix must survive as-is.
            var stamped = SpoilerIdentityService.AppendMarker("sb-1a2b3c4d-origtag", marker);
            Assert.True(SpoilerIdentityService.TryParseMarker(stamped, out var baseTag, out _));
            Assert.Equal("sb-1a2b3c4d-origtag", baseTag);
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("plaintag")]
        [InlineData("-jeu123456789abc")]              // marker with no base tag
        [InlineData("tag-jeu123456789ABC")]           // uppercase hex rejected
        [InlineData("tag-jeu12345678")]               // too short
        [InlineData("tag-jeX123456789abc")]           // wrong sentinel
        public void TryParseMarker_RejectsNonMarkerShapes(string? tag)
        {
            Assert.False(SpoilerIdentityService.TryParseMarker(tag, out _, out _));
        }

        // ─── marker resolution ────────────────────────────────────────────────

        [Fact]
        public void TryResolveMarker_KnownUserResolves_UnknownFalls()
        {
            var user = new User("ident", "Prov", "PwProv");
            var svc = NewService(user);

            Assert.True(svc.TryResolveMarker(svc.MintMarker(user.Id), out var resolved));
            Assert.Equal(user.Id, resolved);

            Assert.False(svc.TryResolveMarker("deadbeef0000", out _));
        }

        // ─── DTO stamping ─────────────────────────────────────────────────────

        [Fact]
        public void StampItem_StampsEveryTagField_AndReKeysBlurhashes()
        {
            var svc = NewService();
            var marker = svc.MintMarker(Guid.NewGuid());
            var suffix = "-jeu" + marker;

            var item = new BaseItemDto
            {
                ImageTags = new Dictionary<ImageType, string> { [ImageType.Primary] = "prim" },
                BackdropImageTags = new[] { "bd0", "bd1" },
                ScreenshotImageTags = new[] { "sc0" },
                ParentBackdropImageTags = new[] { "pbd0" },
                AlbumPrimaryImageTag = "alb",
                SeriesPrimaryImageTag = "serp",
                ParentPrimaryImageTag = "parp",
                ChannelPrimaryImageTag = "chp",
                ParentLogoImageTag = "plog",
                ParentArtImageTag = "part",
                SeriesThumbImageTag = "serth",
                ParentThumbImageTag = "parth",
                Chapters = new List<ChapterInfo> { new() { ImageTag = "chap0" }, new() { ImageTag = null } },
                ImageBlurHashes = new Dictionary<ImageType, Dictionary<string, string>>
                {
                    [ImageType.Primary] = new() { ["prim"] = "HASH-prim", ["serp"] = "HASH-serp" },
                    [ImageType.Backdrop] = new() { ["bd0"] = "HASH-bd0", ["bd1"] = "HASH-bd1", ["pbd0"] = "HASH-pbd0" },
                },
            };

            SpoilerIdentityTagFilter.StampItem(item, marker);

            Assert.Equal("prim" + suffix, item.ImageTags[ImageType.Primary]);
            Assert.Equal(new[] { "bd0" + suffix, "bd1" + suffix }, item.BackdropImageTags);
            Assert.Equal(new[] { "sc0" + suffix }, item.ScreenshotImageTags);
            Assert.Equal(new[] { "pbd0" + suffix }, item.ParentBackdropImageTags);
            Assert.Equal("alb" + suffix, item.AlbumPrimaryImageTag);
            Assert.Equal("serp" + suffix, item.SeriesPrimaryImageTag);
            Assert.Equal("parp" + suffix, item.ParentPrimaryImageTag);
            Assert.Equal("chp" + suffix, item.ChannelPrimaryImageTag);
            Assert.Equal("plog" + suffix, item.ParentLogoImageTag);
            Assert.Equal("part" + suffix, item.ParentArtImageTag);
            Assert.Equal("serth" + suffix, item.SeriesThumbImageTag);
            Assert.Equal("parth" + suffix, item.ParentThumbImageTag);
            Assert.Equal("chap0" + suffix, item.Chapters[0].ImageTag);
            Assert.Null(item.Chapters[1].ImageTag);

            // Blurhash lookups must keep working under the NEW tag strings.
            var prim = item.ImageBlurHashes[ImageType.Primary];
            Assert.Equal("HASH-prim", prim["prim" + suffix]);
            Assert.Equal("HASH-serp", prim["serp" + suffix]);
            Assert.False(prim.ContainsKey("prim"));
            var bd = item.ImageBlurHashes[ImageType.Backdrop];
            Assert.Equal("HASH-bd0", bd["bd0" + suffix]);
            Assert.Equal("HASH-pbd0", bd["pbd0" + suffix]);
        }

        [Fact]
        public void StampItem_ReKeysBlurhash_WhenTagCarriesCacheBustPrefix()
        {
            // The strip filter rewrites ImageTags to "sb-{8hex}-{orig}" but
            // never re-keyed blurhashes — they still sit under the ORIGINAL
            // tag. Stamping must find them via the prefix-stripped base.
            var svc = NewService();
            var marker = svc.MintMarker(Guid.NewGuid());

            var item = new BaseItemDto
            {
                ImageTags = new Dictionary<ImageType, string> { [ImageType.Primary] = "sb-1a2b3c4d-orig" },
                ImageBlurHashes = new Dictionary<ImageType, Dictionary<string, string>>
                {
                    [ImageType.Primary] = new() { ["orig"] = "HASH" },
                },
            };

            SpoilerIdentityTagFilter.StampItem(item, marker);

            var finalTag = "sb-1a2b3c4d-orig-jeu" + marker;
            Assert.Equal(finalTag, item.ImageTags[ImageType.Primary]);
            Assert.Equal("HASH", item.ImageBlurHashes[ImageType.Primary][finalTag]);
        }

        [Fact]
        public void StampItem_DoubleStamp_IsIdempotent()
        {
            var svc = NewService();
            var marker = svc.MintMarker(Guid.NewGuid());
            var item = new BaseItemDto
            {
                ImageTags = new Dictionary<ImageType, string> { [ImageType.Primary] = "prim" },
            };

            SpoilerIdentityTagFilter.StampItem(item, marker);
            var once = item.ImageTags[ImageType.Primary];
            SpoilerIdentityTagFilter.StampItem(item, marker);
            Assert.Equal(once, item.ImageTags[ImageType.Primary]);
        }

        // ─── resolver tier ordering ───────────────────────────────────────────

        private static SpoilerUserResolver NewResolver(SpoilerIdentityService markers)
        {
            var dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "je-ident-" + Guid.NewGuid().ToString("N"));
            System.IO.Directory.CreateDirectory(dir);
            var mgr = new UserConfigurationManager(new StubAppPaths(dir), NullLogger<UserConfigurationManager>.Instance);
            // The identity service gets an EMPTY user manager on purpose: the
            // single-user-server shortcut must stay inert in these tests so
            // they exercise the marker/cookie/IP tiers.
            var identity = new RequestIdentityService(
                new CountingSessionManager(), new StubUserManager(), markers, new FakePluginConfigProvider(new PluginConfiguration()), NullLogger<RequestIdentityService>.Instance);
            return new SpoilerUserResolver(mgr, new CountingLibraryManager(), NullLogger<SpoilerUserResolver>.Instance, identity);
        }

        [Fact]
        public void Resolver_MarkerInTagQuery_ResolvesSingleCandidate_WithoutSessions()
        {
            var user = new User("marker-user", "Prov", "PwProv");
            var identity = NewService(user);
            var resolver = NewResolver(identity);

            var ctx = new DefaultHttpContext();
            ctx.Request.QueryString = new QueryString(
                "?tag=sb-1a2b3c4d-orig-jeu" + identity.MintMarker(user.Id) + "&maxWidth=300");

            var candidates = resolver.ResolveCandidateUserIds(ctx);
            Assert.Equal(new[] { user.Id }, candidates);
        }

        [Fact]
        public void Resolver_UnknownMarker_FallsThroughToIpLadder()
        {
            // Two users so the single-user shortcut stays inert; one of them
            // has a session on the request IP. The unknown marker must be
            // IGNORED and the ladder must CONTINUE to the session-by-IP tier
            // and find that candidate — proving real fall-through rather than
            // an early empty return.
            var userA = new User("ladder-a", "Prov", "PwProv");
            var userB = new User("ladder-b", "Prov", "PwProv");
            var manager = new StubUserManager(userA, userB);
            var markers = new SpoilerIdentityService(manager, NullLogger<SpoilerIdentityService>.Instance);
            var sessions = new CountingSessionManager();
            sessions.SetSessions(new SessionInfo(sessions, NullLogger<SessionInfo>.Instance)
            {
                UserId = userA.Id,
                RemoteEndPoint = "10.9.8.7:41234",
            });
            var identity = new RequestIdentityService(
                sessions, manager, markers, new FakePluginConfigProvider(new PluginConfiguration()), NullLogger<RequestIdentityService>.Instance);

            var ctx = new DefaultHttpContext();
            ctx.Connection.RemoteIpAddress = System.Net.IPAddress.Parse("10.9.8.7");
            ctx.Request.QueryString = new QueryString("?tag=orig-jeu123456789abc");

            var resolved = identity.Resolve(ctx);
            Assert.Equal(IdentityConfidence.SharedIpCandidates, resolved.Confidence);
            Assert.Equal(new[] { userA.Id }, resolved.Candidates);
        }

        [Fact]
        public void RequestIdentity_ReportsConfidenceTiers()
        {
            var user = new User("conf-user", "Prov", "PwProv");
            var markers = NewService(user);
            var identity = new RequestIdentityService(
                new CountingSessionManager(), new StubUserManager(), markers, new FakePluginConfigProvider(new PluginConfiguration()), NullLogger<RequestIdentityService>.Instance);

            // Marker tier.
            var ctx = new DefaultHttpContext();
            ctx.Request.QueryString = new QueryString("?tag=orig-jeu" + markers.MintMarker(user.Id));
            var viaMarker = identity.Resolve(ctx);
            Assert.Equal(IdentityConfidence.Marker, viaMarker.Confidence);
            Assert.Equal(new[] { user.Id }, viaMarker.Candidates);

            // Authenticated tier beats the marker.
            var principal = new ClaimsPrincipal(new ClaimsIdentity(
                new[] { new Claim("Jellyfin-UserId", user.Id.ToString()) }, "TestAuth"));
            var authedCtx = new DefaultHttpContext { User = principal };
            authedCtx.Request.QueryString = ctx.Request.QueryString;
            Assert.Equal(IdentityConfidence.Authenticated, identity.Resolve(authedCtx).Confidence);

            // Nothing at all → None with no candidates.
            var anon = identity.Resolve(new DefaultHttpContext());
            Assert.Equal(IdentityConfidence.None, anon.Confidence);
            Assert.Empty(anon.Candidates);
        }

        [Fact]
        public void RequestIdentity_ReadsMarkerFromPathAndIfNoneMatch()
        {
            var user = new User("carrier-user", "Prov", "PwProv");
            var markers = NewService(user);
            var identity = new RequestIdentityService(
                new CountingSessionManager(), new StubUserManager(), markers, new FakePluginConfigProvider(new PluginConfiguration()), NullLogger<RequestIdentityService>.Instance);
            var marker = markers.MintMarker(user.Id);

            // {tag} PATH segment of the alternate image route.
            var pathCtx = new DefaultHttpContext();
            pathCtx.Request.RouteValues["tag"] = "orig-jeu" + marker;
            var viaPath = identity.Resolve(pathCtx);
            Assert.Equal(IdentityConfidence.Marker, viaPath.Confidence);
            Assert.Equal(new[] { user.Id }, viaPath.Candidates);

            // If-None-Match revalidation (server echoes the tag as the ETag).
            var inmCtx = new DefaultHttpContext();
            inmCtx.Request.Headers.IfNoneMatch = "\"orig-jeu" + marker + "\"";
            var viaInm = identity.Resolve(inmCtx);
            Assert.Equal(IdentityConfidence.Marker, viaInm.Confidence);
            Assert.Equal(new[] { user.Id }, viaInm.Candidates);
        }

        [Fact]
        public void RequestIdentity_SingleUserServer_ShortCircuits()
        {
            var only = new User("only-user", "Prov", "PwProv");
            var markers = NewService();
            var identity = new RequestIdentityService(
                new CountingSessionManager(), new StubUserManager(only), markers, new FakePluginConfigProvider(new PluginConfiguration()), NullLogger<RequestIdentityService>.Instance);

            var res = identity.Resolve(new DefaultHttpContext());
            Assert.Equal(IdentityConfidence.SingleUserServer, res.Confidence);
            Assert.Equal(new[] { only.Id }, res.Candidates);
        }

        [Fact]
        public async System.Threading.Tasks.Task Invalidation_UserCreated_RefreshesSingleUserAndMarkerMap()
        {
            var userA = new User("first-user", "Prov", "PwProv");
            var manager = new StubUserManager(userA);
            var markers = new SpoilerIdentityService(manager, NullLogger<SpoilerIdentityService>.Instance);
            var identity = new RequestIdentityService(
                new CountingSessionManager(), manager, markers, new FakePluginConfigProvider(new PluginConfiguration()), NullLogger<RequestIdentityService>.Instance);

            // Warm both caches: single-user shortcut fires; A's marker resolves.
            Assert.Equal(IdentityConfidence.SingleUserServer, identity.Resolve(new DefaultHttpContext()).Confidence);
            Assert.True(markers.TryResolveMarker(markers.MintMarker(userA.Id), out _));

            // Second user appears; the event consumer invalidates both caches.
            var userB = new User("second-user", "Prov", "PwProv");
            manager.AddUser(userB);
            await new EventHandlers.UserCreatedIdentityInvalidator(identity, markers)
                .OnEvent(new Jellyfin.Data.Events.Users.UserCreatedEventArgs(userB));

            // The stale "only user A" answer must be gone immediately…
            var afterCreate = identity.Resolve(new DefaultHttpContext());
            Assert.NotEqual(IdentityConfidence.SingleUserServer, afterCreate.Confidence);
            Assert.Empty(afterCreate.Candidates);

            // …and B's freshly minted marker must resolve without waiting out
            // the rebuild throttle.
            Assert.True(markers.TryResolveMarker(markers.MintMarker(userB.Id), out var resolvedB));
            Assert.Equal(userB.Id, resolvedB);
        }

        [Fact]
        public void Resolver_ClaimsPrincipal_BeatsMarker()
        {
            var markerUser = new User("marker-user", "Prov", "PwProv");
            var identity = NewService(markerUser);
            var resolver = NewResolver(identity);

            var claimsUserId = Guid.NewGuid();
            var principal = new ClaimsPrincipal(new ClaimsIdentity(
                new[] { new Claim("Jellyfin-UserId", claimsUserId.ToString()) }, "TestAuth"));
            var ctx = new DefaultHttpContext { User = principal };
            ctx.Request.QueryString = new QueryString("?tag=orig-jeu" + identity.MintMarker(markerUser.Id));

            Assert.Equal(new[] { claimsUserId }, resolver.ResolveCandidateUserIds(ctx));
        }
    }
}
