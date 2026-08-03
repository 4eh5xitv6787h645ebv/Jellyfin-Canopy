using System;
using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformGrantCeilingEvaluatorTests
{
    private const string Discovery = "jellyfin.canopy.discovery.read";
    private const string Items = "jellyfin.canopy.items.lookup";
    private const string UserData = "jellyfin.canopy.user-data.read";
    private const string Events = "jellyfin.canopy.events.subscribe";
    private const string Storage = "jellyfin.canopy.storage.read";
    private const string Ui = "jellyfin.canopy.ui.contribute";
    private const string Integrations = "jellyfin.canopy.integrations.invoke";
    private const string Administration = "jellyfin.canopy.administration.manage";
    private const string Diagnostics = "jellyfin.canopy.diagnostics.read";

    [Fact]
    public void RequestedGrantedAndCurrentAuthorityIntersectionIsFailClosed()
    {
        var preview = Evaluate(
            Requested(Administration, Events, Items, Discovery),
            Granted(Administration, Events, Items),
            User(elevated: false));

        Assert.Equal(PlatformGrantEvaluationStatus.Valid, preview.Status);
        Assert.Equal(
            new[]
            {
                Decision(Discovery, false, PlatformGrantDecisionReason.MissingGrant),
                Decision(Items, true, PlatformGrantDecisionReason.Allowed),
                Decision(Events, false, PlatformGrantDecisionReason.ActorKindNotAllowed),
                Decision(Administration, false, PlatformGrantDecisionReason.ElevationRequired),
            },
            preview.Decisions.Select(value => Decision(
                value.Capability.Id.Value,
                value.IsAllowed,
                value.Reason)));
    }

    [Fact]
    public void MissingAndPresentEmptyGrantSetsDenyEveryRequestedCapability()
    {
        foreach (var grants in new[]
        {
            PlatformGrantedCapabilitySet.Missing,
            Granted(),
        })
        {
            var preview = Evaluate(Requested(Discovery, Items), grants, User(elevated: true));

            Assert.Equal(PlatformGrantEvaluationStatus.Valid, preview.Status);
            Assert.All(preview.Decisions, decision =>
            {
                Assert.False(decision.IsAllowed);
                Assert.Equal(PlatformGrantDecisionReason.MissingGrant, decision.Reason);
            });
        }
    }

    [Fact]
    public void UnrequestedGrantInvalidatesTheWholeRecordAndDeniesTheDeterministicUnion()
    {
        var preview = Evaluate(
            Requested(Administration, Discovery),
            Granted(Items, Administration, Discovery),
            User(elevated: true));

        Assert.Equal(PlatformGrantEvaluationStatus.InvalidGrantSet, preview.Status);
        Assert.Equal(
            new[] { Discovery, Items, Administration },
            preview.Decisions.Select(value => value.Capability.Id.Value));
        Assert.All(preview.Decisions, decision =>
        {
            Assert.False(decision.IsAllowed);
            Assert.Equal(PlatformGrantDecisionReason.InvalidGrantRecord, decision.Reason);
        });
    }

    [Fact]
    public void DefaultInputsAndUnknownAuthorityReturnNoPartialPreview()
    {
        var validRequested = Requested(Discovery);
        var validGranted = Granted(Discovery);

        AssertInvalid(
            Evaluate(null, validGranted, User(elevated: false)),
            PlatformGrantEvaluationStatus.InvalidRequestedSet);
        AssertInvalid(
            Evaluate(validRequested, null, User(elevated: false)),
            PlatformGrantEvaluationStatus.InvalidGrantSet);
        AssertInvalid(
            Evaluate(validRequested, validGranted, default),
            PlatformGrantEvaluationStatus.InvalidActorAuthority);

        static void AssertInvalid(
            PlatformGrantPreview preview,
            PlatformGrantEvaluationStatus expected)
        {
            Assert.Equal(expected, preview.Status);
            Assert.Empty(preview.Decisions);
        }
    }

    [Fact]
    public void FailedFactoriesReturnSentinelsThatRemainInvalidAtEvaluation()
    {
        Assert.False(PlatformRequestedCapabilitySet.TryCreate(
            new[] { "jellyfin.canopy.unknown.read" },
            out var invalidRequested));
        Assert.False(PlatformGrantedCapabilitySet.TryCreate(
            new[] { Discovery, Discovery },
            out var invalidGranted));
        Assert.NotNull(invalidRequested);
        Assert.NotNull(invalidGranted);

        var requested = Requested(Discovery);
        var granted = Granted(Discovery);
        var authority = User(elevated: false);

        var requestedPreview = Evaluate(invalidRequested, granted, authority);
        Assert.Equal(PlatformGrantEvaluationStatus.InvalidRequestedSet, requestedPreview.Status);
        Assert.Empty(requestedPreview.Decisions);

        var grantedPreview = Evaluate(requested, invalidGranted, authority);
        Assert.Equal(PlatformGrantEvaluationStatus.InvalidGrantSet, grantedPreview.Status);
        Assert.Empty(grantedPreview.Decisions);
    }

    [Theory]
    [InlineData(Discovery, "user", false, PlatformGrantDecisionReason.Allowed)]
    [InlineData(Discovery, "provider", false, PlatformGrantDecisionReason.ActorKindNotAllowed)]
    [InlineData(Items, "user", false, PlatformGrantDecisionReason.Allowed)]
    [InlineData(Items, "provider", false, PlatformGrantDecisionReason.Allowed)]
    [InlineData(Items, "service", false, PlatformGrantDecisionReason.ActorKindNotAllowed)]
    [InlineData(UserData, "user", false, PlatformGrantDecisionReason.Allowed)]
    [InlineData(UserData, "provider", false, PlatformGrantDecisionReason.Allowed)]
    [InlineData(Events, "service", false, PlatformGrantDecisionReason.Allowed)]
    [InlineData(Events, "user", true, PlatformGrantDecisionReason.ActorKindNotAllowed)]
    [InlineData(Storage, "user", false, PlatformGrantDecisionReason.Allowed)]
    [InlineData(Storage, "provider", false, PlatformGrantDecisionReason.Allowed)]
    [InlineData(Storage, "service", false, PlatformGrantDecisionReason.ActorKindNotAllowed)]
    [InlineData(Ui, "provider", false, PlatformGrantDecisionReason.Allowed)]
    [InlineData(Ui, "user", true, PlatformGrantDecisionReason.ActorKindNotAllowed)]
    [InlineData(Integrations, "user", false, PlatformGrantDecisionReason.Allowed)]
    [InlineData(Integrations, "provider", false, PlatformGrantDecisionReason.Allowed)]
    [InlineData(Administration, "user", false, PlatformGrantDecisionReason.ElevationRequired)]
    [InlineData(Administration, "user", true, PlatformGrantDecisionReason.Allowed)]
    [InlineData(Diagnostics, "user", false, PlatformGrantDecisionReason.ElevationRequired)]
    [InlineData(Diagnostics, "user", true, PlatformGrantDecisionReason.Allowed)]
    [InlineData(Diagnostics, "provider", false, PlatformGrantDecisionReason.ActorKindNotAllowed)]
    public void ActorKindAndElevationCeilingsNeverPromote(
        string capability,
        string actorKind,
        bool elevated,
        PlatformGrantDecisionReason expected)
    {
        var preview = Evaluate(
            Requested(capability),
            Granted(capability),
            Authority(actorKind, elevated));

        Assert.Equal(PlatformGrantEvaluationStatus.Valid, preview.Status);
        var decision = Assert.Single(preview.Decisions);
        Assert.Equal(expected == PlatformGrantDecisionReason.Allowed, decision.IsAllowed);
        Assert.Equal(expected, decision.Reason);
    }

    [Fact]
    public void PreviewOrderAndValuesAreDeterministicAndBounded()
    {
        var reverse = PlatformCapabilityVocabulary.All
            .Select(value => value.Id.Value)
            .Reverse()
            .ToArray();
        var requested = Requested(reverse);
        var granted = Granted(reverse);

        var first = Evaluate(requested, granted, User(elevated: true));
        var second = Evaluate(requested, granted, User(elevated: true));

        Assert.Equal(PlatformGrantEvaluationStatus.Valid, first.Status);
        Assert.Equal(PlatformCapabilityVocabulary.All.Select(value => value.Id.Value),
            first.Decisions.Select(value => value.Capability.Id.Value));
        Assert.Equal(first.Decisions.Length, second.Decisions.Length);
        Assert.InRange(
            first.Decisions.Length,
            0,
            PlatformCapabilityVocabulary.MaximumCapabilityCount);
        Assert.Equal(
            first.Decisions.Select(value => (value.Capability.Id.Value, value.IsAllowed, value.Reason)),
            second.Decisions.Select(value => (value.Capability.Id.Value, value.IsAllowed, value.Reason)));
    }

    private static PlatformGrantPreview Evaluate(
        PlatformRequestedCapabilitySet? requested,
        PlatformGrantedCapabilitySet? granted,
        PlatformActorAuthority authority) =>
        PlatformGrantCeilingEvaluator.Evaluate(requested, granted, authority);

    private static PlatformRequestedCapabilitySet Requested(params string[] capabilities)
    {
        Assert.True(PlatformRequestedCapabilitySet.TryCreate(capabilities, out var result));
        return result;
    }

    private static PlatformGrantedCapabilitySet Granted(params string[] capabilities)
    {
        Assert.True(PlatformGrantedCapabilitySet.TryCreate(capabilities, out var result));
        return result;
    }

    private static PlatformActorAuthority Authority(string actorKind, bool elevated) => actorKind switch
    {
        "user" => User(elevated),
        "provider" => PlatformActorAuthorityTests.Provider(Guid.NewGuid(), new string('a', 64)).Authority,
        "service" => PlatformActorAuthorityTests.Service(Guid.NewGuid(), 1).Authority,
        _ => throw new ArgumentOutOfRangeException(nameof(actorKind)),
    };

    private static PlatformActorAuthority User(bool elevated) =>
        PlatformActorTestFactory.Create(Guid.NewGuid(), elevated, "correlation", null, null).Authority;

    private static object Decision(
        string capability,
        bool isAllowed,
        PlatformGrantDecisionReason reason) => new
        {
            Capability = capability,
            IsAllowed = isAllowed,
            Reason = reason,
        };
}
