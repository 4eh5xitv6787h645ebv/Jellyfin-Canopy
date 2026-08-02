using System.Collections.Immutable;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class HiddenContentPlatformItemActionAdapterTests
{
    [Fact]
    public void Configure_MapsAuthoritativeProjections_AndInvokesOwnerExactlyOnce()
    {
        var owner = new RecordingOwner();
        var adapter = new HiddenContentPlatformItemActionAdapter(owner);
        var userId = Guid.NewGuid();
        var itemId = Guid.NewGuid();
        var actor = new PlatformActor(userId, false, "correlation", null, null);
        var item = new HostAccessibleItem(
            itemId,
            HostItemKind.Movie,
            seriesId: null,
            ImmutableArray.Create(new HostProviderReference("tmdb", "123")));
        var configuration = HiddenContentItemConfiguration.Exact(
            true,
            HiddenContentItemScope.Global,
            expectedItemsRevision: 7);

        adapter.Configure(actor, item, configuration);

        Assert.Equal(1, owner.ConfigureCalls);
        Assert.Equal(0, owner.GetStateCalls);
        Assert.Equal(userId, owner.Actor?.UserId);
        Assert.Equal(itemId, owner.Item?.ItemId);
        Assert.Equal(HiddenContentItemKind.Movie, owner.Item?.Kind);
        Assert.Equal("123", owner.Item?.TmdbId);
        Assert.Same(configuration, owner.Configuration);
    }

    [Fact]
    public void GetState_InvokesOwnerExactlyOnce()
    {
        var owner = new RecordingOwner();
        var adapter = new HiddenContentPlatformItemActionAdapter(owner);

        adapter.GetState(
            new PlatformActor(Guid.NewGuid(), false, "correlation", null, null),
            new HostAccessibleItem(Guid.NewGuid(), HostItemKind.Episode, Guid.NewGuid(), []),
            HiddenContentItemScope.Global);

        Assert.Equal(1, owner.GetStateCalls);
        Assert.Equal(0, owner.ConfigureCalls);
    }

    [Fact]
    public void UnsupportedAccessibleKind_FailsBeforeOwnerInvocation()
    {
        var owner = new RecordingOwner();
        var adapter = new HiddenContentPlatformItemActionAdapter(owner);
        var actor = new PlatformActor(Guid.NewGuid(), false, "correlation", null, null);
        var item = new HostAccessibleItem(Guid.NewGuid(), HostItemKind.Other, null, []);

        Assert.Throws<ArgumentOutOfRangeException>(() => adapter.Configure(
            actor,
            item,
            HiddenContentItemConfiguration.Exact(true, HiddenContentItemScope.Global, 0)));
        Assert.Equal(0, owner.GetStateCalls + owner.ConfigureCalls);
    }

    private sealed class RecordingOwner : IHiddenContentItemActionOwner
    {
        public int GetStateCalls { get; private set; }

        public int ConfigureCalls { get; private set; }

        public HiddenContentActorProjection? Actor { get; private set; }

        public HiddenContentItemProjection? Item { get; private set; }

        public HiddenContentItemConfiguration? Configuration { get; private set; }

        public HiddenContentItemActionResult GetState(
            HiddenContentActorProjection actor,
            HiddenContentItemProjection item,
            HiddenContentItemScope scope)
        {
            GetStateCalls++;
            Actor = actor;
            Item = item;
            return Result();
        }

        public HiddenContentItemActionResult Configure(
            HiddenContentActorProjection actor,
            HiddenContentItemProjection item,
            HiddenContentItemConfiguration configuration)
        {
            ConfigureCalls++;
            Actor = actor;
            Item = item;
            Configuration = configuration;
            return Result();
        }

        private static HiddenContentItemActionResult Result() => new(
            HiddenContentItemActionOutcome.Configured,
            hidden: false,
            changed: false,
            Guid.NewGuid().ToString(),
            entry: null,
            itemsRevision: 0,
            settingsRevision: 0,
            hiddenContentEnabled: false,
            settingsChanged: false);
    }
}
