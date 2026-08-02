using System;
using System.Collections.Generic;
using System.IO;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class SpoilerGuardItemActionOwnerTests : IDisposable
{
    private const string SpoilerFile = "spoilerblur.json";
    private readonly string _directory = Path.Combine(
        Path.GetTempPath(),
        "jc-sg-item-owner-" + Guid.NewGuid().ToString("N"));
    private readonly UserConfigurationManager _manager;

    public SpoilerGuardItemActionOwnerTests()
    {
        _manager = new UserConfigurationManager(
            new StubAppPaths(_directory),
            NullLogger<UserConfigurationManager>.Instance);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_directory, recursive: true);
        }
        catch
        {
            // Best-effort test cleanup.
        }
    }

    [Fact]
    public void Configure_SeriesInsertNoOpAndRename_PreserveTimestampAndAdvanceOncePerChange()
    {
        var now = new DateTimeOffset(2026, 8, 3, 1, 2, 3, TimeSpan.Zero);
        var owner = new SpoilerGuardItemActionOwner(_manager, new ManualTimeProvider(now));
        var actor = Actor();
        var itemId = Guid.NewGuid();
        var userKey = actor.UserId.ToString("N");
        var itemKey = itemId.ToString("N");

        var inserted = owner.Configure(
            actor,
            Accessible(itemId, SpoilerGuardItemKind.Series, "First name"),
            Enabled());
        var first = Read(userKey);
        var enabledAt = first.Series[itemKey].EnabledAt;

        Assert.Equal(SpoilerGuardItemActionOutcome.Configured, inserted.Outcome);
        Assert.True(inserted.Changed);
        Assert.Equal(1, inserted.Revision);
        Assert.Equal(now.UtcDateTime.ToString("o"), enabledAt);
        Assert.Equal("First name", first.Series[itemKey].SeriesName);

        SpoilerUserResolver.SeedUserStateCacheForTest(userKey);
        var noOp = owner.Configure(
            actor,
            Accessible(itemId, SpoilerGuardItemKind.Series, "First name"),
            Enabled());

        Assert.False(noOp.Changed);
        Assert.Equal(1, noOp.Revision);
        Assert.False(SpoilerUserResolver.IsUserStateCachedForTest(userKey));

        var renamed = owner.Configure(
            actor,
            Accessible(itemId, SpoilerGuardItemKind.Series, "Renamed"),
            Enabled());
        var final = Read(userKey);

        Assert.True(renamed.Changed);
        Assert.Equal(2, renamed.Revision);
        Assert.Equal("Renamed", final.Series[itemKey].SeriesName);
        Assert.Equal(enabledAt, final.Series[itemKey].EnabledAt);
    }

    [Fact]
    public void Configure_MovieInsertAndActorOwnedRemoval_AreBoundedAndIdempotent()
    {
        var owner = new SpoilerGuardItemActionOwner(_manager);
        var actor = Actor();
        var itemId = Guid.NewGuid();
        var itemKey = itemId.ToString("N");
        var longName = new string('m', PersistedPayloadPolicy.MaximumStandardStringLength + 50);

        var inserted = owner.Configure(
            actor,
            Accessible(itemId, SpoilerGuardItemKind.Movie, longName),
            Enabled());
        var stored = Read(actor.UserId.ToString("N"));

        Assert.True(inserted.Changed);
        Assert.Equal(
            PersistedPayloadPolicy.MaximumStandardStringLength,
            stored.Movies[itemKey].MovieName.Length);

        var removed = owner.Configure(
            actor,
            SpoilerGuardItemProjection.ActorOwnedRemoval(itemId, SpoilerGuardItemKind.Movie),
            Disabled());
        var noOp = owner.Configure(
            actor,
            SpoilerGuardItemProjection.ActorOwnedRemoval(itemId, SpoilerGuardItemKind.Movie),
            Disabled());

        Assert.True(removed.Changed);
        Assert.True(removed.Removed);
        Assert.Equal(2, removed.Revision);
        Assert.False(noOp.Changed);
        Assert.False(noOp.Removed);
        Assert.Equal(2, noOp.Revision);
    }

    [Fact]
    public void Configure_NewEntryAtCapacity_RefusesWithoutRevisionWriteOrCacheInvalidation()
    {
        var actor = Actor();
        var userKey = actor.UserId.ToString("N");
        var state = new UserSpoilerBlur
        {
            OverridesRevision = 41,
            Series = BuildSeriesOverrides(PersistedPayloadPolicy.MaximumSpoilerEntriesPerDictionary),
        };
        _manager.SaveUserConfiguration(userKey, SpoilerFile, state);
        var before = File.ReadAllBytes(SpoilerPath(userKey));
        SpoilerUserResolver.SeedUserStateCacheForTest(userKey);

        var result = new SpoilerGuardItemActionOwner(_manager).Configure(
            actor,
            Accessible(Guid.NewGuid(), SpoilerGuardItemKind.Series, "Over cap"),
            Enabled());

        Assert.Equal(SpoilerGuardItemActionOutcome.CapacityExceeded, result.Outcome);
        Assert.Equal("series", result.CapacityCategory);
        Assert.False(result.Changed);
        Assert.Equal(41, result.Revision);
        Assert.Equal(before, File.ReadAllBytes(SpoilerPath(userKey)));
        Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(userKey));
    }

    [Fact]
    public void Configure_RemovalProofCannotBeReusedToEnableContent()
    {
        var actor = Actor();
        var item = SpoilerGuardItemProjection.ActorOwnedRemoval(
            Guid.NewGuid(),
            SpoilerGuardItemKind.Series);

        var exception = Assert.Throws<ArgumentException>(() =>
            new SpoilerGuardItemActionOwner(_manager).Configure(actor, item, Enabled()));

        Assert.Equal("item", exception.ParamName);
        Assert.False(File.Exists(SpoilerPath(actor.UserId.ToString("N"))));
    }

    private static SpoilerGuardActorProjection Actor()
        => new(Guid.NewGuid());

    private static SpoilerGuardItemProjection Accessible(
        Guid itemId,
        SpoilerGuardItemKind kind,
        string? name)
        => SpoilerGuardItemProjection.CurrentAccessible(itemId, kind, name);

    private static SpoilerGuardItemConfiguration Enabled() => new(enabled: true);

    private static SpoilerGuardItemConfiguration Disabled() => new(enabled: false);

    private UserSpoilerBlur Read(string userKey)
        => _manager.GetUserConfigurationStrict<UserSpoilerBlur>(userKey, SpoilerFile);

    private string SpoilerPath(string userKey)
        => Path.Combine(
            _directory,
            "configurations",
            "Jellyfin.Plugin.JellyfinCanopy",
            userKey,
            SpoilerFile);

    private static Dictionary<string, SpoilerBlurSeriesEntry> BuildSeriesOverrides(int count)
    {
        var entries = new Dictionary<string, SpoilerBlurSeriesEntry>(
            count,
            StringComparer.OrdinalIgnoreCase);
        for (var index = 1; index <= count; index++)
        {
            var id = new Guid(index, 0, 0, new byte[8]);
            var key = id.ToString("N");
            entries[key] = new SpoilerBlurSeriesEntry
            {
                SeriesId = key,
                SeriesName = "Series " + index,
            };
        }

        return entries;
    }

    private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
