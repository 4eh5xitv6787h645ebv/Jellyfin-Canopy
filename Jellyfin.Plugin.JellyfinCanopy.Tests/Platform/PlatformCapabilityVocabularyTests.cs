using System;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformCapabilityVocabularyTests
{
    private sealed record ExpectedDefinition(
        string Id,
        PlatformCapabilityDomain Domain,
        string ActorKinds,
        bool RequiresElevation = false);

    private static readonly string[] ExpectedIds =
    [
        "jellyfin.canopy.discovery.read",
        "jellyfin.canopy.items.lookup",
        "jellyfin.canopy.user-data.read",
        "jellyfin.canopy.events.subscribe",
        "jellyfin.canopy.storage.read",
        "jellyfin.canopy.ui.contribute",
        "jellyfin.canopy.integrations.invoke",
        "jellyfin.canopy.administration.manage",
        "jellyfin.canopy.diagnostics.read",
    ];

    [Fact]
    public void VocabularyIsTheExactOrderedV1Golden()
    {
        var actual = PlatformCapabilityVocabulary.All
            .Select(definition => new ExpectedDefinition(
                definition.Id.Value,
                definition.Domain,
                string.Join(",", definition.AllowedActorKinds),
                definition.RequiresElevation))
            .ToArray();

        Assert.Equal(
            new[]
            {
                new ExpectedDefinition("jellyfin.canopy.discovery.read", PlatformCapabilityDomain.Discovery, "JellyfinUserClient"),
                new ExpectedDefinition("jellyfin.canopy.items.lookup", PlatformCapabilityDomain.ItemLookup, "JellyfinUserClient,InstalledProvider"),
                new ExpectedDefinition("jellyfin.canopy.user-data.read", PlatformCapabilityDomain.UserData, "JellyfinUserClient,InstalledProvider"),
                new ExpectedDefinition("jellyfin.canopy.events.subscribe", PlatformCapabilityDomain.Events, "CompanionService"),
                new ExpectedDefinition("jellyfin.canopy.storage.read", PlatformCapabilityDomain.Storage, "JellyfinUserClient,InstalledProvider"),
                new ExpectedDefinition("jellyfin.canopy.ui.contribute", PlatformCapabilityDomain.UiContributions, "InstalledProvider"),
                new ExpectedDefinition("jellyfin.canopy.integrations.invoke", PlatformCapabilityDomain.IntegrationActions, "JellyfinUserClient,InstalledProvider"),
                new ExpectedDefinition("jellyfin.canopy.administration.manage", PlatformCapabilityDomain.Administration, "JellyfinUserClient", true),
                new ExpectedDefinition("jellyfin.canopy.diagnostics.read", PlatformCapabilityDomain.Diagnostics, "JellyfinUserClient", true),
            },
            actual);
    }

    [Fact]
    public void VocabularyPinsCountOrderDomainsAndExactResolution()
    {
        Assert.Equal(9, PlatformCapabilityVocabulary.MaximumCapabilityCount);
        Assert.Equal(ExpectedIds, PlatformCapabilityVocabulary.All.Select(value => value.Id.Value));
        Assert.Equal(
            new[]
            {
                PlatformCapabilityDomain.Discovery,
                PlatformCapabilityDomain.ItemLookup,
                PlatformCapabilityDomain.UserData,
                PlatformCapabilityDomain.Events,
                PlatformCapabilityDomain.Storage,
                PlatformCapabilityDomain.UiContributions,
                PlatformCapabilityDomain.IntegrationActions,
                PlatformCapabilityDomain.Administration,
                PlatformCapabilityDomain.Diagnostics,
            },
            Enum.GetValues<PlatformCapabilityDomain>());

        Assert.Equal(
            PlatformCapabilityVocabulary.All.Length,
            PlatformCapabilityVocabulary.All.Select(value => value.Id.Value).Distinct(StringComparer.Ordinal).Count());
        Assert.Equal(
            PlatformCapabilityVocabulary.All.Length,
            PlatformCapabilityVocabulary.All.Select(value => value.Domain).Distinct().Count());

        foreach (var definition in PlatformCapabilityVocabulary.All)
        {
            Assert.Same(definition, PlatformCapabilityVocabulary.Find(definition.Id.Value));
        }
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("jellyfin.canopy.unknown.read")]
    [InlineData("JELLYFIN.CANOPY.DISCOVERY.READ")]
    [InlineData("jellyfin.canopy.discovery.*")]
    [InlineData("jellyfin.canopy.discovery")]
    [InlineData(" jellyfin.canopy.discovery.read")]
    [InlineData("jellyfin.canopy.discovery.read ")]
    public void FindRejectsUnknownMalformedWildcardAndCaseVariantValues(string? value)
        => Assert.Null(PlatformCapabilityVocabulary.Find(value));

    [Theory]
    [InlineData("jellyfin.canopy.discovery.read")]
    [InlineData("jellyfin.canopy.user-data.read")]
    [InlineData("jellyfin.canopy.a.a")]
    [InlineData("jellyfin.canopy.a1-b2.c3-d4")]
    public void IdentifierGrammarAcceptsOnlyTheExactFourSegmentNamespace(string value)
        => Assert.True(PlatformCapabilityVocabulary.IsValidIdentifier(value));

    [Theory]
    [InlineData("jellyfin.canopy.discovery")]
    [InlineData("jellyfin.canopy.discovery.read.extra")]
    [InlineData("vendor.canopy.discovery.read")]
    [InlineData("jellyfin.other.discovery.read")]
    [InlineData("Jellyfin.canopy.discovery.read")]
    [InlineData("jellyfin.canopy.Discovery.read")]
    [InlineData("jellyfin.canopy.1discovery.read")]
    [InlineData("jellyfin.canopy.discovery.1read")]
    [InlineData("jellyfin.canopy.-discovery.read")]
    [InlineData("jellyfin.canopy.discovery-.read")]
    [InlineData("jellyfin.canopy.discovery.-read")]
    [InlineData("jellyfin.canopy.discovery.read-")]
    [InlineData("jellyfin.canopy.user--data.read")]
    [InlineData("jellyfin.canopy.discovery.read_write")]
    [InlineData("jellyfin.canopy.discovery/read")]
    [InlineData("jellyfin.canopy.discovery:read")]
    [InlineData("jellyfin.canopy.discovéry.read")]
    [InlineData("jellyfin.canopy.discovery.reаd")]
    [InlineData("jellyfin.canopy.discovery.*")]
    [InlineData("jellyfin.canopy.*.read")]
    [InlineData("jellyfin.canopy.discovery.**")]
    public void IdentifierGrammarRejectsOpenEndedNonAsciiOrMalformedValues(string value)
        => Assert.False(PlatformCapabilityVocabulary.IsValidIdentifier(value));

    [Fact]
    public void IdentifierGrammarPinsSegmentCountAndBothLengthBoundaries()
    {
        Assert.Equal(4, PlatformCapabilityVocabulary.IdentifierSegmentCount);
        Assert.Equal(64, PlatformCapabilityVocabulary.MaximumVariableSegmentLength);
        Assert.Equal(128, PlatformCapabilityVocabulary.MaximumIdentifierLength);

        var maximumDomain = "jellyfin.canopy." + new string('a', 64) + ".read";
        var overlongDomain = "jellyfin.canopy." + new string('a', 65) + ".read";
        var maximumIdentifier = "jellyfin.canopy." + new string('a', 55) + "." + new string('b', 56);

        Assert.True(PlatformCapabilityVocabulary.IsValidIdentifier(maximumDomain));
        Assert.False(PlatformCapabilityVocabulary.IsValidIdentifier(overlongDomain));
        Assert.Equal(128, maximumIdentifier.Length);
        Assert.True(PlatformCapabilityVocabulary.IsValidIdentifier(maximumIdentifier));
        Assert.False(PlatformCapabilityVocabulary.IsValidIdentifier(maximumIdentifier + "b"));
    }

    [Fact]
    public void AdministrationAndDiagnosticsCannotBeDefinedWithoutElevation()
    {
        var constructor = Assert.Single(typeof(PlatformCapabilityDefinition).GetConstructors(
            BindingFlags.Instance | BindingFlags.NonPublic));
        var id = PlatformCapabilityVocabulary.Find("jellyfin.canopy.administration.manage")!.Id;
        var userKind = ImmutableArray.Create(PlatformActorKind.JellyfinUserClient);

        foreach (var domain in new[]
        {
            PlatformCapabilityDomain.Administration,
            PlatformCapabilityDomain.Diagnostics,
        })
        {
            var exception = Assert.Throws<TargetInvocationException>(() => constructor.Invoke(
                new object[] { id, domain, userKind, false }));
            Assert.IsType<ArgumentException>(exception.InnerException);
        }
    }

    [Fact]
    public void RequestedAndGrantedSetsAreDistinctBoundedCanonicalTypes()
    {
        Assert.NotEqual(typeof(PlatformRequestedCapabilitySet), typeof(PlatformGrantedCapabilitySet));
        Assert.Null(default(PlatformRequestedCapabilitySet));
        Assert.Null(default(PlatformGrantedCapabilitySet));
        Assert.True(PlatformGrantedCapabilitySet.Missing.IsValid);

        Assert.True(PlatformRequestedCapabilitySet.TryCreate(
            ExpectedIds.Reverse().ToArray(),
            out var requested));
        Assert.True(PlatformGrantedCapabilitySet.TryCreate(
            ExpectedIds.Reverse().ToArray(),
            out var granted));

        Assert.Equal(ExpectedIds, requested.Capabilities.Select(value => value.Id.Value));
        Assert.Equal(ExpectedIds, granted.Capabilities.Select(value => value.Id.Value));
        Assert.True(granted.IsPresent);
        Assert.False(PlatformGrantedCapabilitySet.Missing.IsPresent);
    }

    [Fact]
    public void SetFactoriesRejectNullDefaultDuplicateUnknownCaseVariantAndOverBoundInputs()
    {
        Assert.False(PlatformRequestedCapabilitySet.TryCreate(null, out _));
        Assert.False(PlatformGrantedCapabilitySet.TryCreate(null, out _));
        Assert.False(PlatformRequestedCapabilitySet.TryCreate(
            new[] { ExpectedIds[0], ExpectedIds[0] },
            out _));
        Assert.False(PlatformGrantedCapabilitySet.TryCreate(
            new[] { ExpectedIds[0], ExpectedIds[0] },
            out _));

        foreach (var invalid in new[]
        {
            "jellyfin.canopy.unknown.read",
            "JELLYFIN.CANOPY.DISCOVERY.READ",
            "jellyfin.canopy.discovery.*",
            "jellyfin.canopy.discovery",
        })
        {
            Assert.False(PlatformRequestedCapabilitySet.TryCreate(new[] { invalid }, out _));
            Assert.False(PlatformGrantedCapabilitySet.TryCreate(new[] { invalid }, out _));
        }

        var overBound = ExpectedIds.Concat(new[] { ExpectedIds[0] }).ToArray();
        Assert.Equal(PlatformCapabilityVocabulary.MaximumCapabilityCount + 1, overBound.Length);
        Assert.False(PlatformRequestedCapabilitySet.TryCreate(overBound, out _));
        Assert.False(PlatformGrantedCapabilitySet.TryCreate(overBound, out _));
    }
}
