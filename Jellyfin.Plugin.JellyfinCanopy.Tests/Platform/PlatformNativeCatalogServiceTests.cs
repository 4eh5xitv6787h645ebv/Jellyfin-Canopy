using System.Collections.Immutable;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformNativeCatalogServiceTests
{
    private static readonly string[] CompleteOrder =
    [
        "spoiler-guard-status",
        "spoiler-guard-configure",
        "hidden-content-status",
        "hidden-content-configure",
        "seerr-status",
        "seerr-request",
        "seerr-request-4k",
    ];

    [Fact]
    public async Task Resolve_ComposesExactlySevenInFixedOrder_AndReusesSemanticHandles()
    {
        using var fixture = new Fixture();

        var first = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);
        var second = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);

        Assert.Equal(PlatformNativeCatalogOutcomeKind.Success, first.Kind);
        Assert.Equal(PlatformNativeCatalogOutcomeKind.Success, second.Kind);
        Assert.Equal(CompleteOrder.Length, first.Response!.Contributions.Length);
        Assert.Equal(CompleteOrder, first.Response.Contributions.Select(value => value.Id));
        Assert.Equal(first.Response.CatalogRevision, second.Response!.CatalogRevision);
        Assert.Equal(
            first.Response.Contributions.Where(value => value.Kind == "action").Select(value => value.PrepareHandle),
            second.Response.Contributions.Where(value => value.Kind == "action").Select(value => value.PrepareHandle));
        Assert.Equal(4, fixture.Seerr.Calls);
        Assert.All(first.Response.Contributions.Where(value => value.Kind == "action"), action =>
        {
            Assert.True(action.Enabled);
            Assert.NotNull(action.PrepareHandle);
        });
    }

    [Fact]
    public async Task Resolve_SuccessRegistersTheValidatedActorDeviceAndUser()
    {
        using var fixture = new Fixture();

        var result = await fixture.Service.ResolveAsync(
            fixture.ActorA,
            fixture.Request(),
            CancellationToken.None);

        Assert.Equal(PlatformNativeCatalogOutcomeKind.Success, result.Kind);
        Assert.Equal(
            new LiveSessionEntry("device-a", Fixture.UserA),
            Assert.Single(fixture.LiveSessions.GetActiveEntries()));
    }

    [Fact]
    public async Task Resolve_DisableAfterSecondSnapshotCannotPublishStaleCatalog()
    {
        using var liveSessions = new BlockingLiveSessionRegistry();
        using var fixture = new Fixture(liveSessions);
        var resolving = Task.Run(() => fixture.Service.ResolveAsync(
            fixture.ActorA,
            fixture.Request(),
            CancellationToken.None));

        await liveSessions.TouchEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.Configuration.Current = new PluginConfiguration
        {
            PlatformEnabled = false,
            SpoilerBlurEnabled = true,
            HiddenContentEnabled = true,
        };
        liveSessions.Release();

        var result = await resolving.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(PlatformNativeCatalogOutcomeKind.Unavailable, result.Kind);
        Assert.Null(result.Response);
        // The provisional entry is intentionally retained: removing it could erase
        // a newer resolve, while send-time same-user/live-session validation and the
        // inert marker make the bounded stale entry safe.
        Assert.Equal(
            new LiveSessionEntry("device-a", Fixture.UserA),
            Assert.Single(liveSessions.GetActiveEntries()));
    }

    [Fact]
    public async Task Resolve_SuccessWithoutValidatedDeviceAttributionDoesNotRegister()
    {
        using var fixture = new Fixture();

        var result = await fixture.Service.ResolveAsync(
            fixture.Actor(Fixture.UserA, deviceId: null),
            fixture.Request(),
            CancellationToken.None);

        Assert.Equal(PlatformNativeCatalogOutcomeKind.Success, result.Kind);
        Assert.Empty(fixture.LiveSessions.GetActiveEntries());
    }

    [Fact]
    public async Task Resolve_RefusalsAndDisabledServiceBypassDoNotRegister()
    {
        using (var unsupported = new Fixture())
        {
            var result = await unsupported.Service.ResolveAsync(
                unsupported.ActorA,
                unsupported.Request(protocol: 2),
                CancellationToken.None);

            Assert.Equal(PlatformNativeCatalogOutcomeKind.UnsupportedProtocol, result.Kind);
            Assert.Empty(unsupported.LiveSessions.GetActiveEntries());
        }

        using (var notFound = new Fixture())
        {
            notFound.Host.AccessibleUsers.Clear();
            var result = await notFound.Service.ResolveAsync(
                notFound.ActorA,
                notFound.Request(),
                CancellationToken.None);

            Assert.Equal(PlatformNativeCatalogOutcomeKind.NotFound, result.Kind);
            Assert.Empty(notFound.LiveSessions.GetActiveEntries());
        }

        using (var unavailable = new Fixture())
        {
            unavailable.Seerr.Resolver = call => Presentation(provider: "provider-" + call);
            var result = await unavailable.Service.ResolveAsync(
                unavailable.ActorA,
                unavailable.Request(),
                CancellationToken.None);

            Assert.Equal(PlatformNativeCatalogOutcomeKind.Unavailable, result.Kind);
            Assert.Empty(unavailable.LiveSessions.GetActiveEntries());
        }

        using (var disabled = new Fixture())
        {
            disabled.Configuration.Current = new PluginConfiguration
            {
                PlatformEnabled = false,
                SpoilerBlurEnabled = true,
                HiddenContentEnabled = true,
            };
            var result = await disabled.Service.ResolveAsync(
                disabled.ActorA,
                disabled.Request(),
                CancellationToken.None);

            // The HTTP availability filter normally prevents this direct service
            // call. Defense in depth keeps the bypass ineligible for live pushes.
            Assert.Equal(PlatformNativeCatalogOutcomeKind.Unavailable, result.Kind);
            Assert.Empty(disabled.LiveSessions.GetActiveEntries());
        }
    }

    [Fact]
    public async Task Resolve_RegistrationCannotTargetAnotherUsersLiveSession()
    {
        using var fixture = new Fixture();
        var actor = fixture.Actor(Fixture.UserA, "shared-device");

        var result = await fixture.Service.ResolveAsync(
            actor,
            fixture.Request(),
            CancellationToken.None);
        var registered = fixture.LiveSessions.GetActiveEntries();
        var deliverable = LiveNotifierService.SelectDeliverableDeviceIds(
            registered,
            [new LiveSessionEntry("shared-device", Fixture.UserB)]);

        Assert.Equal(PlatformNativeCatalogOutcomeKind.Success, result.Kind);
        Assert.Equal(new LiveSessionEntry("shared-device", Fixture.UserA), Assert.Single(registered));
        Assert.Empty(deliverable);
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(2, 1)]
    [InlineData(1, 0)]
    [InlineData(1, 2)]
    public async Task Resolve_RejectsUnknownProtocolOrSurfaceBeforeOwnerReads(int protocol, int surface)
    {
        using var fixture = new Fixture();

        var result = await fixture.Service.ResolveAsync(
            fixture.ActorA,
            fixture.Request(protocol: protocol, surface: surface),
            CancellationToken.None);

        Assert.Equal(PlatformNativeCatalogOutcomeKind.UnsupportedProtocol, result.Kind);
        Assert.Null(result.Response);
        Assert.Equal(0, fixture.Spoiler.GetStateCalls + fixture.Hidden.GetStateCalls + fixture.Seerr.Calls);
        Assert.Equal(0, fixture.Host.AccessibleCalls);
    }

    [Fact]
    public async Task Resolve_WithoutDpadReturnsEmptyCatalogWithoutFeatureReads()
    {
        using var fixture = new Fixture();

        var result = await fixture.Service.ResolveAsync(
            fixture.ActorA,
            fixture.Request(inputModes: []),
            CancellationToken.None);

        Assert.Equal(PlatformNativeCatalogOutcomeKind.Success, result.Kind);
        Assert.Empty(result.Response!.Contributions);
        Assert.Equal(0, fixture.Spoiler.GetStateCalls + fixture.Hidden.GetStateCalls + fixture.Seerr.Calls);
    }

    [Fact]
    public async Task Resolve_StatusOnlyClientNeverReceivesPrepareHandles()
    {
        using var fixture = new Fixture();

        var result = await fixture.Service.ResolveAsync(
            fixture.ActorA,
            fixture.Request(contributions: ["status"], fields: []),
            CancellationToken.None);

        Assert.Equal(PlatformNativeCatalogOutcomeKind.Success, result.Kind);
        Assert.Equal(
            ["spoiler-guard-status", "hidden-content-status", "seerr-status"],
            result.Response!.Contributions.Select(value => value.Id));
        Assert.All(result.Response.Contributions, value =>
        {
            Assert.Equal("status", value.Kind);
            Assert.Null(value.PrepareHandle);
        });
    }

    [Fact]
    public async Task Resolve_MissingUserOrItemCollapsesToNotFoundBeforeFeatureReads()
    {
        using var fixture = new Fixture();
        fixture.Host.AccessibleUsers.Clear();

        var result = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);

        Assert.Equal(PlatformNativeCatalogOutcomeKind.NotFound, result.Kind);
        Assert.Null(result.Response);
        Assert.Equal(0, fixture.Spoiler.GetStateCalls + fixture.Hidden.GetStateCalls + fixture.Seerr.Calls);
    }

    [Fact]
    public async Task Resolve_UsesOnlyBoundaryActorAndCurrentAccessibleProjection()
    {
        using var fixture = new Fixture();
        fixture.Host.AccessibleUsers.Add(Fixture.UserB);

        var result = await fixture.Service.ResolveAsync(fixture.ActorB, fixture.Request(), CancellationToken.None);

        Assert.Equal(PlatformNativeCatalogOutcomeKind.Success, result.Kind);
        Assert.Equal(Fixture.UserB, fixture.Spoiler.LastUserId);
        Assert.Equal(Fixture.UserB, fixture.Hidden.LastUserId);
        Assert.Equal(Fixture.UserB, fixture.Seerr.LastActor?.UserId);
        Assert.Equal(fixture.Host.Item.Id, fixture.Seerr.LastItem?.Id);
    }

    [Fact]
    public async Task Resolve_InconsistentHiddenScopeSnapshotOmitsWholeHiddenFamily()
    {
        using var fixture = new Fixture();
        fixture.Hidden.Results[HiddenContentItemScope.NextUp] = HiddenResult(
            hidden: false,
            revision: 99,
            enabled: true);

        var result = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);

        Assert.Equal(PlatformNativeCatalogOutcomeKind.Success, result.Kind);
        Assert.DoesNotContain(result.Response!.Contributions, value => value.Id.StartsWith("hidden-content", StringComparison.Ordinal));
        Assert.Equal(
            ["spoiler-guard-status", "spoiler-guard-configure", "seerr-status", "seerr-request", "seerr-request-4k"],
            result.Response.Contributions.Select(value => value.Id));
    }

    [Fact]
    public async Task Resolve_RepeatedSeerrGenerationDriftExhaustsBoundedRetryAndFailsClosed()
    {
        using var fixture = new Fixture();
        fixture.Seerr.Resolver = call => Presentation(provider: "provider-" + call);

        var result = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);

        Assert.Equal(PlatformNativeCatalogOutcomeKind.Unavailable, result.Kind);
        Assert.Null(result.Response);
        Assert.Equal(4, fixture.Seerr.Calls);
    }

    [Fact]
    public async Task Resolve_SeerrOwnerFailureOmitsOnlySeerrFamily()
    {
        using var fixture = new Fixture();
        fixture.Seerr.Resolver = _ => throw new InvalidOperationException("provider secret");

        var result = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);

        Assert.Equal(PlatformNativeCatalogOutcomeKind.Success, result.Kind);
        Assert.Equal(
            ["spoiler-guard-status", "spoiler-guard-configure", "hidden-content-status", "hidden-content-configure"],
            result.Response!.Contributions.Select(value => value.Id));
        Assert.Equal(2, fixture.Seerr.Calls);
    }

    [Fact]
    public async Task Resolve_RepeatedConfigurationDriftExhaustsBoundedRetryAndFailsClosed()
    {
        using var fixture = new Fixture();
        fixture.Seerr.OnResolve = _ => fixture.Configuration.Current = EnabledConfiguration();

        var result = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);

        Assert.Equal(PlatformNativeCatalogOutcomeKind.Unavailable, result.Kind);
        Assert.Null(result.Response);
        Assert.Equal(2, fixture.Seerr.Calls);
    }

    [Fact]
    public async Task Resolve_AccessRevokedDuringCompositionReturnsIndistinguishableNotFound()
    {
        using var fixture = new Fixture();
        fixture.Seerr.OnResolve = _ => fixture.Host.AccessibleUsers.Clear();

        var result = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);

        Assert.Equal(PlatformNativeCatalogOutcomeKind.NotFound, result.Kind);
        Assert.Null(result.Response);
    }

    [Fact]
    public async Task Resolve_ActorElevationChangingOnEveryAttemptFailsClosed()
    {
        using var fixture = new Fixture();
        fixture.Seerr.OnResolve = _ => fixture.Host.IsAdministrator = !fixture.Host.IsAdministrator;

        var result = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);

        Assert.Equal(PlatformNativeCatalogOutcomeKind.Unavailable, result.Kind);
        Assert.Null(result.Response);
        Assert.Equal(2, fixture.Seerr.Calls);
    }

    [Fact]
    public async Task Prepare_EmitsOnlyFamilySpecificBoundedFields()
    {
        using var fixture = new Fixture();
        var resolved = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);

        var spoiler = await fixture.Prepare(fixture.ActorA, resolved, "spoiler-guard-configure");
        var hidden = await fixture.Prepare(fixture.ActorA, resolved, "hidden-content-configure");
        var seerr = await fixture.Prepare(fixture.ActorA, resolved, "seerr-request-4k");

        Assert.Equal(PlatformNativeCatalogOutcomeKind.Success, spoiler.Kind);
        Assert.Equal(["boolean"], spoiler.Response!.Fields.Select(value => value.Kind));
        Assert.True(spoiler.Response.Fields[0].DefaultChecked);
        Assert.NotEmpty(spoiler.Response.Capability);

        Assert.Equal(PlatformNativeCatalogOutcomeKind.Success, hidden.Kind);
        Assert.Equal(["boolean", "single_select"], hidden.Response!.Fields.Select(value => value.Kind));
        Assert.Equal(new[] { "global" }, hidden.Response.Fields[1].DefaultOptionIds.ToArray());
        Assert.Equal(
            ["global", "continue_watching", "next_up", "home_sections"],
            hidden.Response.Fields[1].Options.Select(value => value.Id));

        Assert.Equal(PlatformNativeCatalogOutcomeKind.Success, seerr.Kind);
        Assert.Equal("Request 4K with Seerr", seerr.Response!.Title);
        Assert.Equal(["confirmation"], seerr.Response.Fields.Select(value => value.Kind));
        Assert.False(seerr.Response.Fields[0].DefaultChecked);
    }

    [Fact]
    public async Task Prepare_NormalizesJellyfinProviderNamesBeforeSnapshotComparison()
    {
        using var fixture = new Fixture();
        fixture.Host.Item = new HostAccessibleItem(
            fixture.Host.Item.Id,
            fixture.Host.Item.Kind,
            fixture.Host.Item.SeriesId,
            [new HostProviderReference("Tmdb", "123")]);
        var resolved = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);

        var result = await fixture.Prepare(fixture.ActorA, resolved, "seerr-request");

        Assert.Equal(PlatformNativeCatalogOutcomeKind.Success, result.Kind);
        Assert.NotNull(result.Response);
    }

    [Fact]
    public async Task Prepare_HandleCannotCrossUsersEvenWhenBothCanAccessItem()
    {
        using var fixture = new Fixture();
        fixture.Host.AccessibleUsers.Add(Fixture.UserB);
        var resolved = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);

        var result = await fixture.Prepare(fixture.ActorB, resolved, "spoiler-guard-configure");

        Assert.Equal(PlatformNativeCatalogOutcomeKind.NotFound, result.Kind);
        Assert.Null(result.Response);
    }

    [Fact]
    public async Task Prepare_ConfigurationGenerationDriftFailsClosed()
    {
        using var fixture = new Fixture();
        var resolved = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);
        fixture.Configuration.Current = EnabledConfiguration();

        var result = await fixture.Prepare(fixture.ActorA, resolved, "spoiler-guard-configure");

        Assert.Equal(PlatformNativeCatalogOutcomeKind.NotFound, result.Kind);
        Assert.Null(result.Response);
    }

    [Fact]
    public async Task Prepare_ItemProjectionDriftFailsClosed()
    {
        using var fixture = new Fixture();
        var resolved = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);
        fixture.Host.Item = new HostAccessibleItem(
            fixture.Host.Item.Id,
            fixture.Host.Item.Kind,
            fixture.Host.Item.SeriesId,
            [new HostProviderReference("tmdb", "999")]);

        var result = await fixture.Prepare(fixture.ActorA, resolved, "seerr-request");

        Assert.Equal(PlatformNativeCatalogOutcomeKind.NotFound, result.Kind);
        Assert.Null(result.Response);
    }

    [Fact]
    public async Task Prepare_SpoilerRevisionDriftFailsClosed()
    {
        using var fixture = new Fixture();
        var resolved = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);
        fixture.Spoiler.State = new SpoilerGuardItemState(enabled: true, overridesRevision: 8);

        var result = await fixture.Prepare(fixture.ActorA, resolved, "spoiler-guard-configure");

        Assert.Equal(PlatformNativeCatalogOutcomeKind.NotFound, result.Kind);
    }

    [Fact]
    public async Task Prepare_HiddenStateOrPerUserEnablementDriftFailsClosed()
    {
        using var fixture = new Fixture();
        var resolved = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);
        fixture.Hidden.Results[HiddenContentItemScope.Global] = HiddenResult(
            hidden: true,
            revision: 11,
            enabled: false);

        var result = await fixture.Prepare(fixture.ActorA, resolved, "hidden-content-configure");

        Assert.Equal(PlatformNativeCatalogOutcomeKind.NotFound, result.Kind);
    }

    [Fact]
    public async Task Prepare_SeerrProviderGenerationOrAvailabilityDriftFailsClosed()
    {
        using var fixture = new Fixture();
        var resolved = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);
        fixture.Seerr.Current = Presentation(provider: "changed-provider", standardAvailable: false);

        var result = await fixture.Prepare(fixture.ActorA, resolved, "seerr-request");

        Assert.Equal(PlatformNativeCatalogOutcomeKind.NotFound, result.Kind);
    }

    [Fact]
    public async Task Prepare_SeerrOwnerFailureInvalidatesPreparedAction()
    {
        using var fixture = new Fixture();
        var resolved = await fixture.Service.ResolveAsync(fixture.ActorA, fixture.Request(), CancellationToken.None);
        fixture.Seerr.Resolver = _ => throw new InvalidOperationException("provider secret");

        var result = await fixture.Prepare(fixture.ActorA, resolved, "seerr-request");

        Assert.Equal(PlatformNativeCatalogOutcomeKind.NotFound, result.Kind);
        Assert.Null(result.Response);
    }

    [Fact]
    public async Task Prepare_UnknownOrMalformedHandleIsAlwaysNotFound()
    {
        using var fixture = new Fixture();

        foreach (var handle in new[] { "unknown", new string('a', PlatformPrepareHandleOwner.MaximumHandleCharacters) })
        {
            var result = await fixture.Service.PrepareAsync(
                fixture.ActorA,
                new PlatformActionPrepareRequest(handle),
                CancellationToken.None);
            Assert.Equal(PlatformNativeCatalogOutcomeKind.NotFound, result.Kind);
            Assert.Null(result.Response);
        }
    }

    private static PluginConfiguration EnabledConfiguration() => new()
    {
        SpoilerBlurEnabled = true,
        HiddenContentEnabled = true,
    };

    private static SeerrItemRequestPresentation Presentation(
        string provider = "provider-v1",
        bool standardAvailable = true,
        bool fourKAvailable = true)
        => SeerrItemRequestPresentation.Available(
            standardAvailable,
            fourKAvailable,
            SeerrItemRequestStatus.Unavailable,
            SeerrItemRequestStatus.Unavailable,
            "config-v1",
            "user-v1",
            "item-v1",
            provider);

    private static HiddenContentItemActionResult HiddenResult(bool hidden, long revision, bool enabled)
        => new(
            HiddenContentItemActionOutcome.Configured,
            hidden,
            changed: false,
            "key",
            entry: null,
            itemsRevision: revision,
            settingsRevision: 3,
            hiddenContentEnabled: enabled,
            settingsChanged: false);

    private sealed class Fixture : IDisposable
    {
        internal static readonly Guid UserA = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        internal static readonly Guid UserB = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
        private static readonly Guid ItemId = Guid.Parse("11111111-1111-1111-1111-111111111111");

        private readonly PlatformPrepareHandleOwner _handles;
        private readonly PlatformPreparedActionContextOwner _contexts;
        private readonly PlatformActionCapabilityService _capabilities;
        private readonly PlatformNativeCatalogRevisionAuthority _revisions;

        internal Fixture(ILiveSessionRegistry? liveSessions = null)
        {
            var clock = new ManualTimeProvider(new DateTimeOffset(2026, 8, 3, 0, 0, 0, TimeSpan.Zero));
            Host = new FakeHost(new HostAccessibleItem(
                ItemId,
                HostItemKind.Movie,
                seriesId: null,
                [new HostProviderReference("tmdb", "123")]));
            Configuration = new FakePluginConfigProvider(EnabledConfiguration());
            Spoiler = new FakeSpoilerOwner();
            Hidden = new FakeHiddenOwner();
            Seerr = new FakeSeerrPresentationOwner { Current = Presentation() };
            var prepareNonces = new SequentialNonceSource();
            var capabilityNonces = new SequentialNonceSource();
            _handles = new PlatformPrepareHandleOwner(clock, prepareNonces.GetBytes);
            _capabilities = new PlatformActionCapabilityService(
                clock,
                Enumerable.Repeat((byte)0x41, PlatformActionCapabilityService.AuthorityKeyBytes).ToArray(),
                capabilityNonces.GetBytes);
            _contexts = new PlatformPreparedActionContextOwner(
                _capabilities,
                clock,
                Enumerable.Repeat((byte)0x42, 32).ToArray());
            _revisions = new PlatformNativeCatalogRevisionAuthority(Enumerable.Repeat((byte)0x43, 32).ToArray());
            LiveSessions = liveSessions ?? new LiveSessionRegistry();
            Service = new PlatformNativeCatalogService(
                Host,
                Configuration,
                new SpoilerGuardPlatformItemActionAdapter(Spoiler),
                new HiddenContentPlatformItemActionAdapter(Hidden),
                Seerr,
                _handles,
                _contexts,
                _revisions,
                LiveSessions);
            ActorA = Actor(UserA);
            ActorB = Actor(UserB);
        }

        internal FakeHost Host { get; }

        internal FakePluginConfigProvider Configuration { get; }

        internal FakeSpoilerOwner Spoiler { get; }

        internal FakeHiddenOwner Hidden { get; }

        internal FakeSeerrPresentationOwner Seerr { get; }

        internal PlatformNativeCatalogService Service { get; }

        internal ILiveSessionRegistry LiveSessions { get; }

        internal PlatformActor ActorA { get; }

        internal PlatformActor ActorB { get; }

        internal PlatformItemDetailResolveRequest Request(
            int protocol = PlatformConstants.ProtocolMaximum,
            int surface = 1,
            IEnumerable<string>? contributions = null,
            IEnumerable<string>? fields = null,
            IEnumerable<string>? inputModes = null)
            => new(
                protocol,
                surface,
                Host.Item.Id,
                new PlatformNativeClientCapabilities(
                    contributions ?? ["action", "status"],
                    fields ?? ["confirmation", "boolean", "single_select", "multi_select"],
                    inputModes ?? ["dpad"],
                    ["screen_reader"],
                    "en-AU"));

        internal async Task<PlatformNativePrepareOutcome> Prepare(
            PlatformActor actor,
            PlatformNativeCatalogOutcome resolved,
            string contributionId)
        {
            var handle = Assert.Single(
                resolved.Response!.Contributions,
                value => value.Id == contributionId).PrepareHandle;
            Assert.NotNull(handle);
            return await Service.PrepareAsync(
                actor,
                new PlatformActionPrepareRequest(handle),
                CancellationToken.None);
        }

        public void Dispose()
        {
            _contexts.Dispose();
            _capabilities.Dispose();
            _handles.Dispose();
            _revisions.Dispose();
        }

        internal PlatformActor Actor(Guid userId, string? deviceId = "device-a")
            => PlatformActorTestFactory.Create(userId, false, "catalog-test", "Android TV", deviceId);
    }

    private sealed class BlockingLiveSessionRegistry : ILiveSessionRegistry, IDisposable
    {
        private readonly LiveSessionRegistry _inner = new();
        private readonly ManualResetEventSlim _release = new(initialState: false);
        private int _touches;

        internal TaskCompletionSource TouchEntered { get; } = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public void Touch(string deviceId, Guid userId)
        {
            if (Interlocked.Increment(ref _touches) == 1)
            {
                TouchEntered.TrySetResult();
                _release.Wait();
            }

            _inner.Touch(deviceId, userId);
        }

        public IReadOnlyList<LiveSessionEntry> GetActiveEntries()
            => _inner.GetActiveEntries();

        internal void Release() => _release.Set();

        public void Dispose()
        {
            _release.Set();
            _release.Dispose();
        }
    }

    private sealed class FakeHost : IPlatformHost, IHostUsers, IHostLibrary, IHostSessions, IHostPlugins
    {
        internal FakeHost(HostAccessibleItem item)
        {
            Item = item;
            AccessibleUsers.Add(Fixture.UserA);
        }

        public IHostUsers Users => this;

        public IHostLibrary Library => this;

        public IHostSessions Sessions => this;

        public IHostPlugins Plugins => this;

        internal HashSet<Guid> AccessibleUsers { get; } = [];

        internal HostAccessibleItem Item { get; set; }

        internal bool IsAdministrator { get; set; }

        internal int AccessibleCalls { get; private set; }

        public HostUser? Find(Guid id)
            => id is var value && (value == Fixture.UserA || value == Fixture.UserB)
                ? new HostUser(value, "user", IsAdministrator)
                : null;

        public IReadOnlyList<HostUser> All() => [];

        HostItem? IHostLibrary.Find(Guid id) => null;

        public HostItemAccessResult FindAccessible(Guid userId, Guid itemId)
        {
            AccessibleCalls++;
            return AccessibleUsers.Contains(userId) && itemId == Item.Id
                ? HostItemAccessResult.Accessible(Item)
                : HostItemAccessResult.NotAccessible;
        }

        public IReadOnlyList<HostItem> ChildrenOf(Guid id) => [];

        public IReadOnlyList<HostSession> Active() => [];

        public IReadOnlyList<HostSession> ForUser(Guid userId) => [];

        public IReadOnlyList<HostPlugin> Installed() => [];

        HostPlugin? IHostPlugins.Find(Guid id) => null;

        IReadOnlyList<PlatformInstalledPluginSnapshot> IHostPlugins.InstalledSnapshots() => [];

        PlatformInstalledPluginSnapshot? IHostPlugins.FindSnapshot(Guid id) => null;
    }

    private sealed class FakeSpoilerOwner : ISpoilerGuardItemActionOwner
    {
        internal SpoilerGuardItemState State { get; set; } = new(enabled: true, overridesRevision: 7);

        internal int GetStateCalls { get; private set; }

        internal Guid? LastUserId { get; private set; }

        public SpoilerGuardItemState GetState(SpoilerGuardActorProjection actor, SpoilerGuardItemProjection item)
        {
            GetStateCalls++;
            LastUserId = actor.UserId;
            return State;
        }

        public SpoilerGuardItemActionResult Configure(
            SpoilerGuardActorProjection actor,
            SpoilerGuardItemProjection item,
            SpoilerGuardItemConfiguration configuration)
            => SpoilerGuardItemActionResult.Configured(
                configuration.Enabled,
                changed: true,
                removed: !configuration.Enabled,
                configuration.ExpectedOverridesRevision!.Value + 1);
    }

    private sealed class FakeHiddenOwner : IHiddenContentItemActionOwner
    {
        internal FakeHiddenOwner()
        {
            Results = Enum.GetValues<HiddenContentItemScope>()
                .ToDictionary(
                    scope => scope,
                    scope => HiddenResult(
                        hidden: scope == HiddenContentItemScope.Global,
                        revision: 11,
                        enabled: true));
        }

        internal Dictionary<HiddenContentItemScope, HiddenContentItemActionResult> Results { get; }

        internal int GetStateCalls { get; private set; }

        internal Guid? LastUserId { get; private set; }

        public HiddenContentItemActionResult GetState(
            HiddenContentActorProjection actor,
            HiddenContentItemProjection item,
            HiddenContentItemScope scope)
        {
            GetStateCalls++;
            LastUserId = actor.UserId;
            return Results[scope];
        }

        public HiddenContentItemActionResult Configure(
            HiddenContentActorProjection actor,
            HiddenContentItemProjection item,
            HiddenContentItemConfiguration configuration)
            => new(
                HiddenContentItemActionOutcome.Configured,
                configuration.Hidden,
                changed: true,
                "key",
                entry: null,
                itemsRevision: configuration.ExpectedItemsRevision!.Value + 1,
                settingsRevision: 3,
                hiddenContentEnabled: true,
                settingsChanged: false);
    }

    private sealed class FakeSeerrPresentationOwner : ISeerrItemRequestPresentationOwner
    {
        internal SeerrItemRequestPresentation Current { get; set; } = SeerrItemRequestPresentation.Invisible();

        internal Func<int, SeerrItemRequestPresentation>? Resolver { get; set; }

        internal Action<int>? OnResolve { get; set; }

        internal int Calls { get; private set; }

        internal PlatformActor? LastActor { get; private set; }

        internal HostAccessibleItem? LastItem { get; private set; }

        public Task<SeerrItemRequestPresentation> ResolveItemRequestPresentationAsync(
            PlatformActor actor,
            HostAccessibleItem item,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Calls++;
            LastActor = actor;
            LastItem = item;
            OnResolve?.Invoke(Calls);
            return Task.FromResult(Resolver?.Invoke(Calls) ?? Current);
        }
    }

    private sealed class SequentialNonceSource
    {
        private int _value;

        internal byte[] GetBytes(int length)
        {
            var result = new byte[length];
            BitConverter.GetBytes(++_value).CopyTo(result, 0);
            return result;
        }
    }

    private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
