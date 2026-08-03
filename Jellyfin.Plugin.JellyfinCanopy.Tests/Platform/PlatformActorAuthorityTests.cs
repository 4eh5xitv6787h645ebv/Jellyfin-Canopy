using System;
using System.Linq;
using System.Reflection;
using System.Runtime.ExceptionServices;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformActorAuthorityTests
{
    [Fact]
    public void ActorKindVocabularyIsExactClosedAndHasNoAdministratorKind()
    {
        Assert.Equal(
            new[]
            {
                PlatformActorKind.JellyfinUserClient,
                PlatformActorKind.InstalledProvider,
                PlatformActorKind.CompanionService,
            },
            PlatformActorKindVocabulary.All);
        Assert.Equal(
            new[] { "JellyfinUserClient", "InstalledProvider", "CompanionService" },
            Enum.GetNames<PlatformActorKind>());
        Assert.Equal(new[] { 1, 2, 3 }, Enum.GetValues<PlatformActorKind>().Select(value => (int)value));
        Assert.Equal("jellyfin-user-client", PlatformActorKindVocabulary.TokenFor(PlatformActorKind.JellyfinUserClient));
        Assert.Equal("installed-provider", PlatformActorKindVocabulary.TokenFor(PlatformActorKind.InstalledProvider));
        Assert.Equal("companion-service", PlatformActorKindVocabulary.TokenFor(PlatformActorKind.CompanionService));
        Assert.Null(PlatformActorKindVocabulary.TokenFor(default));
        Assert.Null(PlatformActorKindVocabulary.TokenFor((PlatformActorKind)99));
        Assert.DoesNotContain(Enum.GetNames<PlatformActorKind>(), name => name.Contains("Admin", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void UserActorKeepsOneKindAcrossCurrentElevationChanges()
    {
        var userId = Guid.NewGuid();
        var ordinary = PlatformActorTestFactory.Create(userId, false, "ordinary", null, null);
        var elevated = PlatformActorTestFactory.Create(userId, true, "elevated", null, null);

        Assert.Equal(PlatformActorKind.JellyfinUserClient, ordinary.Kind);
        Assert.Equal(PlatformActorKind.JellyfinUserClient, elevated.Kind);
        Assert.False(ordinary.Authority.IsElevated);
        Assert.True(elevated.Authority.IsElevated);
        Assert.Equal(PlatformActorKind.JellyfinUserClient, ordinary.Authority.Kind);
        Assert.Equal(PlatformActorKind.JellyfinUserClient, elevated.Authority.Kind);
    }

    [Fact]
    public void DefaultUnknownAndCrossKindAuthorityFailClosed()
    {
        var definition = PlatformOperationVocabulary.All[0];
        var provider = Provider(Guid.NewGuid(), new string('a', 64));
        var service = Service(Guid.NewGuid(), 1);

        Assert.False(default(PlatformActorAuthority).IsValid);
        Assert.False(definition.Allows(default));
        Assert.False(definition.Allows(provider.Authority));
        Assert.False(definition.Allows(service.Authority));
        Assert.True(definition.Allows(
            PlatformActorTestFactory.Create(Guid.NewGuid(), false, "correlation", null, null).Authority));
        Assert.True(definition.Allows(
            PlatformActorTestFactory.Create(Guid.NewGuid(), true, "correlation", null, null).Authority));
    }

    [Fact]
    public void ProviderAndServiceActorsRemainDistinctEvenWhenIdentifiersMatch()
    {
        var shared = Guid.NewGuid();
        var provider = Provider(shared, new string('b', 64));
        var service = Service(shared, 7);

        Assert.Equal(PlatformActorKind.InstalledProvider, provider.Kind);
        Assert.Equal(PlatformActorKind.CompanionService, service.Kind);
        Assert.Equal(shared, provider.InstalledPluginId);
        Assert.Equal(shared, service.RegistrationId);
        Assert.Equal(new string('b', 64), provider.ManifestFingerprint);
        Assert.Equal(7, service.CredentialGeneration);
        Assert.False(provider.Authority.IsElevated);
        Assert.False(service.Authority.IsElevated);
        Assert.NotEqual(provider.GetType(), service.GetType());
    }

    [Fact]
    public void ProviderInputRequiresNonemptyPluginAndCanonicalFingerprint()
    {
        Assert.Throws<ArgumentException>(() => InstalledPluginId(Guid.Empty));
        Assert.Throws<ArgumentNullException>(() => ManifestFingerprint(null!));
        Assert.Throws<ArgumentException>(() => ManifestFingerprint(string.Empty));
        Assert.Throws<ArgumentException>(() => ManifestFingerprint(new string('a', 63)));
        Assert.Throws<ArgumentException>(() => ManifestFingerprint(new string('A', 64)));
        Assert.Throws<ArgumentException>(() => ManifestFingerprint(new string('g', 64)));

        var actor = Provider(Guid.NewGuid(), "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
        Assert.Equal(64, actor.ManifestFingerprint.Length);
    }

    [Fact]
    public void ServiceInputRequiresRegistrationAndPositiveCredentialGeneration()
    {
        Assert.Throws<ArgumentException>(() => ServiceRegistrationId(Guid.Empty));
        Assert.Throws<ArgumentOutOfRangeException>(() => CredentialGeneration(0));
        Assert.Throws<ArgumentOutOfRangeException>(() => CredentialGeneration(-1));

        var actor = Service(Guid.NewGuid(), 1);
        Assert.Equal(1, actor.CredentialGeneration);
    }

    [Fact]
    public void FactoriesRejectMissingTypedProofs()
    {
        Assert.Throws<ArgumentNullException>(() => PlatformActorFactory.CreateAuthenticatedUserActor(null!));
        Assert.Throws<ArgumentNullException>(() => PlatformActorFactory.CreateProvider(null!));
        Assert.Throws<ArgumentNullException>(() => PlatformActorFactory.CreateService(null!));
    }

    [Fact]
    public void ReauthorizationOwnsTheFreshLookupAndCannotChangeBoundaryIdentity()
    {
        var userId = Guid.NewGuid();
        var actor = PlatformActorTestFactory.Create(userId, false, "correlation", "client", "device");
        var host = new ReauthorizationHost
        {
            Current = new HostUser(userId, "user", true),
        };

        var elevated = PlatformActorBoundaryFilter.ReauthorizeUserActor(actor, host);

        Assert.NotNull(elevated);
        Assert.Equal(userId, host.RequestedUserId);
        Assert.Equal(userId, elevated.UserId);
        Assert.True(elevated.IsElevated);
        Assert.Equal(actor.CorrelationId, elevated.CorrelationId);
        Assert.Equal(actor.ClientName, elevated.ClientName);
        Assert.Equal(actor.DeviceId, elevated.DeviceId);

        host.Current = new HostUser(Guid.NewGuid(), "other", true);
        Assert.Null(PlatformActorBoundaryFilter.ReauthorizeUserActor(actor, host));

        host.Current = null;
        Assert.Null(PlatformActorBoundaryFilter.ReauthorizeUserActor(actor, host));
    }

    internal static PlatformInstalledProviderActor Provider(Guid pluginId, string fingerprint)
    {
        var identity = ConstructPrivately<PlatformApprovedProviderIdentity>(
            InstalledPluginId(pluginId),
            ManifestFingerprint(fingerprint));
        return PlatformActorFactory.CreateProvider(identity);
    }

    internal static PlatformCompanionServiceActor Service(Guid registrationId, long generation)
    {
        var identity = ConstructPrivately<PlatformCurrentServiceIdentity>(
            ServiceRegistrationId(registrationId),
            CredentialGeneration(generation));
        return PlatformActorFactory.CreateService(identity);
    }

    private static PlatformInstalledPluginId InstalledPluginId(Guid value) =>
        ConstructPrivately<PlatformInstalledPluginId>(value);

    private static PlatformManifestFingerprint ManifestFingerprint(string value) =>
        ConstructPrivately<PlatformManifestFingerprint>(value);

    private static PlatformServiceRegistrationId ServiceRegistrationId(Guid value) =>
        ConstructPrivately<PlatformServiceRegistrationId>(value);

    private static PlatformCredentialGeneration CredentialGeneration(long value) =>
        ConstructPrivately<PlatformCredentialGeneration>(value);

    private static T ConstructPrivately<T>(params object?[] arguments)
    {
        var constructor = typeof(T)
            .GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic)
            .Single();

        try
        {
            return (T)constructor.Invoke(arguments);
        }
        catch (TargetInvocationException exception) when (exception.InnerException is not null)
        {
            ExceptionDispatchInfo.Capture(exception.InnerException).Throw();
            throw;
        }
    }

    private sealed class ReauthorizationHost : IPlatformHost, IHostUsers
    {
        public HostUser? Current { get; set; }

        public Guid RequestedUserId { get; private set; }

        public IHostUsers Users => this;

        public IHostLibrary Library => throw new NotSupportedException();

        public IHostSessions Sessions => throw new NotSupportedException();

        public IHostPlugins Plugins => throw new NotSupportedException();

        public HostUser? Find(Guid id)
        {
            RequestedUserId = id;
            return Current;
        }

        public System.Collections.Generic.IReadOnlyList<HostUser> All() => [];
    }
}
