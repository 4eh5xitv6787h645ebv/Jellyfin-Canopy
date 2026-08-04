using System.Collections.Immutable;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class SeerrMediaRequestOwnerTests
{
    [Fact]
    public async Task MovieRequest_UsesOnlyAuthoritativeTmdbProjectionAndExactInvocationKey()
    {
        var harness = new Harness();
        var key = Key("exact-Key_17");

        var result = await harness.InvokeAsync(
            Item(HostItemKind.Movie, "603"),
            SeerrMediaRequestVariant.Standard,
            key);

        Assert.Equal(SeerrMediaRequestOutcome.Requested, result.Outcome);
        Assert.True(result.ProviderAccepted);
        Assert.False(result.SpoilerIntentRequired);
        Assert.False(result.SpoilerIntentRecorded);
        var sent = Assert.Single(harness.Handler.Sent);
        Assert.Equal(HttpMethod.Post, sent.Method);
        Assert.Equal("/root/api/v1/request", sent.Path);
        using var body = JsonDocument.Parse(sent.Body);
        Assert.Equal("movie", body.RootElement.GetProperty("mediaType").GetString());
        Assert.Equal(603, body.RootElement.GetProperty("mediaId").GetInt32());
        Assert.False(body.RootElement.GetProperty("is4k").GetBoolean());
        Assert.False(body.RootElement.TryGetProperty("seasons", out _));
        var request = Assert.Single(harness.Handler.Requests);
        Assert.Equal("exact-Key_17", Assert.Single(request.Headers.GetValues(PlatformIdempotencyKey.HeaderName)));
        Assert.Equal("27", Assert.Single(request.Headers.GetValues("X-Api-User")));
        Assert.Equal("saved-api-key", Assert.Single(request.Headers.GetValues("X-Api-Key")));
        Assert.Equal(
            new[]
            {
                SeerrRequestIdentityResolutionMode.InitialAdmission,
                SeerrRequestIdentityResolutionMode.FinalPreDispatch,
            },
            harness.Admission.ResolutionModes);
    }

    [Fact]
    public async Task Series4kRequest_UsesClosedWholeSeriesShapeAndAllGates()
    {
        var harness = new Harness();
        harness.Config.SeerrEnable4KTvRequests = true;
        harness.Admission.SetIdentity(permissions: SeerrPermission.REQUEST_4K_TV);

        var result = await harness.InvokeAsync(
            Item(HostItemKind.Series, "1399"),
            SeerrMediaRequestVariant.FourK);

        Assert.Equal(SeerrMediaRequestOutcome.Requested, result.Outcome);
        Assert.Equal(1, harness.Admission.CapabilityCalls);
        Assert.Equal(Found(permissions: SeerrPermission.REQUEST_4K_TV).Identity, harness.Admission.CapabilityIdentity);
        using var body = JsonDocument.Parse(Assert.Single(harness.Handler.Sent).Body);
        Assert.Equal("tv", body.RootElement.GetProperty("mediaType").GetString());
        Assert.Equal("all", body.RootElement.GetProperty("seasons").GetString());
        Assert.True(body.RootElement.GetProperty("is4k").GetBoolean());
    }

    [Theory]
    [InlineData(HostItemKind.Episode, "603")]
    [InlineData(HostItemKind.Movie, "0")]
    [InlineData(HostItemKind.Movie, "caller-value")]
    public async Task UnsupportedOrMalformedAuthoritativeTarget_FailsBeforeAdmission(
        HostItemKind kind,
        string tmdb)
    {
        var harness = new Harness();

        var result = await harness.InvokeAsync(Item(kind, tmdb));

        Assert.Equal(SeerrMediaRequestOutcome.InvalidTarget, result.Outcome);
        Assert.Equal(0, harness.Admission.ResolutionCalls);
        Assert.Empty(harness.Handler.Sent);
    }

    [Fact]
    public async Task MissingOrAmbiguousTmdbProjection_FailsClosed()
    {
        var harness = new Harness();
        var missing = new HostAccessibleItem(
            Guid.NewGuid(),
            HostItemKind.Movie,
            null,
            ImmutableArray.Create(new HostProviderReference("Tvdb", "7")));
        var ambiguous = new HostAccessibleItem(
            Guid.NewGuid(),
            HostItemKind.Movie,
            null,
            ImmutableArray.Create(
                new HostProviderReference("Tmdb", "7"),
                new HostProviderReference("Tmdb", "8")));

        Assert.Equal(
            SeerrMediaRequestOutcome.InvalidTarget,
            (await harness.InvokeAsync(missing)).Outcome);
        Assert.Equal(
            SeerrMediaRequestOutcome.InvalidTarget,
            (await harness.InvokeAsync(ambiguous)).Outcome);
        Assert.Equal(0, harness.Admission.ResolutionCalls);
    }

    [Theory]
    [InlineData(1, SeerrMediaRequestOutcome.Unlinked)]
    [InlineData(2, SeerrMediaRequestOutcome.IdentityBlocked)]
    [InlineData(3, SeerrMediaRequestOutcome.IdentityUnavailable)]
    public async Task LinkedIdentityFailuresAreClosedAndDoNotDispatch(
        int statusValue,
        SeerrMediaRequestOutcome expected)
    {
        var harness = new Harness();
        harness.Admission.Resolutions.Clear();
        harness.Admission.Resolutions.Add(new SeerrRequestIdentityResolution(
            (SeerrRequestIdentityStatus)statusValue,
            default));

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "9"));

        Assert.Equal(expected, result.Outcome);
        Assert.Empty(harness.Handler.Sent);
    }

    [Theory]
    [InlineData(HostItemKind.Movie, SeerrPermission.REQUEST_TV)]
    [InlineData(HostItemKind.Series, SeerrPermission.REQUEST_MOVIE)]
    public async Task StandardRequest_RequiresGlobalOrMatchingMediaPermission(
        HostItemKind kind,
        SeerrPermission wrongPermission)
    {
        var harness = new Harness();
        harness.Admission.SetIdentity(permissions: wrongPermission);

        var result = await harness.InvokeAsync(Item(kind, "11"));

        Assert.Equal(SeerrMediaRequestOutcome.PermissionDenied, result.Outcome);
        Assert.Empty(harness.Handler.Sent);
    }

    [Fact]
    public async Task FourKRequest_DoesNotTreatBaseRequestPermissionAsFourKPermission()
    {
        var harness = new Harness();
        harness.Config.SeerrEnable4KRequests = true;
        harness.Admission.SetIdentity(permissions: SeerrPermission.REQUEST);

        var result = await harness.InvokeAsync(
            Item(HostItemKind.Movie, "12"),
            SeerrMediaRequestVariant.FourK);

        Assert.Equal(SeerrMediaRequestOutcome.PermissionDenied, result.Outcome);
        Assert.Equal(0, harness.Admission.CapabilityCalls);
        Assert.Empty(harness.Handler.Sent);
    }

    [Fact]
    public async Task JellyfinAdministrator_BypassesSeerrPermissionButNot4kMasterSwitch()
    {
        var harness = new Harness(isElevated: true);
        harness.Admission.SetIdentity(permissions: SeerrPermission.NONE);

        var standard = await harness.InvokeAsync(Item(HostItemKind.Movie, "13"));
        var fourK = await harness.InvokeAsync(
            Item(HostItemKind.Movie, "13"),
            SeerrMediaRequestVariant.FourK,
            Key("admin-4k"));

        Assert.Equal(SeerrMediaRequestOutcome.Requested, standard.Outcome);
        Assert.Equal(SeerrMediaRequestOutcome.FeatureUnavailable, fourK.Outcome);
        Assert.Single(harness.Handler.Sent);
    }

    [Fact]
    public async Task ParentalDenialAndConfigurationChangeBothPreventMutation()
    {
        var blockedHarness = new Harness();
        blockedHarness.Parental.Blocked = true;
        Assert.Equal(
            SeerrMediaRequestOutcome.ParentalBlocked,
            (await blockedHarness.InvokeAsync(Item(HostItemKind.Movie, "14"))).Outcome);
        Assert.Empty(blockedHarness.Handler.Sent);

        var changedHarness = new Harness();
        changedHarness.Parental.Callback = _ =>
        {
            changedHarness.Provider.Current = ActiveConfig(apiKey: "rotated-key");
            return Task.FromResult(false);
        };
        Assert.Equal(
            SeerrMediaRequestOutcome.ConfigurationChanged,
            (await changedHarness.InvokeAsync(Item(HostItemKind.Movie, "14"))).Outcome);
        Assert.Empty(changedHarness.Handler.Sent);
    }

    [Fact]
    public async Task FreshIdentityChangeImmediatelyBeforeDispatchFailsClosedAndInvalidatesCache()
    {
        var harness = new Harness();
        harness.Admission.Resolutions.Add(Found(userId: 99));

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "15"));

        Assert.Equal(SeerrMediaRequestOutcome.IdentityChanged, result.Outcome);
        Assert.Equal(1, harness.Admission.InvalidationCalls);
        Assert.Empty(harness.Handler.Sent);
    }

    [Fact]
    public async Task FinalHostReauthorization_RejectsDeletedUser()
    {
        var harness = new Harness();
        harness.Host.UserExists = false;

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "151"));

        Assert.Equal(SeerrMediaRequestOutcome.HostAuthorizationChanged, result.Outcome);
        Assert.Empty(harness.Handler.Sent);
    }

    [Fact]
    public async Task FinalHostReauthorization_RejectsAdministratorDemotion()
    {
        var harness = new Harness(isElevated: true);
        harness.Host.IsAdministrator = false;

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "152"));

        Assert.Equal(SeerrMediaRequestOutcome.HostAuthorizationChanged, result.Outcome);
        Assert.Empty(harness.Handler.Sent);
    }

    [Fact]
    public async Task FinalHostReauthorization_RejectsItemDeletionMoveOrLibraryRemoval()
    {
        var harness = new Harness();
        harness.Host.ItemAccessible = false;

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "153"));

        Assert.Equal(SeerrMediaRequestOutcome.HostAuthorizationChanged, result.Outcome);
        Assert.Empty(harness.Handler.Sent);
    }

    [Fact]
    public async Task FinalHostProjection_RejectsAnyProviderReferenceDriftOrTargetAmbiguity()
    {
        var original = new HostAccessibleItem(
            Guid.NewGuid(),
            HostItemKind.Movie,
            null,
            ImmutableArray.Create(
                new HostProviderReference("Tmdb", "154"),
                new HostProviderReference("Tvdb", "7")));

        var driftHarness = new Harness();
        driftHarness.Host.ItemTransform = item => new HostAccessibleItem(
            item.Id,
            item.Kind,
            item.SeriesId,
            ImmutableArray.Create(
                new HostProviderReference("Tmdb", "154"),
                new HostProviderReference("Tvdb", "8")));
        Assert.Equal(
            SeerrMediaRequestOutcome.HostAuthorizationChanged,
            (await driftHarness.InvokeAsync(original)).Outcome);
        Assert.Empty(driftHarness.Handler.Sent);

        var ambiguityHarness = new Harness();
        ambiguityHarness.Host.ItemTransform = item => new HostAccessibleItem(
            item.Id,
            item.Kind,
            item.SeriesId,
            item.ProviderReferences.Add(new HostProviderReference("Tmdb", "155")));
        Assert.Equal(
            SeerrMediaRequestOutcome.HostAuthorizationChanged,
            (await ambiguityHarness.InvokeAsync(original, idempotencyKey: Key("ambiguous-host"))).Outcome);
        Assert.Empty(ambiguityHarness.Handler.Sent);
    }

    [Fact]
    public async Task DispatchFenceDriftFromFactory_IsTypedAsNotAttemptedAndNeverReachesSendAsync()
    {
        var harness = new Harness(clientFactory: current => new CallbackHttpClientFactory(
            new RecordingHttpClientFactory(current.Handler),
            () => current.Provider.Current = ActiveConfig(apiKey: "rotated-before-send")));

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "156"));

        Assert.Equal(SeerrMediaRequestOutcome.ConfigurationChanged, result.Outcome);
        Assert.Empty(harness.Handler.Sent);
        Assert.Empty(harness.Handler.Requests);
    }

    [Fact]
    public async Task FactoryCallbackUserDeletion_IsRejectedByLastEdgeHostCheckBeforeSendAsync()
    {
        var harness = new Harness(clientFactory: current => new CallbackHttpClientFactory(
            new RecordingHttpClientFactory(current.Handler),
            () => current.Host.UserExists = false));

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "157"));

        Assert.Equal(SeerrMediaRequestOutcome.HostAuthorizationChanged, result.Outcome);
        Assert.Empty(harness.Handler.Sent);
        Assert.Empty(harness.Handler.Requests);
    }

    [Fact]
    public async Task FactoryCallbackAdminDemotion_IsRejectedByLastEdgeHostCheckBeforeSendAsync()
    {
        var harness = new Harness(
            isElevated: true,
            clientFactory: current => new CallbackHttpClientFactory(
                new RecordingHttpClientFactory(current.Handler),
                () => current.Host.IsAdministrator = false));

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "158"));

        Assert.Equal(SeerrMediaRequestOutcome.HostAuthorizationChanged, result.Outcome);
        Assert.Empty(harness.Handler.Sent);
        Assert.Empty(harness.Handler.Requests);
    }

    [Fact]
    public async Task FactoryCallbackItemInaccessible_IsRejectedByLastEdgeHostCheckBeforeSendAsync()
    {
        var harness = new Harness(clientFactory: current => new CallbackHttpClientFactory(
            new RecordingHttpClientFactory(current.Handler),
            () => current.Host.ItemAccessible = false));

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "159"));

        Assert.Equal(SeerrMediaRequestOutcome.HostAuthorizationChanged, result.Outcome);
        Assert.Empty(harness.Handler.Sent);
        Assert.Empty(harness.Handler.Requests);
    }

    [Fact]
    public async Task FactoryCallbackProviderReferenceDrift_IsRejectedBeforeSendAsync()
    {
        var harness = new Harness(clientFactory: current => new CallbackHttpClientFactory(
            new RecordingHttpClientFactory(current.Handler),
            () => current.Host.ItemTransform = item => new HostAccessibleItem(
                item.Id,
                item.Kind,
                item.SeriesId,
                item.ProviderReferences.Add(new HostProviderReference("Tvdb", "factory-drift")))));

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "160"));

        Assert.Equal(SeerrMediaRequestOutcome.HostAuthorizationChanged, result.Outcome);
        Assert.Empty(harness.Handler.Sent);
        Assert.Empty(harness.Handler.Requests);
    }

    [Fact]
    public async Task CallerCancellationPropagatesBeforeMutation()
    {
        var harness = new Harness();
        using var cancellation = new CancellationTokenSource();
        harness.Parental.Callback = token =>
        {
            cancellation.Cancel();
            token.ThrowIfCancellationRequested();
            return Task.FromResult(false);
        };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => harness.InvokeAsync(
            Item(HostItemKind.Movie, "16"),
            cancellationToken: cancellation.Token));
        Assert.Empty(harness.Handler.Sent);
    }

    [Fact]
    public async Task ConfirmedSuccessRecordsTypedSpoilerIntentBeforeReturningWithoutReadingBody()
    {
        var harness = new Harness();
        harness.Config.SpoilerBlurEnabled = true;
        harness.Config.SpoilerAutoEnableOnSeerrRequest = true;
        harness.Handler.ResponseFactory = _ => new HttpResponseMessage(HttpStatusCode.Created)
        {
            Content = new ThrowOnReadContent(),
        };

        var result = await harness.InvokeAsync(Item(HostItemKind.Series, "0017"));

        Assert.Equal(SeerrMediaRequestOutcome.Requested, result.Outcome);
        Assert.True(result.ProviderAccepted);
        Assert.True(result.SpoilerIntentRequired);
        Assert.True(result.SpoilerIntentRecorded);
        Assert.Equal(1, harness.Spoiler.Calls);
        Assert.Equal(SeerrMediaRequestKind.Series, harness.Spoiler.Kind);
        Assert.Equal(17, harness.Spoiler.TmdbId);
    }

    [Fact]
    public async Task AcceptedMutationWithIntentFailureReturnsTerminalPartialSuccess()
    {
        var harness = new Harness();
        harness.Config.SpoilerBlurEnabled = true;
        harness.Config.SpoilerAutoEnableOnSeerrRequest = true;
        harness.Spoiler.Durable = false;

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "18"));

        Assert.Equal(SeerrMediaRequestOutcome.AcceptedSpoilerIntentFailed, result.Outcome);
        Assert.True(result.ProviderAccepted);
        Assert.True(result.SpoilerIntentRequired);
        Assert.False(result.SpoilerIntentRecorded);
        Assert.Single(harness.Handler.Sent);
    }

    [Fact]
    public async Task Definite2xxWithoutJsonContentTypeStillFulfilsIntentDurability()
    {
        var harness = new Harness();
        harness.Config.SpoilerBlurEnabled = true;
        harness.Config.SpoilerAutoEnableOnSeerrRequest = true;
        harness.Handler.ResponseFactory = _ => new HttpResponseMessage(HttpStatusCode.Accepted)
        {
            Content = new StringContent("provider body is intentionally opaque", Encoding.UTF8, "text/plain"),
        };

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "181"));

        Assert.Equal(SeerrMediaRequestOutcome.Requested, result.Outcome);
        Assert.True(result.ProviderAccepted);
        Assert.True(result.SpoilerIntentRecorded);
        Assert.Equal(1, harness.Spoiler.Calls);
    }

    [Theory]
    [InlineData(HttpStatusCode.Conflict, SeerrMediaRequestOutcome.AlreadyRequested)]
    [InlineData(HttpStatusCode.Forbidden, SeerrMediaRequestOutcome.ProviderRejected)]
    [InlineData(HttpStatusCode.UnprocessableEntity, SeerrMediaRequestOutcome.ProviderRejected)]
    [InlineData(HttpStatusCode.RequestTimeout, SeerrMediaRequestOutcome.ProviderUnavailable)]
    [InlineData(HttpStatusCode.TooManyRequests, SeerrMediaRequestOutcome.ProviderUnavailable)]
    [InlineData(HttpStatusCode.InternalServerError, SeerrMediaRequestOutcome.ProviderUnavailable)]
    public async Task ProviderStatusesMapToClosedBodyFreeOutcomes(
        HttpStatusCode status,
        SeerrMediaRequestOutcome expected)
    {
        var harness = new Harness(status);

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "19"));

        Assert.Equal(expected, result.Outcome);
        Assert.False(result.ProviderAccepted);
        Assert.Null(typeof(SeerrMediaRequestResult).GetProperty("ProviderResponse"));
    }

    [Fact]
    public async Task AmbiguousTransportFailureIsNotRetriedAndCallerRetryReusesExactKey()
    {
        var harness = new Harness();
        var observedKeys = new List<string>();
        harness.Handler.ResponseFactory = request =>
        {
            observedKeys.Add(Assert.Single(request.Headers.GetValues(PlatformIdempotencyKey.HeaderName)));
            throw new HttpRequestException("ambiguous send");
        };
        var key = Key("retry-same-key");

        await Assert.ThrowsAsync<HttpRequestException>(() => harness.InvokeAsync(
            Item(HostItemKind.Movie, "20"),
            idempotencyKey: key));
        Assert.Single(observedKeys);

        await Assert.ThrowsAsync<HttpRequestException>(() => harness.InvokeAsync(
            Item(HostItemKind.Movie, "20"),
            idempotencyKey: key));
        Assert.Equal(new[] { "retry-same-key", "retry-same-key" }, observedKeys);
    }

    private static HostAccessibleItem Item(HostItemKind kind, string tmdb)
        => new(
            Guid.NewGuid(),
            kind,
            null,
            ImmutableArray.Create(new HostProviderReference("Tmdb", tmdb)));

    private static PlatformIdempotencyKey Key(string value = "request-key")
    {
        Assert.True(PlatformIdempotencyKey.TryParse(value, out var key));
        return key;
    }

    private static SeerrRequestIdentityResolution Found(
        int userId = 27,
        SeerrPermission permissions = SeerrPermission.REQUEST,
        string source = "https://seerr.example/root")
        => new(
            SeerrRequestIdentityStatus.Found,
            new SeerrRequestIdentity(userId, permissions, source));

    private static PluginConfiguration ActiveConfig(string apiKey = "saved-api-key")
        => new()
        {
            SeerrEnabled = true,
            SeerrUrls = "https://seerr.example/root",
            SeerrApiKey = apiKey,
        };

    private sealed class Harness
    {
        public Harness(
            HttpStatusCode status = HttpStatusCode.Created,
            bool isElevated = false,
            Func<Harness, IHttpClientFactory>? clientFactory = null)
        {
            Config = ActiveConfig();
            Provider = new FakePluginConfigProvider(Config);
            Admission.Resolutions.Add(Found());
            Handler.AddResponse("/api/v1/request", "{}", status);
            Actor = PlatformActorTestFactory.Create(
                Guid.NewGuid(),
                isElevated,
                "correlation",
                null,
                null);
            Host.IsAdministrator = isElevated;
            Owner = new SeerrMediaRequestOwner(
                clientFactory?.Invoke(this) ?? new RecordingHttpClientFactory(Handler),
                Provider,
                Host,
                Admission,
                Parental,
                Spoiler,
                NullLogger<SeerrMediaRequestOwner>.Instance);
        }

        public PluginConfiguration Config { get; }

        public FakePluginConfigProvider Provider { get; }

        public FakePlatformHost Host { get; } = new();

        public FakeAdmission Admission { get; } = new();

        public FakeParentalFilter Parental { get; } = new();

        public FakeSpoilerIntentStore Spoiler { get; } = new();

        public RecordingHttpMessageHandler Handler { get; } = new();

        public SeerrMediaRequestOwner Owner { get; }

        public PlatformActor Actor { get; }

        public Task<SeerrMediaRequestResult> InvokeAsync(
            HostAccessibleItem item,
            SeerrMediaRequestVariant variant = SeerrMediaRequestVariant.Standard,
            PlatformIdempotencyKey? idempotencyKey = null,
            CancellationToken cancellationToken = default)
        {
            Host.AdmittedItem = item;
            return Owner.RequestAsync(
                Actor,
                item,
                variant,
                idempotencyKey ?? Key(),
                cancellationToken);
        }
    }

    private sealed class FakeAdmission : ISeerrMediaRequestAdmission
    {
        public List<SeerrRequestIdentityResolution> Resolutions { get; } = new();

        public int ResolutionCalls { get; private set; }

        public int CapabilityCalls { get; private set; }

        public int InvalidationCalls { get; private set; }

        public Seerr4kCapability Capability { get; set; } = new(true, true, true, true);

        public SeerrRequestIdentity? CapabilityIdentity { get; private set; }

        public List<SeerrRequestIdentityResolutionMode> ResolutionModes { get; } = new();

        public Task<SeerrRequestIdentityResolution> ResolveAsync(
            Guid jellyfinUserId,
            SeerrRequestIdentityResolutionMode mode,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ResolutionModes.Add(mode);
            var index = Math.Min(ResolutionCalls, Resolutions.Count - 1);
            ResolutionCalls++;
            return Task.FromResult(Resolutions[index]);
        }

        public Task<Seerr4kCapability> Get4kCapabilityAsync(
            SeerrRequestIdentity admittedIdentity,
            bool isAdministrator,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CapabilityCalls++;
            CapabilityIdentity = admittedIdentity;
            return Task.FromResult(Capability);
        }

        public void InvalidateIdentity(Guid jellyfinUserId) => InvalidationCalls++;

        public void SetIdentity(
            int userId = 27,
            SeerrPermission permissions = SeerrPermission.REQUEST,
            string source = "https://seerr.example/root")
        {
            Resolutions.Clear();
            Resolutions.Add(Found(userId, permissions, source));
        }
    }

    private sealed class FakePlatformHost : IPlatformHost
    {
        public FakePlatformHost()
        {
            Users = new FakeUsers(this);
            Library = new FakeLibrary(this);
        }

        public bool UserExists { get; set; } = true;

        public bool IsAdministrator { get; set; }

        public bool ItemAccessible { get; set; } = true;

        public HostAccessibleItem AdmittedItem { get; set; }

        public Func<HostAccessibleItem, HostAccessibleItem>? ItemTransform { get; set; }

        public IHostUsers Users { get; }

        public IHostLibrary Library { get; }

        public IHostSessions Sessions { get; } = new EmptySessions();

        public IHostPlugins Plugins { get; } = new EmptyPlugins();

        private sealed class FakeUsers(FakePlatformHost owner) : IHostUsers
        {
            public HostUser? Find(Guid id)
                => owner.UserExists
                    ? new HostUser(id, "current-user", owner.IsAdministrator)
                    : null;

            public IReadOnlyList<HostUser> All() => Array.Empty<HostUser>();
        }

        private sealed class FakeLibrary(FakePlatformHost owner) : IHostLibrary
        {
            public HostItem? Find(Guid id) => null;

            public HostItemAccessResult FindAccessible(Guid userId, Guid itemId)
            {
                if (!owner.ItemAccessible
                    || !owner.UserExists
                    || owner.AdmittedItem.Id != itemId)
                {
                    return HostItemAccessResult.NotAccessible;
                }

                var item = owner.ItemTransform?.Invoke(owner.AdmittedItem)
                    ?? owner.AdmittedItem;
                return HostItemAccessResult.Accessible(item);
            }

            public IReadOnlyList<HostItem> ChildrenOf(Guid id) => Array.Empty<HostItem>();
        }

        private sealed class EmptySessions : IHostSessions
        {
            public IReadOnlyList<HostSession> Active() => Array.Empty<HostSession>();

            public IReadOnlyList<HostSession> ForUser(Guid userId) => Array.Empty<HostSession>();
        }

        private sealed class EmptyPlugins : IHostPlugins
        {
            public IReadOnlyList<HostPlugin> Installed() => Array.Empty<HostPlugin>();

            public HostPlugin? Find(Guid id) => null;

            public IReadOnlyList<PlatformInstalledPluginSnapshot> InstalledSnapshots() =>
                Array.Empty<PlatformInstalledPluginSnapshot>();

            public PlatformInstalledPluginSnapshot? FindSnapshot(Guid id) => null;
        }
    }

    private sealed class CallbackHttpClientFactory : IHttpClientFactory
    {
        private readonly IHttpClientFactory _inner;
        private Action? _callback;

        public CallbackHttpClientFactory(IHttpClientFactory inner, Action callback)
        {
            _inner = inner;
            _callback = callback;
        }

        public HttpClient CreateClient(string name)
        {
            Interlocked.Exchange(ref _callback, null)?.Invoke();
            return _inner.CreateClient(name);
        }
    }

    private sealed class FakeParentalFilter : ISeerrParentalFilter
    {
        public bool Blocked { get; set; }

        public Func<CancellationToken, Task<bool>>? Callback { get; set; }

        public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
            => Task.FromResult(new SeerrParentalResult(false, json));

        public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
            => Task.FromResult(Blocked);

        public Task<bool> IsBlockedAsync(
            string mediaType,
            int tmdbId,
            SeerrCaller caller,
            CancellationToken cancellationToken)
            => Callback?.Invoke(cancellationToken) ?? Task.FromResult(Blocked);

        public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
            => Task.FromResult(false);
    }

    private sealed class FakeSpoilerIntentStore : ISeerrSpoilerIntentStore
    {
        public bool Durable { get; set; } = true;

        public int Calls { get; private set; }

        public SeerrMediaRequestKind Kind { get; private set; }

        public int TmdbId { get; private set; }

        public bool TryRegister(Guid userId, SeerrMediaRequestKind kind, int tmdbId)
        {
            Calls++;
            Kind = kind;
            TmdbId = tmdbId;
            return Durable;
        }
    }

    private sealed class ThrowOnReadContent : HttpContent
    {
        public ThrowOnReadContent()
        {
            Headers.ContentType = new MediaTypeHeaderValue("application/json");
        }

        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context)
            => throw new InvalidOperationException("The owner must not read provider bodies.");

        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }
    }
}
