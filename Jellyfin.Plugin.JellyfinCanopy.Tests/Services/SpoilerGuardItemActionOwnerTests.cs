using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
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

    [Fact]
    public void GetState_ReturnsOnlyClosedItemStateAndRevision_WithoutWritingOrExposingPrefs()
    {
        var actor = Actor();
        var itemId = Guid.NewGuid();
        var itemKey = itemId.ToString("N");
        var userKey = actor.UserId.ToString("N");
        _manager.SaveUserConfiguration(userKey, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 23,
            Series = new Dictionary<string, SpoilerBlurSeriesEntry>(StringComparer.OrdinalIgnoreCase)
            {
                [itemKey] = new()
                {
                    SeriesId = itemKey,
                    SeriesName = "Private presentation metadata",
                },
            },
            Prefs = new SpoilerBlurUserPrefs
            {
                Revision = 17,
                HideTags = false,
                HideRatings = true,
            },
        });
        var before = File.ReadAllBytes(SpoilerPath(userKey));

        var state = new SpoilerGuardItemActionOwner(_manager).GetState(
            actor,
            Accessible(itemId, SpoilerGuardItemKind.Series, "Ignored"));

        Assert.True(state.Enabled);
        Assert.Equal(23, state.OverridesRevision);
        Assert.Equal(
            new[] { nameof(SpoilerGuardItemState.Enabled), nameof(SpoilerGuardItemState.OverridesRevision) },
            typeof(SpoilerGuardItemState).GetProperties().Select(property => property.Name).Order());
        Assert.Empty(typeof(SpoilerGuardItemState).GetConstructors());
        Assert.Equal(before, File.ReadAllBytes(SpoilerPath(userKey)));
        Assert.DoesNotContain("Prefs", JsonSerializer.Serialize(state), StringComparison.Ordinal);
        Assert.DoesNotContain("Private presentation metadata", JsonSerializer.Serialize(state), StringComparison.Ordinal);
    }

    [Fact]
    public void GetState_IsolatesActorAndExactItem()
    {
        var actor = Actor();
        var otherActor = Actor();
        var protectedItem = Guid.NewGuid();
        var userKey = actor.UserId.ToString("N");
        var itemKey = protectedItem.ToString("N");
        _manager.SaveUserConfiguration(userKey, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 9,
            Movies = new Dictionary<string, SpoilerBlurMovieEntry>(StringComparer.OrdinalIgnoreCase)
            {
                [itemKey] = new() { MovieId = itemKey },
            },
        });

        var owner = new SpoilerGuardItemActionOwner(_manager);
        var protectedState = owner.GetState(
            actor,
            Accessible(protectedItem, SpoilerGuardItemKind.Movie, null));
        var otherItemState = owner.GetState(
            actor,
            Accessible(Guid.NewGuid(), SpoilerGuardItemKind.Movie, null));
        var otherActorState = owner.GetState(
            otherActor,
            Accessible(protectedItem, SpoilerGuardItemKind.Movie, null));

        Assert.True(protectedState.Enabled);
        Assert.Equal(9, protectedState.OverridesRevision);
        Assert.False(otherItemState.Enabled);
        Assert.Equal(9, otherItemState.OverridesRevision);
        Assert.False(otherActorState.Enabled);
        Assert.Equal(0, otherActorState.OverridesRevision);
    }

    [Fact]
    public void GetState_RejectsLegacyRemovalProofAndUnavailableStore()
    {
        var actor = Actor();
        var owner = new SpoilerGuardItemActionOwner(_manager);
        Assert.Throws<ArgumentException>(() => owner.GetState(
            actor,
            SpoilerGuardItemProjection.ActorOwnedRemoval(
                Guid.NewGuid(),
                SpoilerGuardItemKind.Movie)));

        var userKey = actor.UserId.ToString("N");
        Directory.CreateDirectory(SpoilerPath(userKey));
        Assert.Throws<IOException>(() => owner.GetState(
            actor,
            Accessible(Guid.NewGuid(), SpoilerGuardItemKind.Movie, null)));
    }

    [Fact]
    public void Configure_StaleExpectedRevision_ReturnsCurrentTypedEvidenceWithoutWriteOrInvalidation()
    {
        var actor = Actor();
        var itemId = Guid.NewGuid();
        var itemKey = itemId.ToString("N");
        var userKey = actor.UserId.ToString("N");
        _manager.SaveUserConfiguration(userKey, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 11,
            Series = new Dictionary<string, SpoilerBlurSeriesEntry>(StringComparer.OrdinalIgnoreCase)
            {
                [itemKey] = new() { SeriesId = itemKey, SeriesName = "Existing" },
            },
        });
        var before = File.ReadAllBytes(SpoilerPath(userKey));
        SpoilerUserResolver.SeedUserStateCacheForTest(userKey);

        var result = new SpoilerGuardItemActionOwner(_manager).Configure(
            actor,
            Accessible(itemId, SpoilerGuardItemKind.Series, null),
            Exact(enabled: false, expectedRevision: 10));

        Assert.Equal(SpoilerGuardItemActionOutcome.RevisionConflict, result.Outcome);
        Assert.True(result.Enabled);
        Assert.False(result.Changed);
        Assert.False(result.Removed);
        Assert.Equal(11, result.Revision);
        Assert.Equal(before, File.ReadAllBytes(SpoilerPath(userKey)));
        Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(userKey));
    }

    [Fact]
    public async Task Configure_ConcurrentSameRevision_AllowsExactlyOneAtomicWinner()
    {
        var actor = Actor();
        var itemId = Guid.NewGuid();
        var owner = new SpoilerGuardItemActionOwner(_manager);
        using var start = new ManualResetEventSlim(initialState: false);
        var calls = Enumerable.Range(0, 8)
            .Select(_ => Task.Run(() =>
            {
                start.Wait();
                return owner.Configure(
                    actor,
                    Accessible(itemId, SpoilerGuardItemKind.Movie, null),
                    Exact(enabled: true, expectedRevision: 0));
            }))
            .ToArray();

        start.Set();
        var results = await Task.WhenAll(calls);

        var winner = Assert.Single(
            results,
            result => result.Outcome == SpoilerGuardItemActionOutcome.Configured);
        Assert.True(winner.Changed);
        Assert.Equal(1, winner.Revision);
        Assert.Equal(7, results.Count(result =>
            result.Outcome == SpoilerGuardItemActionOutcome.RevisionConflict));
        Assert.True(new SpoilerGuardItemActionOwner(_manager).GetState(
            actor,
            Accessible(itemId, SpoilerGuardItemKind.Movie, null)).Enabled);
    }

    [Fact]
    public void Configure_AbaStateStillRejectsOriginalRevision()
    {
        var actor = Actor();
        var item = Accessible(Guid.NewGuid(), SpoilerGuardItemKind.Series, null);
        var owner = new SpoilerGuardItemActionOwner(_manager);
        var original = owner.GetState(actor, item);

        var enabled = owner.Configure(actor, item, Exact(true, original.OverridesRevision));
        var disabled = owner.Configure(actor, item, Exact(false, enabled.Revision));
        var stale = owner.Configure(actor, item, Exact(true, original.OverridesRevision));

        Assert.Equal(1, enabled.Revision);
        Assert.Equal(2, disabled.Revision);
        Assert.False(disabled.Enabled);
        Assert.Equal(SpoilerGuardItemActionOutcome.RevisionConflict, stale.Outcome);
        Assert.False(stale.Enabled);
        Assert.Equal(2, stale.Revision);
        Assert.False(owner.GetState(actor, item).Enabled);
    }

    [Fact]
    public void Configure_ExactMutationPreservesNullablePreferenceInheritanceAndRevision()
    {
        var actor = Actor();
        var userKey = actor.UserId.ToString("N");
        var item = Accessible(Guid.NewGuid(), SpoilerGuardItemKind.Series, null);
        var future = JsonSerializer.Deserialize<JsonElement>("{\"nested\":\"preserved\"}");
        _manager.SaveUserConfiguration(userKey, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 12,
            Prefs = new SpoilerBlurUserPrefs
            {
                Revision = 31,
                HideEpisodeDescriptions = null,
                HideTags = false,
                HideRatings = true,
                SkipDisableConfirm = true,
                ExtensionData = new Dictionary<string, JsonElement>(StringComparer.Ordinal)
                {
                    ["future-pref"] = future,
                },
            },
        });
        var owner = new SpoilerGuardItemActionOwner(_manager);

        var enabled = owner.Configure(actor, item, Exact(true, 12));
        var disabled = owner.Configure(actor, item, Exact(false, enabled.Revision));
        var stored = Read(userKey);

        Assert.Equal(14, disabled.Revision);
        Assert.Equal(31, stored.Prefs.Revision);
        Assert.Null(stored.Prefs.HideEpisodeDescriptions);
        Assert.False(stored.Prefs.HideTags);
        Assert.True(stored.Prefs.HideRatings);
        Assert.True(stored.Prefs.SkipDisableConfirm);
        Assert.Equal(
            "preserved",
            stored.Prefs.ExtensionData["future-pref"].GetProperty("nested").GetString());
    }

    [Fact]
    public void Configure_LegacyNoCasAndNativeExactHaveEquivalentDurableSemantics()
    {
        var legacyDirectory = Path.Combine(_directory, "legacy");
        var nativeDirectory = Path.Combine(_directory, "native");
        var legacyManager = Manager(legacyDirectory);
        var nativeManager = Manager(nativeDirectory);
        var actor = Actor();
        var item = Accessible(Guid.NewGuid(), SpoilerGuardItemKind.Movie, "Movie");
        var initial = new UserSpoilerBlur
        {
            OverridesRevision = 7,
            Prefs = new SpoilerBlurUserPrefs
            {
                Revision = 3,
                HideTags = null,
                HideReviews = false,
            },
        };
        var userKey = actor.UserId.ToString("N");
        legacyManager.SaveUserConfiguration(userKey, SpoilerFile, initial);
        nativeManager.SaveUserConfiguration(userKey, SpoilerFile, initial);
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 8, 3, 4, 5, 6, TimeSpan.Zero));
        var legacyOwner = new SpoilerGuardItemActionOwner(legacyManager, clock);
        var nativeOwner = new SpoilerGuardItemActionOwner(nativeManager, clock);

        var legacyEnabled = legacyOwner.Configure(actor, item, Enabled());
        var nativeEnabled = nativeOwner.Configure(actor, item, Exact(true, 7));
        var legacyDisabled = legacyOwner.Configure(actor, item, Disabled());
        var nativeDisabled = nativeOwner.Configure(actor, item, Exact(false, nativeEnabled.Revision));

        Assert.Equal(legacyEnabled.Enabled, nativeEnabled.Enabled);
        Assert.Equal(legacyEnabled.Changed, nativeEnabled.Changed);
        Assert.Equal(legacyEnabled.Revision, nativeEnabled.Revision);
        Assert.Equal(legacyDisabled.Enabled, nativeDisabled.Enabled);
        Assert.Equal(legacyDisabled.Removed, nativeDisabled.Removed);
        Assert.Equal(legacyDisabled.Revision, nativeDisabled.Revision);
        Assert.Equal(
            JsonSerializer.Serialize(legacyManager.GetUserConfigurationStrict<UserSpoilerBlur>(userKey, SpoilerFile)),
            JsonSerializer.Serialize(nativeManager.GetUserConfigurationStrict<UserSpoilerBlur>(userKey, SpoilerFile)));
    }

    [Fact]
    public void Configure_PersistenceFailureNeverAcknowledgesOrInvalidates()
    {
        var actor = Actor();
        var userKey = actor.UserId.ToString("N");
        var path = SpoilerPath(userKey);
        Directory.CreateDirectory(path);
        SpoilerUserResolver.SeedUserStateCacheForTest(userKey);

        Assert.ThrowsAny<IOException>(() => new SpoilerGuardItemActionOwner(_manager).Configure(
            actor,
            Accessible(Guid.NewGuid(), SpoilerGuardItemKind.Movie, null),
            Exact(enabled: true, expectedRevision: 0)));

        Assert.True(Directory.Exists(path));
        Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(userKey));
    }

    [Fact]
    public void ExactConfiguration_RejectsNegativeRevision()
        => Assert.Throws<ArgumentOutOfRangeException>(() => Exact(true, -1));

    private static SpoilerGuardActorProjection Actor()
        => new(Guid.NewGuid());

    private static SpoilerGuardItemProjection Accessible(
        Guid itemId,
        SpoilerGuardItemKind kind,
        string? name)
        => SpoilerGuardItemProjection.CurrentAccessible(itemId, kind, name);

    private static SpoilerGuardItemConfiguration Enabled() => new(enabled: true);

    private static SpoilerGuardItemConfiguration Disabled() => new(enabled: false);

    private static SpoilerGuardItemConfiguration Exact(bool enabled, long expectedRevision)
        => SpoilerGuardItemConfiguration.Exact(enabled, expectedRevision);

    private static UserConfigurationManager Manager(string directory)
        => new(
            new StubAppPaths(directory),
            NullLogger<UserConfigurationManager>.Instance);

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
