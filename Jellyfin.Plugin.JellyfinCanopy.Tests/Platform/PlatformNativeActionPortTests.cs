using System.Collections.Immutable;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformNativeActionPortTests
{
    private static readonly Guid UserId = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly HostAccessibleItem Item = new(
        Guid.Parse("11111111-1111-1111-1111-111111111111"),
        HostItemKind.Movie,
        seriesId: null,
        [new HostProviderReference("tmdb", "123")]);
    private static readonly PlatformActor Actor = PlatformActorTestFactory.Create(
        UserId,
        false,
        "action-port-test",
        "Android TV",
        "device-a");

    [Fact]
    public async Task Spoiler_ExactAnswerAndCurrentRevisionAreRequired_ThenSuccessRefreshesItemAndSurface()
    {
        var configuration = EnabledProvider();
        var owner = new SpoilerOwner();
        var port = new SpoilerGuardPlatformActionPort(
            configuration,
            new SpoilerGuardPlatformItemActionAdapter(owner));
        var prepared = Prepared(
            PlatformOperationDefinition.SpoilerGuardConfigureItem,
            configuration.ConfigurationRevision,
            PlatformNativePreparedState.Spoiler(enabled: false, revision: 7));

        var admission = port.ValidateCurrent(Actor, Item, prepared, [BooleanAnswer("enabled", true)]);

        Assert.Equal(PlatformActionPortDecision.Admitted, admission.Decision);
        Assert.Equal("enabled:1", Encoding.ASCII.GetString(admission.CanonicalInput.Span));
        var result = await port.InvokeAsync(Actor, Item, admission.Input!, Key(), CancellationToken.None);
        Assert.Equal(1, owner.ConfigureCalls);
        Assert.True(owner.LastConfiguration?.Enabled);
        Assert.Equal(7, owner.LastConfiguration?.ExpectedOverridesRevision);
        AssertSuccess(result, "Spoiler Guard enabled", "jellyfin_item", "item_detail_surface");
    }

    [Fact]
    public void Spoiler_MalformedAnswersConfigurationAndStateDriftAllFailClosed()
    {
        var configuration = EnabledProvider();
        var owner = new SpoilerOwner();
        var port = new SpoilerGuardPlatformActionPort(
            configuration,
            new SpoilerGuardPlatformItemActionAdapter(owner));
        var valid = Prepared(
            PlatformOperationDefinition.SpoilerGuardConfigureItem,
            configuration.ConfigurationRevision,
            PlatformNativePreparedState.Spoiler(enabled: false, revision: 7));
        var malformedAnswers = new[]
        {
            ImmutableArray<PlatformActionAnswer>.Empty,
            ImmutableArray.Create(BooleanAnswer("wrong", true)),
            ImmutableArray.Create(new PlatformActionAnswer("enabled", booleanValue: null, optionIds: null)),
            ImmutableArray.Create(new PlatformActionAnswer("enabled", true, ImmutableArray.Create("unexpected"))),
            ImmutableArray.Create(BooleanAnswer("enabled", true), BooleanAnswer("enabled", false)),
        };

        foreach (var answers in malformedAnswers)
        {
            Assert.Equal(
                PlatformActionPortDecision.InvalidInput,
                port.ValidateCurrent(Actor, Item, valid, answers).Decision);
        }

        var wrongGeneration = Prepared(
            PlatformOperationDefinition.SpoilerGuardConfigureItem,
            configuration.ConfigurationRevision + 1,
            PlatformNativePreparedState.Spoiler(false, 7));
        Assert.Equal(
            PlatformActionPortDecision.InvalidInput,
            port.ValidateCurrent(Actor, Item, wrongGeneration, [BooleanAnswer("enabled", true)]).Decision);

        configuration.Current = new PluginConfiguration { SpoilerBlurEnabled = false, HiddenContentEnabled = true };
        Assert.Equal(
            PlatformActionPortDecision.InvalidInput,
            port.ValidateCurrent(Actor, Item, valid, [BooleanAnswer("enabled", true)]).Decision);

        configuration.Current = EnabledConfiguration();
        var currentGeneration = configuration.ConfigurationRevision;
        owner.State = new SpoilerGuardItemState(enabled: true, overridesRevision: 8);
        var stale = Prepared(
            PlatformOperationDefinition.SpoilerGuardConfigureItem,
            currentGeneration,
            PlatformNativePreparedState.Spoiler(false, 7));
        Assert.Equal(
            PlatformActionPortDecision.AuthorityDenied,
            port.ValidateCurrent(Actor, Item, stale, [BooleanAnswer("enabled", true)]).Decision);
        Assert.Equal(0, owner.ConfigureCalls);
    }

    [Theory]
    [InlineData(SpoilerGuardItemActionOutcome.RevisionConflict, PlatformErrorCode.Conflict)]
    [InlineData(SpoilerGuardItemActionOutcome.CapacityExceeded, PlatformErrorCode.RateLimited)]
    public async Task Spoiler_MapsClosedOwnerFailures(
        SpoilerGuardItemActionOutcome ownerOutcome,
        string expectedCode)
    {
        var configuration = EnabledProvider();
        var owner = new SpoilerOwner { ConfigureOutcome = ownerOutcome };
        var port = new SpoilerGuardPlatformActionPort(
            configuration,
            new SpoilerGuardPlatformItemActionAdapter(owner));
        var admission = port.ValidateCurrent(
            Actor,
            Item,
            Prepared(
                PlatformOperationDefinition.SpoilerGuardConfigureItem,
                configuration.ConfigurationRevision,
                PlatformNativePreparedState.Spoiler(false, 7)),
            [BooleanAnswer("enabled", true)]);

        var result = await port.InvokeAsync(Actor, Item, admission.Input!, Key(), CancellationToken.None);

        AssertFailure(result, expectedCode);
    }

    [Theory]
    [InlineData("global", HiddenContentItemScope.Global)]
    [InlineData("continue_watching", HiddenContentItemScope.ContinueWatching)]
    [InlineData("next_up", HiddenContentItemScope.NextUp)]
    [InlineData("home_sections", HiddenContentItemScope.HomeSections)]
    public async Task Hidden_ExactAnswersMapEveryClosedScopeAndRefreshItemAndSurface(
        string scopeId,
        HiddenContentItemScope expectedScope)
    {
        var configuration = EnabledProvider();
        var owner = new HiddenOwner();
        var port = new HiddenContentPlatformActionPort(
            configuration,
            new HiddenContentPlatformItemActionAdapter(owner));
        var prepared = Prepared(
            PlatformOperationDefinition.HiddenContentConfigureItem,
            configuration.ConfigurationRevision,
            PlatformNativePreparedState.Hidden(false, HiddenContentItemScope.Global, 11));

        var admission = port.ValidateCurrent(
            Actor,
            Item,
            prepared,
            [BooleanAnswer("hidden", true), OptionAnswer("scope", scopeId)]);

        Assert.Equal(PlatformActionPortDecision.Admitted, admission.Decision);
        Assert.Equal($"hidden:1;scope:{(int)expectedScope}", Encoding.ASCII.GetString(admission.CanonicalInput.Span));
        var result = await port.InvokeAsync(Actor, Item, admission.Input!, Key(), CancellationToken.None);
        Assert.True(owner.LastConfiguration?.Hidden);
        Assert.Equal(expectedScope, owner.LastConfiguration?.Scope);
        Assert.Equal(11, owner.LastConfiguration?.ExpectedItemsRevision);
        AssertSuccess(result, "Item hidden", "jellyfin_item", "item_detail_surface");
    }

    [Fact]
    public void Hidden_DuplicateUnknownOrWrongTypedAnswersFailBeforeOwnerMutation()
    {
        var configuration = EnabledProvider();
        var owner = new HiddenOwner();
        var port = new HiddenContentPlatformActionPort(
            configuration,
            new HiddenContentPlatformItemActionAdapter(owner));
        var prepared = Prepared(
            PlatformOperationDefinition.HiddenContentConfigureItem,
            configuration.ConfigurationRevision,
            PlatformNativePreparedState.Hidden(false, HiddenContentItemScope.Global, 11));
        var invalid = new[]
        {
            ImmutableArray.Create(BooleanAnswer("hidden", true)),
            ImmutableArray.Create(BooleanAnswer("hidden", true), OptionAnswer("scope", "unknown")),
            ImmutableArray.Create(BooleanAnswer("hidden", true), OptionAnswer("scope", "global"), OptionAnswer("scope", "next_up")),
            ImmutableArray.Create(new PlatformActionAnswer("hidden", null, ImmutableArray.Create("true")), OptionAnswer("scope", "global")),
            ImmutableArray.Create(BooleanAnswer("hidden", true), new PlatformActionAnswer("scope", true, ImmutableArray.Create("global"))),
            ImmutableArray.Create(BooleanAnswer("hidden", true), new PlatformActionAnswer("scope", null, ImmutableArray<string>.Empty)),
        };

        foreach (var answers in invalid)
        {
            Assert.Equal(
                PlatformActionPortDecision.InvalidInput,
                port.ValidateCurrent(Actor, Item, prepared, answers).Decision);
        }

        owner.Result = HiddenResult(HiddenContentItemActionOutcome.Configured, hidden: false, revision: 12, enabled: false);
        Assert.Equal(
            PlatformActionPortDecision.AuthorityDenied,
            port.ValidateCurrent(
                Actor,
                Item,
                prepared,
                [BooleanAnswer("hidden", true), OptionAnswer("scope", "global")]).Decision);
        Assert.Equal(0, owner.ConfigureCalls);
    }

    [Theory]
    [InlineData(HiddenContentItemActionOutcome.RevisionConflict, PlatformErrorCode.Conflict)]
    [InlineData(HiddenContentItemActionOutcome.CapacityExceeded, PlatformErrorCode.RateLimited)]
    [InlineData(HiddenContentItemActionOutcome.PayloadTooLarge, PlatformErrorCode.PayloadTooLarge)]
    public async Task Hidden_MapsClosedOwnerFailures(
        HiddenContentItemActionOutcome ownerOutcome,
        string expectedCode)
    {
        var configuration = EnabledProvider();
        var owner = new HiddenOwner { ConfigureOutcome = ownerOutcome };
        var port = new HiddenContentPlatformActionPort(
            configuration,
            new HiddenContentPlatformItemActionAdapter(owner));
        var admission = port.ValidateCurrent(
            Actor,
            Item,
            Prepared(
                PlatformOperationDefinition.HiddenContentConfigureItem,
                configuration.ConfigurationRevision,
                PlatformNativePreparedState.Hidden(false, HiddenContentItemScope.Global, 11)),
            [BooleanAnswer("hidden", true), OptionAnswer("scope", "global")]);

        var result = await port.InvokeAsync(Actor, Item, admission.Input!, Key(), CancellationToken.None);

        AssertFailure(result, expectedCode);
    }

    [Theory]
    [InlineData(SeerrMediaRequestVariant.Standard, "variant:0;confirmed:1")]
    [InlineData(SeerrMediaRequestVariant.FourK, "variant:1;confirmed:1")]
    public async Task Seerr_RequiresExactPositiveConfirmationAndKeepsVariantServerBound(
        SeerrMediaRequestVariant variant,
        string expectedCanonical)
    {
        var configuration = EnabledProvider();
        var owner = new SeerrOwner();
        var port = SeerrPort(configuration, owner);
        var prepared = Prepared(
            PlatformOperationDefinition.SeerrRequestItem,
            configuration.ConfigurationRevision,
            PlatformNativePreparedState.Seerr(variant, Presentation()));

        var admission = await port.ValidateCurrentAsync(
            Actor,
            Item,
            prepared,
            [BooleanAnswer("confirm", true)],
            CancellationToken.None);

        Assert.Equal(PlatformActionPortDecision.Admitted, admission.Decision);
        Assert.Equal(expectedCanonical, Encoding.ASCII.GetString(admission.CanonicalInput.Span));
        var key = Key();
        var result = await port.InvokeAsync(Actor, Item, admission.Input!, key, CancellationToken.None);
        Assert.Equal(variant, owner.LastVariant);
        Assert.Equal(key, owner.LastKey);
        AssertSuccess(result, "Request submitted", "item_detail_surface");
    }

    [Fact]
    public async Task Seerr_FalseMissingOptionOrExtraConfirmationFailsBeforeOwner()
    {
        var configuration = EnabledProvider();
        var owner = new SeerrOwner();
        var port = SeerrPort(configuration, owner);
        var prepared = Prepared(
            PlatformOperationDefinition.SeerrRequestItem,
            configuration.ConfigurationRevision,
            PlatformNativePreparedState.Seerr(SeerrMediaRequestVariant.Standard, Presentation()));
        var invalid = new[]
        {
            ImmutableArray<PlatformActionAnswer>.Empty,
            ImmutableArray.Create(BooleanAnswer("confirm", false)),
            ImmutableArray.Create(BooleanAnswer("wrong", true)),
            ImmutableArray.Create(new PlatformActionAnswer("confirm", true, ImmutableArray.Create("yes"))),
            ImmutableArray.Create(BooleanAnswer("confirm", true), BooleanAnswer("confirm", true)),
        };

        foreach (var answers in invalid)
        {
            Assert.Equal(
                PlatformActionPortDecision.InvalidInput,
                (await port.ValidateCurrentAsync(
                    Actor,
                    Item,
                    prepared,
                    answers,
                    CancellationToken.None)).Decision);
        }

        Assert.Equal(0, owner.Calls);
    }

    [Theory]
    [InlineData(SeerrMediaRequestOutcome.AlreadyRequested, 200, "succeeded", "Already requested")]
    [InlineData(SeerrMediaRequestOutcome.AcceptedSpoilerIntentFailed, 200, "succeeded", "Request accepted; review Spoiler Guard before retrying")]
    [InlineData(SeerrMediaRequestOutcome.ProviderUnavailable, 503, PlatformErrorCode.Unavailable, null)]
    [InlineData(SeerrMediaRequestOutcome.IdentityUnavailable, 503, PlatformErrorCode.Unavailable, null)]
    [InlineData(SeerrMediaRequestOutcome.ProviderRejected, 409, PlatformErrorCode.Conflict, null)]
    [InlineData(SeerrMediaRequestOutcome.PermissionDenied, 404, PlatformErrorCode.NotFound, null)]
    [InlineData(SeerrMediaRequestOutcome.ParentalBlocked, 404, PlatformErrorCode.NotFound, null)]
    [InlineData(SeerrMediaRequestOutcome.ConfigurationChanged, 404, PlatformErrorCode.NotFound, null)]
    public async Task Seerr_MapsOwnerOutcomesWithoutProviderDetails(
        SeerrMediaRequestOutcome ownerOutcome,
        int status,
        string expectedCode,
        string? expectedMessage)
    {
        var configuration = EnabledProvider();
        var owner = new SeerrOwner { Outcome = ownerOutcome };
        var port = SeerrPort(configuration, owner);
        var admission = await port.ValidateCurrentAsync(
            Actor,
            Item,
            Prepared(
                PlatformOperationDefinition.SeerrRequestItem,
                configuration.ConfigurationRevision,
                PlatformNativePreparedState.Seerr(SeerrMediaRequestVariant.Standard, Presentation())),
            [BooleanAnswer("confirm", true)],
            CancellationToken.None);

        var result = await port.InvokeAsync(Actor, Item, admission.Input!, Key(), CancellationToken.None);

        Assert.Equal(status, result.Result.StatusCode);
        Assert.Equal(expectedCode, result.Result.OutcomeCode);
        if (expectedMessage is not null)
        {
            AssertSuccess(result, expectedMessage, "item_detail_surface");
        }
        else
        {
            Assert.Equal(JsonValueKind.Object, result.Result.Value.ValueKind);
            Assert.Empty(result.Result.Value.EnumerateObject());
        }
    }

    [Theory]
    [InlineData("invisible")]
    [InlineData("configuration")]
    [InlineData("user")]
    [InlineData("item")]
    [InlineData("variant")]
    [InlineData("variant-4k")]
    public async Task Seerr_CurrentAuthorityDriftFailsBeforeStoredOrFreshResultCanBeReleased(string drift)
    {
        var configuration = EnabledProvider();
        var owner = new SeerrOwner();
        var current = drift switch
        {
            "invisible" => SeerrItemRequestPresentation.Invisible(),
            "configuration" => Presentation(configuration: "config-v2"),
            "user" => Presentation(user: "user-v2"),
            "item" => Presentation(item: "item-v2"),
            "variant" => Presentation(standardAvailable: false),
            "variant-4k" => Presentation(fourKAvailable: false),
            _ => throw new InvalidOperationException(),
        };
        var variant = drift == "variant-4k"
            ? SeerrMediaRequestVariant.FourK
            : SeerrMediaRequestVariant.Standard;
        var port = SeerrPort(configuration, owner, current);
        var prepared = Prepared(
            PlatformOperationDefinition.SeerrRequestItem,
            configuration.ConfigurationRevision,
            PlatformNativePreparedState.Seerr(variant, Presentation()));

        var admission = await port.ValidateCurrentAsync(
            Actor,
            Item,
            prepared,
            [BooleanAnswer("confirm", true)],
            CancellationToken.None);

        Assert.Equal(PlatformActionPortDecision.AuthorityDenied, admission.Decision);
        Assert.Equal(0, owner.Calls);
    }

    [Fact]
    public async Task Seerr_VisibleRequestedStateAllowsIdempotentReplayAfterProviderStatusChange()
    {
        var configuration = EnabledProvider();
        var owner = new SeerrOwner();
        var requested = Presentation(
            standardAvailable: false,
            standardStatus: SeerrItemRequestStatus.Pending,
            provider: "provider-v2");
        var port = SeerrPort(configuration, owner, requested);
        var prepared = Prepared(
            PlatformOperationDefinition.SeerrRequestItem,
            configuration.ConfigurationRevision,
            PlatformNativePreparedState.Seerr(SeerrMediaRequestVariant.Standard, Presentation()));

        var admission = await port.ValidateCurrentAsync(
            Actor,
            Item,
            prepared,
            [BooleanAnswer("confirm", true)],
            CancellationToken.None);

        Assert.Equal(PlatformActionPortDecision.Admitted, admission.Decision);
    }

    [Fact]
    public async Task Seerr_CurrentAuthorityFailureDeniesButRequestedCancellationPropagates()
    {
        var configuration = EnabledProvider();
        var owner = new SeerrOwner();
        var presentation = new SeerrPresentationOwner { Failure = new InvalidOperationException("provider failed") };
        var port = new SeerrPlatformActionPort(configuration, owner, presentation);
        var prepared = Prepared(
            PlatformOperationDefinition.SeerrRequestItem,
            configuration.ConfigurationRevision,
            PlatformNativePreparedState.Seerr(SeerrMediaRequestVariant.Standard, Presentation()));

        var denied = await port.ValidateCurrentAsync(
            Actor,
            Item,
            prepared,
            [BooleanAnswer("confirm", true)],
            CancellationToken.None);
        Assert.Equal(PlatformActionPortDecision.AuthorityDenied, denied.Decision);

        using var canceled = new CancellationTokenSource();
        canceled.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => port.ValidateCurrentAsync(
            Actor,
            Item,
            prepared,
            [BooleanAnswer("confirm", true)],
            canceled.Token));
        Assert.Equal(0, owner.Calls);
    }

    [Fact]
    public async Task EveryPortHonorsPreCanceledInvocationBeforeMutation()
    {
        var configuration = EnabledProvider();
        var spoilerOwner = new SpoilerOwner();
        var spoiler = new SpoilerGuardPlatformActionPort(
            configuration,
            new SpoilerGuardPlatformItemActionAdapter(spoilerOwner));
        var admission = spoiler.ValidateCurrent(
            Actor,
            Item,
            Prepared(
                PlatformOperationDefinition.SpoilerGuardConfigureItem,
                configuration.ConfigurationRevision,
                PlatformNativePreparedState.Spoiler(false, 7)),
            [BooleanAnswer("enabled", true)]);
        using var canceled = new CancellationTokenSource();
        canceled.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(() => spoiler.InvokeAsync(
            Actor,
            Item,
            admission.Input!,
            Key(),
            canceled.Token));
        Assert.Equal(0, spoilerOwner.ConfigureCalls);
    }

    private static FakePluginConfigProvider EnabledProvider()
        => new(EnabledConfiguration());

    private static PluginConfiguration EnabledConfiguration() => new()
    {
        SpoilerBlurEnabled = true,
        HiddenContentEnabled = true,
    };

    private static PlatformPreparedActionContext Prepared(
        PlatformOperationDefinition definition,
        long configurationRevision,
        PlatformNativePreparedState state)
        => new(
            new PlatformPreparedActionRequest(
                definition,
                Item,
                configurationRevision,
                PlatformNativePreparedStateCodec.Encode(state)),
            new byte[PlatformActionCapabilityService.InputDigestBytes]);

    private static PlatformActionAnswer BooleanAnswer(string field, bool value)
        => new(field, value, optionIds: null);

    private static PlatformActionAnswer OptionAnswer(string field, string value)
        => new(field, booleanValue: null, ImmutableArray.Create(value));

    private static PlatformIdempotencyKey Key()
    {
        Assert.True(PlatformIdempotencyKey.TryParse("native-action-test-key", out var key));
        return key;
    }

    private static SeerrPlatformActionPort SeerrPort(
        FakePluginConfigProvider configuration,
        SeerrOwner owner,
        SeerrItemRequestPresentation? presentation = null)
        => new(
            configuration,
            owner,
            new SeerrPresentationOwner { Current = presentation ?? Presentation() });

    private static SeerrItemRequestPresentation Presentation(
        bool standardAvailable = true,
        bool fourKAvailable = true,
        SeerrItemRequestStatus standardStatus = SeerrItemRequestStatus.Unavailable,
        SeerrItemRequestStatus fourKStatus = SeerrItemRequestStatus.Unavailable,
        string configuration = "config-v1",
        string user = "user-v1",
        string item = "item-v1",
        string provider = "provider-v1")
        => SeerrItemRequestPresentation.Available(
            standardAvailable,
            fourKAvailable,
            standardStatus,
            fourKStatus,
            configuration,
            user,
            item,
            provider);

    private static HiddenContentItemActionResult HiddenResult(
        HiddenContentItemActionOutcome outcome,
        bool hidden,
        long revision,
        bool enabled)
        => new(
            outcome,
            hidden,
            changed: outcome == HiddenContentItemActionOutcome.Configured,
            "key",
            entry: null,
            itemsRevision: revision,
            settingsRevision: 3,
            hiddenContentEnabled: enabled,
            settingsChanged: false);

    private static void AssertSuccess(
        PlatformActionOwnerResult result,
        string message,
        params string[] refreshTargets)
    {
        Assert.Equal(200, result.Result.StatusCode);
        Assert.Equal("succeeded", result.Result.OutcomeCode);
        var value = result.Result.Value;
        Assert.Equal("succeeded", value.GetProperty("Outcome").GetString());
        Assert.Equal(message, value.GetProperty("Message").GetProperty("Text").GetString());
        Assert.Equal("positive", value.GetProperty("Message").GetProperty("Tone").GetString());
        Assert.Equal(
            refreshTargets,
            value.GetProperty("Refresh").GetProperty("Targets").EnumerateArray().Select(entry => entry.GetString()).ToArray());
        Assert.False(value.GetProperty("Refresh").TryGetProperty("CatalogRevision", out _));
    }

    private static void AssertFailure(PlatformActionOwnerResult result, string code)
    {
        Assert.Equal(code, result.Result.OutcomeCode);
        Assert.Equal(PlatformErrorCode.StatusFor(code), result.Result.StatusCode);
        Assert.Equal(JsonValueKind.Object, result.Result.Value.ValueKind);
        Assert.Empty(result.Result.Value.EnumerateObject());
    }

    private sealed class SpoilerOwner : ISpoilerGuardItemActionOwner
    {
        internal SpoilerGuardItemState State { get; set; } = new(enabled: false, overridesRevision: 7);

        internal SpoilerGuardItemActionOutcome ConfigureOutcome { get; set; } = SpoilerGuardItemActionOutcome.Configured;

        internal int ConfigureCalls { get; private set; }

        internal SpoilerGuardItemConfiguration? LastConfiguration { get; private set; }

        public SpoilerGuardItemState GetState(SpoilerGuardActorProjection actor, SpoilerGuardItemProjection item)
            => State;

        public SpoilerGuardItemActionResult Configure(
            SpoilerGuardActorProjection actor,
            SpoilerGuardItemProjection item,
            SpoilerGuardItemConfiguration configuration)
        {
            ConfigureCalls++;
            LastConfiguration = configuration;
            return ConfigureOutcome switch
            {
                SpoilerGuardItemActionOutcome.Configured => SpoilerGuardItemActionResult.Configured(
                    configuration.Enabled,
                    changed: true,
                    removed: !configuration.Enabled,
                    revision: 8),
                SpoilerGuardItemActionOutcome.RevisionConflict => SpoilerGuardItemActionResult.RevisionConflict(false, 8),
                SpoilerGuardItemActionOutcome.CapacityExceeded => SpoilerGuardItemActionResult.CapacityExceeded(false, 7, "movies"),
                _ => throw new InvalidOperationException(),
            };
        }
    }

    private sealed class HiddenOwner : IHiddenContentItemActionOwner
    {
        internal HiddenContentItemActionResult Result { get; set; } = HiddenResult(
            HiddenContentItemActionOutcome.Configured,
            hidden: false,
            revision: 11,
            enabled: true);

        internal HiddenContentItemActionOutcome ConfigureOutcome { get; set; } = HiddenContentItemActionOutcome.Configured;

        internal int ConfigureCalls { get; private set; }

        internal HiddenContentItemConfiguration? LastConfiguration { get; private set; }

        public HiddenContentItemActionResult GetState(
            HiddenContentActorProjection actor,
            HiddenContentItemProjection item,
            HiddenContentItemScope scope)
            => Result;

        public HiddenContentItemActionResult Configure(
            HiddenContentActorProjection actor,
            HiddenContentItemProjection item,
            HiddenContentItemConfiguration configuration)
        {
            ConfigureCalls++;
            LastConfiguration = configuration;
            return HiddenResult(
                ConfigureOutcome,
                configuration.Hidden,
                revision: 12,
                enabled: true);
        }
    }

    private sealed class SeerrOwner : ISeerrMediaRequestOwner
    {
        internal SeerrMediaRequestOutcome Outcome { get; set; } = SeerrMediaRequestOutcome.Requested;

        internal int Calls { get; private set; }

        internal SeerrMediaRequestVariant? LastVariant { get; private set; }

        internal PlatformIdempotencyKey? LastKey { get; private set; }

        public Task<SeerrMediaRequestResult> RequestAsync(
            PlatformActor actor,
            HostAccessibleItem item,
            SeerrMediaRequestVariant variant,
            PlatformIdempotencyKey idempotencyKey,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Calls++;
            LastVariant = variant;
            LastKey = idempotencyKey;
            var result = Outcome switch
            {
                SeerrMediaRequestOutcome.Requested => SeerrMediaRequestResult.Accepted(false, false),
                SeerrMediaRequestOutcome.AcceptedSpoilerIntentFailed => SeerrMediaRequestResult.Accepted(true, false),
                _ => SeerrMediaRequestResult.Refused(Outcome),
            };
            return Task.FromResult(result);
        }
    }

    private sealed class SeerrPresentationOwner : ISeerrItemRequestPresentationOwner
    {
        internal SeerrItemRequestPresentation Current { get; set; } = SeerrItemRequestPresentation.Invisible();

        internal Exception? Failure { get; set; }

        public Task<SeerrItemRequestPresentation> ResolveItemRequestPresentationAsync(
            PlatformActor actor,
            HostAccessibleItem item,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (Failure is not null)
            {
                return Task.FromException<SeerrItemRequestPresentation>(Failure);
            }

            return Task.FromResult(Current);
        }
    }
}
