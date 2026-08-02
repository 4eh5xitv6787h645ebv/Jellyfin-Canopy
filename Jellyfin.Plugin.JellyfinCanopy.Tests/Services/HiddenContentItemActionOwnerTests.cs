using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using System.Diagnostics;
using System.Text.Json;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class HiddenContentItemActionOwnerTests : IDisposable
{
    private readonly string _baseDirectory;
    private readonly UserConfigurationManager _manager;
    private readonly FakePluginConfigProvider _provider;
    private readonly HiddenContentItemActionOwner _owner;

    public HiddenContentItemActionOwnerTests()
    {
        _baseDirectory = Path.Combine(Path.GetTempPath(), "jc-hidden-owner-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_baseDirectory);
        _manager = new UserConfigurationManager(
            new StubAppPaths(_baseDirectory),
            NullLogger<UserConfigurationManager>.Instance);
        _provider = new FakePluginConfigProvider(new PluginConfiguration());
        _owner = new HiddenContentItemActionOwner(_manager, _provider);
    }

    public void Dispose()
    {
        try { Directory.Delete(_baseDirectory, recursive: true); } catch { }
    }

    [Fact]
    public void StateRead_ForMissingActorStore_IsSideEffectFree()
    {
        var actor = Actor(Guid.NewGuid());
        var result = _owner.GetState(actor, Movie(Guid.NewGuid()), HiddenContentItemScope.Global);

        Assert.False(result.Hidden);
        Assert.False(result.Changed);
        Assert.Equal(0, result.ItemsRevision);
        Assert.False(File.Exists(Path.Combine(UserDirectory(actor.UserId), "hidden-content.json")));
    }

    [Fact]
    public void ItemProjection_BoundsPresentationAndDropsNonEpisodeAncestry()
    {
        var projection = new HiddenContentItemProjection(
            Guid.NewGuid(),
            HiddenContentItemKind.Movie,
            new string('n', 700),
            "123",
            Guid.NewGuid(),
            new string('s', 700),
            2,
            3);

        Assert.Equal(512, projection.DisplayName?.Length);
        Assert.Null(projection.SeriesId);
        Assert.Null(projection.SeriesName);
        Assert.Null(projection.SeasonNumber);
        Assert.Null(projection.EpisodeNumber);
    }

    [Fact]
    public void ExactMutation_UsesItemsRevisionCas_AndPreservesPreferenceRevision()
    {
        var actor = Actor(Guid.NewGuid());
        var item = Movie(Guid.NewGuid());
        Save(actor, new UserHiddenContent
        {
            ItemsRevision = 4,
            Settings = new HiddenContentSettings { Revision = 9, Enabled = false }
        });

        var hidden = _owner.Configure(
            actor,
            item,
            HiddenContentItemConfiguration.Exact(true, HiddenContentItemScope.Global, 4));
        var unhidden = _owner.Configure(
            actor,
            item,
            HiddenContentItemConfiguration.Exact(false, HiddenContentItemScope.Global, 5));

        Assert.Equal(HiddenContentItemActionOutcome.Configured, hidden.Outcome);
        Assert.True(hidden.Hidden);
        Assert.Equal(5, hidden.ItemsRevision);
        Assert.Equal(9, hidden.SettingsRevision);
        Assert.False(hidden.HiddenContentEnabled);
        Assert.True(unhidden.Changed);
        Assert.Equal(6, unhidden.ItemsRevision);
        var durable = Read(actor);
        Assert.Empty(durable.Items);
        Assert.Equal(6, durable.ItemsRevision);
        Assert.Equal(9, durable.Settings.Revision);
    }

    [Fact]
    public void ExactMutation_WithStaleRevision_ReturnsConflictWithoutMutation()
    {
        var actor = Actor(Guid.NewGuid());
        var item = Movie(Guid.NewGuid());
        Save(actor, new UserHiddenContent { ItemsRevision = 12 });

        var result = _owner.Configure(
            actor,
            item,
            HiddenContentItemConfiguration.Exact(true, HiddenContentItemScope.Global, 11));

        Assert.Equal(HiddenContentItemActionOutcome.RevisionConflict, result.Outcome);
        Assert.False(result.Changed);
        Assert.Equal(12, result.ItemsRevision);
        Assert.Empty(Read(actor).Items);
    }

    [Theory]
    [InlineData("global", HiddenContentItemScope.ContinueWatching, "continuewatching")]
    [InlineData("homesections", HiddenContentItemScope.NextUp, "nextup")]
    public void ExactHide_ReplacesPriorScopeWithoutLegacyWidening(
        string priorScope,
        HiddenContentItemScope desiredScope,
        string expectedScope)
    {
        var actor = Actor(Guid.NewGuid());
        var item = Movie(Guid.NewGuid());
        Save(actor, new UserHiddenContent
        {
            ItemsRevision = 14,
            Items = new Dictionary<string, HiddenContentItem>
            {
                [item.ItemId.ToString("N")] = new()
                {
                    ItemId = item.ItemId.ToString("N"),
                    HideScope = priorScope
                },
                [item.ItemId.ToString()] = new()
                {
                    ItemId = item.ItemId.ToString(),
                    HideScope = priorScope
                }
            }
        });

        var result = _owner.Configure(
            actor,
            item,
            HiddenContentItemConfiguration.Exact(true, desiredScope, 14));

        Assert.Equal(HiddenContentItemActionOutcome.Configured, result.Outcome);
        Assert.True(result.Changed);
        Assert.Equal(15, result.ItemsRevision);
        Assert.Equal(expectedScope, result.Entry?.HideScope);
        var durable = Read(actor);
        Assert.Equal(15, durable.ItemsRevision);
        Assert.Equal(expectedScope, Assert.Single(durable.Items).Value.HideScope);
    }

    [Fact]
    public void ExactUnhide_RemovesItemDespiteMismatchedPriorScope()
    {
        var actor = Actor(Guid.NewGuid());
        var item = Movie(Guid.NewGuid());
        Save(actor, new UserHiddenContent
        {
            ItemsRevision = 20,
            Items = new Dictionary<string, HiddenContentItem>
            {
                [item.ItemId.ToString()] = new()
                {
                    ItemId = item.ItemId.ToString(),
                    HideScope = "global"
                }
            }
        });

        var result = _owner.Configure(
            actor,
            item,
            HiddenContentItemConfiguration.Exact(false, HiddenContentItemScope.NextUp, 20));

        Assert.True(result.Changed);
        Assert.False(result.Hidden);
        Assert.Equal(21, result.ItemsRevision);
        var durable = Read(actor);
        Assert.Empty(durable.Items);
        Assert.Equal(21, durable.ItemsRevision);
    }

    [Fact]
    public void ActorProjection_IsTheOnlyUserStoreSelected()
    {
        var first = Actor(Guid.NewGuid());
        var second = Actor(Guid.NewGuid());
        var item = Movie(Guid.NewGuid());

        _owner.Configure(first, item, HiddenContentItemConfiguration.Exact(true, HiddenContentItemScope.Global, 0));

        Assert.True(_owner.GetState(first, item, HiddenContentItemScope.Global).Hidden);
        Assert.False(_owner.GetState(second, item, HiddenContentItemScope.Global).Hidden);
        Assert.Empty(Read(second).Items);
    }

    [Fact]
    public void LegacyScopedMutation_SeedsDefaults_AndWidensHomeScopes()
    {
        _provider.Current = new PluginConfiguration
        {
            HiddenContentDefaultEnabled = false,
            HiddenContentDefaultFilterSearch = true
        };
        var actor = Actor(Guid.NewGuid());
        var item = Movie(Guid.NewGuid());

        var first = _owner.Configure(
            actor,
            item,
            HiddenContentItemConfiguration.LegacyHomeSurface(true, HiddenContentItemScope.ContinueWatching));
        var second = _owner.Configure(
            actor,
            item,
            HiddenContentItemConfiguration.LegacyHomeSurface(true, HiddenContentItemScope.NextUp));

        Assert.True(first.SettingsChanged);
        Assert.True(first.HiddenContentEnabled);
        Assert.Equal(1, first.SettingsRevision);
        Assert.Equal("homesections", second.Entry?.HideScope);
        Assert.Equal(2, second.ItemsRevision);
        var durable = Read(actor);
        Assert.True(durable.Settings.Enabled);
        Assert.True(durable.Settings.FilterSearch);
        Assert.Single(durable.Items);
    }

    [Theory]
    [InlineData("series")]
    public void LegacyScopedMutation_SeriesScopeComposesToHomeSections(
        string storedScope)
    {
        var actor = Actor(Guid.NewGuid());
        var item = Movie(Guid.NewGuid());
        Save(actor, new UserHiddenContent
        {
            ItemsRevision = 9,
            Items = new Dictionary<string, HiddenContentItem>
            {
                [item.ItemId.ToString()] = new()
                {
                    ItemId = item.ItemId.ToString(),
                    HideScope = storedScope
                }
            }
        });

        var result = _owner.Configure(
            actor,
            item,
            HiddenContentItemConfiguration.LegacyHomeSurface(
                true,
                HiddenContentItemScope.ContinueWatching));

        Assert.Equal("homesections", result.Entry?.HideScope);
        Assert.Equal(10, result.ItemsRevision);
        Assert.Equal(
            "homesections",
            Assert.Single(Read(actor).Items).Value.HideScope);
    }

    [Fact]
    public void ExactMutation_PreservesLargeNestedExtensionOnlyOnDisk_AndReturnsReplaySafeEvidence()
    {
        var actor = Actor(Guid.NewGuid());
        var item = Movie(Guid.NewGuid());
        var extensions = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        for (var index = 0; index < 24; index++)
        {
            extensions[$"future-{index:D2}"] = JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(new
            {
                nested = new
                {
                    value = new string((char)('a' + (index % 26)), PersistedPayloadPolicy.MaximumExtensionStringLength),
                    marker = $"kept-{index:D2}"
                }
            }));
        }

        Assert.True(JsonSerializer.SerializeToUtf8Bytes(extensions).Length > PlatformIdempotencyStore.MaximumResultBytes);
        Save(actor, new UserHiddenContent
        {
            ItemsRevision = 2,
            Items = new Dictionary<string, HiddenContentItem>
            {
                [item.ItemId.ToString()] = new()
                {
                    ItemId = item.ItemId.ToString(),
                    HideScope = "global",
                    ExtensionData = extensions
                }
            }
        });

        var result = _owner.Configure(
            actor,
            item,
            HiddenContentItemConfiguration.Exact(
                true,
                HiddenContentItemScope.ContinueWatching,
                2));

        Assert.Null(typeof(HiddenContentItemState).GetProperty("ExtensionData"));
        Assert.Null(typeof(HiddenContentItemIdentityState).GetProperty("ExtensionData"));
        var resultBytes = JsonSerializer.SerializeToUtf8Bytes(result);
        Assert.True(resultBytes.Length < PlatformIdempotencyStore.MaximumResultBytes);
        Assert.DoesNotContain("future-", System.Text.Encoding.UTF8.GetString(resultBytes), StringComparison.Ordinal);
        var durable = Assert.Single(Read(actor).Items).Value;
        Assert.Equal(24, durable.ExtensionData.Count);
        Assert.Equal(
            "kept-23",
            durable.ExtensionData["future-23"]
                .GetProperty("nested")
                .GetProperty("marker")
                .GetString());
    }

    [Fact]
    public void ExactMutation_MergesAliasesFirstWins_AndFailsClosedAtAggregateExtensionBound()
    {
        var actor = Actor(Guid.NewGuid());
        var item = Movie(Guid.NewGuid());
        var state = new UserHiddenContent { ItemsRevision = 7 };
        for (var index = 0; index <= PersistedPayloadPolicy.MaximumExtensionProperties; index++)
        {
            state.Items[(index + 1).ToString("x32")] = new HiddenContentItem
            {
                ItemId = item.ItemId.ToString(),
                HideScope = "global",
                ExtensionData = new Dictionary<string, JsonElement>(StringComparer.Ordinal)
                {
                    [$"opaque-{index:D4}"] = JsonSerializer.Deserialize<JsonElement>($"{{\"order\":{index}}}")
                }
            };
        }

        Save(actor, state);
        var path = Path.Combine(UserDirectory(actor.UserId), "hidden-content.json");
        var before = File.ReadAllBytes(path);
        var stopwatch = Stopwatch.StartNew();

        Assert.Throws<InvalidDataException>(() => _owner.Configure(
            actor,
            item,
            HiddenContentItemConfiguration.Exact(
                true,
                HiddenContentItemScope.ContinueWatching,
                expectedItemsRevision: 7)));

        stopwatch.Stop();
        Assert.Equal(before, File.ReadAllBytes(path));
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(5), $"Aggregate rejection took {stopwatch.Elapsed}.");
    }

    [Fact]
    public void ExactMutation_DuplicateAliasExtensionKeysKeepFirstValue()
    {
        var actor = Actor(Guid.NewGuid());
        var item = Movie(Guid.NewGuid());
        var state = new UserHiddenContent { ItemsRevision = 2 };
        foreach (var index in new[] { 1, 2 })
        {
            state.Items[index.ToString("x32")] = new HiddenContentItem
            {
                ItemId = item.ItemId.ToString(),
                HideScope = "global",
                ExtensionData = new Dictionary<string, JsonElement>(StringComparer.Ordinal)
                {
                    ["same"] = JsonSerializer.Deserialize<JsonElement>($"{{\"order\":{index}}}")
                }
            };
        }

        var validation = PersistedPayloadPolicy.ValidateMutationCandidate(state);
        Assert.True(validation.IsValid, validation.Code);
        Save(actor, state);
        Assert.Equal(2, Read(actor).ItemsRevision);
        Assert.Equal(2, Read(actor).Items.Count);
        var result = _owner.Configure(
            actor,
            item,
            HiddenContentItemConfiguration.Exact(
                true,
                HiddenContentItemScope.ContinueWatching,
                expectedItemsRevision: 2));

        Assert.Equal(HiddenContentItemActionOutcome.Configured, result.Outcome);
        Assert.True(result.Changed);
        Assert.Equal(
            1,
            Assert.Single(Read(actor).Items).Value.ExtensionData["same"].GetProperty("order").GetInt32());
    }

    [Fact]
    public void LegacyMutation_BackfillsBlankTmdbIdFromValidTypedIdentity()
    {
        var actor = Actor(Guid.NewGuid());
        var itemId = Guid.NewGuid();
        Save(actor, new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                [itemId.ToString()] = new()
                {
                    ItemId = itemId.ToString(),
                    TmdbId = string.Empty,
                    Identity = new HiddenContentIdentity
                    {
                        Version = 1,
                        Provider = "tmdb",
                        MediaType = "movie",
                        Id = "456"
                    },
                    HideScope = "continuewatching"
                }
            }
        });
        var item = new HiddenContentItemProjection(
            itemId,
            HiddenContentItemKind.Movie,
            "Movie",
            tmdbId: null,
            seriesId: null,
            seriesName: null,
            seasonNumber: null,
            episodeNumber: null);

        var result = _owner.Configure(
            actor,
            item,
            HiddenContentItemConfiguration.LegacyHomeSurface(
                true,
                HiddenContentItemScope.ContinueWatching));

        Assert.Equal("456", result.Entry?.TmdbId);
        Assert.Equal("456", Assert.Single(Read(actor).Items).Value.TmdbId);
    }

    [Fact]
    public void GetState_ReturnsDetachedBoundedLegacyEntryWithoutRewritingDisk()
    {
        var actor = Actor(Guid.NewGuid());
        var item = Movie(Guid.NewGuid());
        Save(actor, LegacyUnboundedState(item.ItemId, revision: 4));
        var path = Path.Combine(UserDirectory(actor.UserId), "hidden-content.json");
        var before = File.ReadAllBytes(path);

        var result = _owner.GetState(actor, item, HiddenContentItemScope.Global);

        Assert.True(result.Hidden);
        Assert.Equal(511, result.Entry?.Name.Length);
        Assert.Equal(new string('n', 511), result.Entry?.Name);
        Assert.Equal(before, File.ReadAllBytes(path));
    }

    [Fact]
    public void RevisionRejection_ReturnsDetachedBoundedLegacyEntryWithoutRewritingDisk()
    {
        var actor = Actor(Guid.NewGuid());
        var item = Movie(Guid.NewGuid());
        Save(actor, LegacyUnboundedState(item.ItemId, revision: 4));
        var path = Path.Combine(UserDirectory(actor.UserId), "hidden-content.json");
        var before = File.ReadAllBytes(path);

        var result = _owner.Configure(
            actor,
            item,
            HiddenContentItemConfiguration.Exact(
                true,
                HiddenContentItemScope.Global,
                expectedItemsRevision: 3));

        Assert.Equal(HiddenContentItemActionOutcome.RevisionConflict, result.Outcome);
        Assert.Equal(511, result.Entry?.Name.Length);
        Assert.Equal(new string('n', 511), result.Entry?.Name);
        Assert.Equal(4, result.ItemsRevision);
        Assert.Equal(before, File.ReadAllBytes(path));
    }

    [Fact]
    public void CorruptStore_FailsClosedAndPublishesRecoveryMarker()
    {
        var actor = Actor(Guid.NewGuid());
        var directory = UserDirectory(actor.UserId);
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "hidden-content.json");
        File.WriteAllText(path, "{not-json");

        Assert.Throws<UserStoreUnhealthyException>(() => _owner.Configure(
            actor,
            Movie(Guid.NewGuid()),
            HiddenContentItemConfiguration.Exact(true, HiddenContentItemScope.Global, 0)));
        Assert.Contains(
            Directory.EnumerateFiles(directory),
            candidate => candidate.Contains("unhealthy", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void PayloadTooLarge_ReturnsAuthoritativeEvidenceAndLeavesBytesUnchanged()
    {
        var actor = Actor(Guid.NewGuid());
        var itemId = Guid.Parse("ffffffff-ffff-ffff-ffff-ffffffffffff");
        var state = new UserHiddenContent
        {
            ItemsRevision = 27,
            Settings = new HiddenContentSettings { Revision = 8, Enabled = false }
        };
        state.Items[itemId.ToString()] = new HiddenContentItem
        {
            ItemId = itemId.ToString(),
            Type = "Movie",
            HideScope = "global"
        };
        for (var index = 1; index < 5000; index++)
        {
            var id = index.ToString("x32");
            state.Items[id] = new HiddenContentItem
            {
                ItemId = id,
                Type = "Movie",
                HideScope = "global"
            };
        }

        var targetBytes = PersistedPayloadPolicy.HiddenContentPersistedBytes - 100;
        var remaining = targetBytes
            - PersistedPayloadPolicy.ValidateSerializedSize(state, int.MaxValue).SerializedBytes;
        foreach (var pair in state.Items)
        {
            if (pair.Key == itemId.ToString())
            {
                continue;
            }

            pair.Value.Name = Padding(ref remaining);
            pair.Value.SeriesName = Padding(ref remaining);
            pair.Value.PosterPath = Padding(ref remaining);
            if (remaining == 0)
            {
                break;
            }
        }

        Assert.Equal(0, remaining);
        Save(actor, state);
        var path = Path.Combine(UserDirectory(actor.UserId), "hidden-content.json");
        var before = File.ReadAllBytes(path);
        var actorKey = actor.UserId.ToString("N");
        HiddenContentResponseFilter.SeedCacheForTest(actorKey);

        var result = _owner.Configure(
            actor,
            new HiddenContentItemProjection(
                itemId,
                HiddenContentItemKind.Movie,
                new string('n', 512),
                "123",
                null,
                null,
                null,
                null),
            HiddenContentItemConfiguration.Exact(true, HiddenContentItemScope.Global, 27));

        Assert.Equal(HiddenContentItemActionOutcome.PayloadTooLarge, result.Outcome);
        Assert.True(result.Hidden);
        Assert.False(result.Changed);
        Assert.Equal(27, result.ItemsRevision);
        Assert.Equal(8, result.SettingsRevision);
        Assert.False(result.HiddenContentEnabled);
        Assert.Equal(before, File.ReadAllBytes(path));
        Assert.True(HiddenContentResponseFilter.IsCachedForTest(actorKey));
        HiddenContentResponseFilter.InvalidateUser(actorKey);
    }

    [Fact]
    public void CapacityRejection_ReturnsAuthoritativeEvidenceWithoutCacheInvalidation()
    {
        var actor = Actor(Guid.NewGuid());
        var state = new UserHiddenContent
        {
            ItemsRevision = 31,
            Settings = new HiddenContentSettings { Revision = 6, Enabled = false }
        };
        for (var index = 0; index < PersistedPayloadPolicy.MaximumHiddenItems; index++)
        {
            var id = (index + 1).ToString("x32");
            state.Items[id] = new HiddenContentItem { ItemId = id, HideScope = "global" };
        }

        Save(actor, state);
        var path = Path.Combine(UserDirectory(actor.UserId), "hidden-content.json");
        var before = File.ReadAllBytes(path);
        var actorKey = actor.UserId.ToString("N");
        HiddenContentResponseFilter.SeedCacheForTest(actorKey);

        var result = _owner.Configure(
            actor,
            Movie(Guid.NewGuid()),
            HiddenContentItemConfiguration.Exact(true, HiddenContentItemScope.Global, 31));

        Assert.Equal(HiddenContentItemActionOutcome.CapacityExceeded, result.Outcome);
        Assert.False(result.Hidden);
        Assert.False(result.Changed);
        Assert.Equal(31, result.ItemsRevision);
        Assert.Equal(6, result.SettingsRevision);
        Assert.False(result.HiddenContentEnabled);
        Assert.Equal(before, File.ReadAllBytes(path));
        Assert.True(HiddenContentResponseFilter.IsCachedForTest(actorKey));
        HiddenContentResponseFilter.InvalidateUser(actorKey);
    }

    private static HiddenContentActorProjection Actor(Guid id) => new(id);

    private static HiddenContentItemProjection Movie(Guid id) => new(
        id,
        HiddenContentItemKind.Movie,
        "A movie",
        "123",
        seriesId: null,
        seriesName: null,
        seasonNumber: null,
        episodeNumber: null);

    private string UserDirectory(Guid userId) => Path.Combine(
        _baseDirectory,
        "configurations",
        "Jellyfin.Plugin.JellyfinCanopy",
        userId.ToString("N"));

    private void Save(HiddenContentActorProjection actor, UserHiddenContent state)
        => _manager.SaveUserConfiguration(actor.UserId.ToString("N"), "hidden-content.json", state);

    private UserHiddenContent Read(HiddenContentActorProjection actor)
        => _manager.GetUserConfigurationStrict<UserHiddenContent>(actor.UserId.ToString("N"), "hidden-content.json");

    private static UserHiddenContent LegacyUnboundedState(Guid itemId, long revision)
        => new()
        {
            ItemsRevision = revision,
            Items = new Dictionary<string, HiddenContentItem>
            {
                [itemId.ToString()] = new()
                {
                    ItemId = itemId.ToString(),
                    Name = new string('n', 511) + "😀" + new string('x', 1535),
                    Type = "Movie",
                    HideScope = "global"
                }
            }
        };

    private static string Padding(ref int remaining)
    {
        var length = Math.Min(remaining, 512);
        remaining -= length;
        return new string('x', length);
    }
}
