using System.Security.Claims;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Services.Identity;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class AuthenticatedUserClaimResolverTests
{
    [Fact]
    public void Resolve_AcceptsExactlyOneCaseInsensitiveAuthenticatedClaim()
    {
        var userId = Guid.NewGuid();
        var principal = Principal(
            true,
            new Claim("jElLyFiN-uSeRiD", userId.ToString("N")));

        Assert.Equal(userId, AuthenticatedUserClaimResolver.Resolve(principal));
        Assert.Equal(userId, UserHelper.GetCurrentUserId(principal));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("not-a-guid")]
    [InlineData("00000000-0000-0000-0000-000000000000")]
    [InlineData("00000000000000000000000000000000")]
    [InlineData(" 11111111-1111-1111-1111-111111111111")]
    [InlineData("11111111-1111-1111-1111-111111111111 ")]
    public void Resolve_RejectsMissingEmptyMalformedZeroOrPaddedClaims(string? raw)
    {
        var claims = raw is null
            ? Array.Empty<Claim>()
            : new[] { new Claim("Jellyfin-UserId", raw) };
        var principal = Principal(true, claims);

        Assert.Null(AuthenticatedUserClaimResolver.Resolve(principal));
        Assert.Null(UserHelper.GetCurrentUserId(principal));
    }

    [Fact]
    public void Resolve_RejectsAnUnauthenticatedForgedClaim()
    {
        var principal = Principal(
            false,
            new Claim("Jellyfin-UserId", Guid.NewGuid().ToString()));

        Assert.Null(AuthenticatedUserClaimResolver.Resolve(principal));
        Assert.Null(UserHelper.GetCurrentUserId(principal));
    }

    [Fact]
    public void Resolve_RejectsDuplicateSameAndConflictingClaimsAcrossCaseAndIdentities()
    {
        var userA = Guid.NewGuid();
        var userB = Guid.NewGuid();
        var duplicateSame = Principal(
            true,
            new Claim("Jellyfin-UserId", userA.ToString()),
            new Claim("jellyfin-userid", userA.ToString()));
        var duplicateConflicting = new ClaimsPrincipal(new[]
        {
            new ClaimsIdentity(
                new[] { new Claim("Jellyfin-UserId", userA.ToString()) },
                "PrimaryAuth"),
            new ClaimsIdentity(
                new[] { new Claim("JELLYFIN-USERID", userB.ToString()) },
                "SecondaryAuth"),
        });

        Assert.Null(AuthenticatedUserClaimResolver.Resolve(duplicateSame));
        Assert.Null(AuthenticatedUserClaimResolver.Resolve(duplicateConflicting));
        Assert.Null(UserHelper.GetCurrentUserId(duplicateSame));
        Assert.Null(UserHelper.GetCurrentUserId(duplicateConflicting));
    }

    [Fact]
    public void Resolve_RejectsClaimsOwnedByUnauthenticatedIdentities()
    {
        var userId = Guid.NewGuid();
        var claimOnUnauthenticatedIdentity = new ClaimsPrincipal(new[]
        {
            new ClaimsIdentity(authenticationType: "PrimaryAuth"),
            new ClaimsIdentity(new[] { new Claim("Jellyfin-UserId", userId.ToString()) }),
        });
        var validPlusUnauthenticatedDuplicate = new ClaimsPrincipal(new[]
        {
            new ClaimsIdentity(
                new[] { new Claim("Jellyfin-UserId", userId.ToString()) },
                "PrimaryAuth"),
            new ClaimsIdentity(new[] { new Claim("jellyfin-userid", userId.ToString()) }),
        });
        var unauthenticatedPrimaryWithAuthenticatedClaimOwner = new ClaimsPrincipal(new[]
        {
            new ClaimsIdentity(),
            new ClaimsIdentity(
                new[] { new Claim("Jellyfin-UserId", userId.ToString()) },
                "SecondaryAuth"),
        });

        Assert.Null(AuthenticatedUserClaimResolver.Resolve(claimOnUnauthenticatedIdentity));
        Assert.Null(AuthenticatedUserClaimResolver.Resolve(validPlusUnauthenticatedDuplicate));
        Assert.Null(AuthenticatedUserClaimResolver.Resolve(unauthenticatedPrimaryWithAuthenticatedClaimOwner));
    }

    [Fact]
    public void GetUserId_RejectsElevatedPrincipalWithoutCanonicalActor()
    {
        var target = Guid.NewGuid();
        foreach (var principal in new[]
        {
            Principal(true, new Claim(ClaimTypes.Role, "Administrator")),
            Principal(
                true,
                new Claim(ClaimTypes.Role, "Administrator"),
                new Claim(ClaimTypes.NameIdentifier, Guid.NewGuid().ToString())),
            Principal(
                true,
                new Claim(ClaimTypes.Role, "Administrator"),
                new Claim("sub", Guid.NewGuid().ToString())),
            Principal(
                true,
                new Claim(ClaimTypes.Role, "Administrator"),
                new Claim("Sid", Guid.NewGuid().ToString())),
            Principal(
                false,
                new Claim(ClaimTypes.Role, "Administrator"),
                new Claim("Jellyfin-UserId", Guid.NewGuid().ToString())),
            Principal(
                true,
                new Claim(ClaimTypes.Role, "Administrator"),
                new Claim("Jellyfin-UserId", "malformed")),
            Principal(
                true,
                new Claim(ClaimTypes.Role, "Administrator"),
                new Claim("Jellyfin-UserId", Guid.NewGuid().ToString()),
                new Claim("jellyfin-userid", Guid.NewGuid().ToString())),
        })
        {
            Assert.Null(UserHelper.GetUserId(principal, target));
        }
    }

    [Fact]
    public void GetUserId_RequiresCanonicalActorBeforeSelfOrElevatedTargetSelection()
    {
        var actor = Guid.NewGuid();
        var target = Guid.NewGuid();
        var user = Principal(true, new Claim("Jellyfin-UserId", actor.ToString()));
        var admin = Principal(
            true,
            new Claim("Jellyfin-UserId", actor.ToString()),
            new Claim(ClaimTypes.Role, "Administrator"));

        Assert.Equal(actor, UserHelper.GetUserId(user, null));
        Assert.Equal(actor, UserHelper.GetUserId(user, Guid.Empty));
        Assert.Equal(actor, UserHelper.GetUserId(user, actor));
        Assert.Null(UserHelper.GetUserId(user, target));
        Assert.Equal(target, UserHelper.GetUserId(admin, target));
    }

    [Fact]
    public void GetUserId_RequiresAdministratorRoleOnTheCanonicalIdentity()
    {
        var actor = Guid.NewGuid();
        var target = Guid.NewGuid();
        var canonicalClaims = new[] { new Claim("Jellyfin-UserId", actor.ToString()) };
        var secondaryAuthenticatedRole = new ClaimsPrincipal(new[]
        {
            new ClaimsIdentity(canonicalClaims, "PrimaryAuth"),
            new ClaimsIdentity(
                new[] { new Claim(ClaimTypes.Role, "Administrator") },
                "SecondaryAuth"),
        });
        var secondaryUnauthenticatedRole = new ClaimsPrincipal(new[]
        {
            new ClaimsIdentity(canonicalClaims, "PrimaryAuth"),
            new ClaimsIdentity(new[] { new Claim(ClaimTypes.Role, "Administrator") }),
        });

        Assert.Null(UserHelper.GetUserId(secondaryAuthenticatedRole, target));
        Assert.Null(UserHelper.GetUserId(secondaryUnauthenticatedRole, target));
    }

    private static ClaimsPrincipal Principal(bool authenticated, params Claim[] claims)
        => new(new ClaimsIdentity(claims, authenticated ? "TestAuth" : null));
}
