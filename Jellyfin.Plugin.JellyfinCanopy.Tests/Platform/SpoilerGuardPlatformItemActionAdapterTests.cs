using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class SpoilerGuardPlatformItemActionAdapterTests
{
    [Theory]
    [InlineData(HostItemKind.Movie, SpoilerGuardItemKind.Movie)]
    [InlineData(HostItemKind.Series, SpoilerGuardItemKind.Series)]
    public void Configure_MapsAuthoritativeProjections_AndInvokesOwnerExactlyOnce(
        HostItemKind hostKind,
        SpoilerGuardItemKind ownerKind)
    {
        var owner = new RecordingOwner();
        var adapter = new SpoilerGuardPlatformItemActionAdapter(owner);
        var userId = Guid.NewGuid();
        var itemId = Guid.NewGuid();
        var configuration = SpoilerGuardItemConfiguration.Exact(
            enabled: true,
            expectedOverridesRevision: 7);

        var result = adapter.Configure(
            PlatformActorTestFactory.Create(userId, false, "correlation", null, null),
            new HostAccessibleItem(itemId, hostKind, seriesId: null, ImmutableArray<HostProviderReference>.Empty),
            configuration);

        Assert.Same(owner.Result, result);
        Assert.Equal(1, owner.ConfigureCalls);
        Assert.Equal(userId, owner.Actor?.UserId);
        Assert.Equal(itemId, owner.Item?.ItemId);
        Assert.Equal(ownerKind, owner.Item?.Kind);
        Assert.False(owner.Item?.ActorOwnedRemovalOnly);
        Assert.Null(owner.Item?.DisplayName);
        Assert.Same(configuration, owner.Configuration);
        Assert.Equal(7, owner.Configuration?.ExpectedOverridesRevision);
        Assert.Equal(0, owner.GetStateCalls);
    }

    [Theory]
    [InlineData(HostItemKind.Movie, SpoilerGuardItemKind.Movie)]
    [InlineData(HostItemKind.Series, SpoilerGuardItemKind.Series)]
    public void GetState_MapsOnlyAuthoritativeActorAndItem_AndInvokesOwnerExactlyOnce(
        HostItemKind hostKind,
        SpoilerGuardItemKind ownerKind)
    {
        var owner = new RecordingOwner();
        var adapter = new SpoilerGuardPlatformItemActionAdapter(owner);
        var userId = Guid.NewGuid();
        var itemId = Guid.NewGuid();

        var result = adapter.GetState(
            PlatformActorTestFactory.Create(userId, false, "correlation", "client", "device"),
            new HostAccessibleItem(itemId, hostKind, seriesId: null, []));

        Assert.Same(owner.State, result);
        Assert.Equal(1, owner.GetStateCalls);
        Assert.Equal(0, owner.ConfigureCalls);
        Assert.Equal(userId, owner.Actor?.UserId);
        Assert.Equal(itemId, owner.Item?.ItemId);
        Assert.Equal(ownerKind, owner.Item?.Kind);
        Assert.False(owner.Item?.ActorOwnedRemovalOnly);
        Assert.Null(owner.Item?.DisplayName);
    }

    [Fact]
    public void UnsupportedAccessibleKind_FailsBeforeOwnerInvocation()
    {
        var owner = new RecordingOwner();
        var adapter = new SpoilerGuardPlatformItemActionAdapter(owner);

        Assert.Throws<ArgumentOutOfRangeException>(() => adapter.Configure(
            PlatformActorTestFactory.Create(Guid.NewGuid(), false, "correlation", null, null),
            new HostAccessibleItem(Guid.NewGuid(), HostItemKind.Episode, Guid.NewGuid(), []),
            SpoilerGuardItemConfiguration.Exact(false, 0)));
        Assert.Throws<ArgumentOutOfRangeException>(() => adapter.GetState(
            PlatformActorTestFactory.Create(Guid.NewGuid(), false, "correlation", null, null),
            new HostAccessibleItem(Guid.NewGuid(), HostItemKind.Other, null, [])));
        Assert.Equal(0, owner.ConfigureCalls + owner.GetStateCalls);
    }

    [Fact]
    public void Configure_RejectsLegacyNoCasConfigurationBeforeOwnerInvocation()
    {
        var owner = new RecordingOwner();
        var adapter = new SpoilerGuardPlatformItemActionAdapter(owner);

        var exception = Assert.Throws<ArgumentException>(() => adapter.Configure(
            PlatformActorTestFactory.Create(Guid.NewGuid(), false, "correlation", null, null),
            new HostAccessibleItem(Guid.NewGuid(), HostItemKind.Movie, null, []),
            new SpoilerGuardItemConfiguration(enabled: true)));

        Assert.Equal("configuration", exception.ParamName);
        Assert.Equal(0, owner.ConfigureCalls + owner.GetStateCalls);
    }

    [Fact]
    public void ExistingMovie_WithNoPlatformDisplayName_PreservesOwnerStateAndRevision()
    {
        var directory = Path.Combine(
            Path.GetTempPath(),
            "jc-sg-platform-adapter-" + Guid.NewGuid().ToString("N"));
        try
        {
            var manager = new UserConfigurationManager(
                new StubAppPaths(directory),
                NullLogger<UserConfigurationManager>.Instance);
            var userId = Guid.NewGuid();
            var itemId = Guid.NewGuid();
            var itemKey = itemId.ToString("N");
            manager.SaveUserConfiguration(
                userId.ToString("N"),
                "spoilerblur.json",
                new UserSpoilerBlur
                {
                    OverridesRevision = 17,
                    Movies = new Dictionary<string, SpoilerBlurMovieEntry>(StringComparer.OrdinalIgnoreCase)
                    {
                        [itemKey] = new SpoilerBlurMovieEntry
                        {
                            MovieId = itemKey,
                            MovieName = "Preserve this title",
                            EnabledAt = "2026-08-03T01:02:03.0000000Z",
                        },
                    },
                });

            var adapter = new SpoilerGuardPlatformItemActionAdapter(
                new SpoilerGuardItemActionOwner(manager));
            var result = adapter.Configure(
                PlatformActorTestFactory.Create(userId, false, "correlation", null, null),
                new HostAccessibleItem(itemId, HostItemKind.Movie, seriesId: null, []),
                SpoilerGuardItemConfiguration.Exact(enabled: true, expectedOverridesRevision: 17));
            var stored = manager.GetUserConfigurationStrict<UserSpoilerBlur>(
                userId.ToString("N"),
                "spoilerblur.json");

            Assert.Equal(SpoilerGuardItemActionOutcome.Configured, result.Outcome);
            Assert.False(result.Changed);
            Assert.Equal(17, result.Revision);
            Assert.Equal(17, stored.OverridesRevision);
            Assert.Equal("Preserve this title", stored.Movies[itemKey].MovieName);
            Assert.Equal("2026-08-03T01:02:03.0000000Z", stored.Movies[itemKey].EnabledAt);
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
                // Best-effort test cleanup.
            }
        }
    }

    private sealed class RecordingOwner : ISpoilerGuardItemActionOwner
    {
        internal RecordingOwner()
        {
            State = new SpoilerGuardItemState(enabled: true, overridesRevision: 7);
            Result = SpoilerGuardItemActionResult.Configured(
                enabled: true,
                changed: true,
                removed: false,
                revision: 7);
        }

        internal SpoilerGuardItemActionResult Result { get; }

        internal SpoilerGuardItemState State { get; }

        internal int GetStateCalls { get; private set; }

        internal int ConfigureCalls { get; private set; }

        internal SpoilerGuardActorProjection? Actor { get; private set; }

        internal SpoilerGuardItemProjection? Item { get; private set; }

        internal SpoilerGuardItemConfiguration? Configuration { get; private set; }

        public SpoilerGuardItemState GetState(
            SpoilerGuardActorProjection actor,
            SpoilerGuardItemProjection item)
        {
            GetStateCalls++;
            Actor = actor;
            Item = item;
            return State;
        }

        public SpoilerGuardItemActionResult Configure(
            SpoilerGuardActorProjection actor,
            SpoilerGuardItemProjection item,
            SpoilerGuardItemConfiguration configuration)
        {
            ConfigureCalls++;
            Actor = actor;
            Item = item;
            Configuration = configuration;
            return Result;
        }
    }
}
