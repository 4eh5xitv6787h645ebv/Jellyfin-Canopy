using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration;

public sealed class RatingTagScopePolicyTests
{
    [Fact]
    public void DefaultsAndLegacyEmptyShapesPreserveAllScopes()
    {
        AssertEmptyV1(new PluginConfiguration().RatingTagScopePolicy);
        AssertEmptyV1(new UserSettings().RatingTagScopeOverrides);

        Assert.True(RatingTagScopePolicyV1.TryNormalize(null, out var missing));
        AssertEmptyV1(missing);

        Assert.True(RatingTagScopePolicyV1.TryNormalize(
            new RatingTagScopePolicy
            {
                Version = 0,
                DisabledItemTypes = new List<string>(),
                DisabledSurfaces = new List<string>()
            },
            out var versionZero));
        AssertEmptyV1(versionZero);
    }

    [Fact]
    public void ParserCanonicalizesCaseWhitespaceDuplicatesAndSchemaOrder()
    {
        var input = new RatingTagScopePolicy
        {
            Version = 1,
            DisabledItemTypes = new List<string> { " episode ", "movie", "EPISODE" },
            DisabledSurfaces = new List<string> { "other", " nextup ", "OTHER" }
        };

        Assert.True(RatingTagScopePolicyV1.TryNormalize(input, out var normalized));

        Assert.NotSame(input, normalized);
        Assert.Equal(1, normalized.Version);
        Assert.Equal(new[] { "Movie", "Episode" }, normalized.DisabledItemTypes);
        Assert.Equal(new[] { "NextUp", "Other" }, normalized.DisabledSurfaces);
        Assert.Equal(new[] { " episode ", "movie", "EPISODE" }, input.DisabledItemTypes);
    }

    [Fact]
    public void AdministratorSaveCanonicalizesLegacyAndValidPolicies()
    {
        var legacy = new PluginConfiguration { RatingTagScopePolicy = null! };
        JellyfinCanopy.NormalizeRatingTagScopePolicyForUpdate(legacy);
        AssertEmptyV1(legacy.RatingTagScopePolicy);

        var configured = new PluginConfiguration
        {
            RatingTagScopePolicy = new RatingTagScopePolicy
            {
                Version = 1,
                DisabledItemTypes = new List<string> { "boxset", " EPISODE " },
                DisabledSurfaces = new List<string> { "continuewatching", "NEXTUP" }
            }
        };

        JellyfinCanopy.NormalizeRatingTagScopePolicyForUpdate(configured);

        Assert.Equal(new[] { "Episode", "BoxSet" }, configured.RatingTagScopePolicy.DisabledItemTypes);
        Assert.Equal(
            new[] { "NextUp", "ContinueWatching" },
            configured.RatingTagScopePolicy.DisabledSurfaces);
    }

    [Fact]
    public void AdministratorAndUserSchemasRejectMalformedUnknownAndOversizedPolicies()
    {
        foreach (var invalid in InvalidPolicies())
        {
            var admin = new PluginConfiguration { RatingTagScopePolicy = invalid };
            Assert.Throws<ArgumentException>(() =>
                JellyfinCanopy.NormalizeRatingTagScopePolicyForUpdate(admin));

            var user = new UserSettings { RatingTagScopeOverrides = invalid };
            Assert.Equal(
                PersistedPayloadStatus.Invalid,
                PersistedPayloadPolicy.Validate(user).Status);
        }
    }

    [Fact]
    public void UserPersistenceAcceptsCanonicalizableBoundedPolicy()
    {
        var settings = new UserSettings
        {
            RatingTagScopeOverrides = new RatingTagScopePolicy
            {
                Version = 1,
                DisabledItemTypes = new List<string> { " episode ", "movie" },
                DisabledSurfaces = new List<string> { "nextup", "OTHER" }
            }
        };

        Assert.True(PersistedPayloadPolicy.Validate(settings).IsValid);
        Assert.True(RatingTagScopePolicyV1.TryNormalize(
            settings.RatingTagScopeOverrides,
            out var normalized));
        Assert.Equal(new[] { "Movie", "Episode" }, normalized.DisabledItemTypes);
        Assert.Equal(new[] { "NextUp", "Other" }, normalized.DisabledSurfaces);
    }

    private static IEnumerable<RatingTagScopePolicy> InvalidPolicies()
    {
        yield return new RatingTagScopePolicy { Version = 2 };
        yield return new RatingTagScopePolicy
        {
            Version = 0,
            DisabledItemTypes = new List<string> { "Episode" }
        };
        yield return new RatingTagScopePolicy
        {
            Version = 1,
            DisabledItemTypes = null!
        };
        yield return new RatingTagScopePolicy
        {
            Version = 1,
            DisabledSurfaces = null!
        };
        yield return new RatingTagScopePolicy
        {
            Version = 1,
            DisabledItemTypes = new List<string> { null! }
        };
        yield return new RatingTagScopePolicy
        {
            Version = 1,
            DisabledItemTypes = new List<string> { "Person" }
        };
        yield return new RatingTagScopePolicy
        {
            Version = 1,
            DisabledSurfaces = new List<string> { "#homePage .section" }
        };
        yield return new RatingTagScopePolicy
        {
            Version = 1,
            DisabledItemTypes = Enumerable.Repeat("Movie", RatingTagScopePolicyV1.ItemTypes.Count + 1).ToList()
        };
        yield return new RatingTagScopePolicy
        {
            Version = 1,
            DisabledSurfaces = Enumerable.Repeat("Other", RatingTagScopePolicyV1.Surfaces.Count + 1).ToList()
        };
    }

    private static void AssertEmptyV1(RatingTagScopePolicy policy)
    {
        Assert.Equal(1, policy.Version);
        Assert.Empty(policy.DisabledItemTypes);
        Assert.Empty(policy.DisabledSurfaces);
    }
}
