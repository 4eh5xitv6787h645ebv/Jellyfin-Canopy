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
        var configuration = new SpoilerGuardItemConfiguration(enabled: true);

        var result = adapter.Configure(
            new PlatformActor(userId, false, "correlation", null, null),
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
    }

    [Fact]
    public void UnsupportedAccessibleKind_FailsBeforeOwnerInvocation()
    {
        var owner = new RecordingOwner();
        var adapter = new SpoilerGuardPlatformItemActionAdapter(owner);

        Assert.Throws<ArgumentOutOfRangeException>(() => adapter.Configure(
            new PlatformActor(Guid.NewGuid(), false, "correlation", null, null),
            new HostAccessibleItem(Guid.NewGuid(), HostItemKind.Episode, Guid.NewGuid(), []),
            new SpoilerGuardItemConfiguration(enabled: false)));
        Assert.Equal(0, owner.ConfigureCalls);
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
                new PlatformActor(userId, false, "correlation", null, null),
                new HostAccessibleItem(itemId, HostItemKind.Movie, seriesId: null, []),
                new SpoilerGuardItemConfiguration(enabled: true));
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
            Result = SpoilerGuardItemActionResult.Configured(
                enabled: true,
                changed: true,
                removed: false,
                revision: 7);
        }

        internal SpoilerGuardItemActionResult Result { get; }

        internal int ConfigureCalls { get; private set; }

        internal SpoilerGuardActorProjection? Actor { get; private set; }

        internal SpoilerGuardItemProjection? Item { get; private set; }

        internal SpoilerGuardItemConfiguration? Configuration { get; private set; }

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
