using System;
using System.Collections.Generic;
using System.Net;
using System.Security.Claims;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Services;
using Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Services
{
    /// <summary>
    /// Milestone-3 identity-ladder hardening: the trusted-proxy gate, the
    /// forward-auth SSO tier, the HMAC signed cookie, the XFF learned map, and
    /// their fail-closed ordering inside RequestIdentityService.
    /// </summary>
    public class IdentityLadderM3Tests
    {
        private static RequestIdentityService NewResolver(
            PluginConfiguration config,
            StubUserManager users,
            out SpoilerIdentityService markers,
            CountingSessionManager? sessions = null)
        {
            markers = new SpoilerIdentityService(users, NullLogger<SpoilerIdentityService>.Instance);
            return new RequestIdentityService(
                sessions ?? new CountingSessionManager(),
                users,
                markers,
                new FakePluginConfigProvider(config),
                NullLogger<RequestIdentityService>.Instance);
        }

        // ─── TrustedProxyEvaluator ───────────────────────────────────────────

        [Theory]
        [InlineData("10.0.0.0/8", "10.9.8.7", true)]
        [InlineData("10.0.0.0/8", "11.0.0.1", false)]
        [InlineData("192.168.1.5", "192.168.1.5", true)]
        [InlineData("192.168.1.5", "192.168.1.6", false)]
        [InlineData("172.16.0.0/12", "172.31.255.254", true)]
        [InlineData("172.16.0.0/12", "172.32.0.1", false)]
        [InlineData("::1", "::1", true)]
        [InlineData("2001:db8::/32", "2001:db8:abcd::1", true)]
        [InlineData("2001:db8::/32", "2001:db9::1", false)]
        public void TrustedProxy_CidrMatching(string config, string peer, bool expected)
        {
            var eval = new TrustedProxyEvaluator(config);
            Assert.Equal(expected, eval.IsTrusted(IPAddress.Parse(peer)));
        }

        [Fact]
        public void TrustedProxy_EmptyOrNull_MatchesNothing()
        {
            Assert.False(new TrustedProxyEvaluator("").HasAny);
            Assert.False(new TrustedProxyEvaluator(null).IsTrusted(IPAddress.Loopback));
        }

        [Fact]
        public void TrustedProxy_IPv4MappedPeer_MatchesV4Range()
        {
            var eval = new TrustedProxyEvaluator("10.0.0.0/8");
            Assert.True(eval.IsTrusted(IPAddress.Parse("10.1.2.3").MapToIPv6()));
        }

        // ─── IdentityCookieSigner ────────────────────────────────────────────

        [Fact]
        public void SignedCookie_RoundTrips()
        {
            const string secret = "a-sufficiently-long-secret-value";
            var uid = Guid.NewGuid();
            var now = DateTime.UtcNow;
            var value = IdentityCookieSigner.Sign(uid, secret, now);
            Assert.NotNull(value);
            Assert.Equal(uid, IdentityCookieSigner.Verify(value, secret, now));
        }

        [Fact]
        public void SignedCookie_WrongSecret_Rejected()
        {
            var uid = Guid.NewGuid();
            var value = IdentityCookieSigner.Sign(uid, "the-original-secret-value", DateTime.UtcNow);
            Assert.Null(IdentityCookieSigner.Verify(value, "a-different-secret-value!", DateTime.UtcNow));
        }

        [Fact]
        public void SignedCookie_TamperedPayload_Rejected()
        {
            const string secret = "a-sufficiently-long-secret-value";
            var value = IdentityCookieSigner.Sign(Guid.NewGuid(), secret, DateTime.UtcNow);
            // Flip a character in the payload half.
            var dot = value!.IndexOf('.');
            var tampered = (value[0] == 'A' ? 'B' : 'A') + value.Substring(1, dot - 1) + value.Substring(dot);
            Assert.Null(IdentityCookieSigner.Verify(tampered, secret, DateTime.UtcNow));
        }

        [Fact]
        public void SignedCookie_Expired_Rejected()
        {
            const string secret = "a-sufficiently-long-secret-value";
            var issued = DateTime.UtcNow.AddDays(-40);
            var value = IdentityCookieSigner.Sign(Guid.NewGuid(), secret, issued);
            Assert.Null(IdentityCookieSigner.Verify(value, secret, DateTime.UtcNow));
        }

        [Fact]
        public void SignedCookie_BlankOrShortSecret_CannotSign()
        {
            Assert.Null(IdentityCookieSigner.Sign(Guid.NewGuid(), "", DateTime.UtcNow));
            Assert.Null(IdentityCookieSigner.Sign(Guid.NewGuid(), "short", DateTime.UtcNow));
        }

        [Fact]
        public void SignedCookie_GarbageValue_Rejected()
        {
            const string secret = "a-sufficiently-long-secret-value";
            Assert.Null(IdentityCookieSigner.Verify("not-a-cookie", secret, DateTime.UtcNow));
            Assert.Null(IdentityCookieSigner.Verify("no.dot.here.extra", secret, DateTime.UtcNow));
            Assert.Null(IdentityCookieSigner.Verify("", secret, DateTime.UtcNow));
        }

        // ─── ForwardAuthResolver ─────────────────────────────────────────────

        [Fact]
        public void ForwardAuth_MatchesUsernameHeaderInPriorityOrder()
        {
            var names = ForwardAuthResolver.ParseHeaderNames("Remote-User, X-Forwarded-User");
            var uid = Guid.NewGuid();
            var got = ForwardAuthResolver.Resolve(
                names,
                n => n == "X-Forwarded-User" ? "bob" : null,
                u => u == "bob" ? uid : Guid.Empty);
            Assert.Equal(uid, got);
        }

        [Fact]
        public void ForwardAuth_EmailHeader_MatchesLocalPart()
        {
            var uid = Guid.NewGuid();
            var got = ForwardAuthResolver.Resolve(
                new[] { "Cf-Access-Authenticated-User-Email" },
                _ => "alice@example.com",
                u => u == "alice" ? uid : Guid.Empty); // username == email local-part
            Assert.Equal(uid, got);
        }

        [Fact]
        public void ForwardAuth_EmailHeader_MatchesFullEmailAsUsername()
        {
            var uid = Guid.NewGuid();
            var got = ForwardAuthResolver.Resolve(
                new[] { "Remote-Email" },
                _ => "carol@example.com",
                u => u == "carol@example.com" ? uid : Guid.Empty);
            Assert.Equal(uid, got);
        }

        [Fact]
        public void ForwardAuth_NoMatchingUser_ReturnsEmpty()
        {
            var got = ForwardAuthResolver.Resolve(
                new[] { "Remote-User" },
                _ => "ghost",
                _ => Guid.Empty);
            Assert.Equal(Guid.Empty, got);
        }

        // ─── ForwardedHeaderParser ───────────────────────────────────────────

        [Theory]
        [InlineData("X-Forwarded-For", "203.0.113.5", "203.0.113.5")]
        [InlineData("X-Forwarded-For", "203.0.113.5, 10.0.0.1", "10.0.0.1")] // rightmost = proxy-appended
        [InlineData("X-Real-IP", "203.0.113.9", "203.0.113.9")]
        public void ForwardedParser_ExtractsRealIp(string header, string value, string expected)
        {
            var ip = ForwardedHeaderParser.ExtractRealClientIp(n => n == header ? value : null);
            Assert.Equal(IPAddress.Parse(expected), ip);
        }

        [Fact]
        public void ForwardedParser_RfcForwarded_TakesRightmostFor()
        {
            var ip = ForwardedHeaderParser.ExtractRealClientIp(
                n => n == "Forwarded" ? "for=203.0.113.1, for=198.51.100.2" : null);
            Assert.Equal(IPAddress.Parse("198.51.100.2"), ip);
        }

        [Fact]
        public void ForwardedParser_NoHeaders_Null()
        {
            Assert.Null(ForwardedHeaderParser.ExtractRealClientIp(_ => null));
        }

        // ─── XffLearnedMap ───────────────────────────────────────────────────

        [Fact]
        public void XffMap_ObserveThenResolve_ReturnsCandidate()
        {
            var map = new XffLearnedMap();
            var uid = Guid.NewGuid();
            map.Observe("203.0.113.5", uid);
            Assert.Contains(uid, map.Resolve("203.0.113.5"));
            Assert.Empty(map.Resolve("203.0.113.6"));
        }

        [Fact]
        public void XffMap_MultipleUsersOneIp_AllCandidates()
        {
            var map = new XffLearnedMap();
            var a = Guid.NewGuid();
            var b = Guid.NewGuid();
            map.Observe("10.0.0.1", a);
            map.Observe("10.0.0.1", b);
            var got = map.Resolve("10.0.0.1");
            Assert.Contains(a, got);
            Assert.Contains(b, got);
        }

        [Fact]
        public void XffMap_ExpiredEntry_DroppedFromResolve()
        {
            var now = DateTime.UtcNow;
            var clock = now;
            var map = new XffLearnedMap(() => clock);
            var uid = Guid.NewGuid();
            map.Observe("10.0.0.1", uid);
            clock = now.AddMinutes(31); // past the 30-minute TTL
            Assert.Empty(map.Resolve("10.0.0.1"));
        }

        // ─── Ladder integration: tier ordering + gating ──────────────────────

        [Fact]
        public void ForwardAuthTier_RequiresTrustedProxyAndEnable()
        {
            var user = new User("sso-user", "Prov", "PwProv");
            var users = new StubUserManager(user, new User("other", "Prov", "PwProv"));
            var config = new PluginConfiguration
            {
                IdentityForwardAuthEnabled = true,
                IdentityTrustedProxies = "10.0.0.0/8",
                IdentityForwardAuthHeaders = "Remote-User",
            };
            var identity = NewResolver(config, users, out _);

            // From the trusted proxy: header is honored → authoritative.
            var trusted = new DefaultHttpContext();
            trusted.Connection.RemoteIpAddress = IPAddress.Parse("10.1.2.3");
            trusted.Request.Headers["Remote-User"] = "sso-user";
            var viaSso = identity.Resolve(trusted);
            Assert.Equal(IdentityConfidence.ForwardAuthHeader, viaSso.Confidence);
            Assert.Equal(new[] { user.Id }, viaSso.Candidates);

            // Same header from a NON-trusted peer must be ignored (forgeable).
            var untrusted = new DefaultHttpContext();
            untrusted.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.9");
            untrusted.Request.Headers["Remote-User"] = "sso-user";
            Assert.NotEqual(IdentityConfidence.ForwardAuthHeader, identity.Resolve(untrusted).Confidence);
        }

        [Fact]
        public void ForwardAuthTier_DisabledByDefault()
        {
            var user = new User("sso-user", "Prov", "PwProv");
            var users = new StubUserManager(user, new User("other", "Prov", "PwProv"));
            var config = new PluginConfiguration { IdentityTrustedProxies = "10.0.0.0/8" }; // enable flag off
            var identity = NewResolver(config, users, out _);

            var ctx = new DefaultHttpContext();
            ctx.Connection.RemoteIpAddress = IPAddress.Parse("10.1.2.3");
            ctx.Request.Headers["Remote-User"] = "sso-user";
            Assert.NotEqual(IdentityConfidence.ForwardAuthHeader, identity.Resolve(ctx).Confidence);
        }

        [Fact]
        public void AuthenticatedTier_StillBeatsForwardAuth()
        {
            var user = new User("both-user", "Prov", "PwProv");
            var users = new StubUserManager(user, new User("other", "Prov", "PwProv"));
            var config = new PluginConfiguration
            {
                IdentityForwardAuthEnabled = true,
                IdentityTrustedProxies = "10.0.0.0/8",
                IdentityForwardAuthHeaders = "Remote-User",
            };
            var identity = NewResolver(config, users, out _);

            var principal = new ClaimsPrincipal(new ClaimsIdentity(
                new[] { new Claim("Jellyfin-UserId", user.Id.ToString()) }, "TestAuth"));
            var ctx = new DefaultHttpContext { User = principal };
            ctx.Connection.RemoteIpAddress = IPAddress.Parse("10.1.2.3");
            ctx.Request.Headers["Remote-User"] = "other";
            Assert.Equal(IdentityConfidence.Authenticated, identity.Resolve(ctx).Confidence);
        }

        [Fact]
        public void SignedCookieTier_TrustsWithoutSessionOnIp()
        {
            const string secret = "a-sufficiently-long-secret-value";
            var user = new User("cookie-user", "Prov", "PwProv");
            var users = new StubUserManager(user, new User("other", "Prov", "PwProv"));
            var config = new PluginConfiguration
            {
                IdentitySignedCookieEnabled = true,
                IdentityCookieSecret = secret,
            };
            var identity = NewResolver(config, users, out _);

            var ctx = new DefaultHttpContext();
            ctx.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.50"); // no session here
            ctx.Request.Headers["Cookie"] =
                IdentityCookieSigner.CookieName + "=" + IdentityCookieSigner.Sign(user.Id, secret, DateTime.UtcNow);
            var res = identity.Resolve(ctx);
            Assert.Equal(IdentityConfidence.SignedCookie, res.Confidence);
            Assert.Equal(new[] { user.Id }, res.Candidates);
        }

        [Fact]
        public void SignedCookieTier_ForgedCookie_FallsThrough()
        {
            var user = new User("cookie-user", "Prov", "PwProv");
            var users = new StubUserManager(user, new User("other", "Prov", "PwProv"));
            var config = new PluginConfiguration
            {
                IdentitySignedCookieEnabled = true,
                IdentityCookieSecret = "a-sufficiently-long-secret-value",
            };
            var identity = NewResolver(config, users, out _);

            var ctx = new DefaultHttpContext();
            ctx.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.50");
            // Cookie signed with the WRONG secret.
            ctx.Request.Headers["Cookie"] =
                IdentityCookieSigner.CookieName + "=" + IdentityCookieSigner.Sign(user.Id, "a-totally-different-secret", DateTime.UtcNow);
            Assert.NotEqual(IdentityConfidence.SignedCookie, identity.Resolve(ctx).Confidence);
        }

        [Fact]
        public void XffTier_LearnsFromAuthedThenResolvesAnonymous()
        {
            var user = new User("xff-user", "Prov", "PwProv");
            var users = new StubUserManager(user, new User("other", "Prov", "PwProv"));
            var config = new PluginConfiguration
            {
                IdentityXffLearnedMapEnabled = true,
                IdentityTrustedProxies = "10.0.0.0/8",
            };
            var identity = NewResolver(config, users, out _);

            // Authenticated request through the proxy carrying the real client IP.
            var principal = new ClaimsPrincipal(new ClaimsIdentity(
                new[] { new Claim("Jellyfin-UserId", user.Id.ToString()) }, "TestAuth"));
            var authed = new DefaultHttpContext { User = principal };
            authed.Connection.RemoteIpAddress = IPAddress.Parse("10.0.0.9"); // trusted proxy
            authed.Request.Headers["X-Forwarded-For"] = "203.0.113.77";
            Assert.Equal(IdentityConfidence.Authenticated, identity.Resolve(authed).Confidence);

            // Anonymous request from the SAME real IP → learned candidate.
            var anon = new DefaultHttpContext();
            anon.Connection.RemoteIpAddress = IPAddress.Parse("10.0.0.9");
            anon.Request.Headers["X-Forwarded-For"] = "203.0.113.77";
            var res = identity.Resolve(anon);
            Assert.Equal(IdentityConfidence.SharedIpCandidates, res.Confidence);
            Assert.Contains(user.Id, res.Candidates);
        }

        [Fact]
        public void XffTier_DisabledByDefault_NoLearning()
        {
            var user = new User("xff-user", "Prov", "PwProv");
            var users = new StubUserManager(user, new User("other", "Prov", "PwProv"));
            var config = new PluginConfiguration { IdentityTrustedProxies = "10.0.0.0/8" }; // xff flag off
            var identity = NewResolver(config, users, out _);

            var principal = new ClaimsPrincipal(new ClaimsIdentity(
                new[] { new Claim("Jellyfin-UserId", user.Id.ToString()) }, "TestAuth"));
            var authed = new DefaultHttpContext { User = principal };
            authed.Connection.RemoteIpAddress = IPAddress.Parse("10.0.0.9");
            authed.Request.Headers["X-Forwarded-For"] = "203.0.113.77";
            identity.Resolve(authed);

            var anon = new DefaultHttpContext();
            anon.Connection.RemoteIpAddress = IPAddress.Parse("10.0.0.9");
            anon.Request.Headers["X-Forwarded-For"] = "203.0.113.77";
            Assert.Equal(IdentityConfidence.None, identity.Resolve(anon).Confidence);
        }
    }
}
