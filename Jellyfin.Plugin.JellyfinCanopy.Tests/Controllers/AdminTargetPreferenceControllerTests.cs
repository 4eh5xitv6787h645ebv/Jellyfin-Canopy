using System.Reflection;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class AdminTargetPreferenceControllerTests : IDisposable
{
    private const string HiddenFile = "hidden-content.json";
    private const string SpoilerFile = "spoilerblur.json";
    private const long PreferenceRequestBytes = 8 * 1024;
    private const long SpoilerOverridesRequestBytes = 2L * 1024 * 1024;

    private readonly string _baseDir;
    private readonly UserConfigurationManager _manager;
    private readonly User _actor;
    private readonly User _target;
    private readonly StubUserManager _userManager;
    private readonly FakePluginConfigProvider _provider;
    private readonly CountingLibraryManager _library;

    public AdminTargetPreferenceControllerTests()
    {
        _baseDir = Path.Combine(
            Path.GetTempPath(),
            "jc-admin-target-preferences-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_baseDir);
        _manager = new UserConfigurationManager(
            new StubAppPaths(_baseDir),
            NullLogger<UserConfigurationManager>.Instance);
        _actor = new User("admin-actor", "Provider", "PasswordProvider");
        _actor.SetPermission(PermissionKind.IsAdministrator, true);
        _target = new User("Target <User> & Co", "Provider", "PasswordProvider");
        _userManager = new StubUserManager(_actor, _target);
        _provider = new FakePluginConfigProvider(new PluginConfiguration
        {
            HiddenContentAdmin = true,
            SpoilerBlurEnabled = true
        });
        _library = new CountingLibraryManager();
    }

    public void Dispose()
    {
        HiddenContentResponseFilter.InvalidateUser(ActorId);
        HiddenContentResponseFilter.InvalidateUser(TargetId);
        SpoilerUserResolver.InvalidateUser(ActorId);
        SpoilerUserResolver.InvalidateUser(TargetId);
        try { Directory.Delete(_baseDir, recursive: true); } catch { /* best effort */ }
    }

    [Fact]
    public void ElevatedPreferenceEndpoints_HaveExactRoutesPoliciesAndRequestLimits()
    {
        AssertGet(
            typeof(HiddenContentController),
            nameof(HiddenContentController.GetTargetHiddenContentSettings),
            "admin/user-settings/{targetUserId}/hidden-content-settings.json",
            "admin/user-settings/{targetUserId}/hidden-content-settings.json/evidence");
        AssertPost(
            typeof(HiddenContentController),
            nameof(HiddenContentController.SaveTargetHiddenContentSettings),
            "admin/user-settings/{targetUserId}/hidden-content-settings.json");

        AssertGet(
            typeof(SpoilerGuardController),
            nameof(SpoilerGuardController.GetTargetSpoilerGuardPreferences),
            "admin/user-settings/{targetUserId}/spoiler-guard-prefs.json",
            "admin/user-settings/{targetUserId}/spoiler-guard-prefs.json/evidence");
        AssertPost(
            typeof(SpoilerGuardController),
            nameof(SpoilerGuardController.SaveTargetSpoilerGuardPreferences),
            "admin/user-settings/{targetUserId}/spoiler-guard-prefs.json");
        AssertGet(
            typeof(SpoilerGuardController),
            nameof(SpoilerGuardController.GetTargetSpoilerGuardOverrides),
            "admin/user-settings/{targetUserId}/spoiler-guard-overrides.json",
            "admin/user-settings/{targetUserId}/spoiler-guard-overrides.json/evidence");
        AssertPost(
            typeof(SpoilerGuardController),
            nameof(SpoilerGuardController.SaveTargetSpoilerGuardOverrides),
            "admin/user-settings/{targetUserId}/spoiler-guard-overrides.json",
            SpoilerOverridesRequestBytes);
    }

    [Fact]
    public void TargetResolution_AcceptsDAndNAndRejectsMalformedOrUnknownWithoutCreatingAStore()
    {
        _manager.SaveUserConfiguration(TargetId, HiddenFile, new UserHiddenContent
        {
            Settings = new HiddenContentSettings { Revision = 3 }
        });
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            Prefs = new SpoilerBlurUserPrefs { Revision = 4 }
        });

        var hiddenEnvelope = AssertOkEnvelope(
            HiddenController().GetTargetHiddenContentSettings(
                _target.Id.ToString("D").ToUpperInvariant()));
        Assert.Equal(TargetId, Property<string>(hiddenEnvelope, "TargetUserId"));
        Assert.Equal(_target.Username, Property<string>(hiddenEnvelope, "TargetDisplayName"));

        var spoilerEnvelope = AssertOkEnvelope(
            SpoilerController().GetTargetSpoilerGuardPreferences(TargetId));
        Assert.Equal(TargetId, Property<string>(spoilerEnvelope, "TargetUserId"));
        Assert.Equal(_target.Username, Property<string>(spoilerEnvelope, "TargetDisplayName"));
        var spoilerOverrides = AssertOkEnvelope(
            SpoilerController().GetTargetSpoilerGuardOverrides(
                _target.Id.ToString("D").ToUpperInvariant()));
        Assert.Equal(TargetId, Property<string>(spoilerOverrides, "TargetUserId"));
        Assert.Equal(
            _target.Username,
            Property<string>(spoilerOverrides, "TargetDisplayName"));

        Assert.IsType<BadRequestObjectResult>(
            HiddenController().GetTargetHiddenContentSettings("not-a-guid"));
        Assert.IsType<BadRequestObjectResult>(
            SpoilerController(ifMatch: 0).SaveTargetSpoilerGuardPreferences(
                Guid.Empty.ToString("N"),
                new SpoilerBlurUserPrefs()));
        Assert.IsType<BadRequestObjectResult>(
            SpoilerController().GetTargetSpoilerGuardOverrides("not-a-guid"));

        var unknown = Guid.NewGuid();
        Assert.IsType<NotFoundObjectResult>(
            SpoilerController().GetTargetSpoilerGuardPreferences(
                unknown.ToString("D")));
        Assert.IsType<NotFoundObjectResult>(
            SpoilerController(ifMatch: 0).SaveTargetSpoilerGuardOverrides(
                unknown.ToString("D"),
                new SpoilerGuardOverrides()));
        Assert.IsType<NotFoundObjectResult>(
            HiddenController(ifMatch: 0).SaveTargetHiddenContentSettings(
                unknown.ToString("N"),
                new HiddenContentSettings()));
        Assert.IsType<NotFoundObjectResult>(
            HiddenController().GetUserHiddenContent(unknown.ToString("D")));
        Assert.IsType<NotFoundObjectResult>(
            HiddenController().SaveUserHiddenContent(
                unknown.ToString("N"),
                new UserHiddenContent()));
        Assert.IsType<NotFoundObjectResult>(
            SpoilerController().GetUserSpoilerBlur(unknown.ToString("D")));
        Assert.IsType<NotFoundObjectResult>(
            SpoilerController().SaveUserSpoilerBlur(
                unknown.ToString("N"),
                new UserSpoilerBlur()));

        Assert.False(Directory.Exists(UserDirectory(unknown)));
        Assert.False(Directory.Exists(UserDirectory(Guid.Empty)));
    }

    [Fact]
    public void HiddenItemMutationAcknowledgements_EchoCanonicalResolvedTargetIdentity()
    {
        var addItemId = Guid.Parse("10101010-1111-2222-3333-444444444444");
        _library.GetItemByIdUserHook = (id, scopedUser) =>
            id == addItemId && scopedUser?.Id == _target.Id
                ? new MediaBrowser.Controller.Entities.Movies.Movie
                {
                    Id = addItemId,
                    Name = "Canonical add item"
                }
                : null;
        _manager.SaveUserConfiguration(TargetId, HiddenFile, new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["remove-me"] = new() { ItemId = "remove-me", Name = "Remove me" }
            }
        });

        var hide = Assert.IsType<OkObjectResult>(
            HiddenController(ifMatch: 0).AdminHideForUser(
                TargetId,
                new List<HiddenContentItem>
                {
                    new() { ItemId = addItemId.ToString("N"), Name = "Untrusted add item" }
                }));
        var hideAck = JsonSerializer.SerializeToElement(hide.Value);
        Assert.Equal(1, hideAck.GetProperty("added").GetInt32());
        Assert.Equal(TargetId, hideAck.GetProperty("userId").GetString());
        Assert.Equal(_target.Username, hideAck.GetProperty("userName").GetString());
        Assert.Equal(TargetId, hideAck.GetProperty("targetUserId").GetString());
        Assert.Equal(_target.Username, hideAck.GetProperty("targetDisplayName").GetString());

        var unhide = Assert.IsType<OkObjectResult>(
            HiddenController(ifMatch: 1).AdminUnhideForUser(
                TargetId,
                new List<string> { "remove-me" }));
        var unhideAck = JsonSerializer.SerializeToElement(unhide.Value);
        Assert.Equal(TargetId, unhideAck.GetProperty("userId").GetString());
        Assert.Equal(_target.Username, unhideAck.GetProperty("userName").GetString());
        Assert.Equal(TargetId, unhideAck.GetProperty("targetUserId").GetString());
        Assert.Equal(_target.Username, unhideAck.GetProperty("targetDisplayName").GetString());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("W/\"4\"")]
    [InlineData("\"04\"")]
    [InlineData("\"4\", \"5\"")]
    [InlineData("4")]
    public void HiddenItemMutations_RequireOneStrongCanonicalIfMatchWithoutMutation(
        string? rawIfMatch)
    {
        _manager.SaveUserConfiguration(TargetId, HiddenFile, new UserHiddenContent
        {
            ItemsRevision = 4,
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["keep"] = new() { ItemId = "keep", Name = "Keep" }
            }
        });
        var before = File.ReadAllBytes(UserFile(_target.Id, HiddenFile));

        var unhide = Assert.IsType<ObjectResult>(
            HiddenController(rawIfMatch: rawIfMatch).AdminUnhideForUser(
                TargetId,
                new List<string> { "keep" }));
        var hide = Assert.IsType<ObjectResult>(
            HiddenController(rawIfMatch: rawIfMatch).AdminHideForUser(
                TargetId,
                new List<HiddenContentItem>
                {
                    new()
                    {
                        Name = "Provider item",
                        Type = "Movie",
                        TmdbId = "550"
                    }
                }));

        Assert.Equal(StatusCodes.Status428PreconditionRequired, unhide.StatusCode);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, hide.StatusCode);
        Assert.Equal(before, File.ReadAllBytes(UserFile(_target.Id, HiddenFile)));
    }

    [Fact]
    public void HiddenItemGetAndSuccessfulMutation_ReturnStrongRevisionEvidence()
    {
        _manager.SaveUserConfiguration(TargetId, HiddenFile, new UserHiddenContent
        {
            ItemsRevision = 4,
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["remove"] = new() { ItemId = "remove", Name = "Remove" }
            }
        });

        var readController = HiddenController();
        var read = Assert.IsType<OkObjectResult>(
            readController.GetUserHiddenContentForAdmin(TargetId));
        var readEvidence = JsonSerializer.SerializeToElement(read.Value);
        Assert.Equal(TargetId, readEvidence.GetProperty("userId").GetString());
        Assert.Equal(
            4,
            readEvidence.GetProperty("hiddenContent")
                .GetProperty("ItemsRevision")
                .GetInt64());
        Assert.Equal("\"4\"", readController.Response.Headers.ETag.ToString());

        var writeController = HiddenController(ifMatch: 4);
        var write = Assert.IsType<OkObjectResult>(
            writeController.AdminUnhideForUser(
                TargetId,
                new List<string> { "remove" }));
        var acknowledgement = JsonSerializer.SerializeToElement(write.Value);
        Assert.Equal(1, acknowledgement.GetProperty("removed").GetInt32());
        Assert.Equal(5, acknowledgement.GetProperty("itemsRevision").GetInt64());
        Assert.Equal(TargetId, acknowledgement.GetProperty("targetUserId").GetString());
        Assert.Equal("\"5\"", writeController.Response.Headers.ETag.ToString());
        Assert.Equal(
            5,
            _manager.GetUserConfigurationStrict<UserHiddenContent>(
                TargetId,
                HiddenFile).ItemsRevision);
    }

    [Fact]
    public void HiddenItemStaleNoOps_ConflictAfterSameKeyRemoveAndReadd()
    {
        const string key = "hc1:tmdb:movie:550";
        _manager.SaveUserConfiguration(TargetId, HiddenFile, new UserHiddenContent
        {
            ItemsRevision = 7,
            Items = new Dictionary<string, HiddenContentItem>
            {
                [key] = new()
                {
                    Name = "Before",
                    Type = "Movie",
                    TmdbId = "550",
                    Identity = new HiddenContentIdentity
                    {
                        Version = 1,
                        Provider = "tmdb",
                        MediaType = "movie",
                        Id = "550"
                    }
                }
            }
        });

        var remove = PersistedPayloadPolicy.CloneValidated(
            _manager.GetUserConfigurationStrict<UserHiddenContent>(
                TargetId,
                HiddenFile));
        remove.Items.Clear();
        Assert.IsType<OkObjectResult>(
            HiddenController().SaveUserHiddenContent(TargetId, remove));
        var readd = PersistedPayloadPolicy.CloneValidated(
            _manager.GetUserConfigurationStrict<UserHiddenContent>(
                TargetId,
                HiddenFile));
        readd.Items[key] = new HiddenContentItem
        {
            Name = "After",
            Type = "Movie",
            TmdbId = "550",
            Identity = new HiddenContentIdentity
            {
                Version = 1,
                Provider = "tmdb",
                MediaType = "movie",
                Id = "550"
            }
        };
        Assert.IsType<OkObjectResult>(
            HiddenController().SaveUserHiddenContent(TargetId, readd));
        var beforeConflicts = File.ReadAllBytes(UserFile(_target.Id, HiddenFile));
        HiddenContentResponseFilter.SeedCacheForTest(TargetId);

        var staleUnhideController = HiddenController(ifMatch: 7);
        var staleUnhide = Assert.IsType<ConflictObjectResult>(
            staleUnhideController.AdminUnhideForUser(
                TargetId,
                new List<string> { "missing-no-op" }));
        AssertHiddenItemsConflict(
            staleUnhide,
            staleUnhideController,
            expectedRevision: 9);

        var staleHideController = HiddenController(ifMatch: 7);
        var staleHide = Assert.IsType<ConflictObjectResult>(
            staleHideController.AdminHideForUser(
                TargetId,
                new List<HiddenContentItem>
                {
                    new()
                    {
                        Name = "Stale no-op",
                        Type = "Movie",
                        TmdbId = "550",
                        Identity = new HiddenContentIdentity
                        {
                            Version = 1,
                            Provider = "tmdb",
                            MediaType = "movie",
                            Id = "550"
                        }
                    }
                }));
        AssertHiddenItemsConflict(
            staleHide,
            staleHideController,
            expectedRevision: 9);
        Assert.Equal(
            beforeConflicts,
            File.ReadAllBytes(UserFile(_target.Id, HiddenFile)));
        Assert.True(HiddenContentResponseFilter.IsCachedForTest(TargetId));
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            TargetId,
            HiddenFile);
        Assert.Equal(9, stored.ItemsRevision);
        Assert.Equal("After", stored.Items[key].Name);

        var currentNoOpController = HiddenController(ifMatch: 9);
        var currentNoOp = Assert.IsType<OkObjectResult>(
            currentNoOpController.AdminHideForUser(
                TargetId,
                new List<HiddenContentItem>
                {
                    new()
                    {
                        Name = "Correct-revision no-op",
                        Type = "Movie",
                        TmdbId = "550"
                    }
                }));
        var noOpEvidence = JsonSerializer.SerializeToElement(currentNoOp.Value);
        Assert.Equal(0, noOpEvidence.GetProperty("added").GetInt32());
        Assert.Equal(9, noOpEvidence.GetProperty("itemsRevision").GetInt64());
        Assert.Equal("\"9\"", currentNoOpController.Response.Headers.ETag.ToString());
    }

    [Fact]
    public void AdminHide_LocalItemVisibleOnlyToActor_RejectsWithoutTargetMutation()
    {
        var itemId = Guid.Parse("20202020-1111-2222-3333-444444444444");
        var actorVisibleItem = new MediaBrowser.Controller.Entities.Movies.Movie
        {
            Id = itemId,
            Name = "Actor-only movie"
        };
        User? observedEndpointScope = null;
        _library.GetItemByIdUserHook = (id, scopedUser) =>
        {
            if (id != itemId) return null;
            if (scopedUser?.Id == _target.Id) observedEndpointScope = scopedUser;
            return scopedUser?.Id == _actor.Id ? actorVisibleItem : null;
        };
        Assert.Same(
            actorVisibleItem,
            _library.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(
                itemId,
                _actor));

        _manager.SaveUserConfiguration(TargetId, HiddenFile, new UserHiddenContent
        {
            ItemsRevision = 7,
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["keep"] = new() { ItemId = "keep", Name = "Keep" }
            }
        });
        var before = File.ReadAllBytes(UserFile(_target.Id, HiddenFile));
        HiddenContentResponseFilter.SeedCacheForTest(TargetId);

        var result = Assert.IsType<NotFoundObjectResult>(
            HiddenController(ifMatch: 7).AdminHideForUser(
                TargetId,
                new List<HiddenContentItem>
                {
                    new()
                    {
                        ItemId = itemId.ToString("N"),
                        Name = "Spoofed actor metadata"
                    }
                }));

        Assert.Same(_target, observedEndpointScope);
        Assert.Equal(before, File.ReadAllBytes(UserFile(_target.Id, HiddenFile)));
        Assert.True(HiddenContentResponseFilter.IsCachedForTest(TargetId));
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            TargetId,
            HiddenFile);
        Assert.Equal(7, stored.ItemsRevision);
        Assert.Equal(new[] { "keep" }, stored.Items.Keys);
        Assert.NotNull(result.Value);
    }

    [Fact]
    public void HiddenItemEndpoints_RejectWrongIdDirectoryResolutionBeforeStoreOrLibraryAccess()
    {
        var requested = Guid.NewGuid();
        var localItem = Guid.NewGuid();
        _userManager.GetUserByIdHook = id =>
            id == requested
                ? _target
                : (id == _actor.Id
                    ? _actor
                    : (id == _target.Id ? _target : null));
        _library.GetItemByIdUserHook = (_, _) =>
            throw new InvalidOperationException("Library access must not occur.");

        Assert.IsType<NotFoundObjectResult>(
            HiddenController().GetUserHiddenContentForAdmin(requested.ToString("N")));
        Assert.IsType<NotFoundObjectResult>(
            HiddenController(ifMatch: 0).AdminHideForUser(
                requested.ToString("N"),
                new List<HiddenContentItem>
                {
                    new() { ItemId = localItem.ToString("N"), Name = "Never resolved" }
                }));
        Assert.IsType<NotFoundObjectResult>(
            HiddenController(ifMatch: 0).AdminUnhideForUser(
                requested.ToString("N"),
                new List<string> { "never-read" }));

        Assert.Equal(0, _library.GetItemByIdUserCallCount);
        Assert.False(Directory.Exists(UserDirectory(requested)));
    }

    [Fact]
    public void HiddenItemEndpoints_Return503WhenUserDirectoryLookupThrowsWithoutStoreOrLibraryAccess()
    {
        var requested = Guid.NewGuid();
        var localItem = Guid.NewGuid();
        _userManager.GetUserByIdHook = id =>
            id == requested
                ? throw new IOException("Directory unavailable.")
                : (id == _actor.Id
                    ? _actor
                    : (id == _target.Id ? _target : null));
        _library.GetItemByIdUserHook = (_, _) =>
            throw new InvalidOperationException("Library access must not occur.");

        var read = Assert.IsType<ObjectResult>(
            HiddenController().GetUserHiddenContentForAdmin(requested.ToString("N")));
        var hide = Assert.IsType<ObjectResult>(
            HiddenController(ifMatch: 0).AdminHideForUser(
                requested.ToString("N"),
                new List<HiddenContentItem>
                {
                    new() { ItemId = localItem.ToString("N"), Name = "Never resolved" }
                }));
        var unhide = Assert.IsType<ObjectResult>(
            HiddenController(ifMatch: 0).AdminUnhideForUser(
                requested.ToString("N"),
                new List<string> { "never-read" }));

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, read.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, hide.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, unhide.StatusCode);
        Assert.Equal(0, _library.GetItemByIdUserCallCount);
        Assert.False(Directory.Exists(UserDirectory(requested)));
    }

    [Fact]
    public void HiddenUserEnumeration_IsBoundedCursorPagedAndFindsLaterHiddenRows()
    {
        var candidates = new List<User> { _target };
        for (var i = 0; i < 100; i++)
        {
            var user = new User($"candidate-{i:D3}", "Provider", "PasswordProvider");
            _userManager.AddUser(user);
            candidates.Add(user);
        }

        var laterHiddenUser = candidates[^1];
        _manager.SaveUserConfiguration(
            laterHiddenUser.Id.ToString("N"),
            HiddenFile,
            new UserHiddenContent
            {
                Items = new Dictionary<string, HiddenContentItem>
                {
                    ["later"] = new()
                    {
                        ItemId = "later",
                        Name = "Later hidden row",
                        HideScope = "global"
                    }
                }
            });

        var first = Assert.IsType<OkObjectResult>(
            HiddenController().GetHiddenContentUsers(limit: 100));
        var firstJson = JsonSerializer.SerializeToElement(first.Value);
        Assert.Equal(100, firstJson.GetProperty("scanned").GetInt32());
        Assert.Equal(100, firstJson.GetProperty("limit").GetInt32());
        Assert.True(firstJson.GetProperty("truncated").GetBoolean());
        Assert.Empty(firstJson.GetProperty("users").EnumerateArray());
        var nextCursor = Assert.IsType<string>(
            firstJson.GetProperty("nextCursor").GetString());
        Assert.Equal(candidates[99].Id.ToString("N"), nextCursor);

        // The bounded read must not materialize Canopy directories for users
        // who have no existing optional configuration.
        Assert.False(Directory.Exists(UserDirectory(candidates[0].Id)));

        var second = Assert.IsType<OkObjectResult>(
            HiddenController().GetHiddenContentUsers(limit: 100, cursor: nextCursor));
        var secondJson = JsonSerializer.SerializeToElement(second.Value);
        Assert.Equal(1, secondJson.GetProperty("scanned").GetInt32());
        Assert.False(secondJson.GetProperty("truncated").GetBoolean());
        Assert.Equal(JsonValueKind.Null, secondJson.GetProperty("nextCursor").ValueKind);
        var later = Assert.Single(secondJson.GetProperty("users").EnumerateArray());
        Assert.Equal(laterHiddenUser.Id.ToString("N"), later.GetProperty("userId").GetString());
        Assert.Equal(laterHiddenUser.Username, later.GetProperty("userName").GetString());
        Assert.Equal(1, later.GetProperty("count").GetInt32());

        Assert.IsType<BadRequestObjectResult>(
            HiddenController().GetHiddenContentUsers(limit: 101));
        Assert.IsType<BadRequestObjectResult>(
            HiddenController().GetHiddenContentUsers(cursor: nextCursor.ToUpperInvariant()));
    }

    [Fact]
    public void HiddenUserEnumeration_ReadsLegacyMetadataWithoutRepairingIt()
    {
        _manager.SaveUserConfiguration(TargetId, HiddenFile, new UserHiddenContent
        {
            ItemsRevision = 6,
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["legacy"] = new()
                {
                    ItemId = "legacy",
                    Name = new string('n', 700),
                    SeriesName = new string('s', 700),
                    SeasonNumber = -1,
                    EpisodeNumber =
                        PersistedPayloadPolicy.MaximumHiddenIndex + 1,
                    HideScope = "global"
                }
            }
        });
        var path = UserFile(_target.Id, HiddenFile);
        var before = File.ReadAllBytes(path);

        var result = Assert.IsType<OkObjectResult>(
            HiddenController().GetHiddenContentUsers(limit: 100));
        var json = JsonSerializer.SerializeToElement(result.Value);
        var target = Assert.Single(json.GetProperty("users").EnumerateArray());
        Assert.Equal(TargetId, target.GetProperty("userId").GetString());
        Assert.Equal(1, target.GetProperty("count").GetInt32());
        Assert.Equal(before, File.ReadAllBytes(path));
        var stillLegacy =
            _manager.GetUserConfigurationStrict<UserHiddenContent>(
                TargetId,
                HiddenFile);
        Assert.Equal(6, stillLegacy.ItemsRevision);
        Assert.Equal(700, stillLegacy.Items["legacy"].Name.Length);
        Assert.Equal(-1, stillLegacy.Items["legacy"].SeasonNumber);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void HiddenUserEnumeration_InvalidValidJsonStateFailsWholePageWithoutMutation(
        bool overCap)
    {
        var state = new UserHiddenContent
        {
            ItemsRevision = overCap ? 0 : -1,
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["visible-if-not-validated"] = new()
                {
                    ItemId = "visible-if-not-validated",
                    HideScope = "global"
                }
            }
        };
        if (overCap)
        {
            state.Items.Clear();
            for (var index = 0;
                 index <= PersistedPayloadPolicy.MaximumHiddenItems;
                 index++)
            {
                var key = index.ToString("x32");
                state.Items[key] = new HiddenContentItem
                {
                    ItemId = key,
                    HideScope = "global"
                };
            }
        }

        _manager.SaveUserConfiguration(TargetId, HiddenFile, state);
        var path = UserFile(_target.Id, HiddenFile);
        var before = File.ReadAllBytes(path);

        var result = Assert.IsType<ObjectResult>(
            HiddenController().GetHiddenContentUsers(limit: 100));

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, result.StatusCode);
        Assert.Equal(before, File.ReadAllBytes(path));
        Assert.False(File.Exists(path + ".unhealthy"));
        Assert.Empty(Directory.GetFiles(
            Path.GetDirectoryName(path)!,
            HiddenFile + ".corrupt-*"));
    }

    [Fact]
    public void HiddenPreferences_RoundTripEveryFieldWithoutChangingActorOrItemDictionary()
    {
        _manager.SaveUserConfiguration(ActorId, HiddenFile, new UserHiddenContent
        {
            ItemsRevision = 19,
            Settings = new HiddenContentSettings { Revision = 17, Enabled = true },
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["actor-only"] = new() { Name = "Actor item", HideScope = "global" }
            }
        });
        _manager.SaveUserConfiguration(TargetId, HiddenFile, new UserHiddenContent
        {
            ItemsRevision = 8,
            Settings = new HiddenContentSettings { Revision = 3 },
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["keep-item"] = new()
                {
                    ItemId = "keep-item",
                    Name = "Preserved item",
                    Type = "Movie",
                    HideScope = "global"
                }
            }
        });
        using var extension = JsonDocument.Parse("""{"nested":["kept",2]}""");
        var candidate = CompleteHiddenPreferences(revision: 3);
        candidate.ExtensionData["FutureHiddenPreference"] = extension.RootElement.Clone();
        HiddenContentResponseFilter.SeedCacheForTest(ActorId);
        HiddenContentResponseFilter.SeedCacheForTest(TargetId);

        var saveController = HiddenController(ifMatch: 3);
        var saveEnvelope = AssertOkEnvelope(
            saveController.SaveTargetHiddenContentSettings(
                _target.Id.ToString("D"),
                candidate));
        Assert.Equal(4, Property<long>(saveEnvelope, "Revision"));
        Assert.Equal("\"4\"", saveController.Response.Headers.ETag.ToString());
        Assert.Matches("^[0-9a-f]{64}$", Property<string>(saveEnvelope, "ContentHash"));
        Assert.Equal(1, Property<int>(saveEnvelope, "ItemCount"));
        Assert.Equal(3, candidate.Revision);
        Assert.False(HiddenContentResponseFilter.IsCachedForTest(TargetId));
        Assert.True(HiddenContentResponseFilter.IsCachedForTest(ActorId));

        var storedTarget = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            TargetId,
            HiddenFile);
        AssertCompleteHiddenPreferences(storedTarget.Settings, expectedRevision: 4);
        Assert.Equal(8, storedTarget.ItemsRevision);
        var targetItem = Assert.Single(storedTarget.Items);
        Assert.Equal("keep-item", targetItem.Key);
        Assert.Equal("Preserved item", targetItem.Value.Name);
        Assert.Equal(
            "kept",
            storedTarget.Settings.ExtensionData["FutureHiddenPreference"]
                .GetProperty("nested")[0]
                .GetString());

        var storedActor = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            ActorId,
            HiddenFile);
        Assert.Equal(17, storedActor.Settings.Revision);
        Assert.Equal(19, storedActor.ItemsRevision);
        Assert.True(storedActor.Settings.Enabled);
        Assert.True(storedActor.Items.ContainsKey("actor-only"));

        var readController = HiddenController();
        var readEnvelope = AssertOkEnvelope(
            readController.GetTargetHiddenContentSettings(TargetId));
        AssertCompleteHiddenPreferences(
            Property<HiddenContentSettings>(readEnvelope, "Data"),
            expectedRevision: 4);
        Assert.Equal("\"4\"", readController.Response.Headers.ETag.ToString());
    }

    [Fact]
    public void SpoilerPreferences_RoundTripEveryFieldWithoutChangingActorOrDictionaries()
    {
        _manager.SaveUserConfiguration(ActorId, SpoilerFile, new UserSpoilerBlur
        {
            Prefs = new SpoilerBlurUserPrefs { Revision = 11, HideTags = true },
            Series = new Dictionary<string, SpoilerBlurSeriesEntry>
            {
                [Guid.NewGuid().ToString("N")] = new() { SeriesName = "Actor series" }
            }
        });
        var seriesKey = Guid.NewGuid().ToString("N");
        var movieKey = Guid.NewGuid().ToString("N");
        var collectionKey = Guid.NewGuid().ToString("N");
        const string pendingKey = "tv:54321";
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            Prefs = new SpoilerBlurUserPrefs { Revision = 6 },
            Series = new Dictionary<string, SpoilerBlurSeriesEntry>
            {
                [seriesKey] = new() { SeriesId = seriesKey, SeriesName = "Keep series" }
            },
            Movies = new Dictionary<string, SpoilerBlurMovieEntry>
            {
                [movieKey] = new() { MovieId = movieKey, MovieName = "Keep movie" }
            },
            Collections = new Dictionary<string, SpoilerBlurCollectionEntry>
            {
                [collectionKey] = new()
                {
                    CollectionId = collectionKey,
                    CollectionName = "Keep collection"
                }
            },
            PendingTmdb = new Dictionary<string, SpoilerBlurPendingEntry>
            {
                [pendingKey] = new()
                {
                    MediaType = "tv",
                    TmdbId = "54321",
                    DisplayName = "Keep pending"
                }
            }
        });
        using var extension = JsonDocument.Parse("""{"future":{"kept":true}}""");
        var candidate = CompleteSpoilerPreferences(revision: 6);
        candidate.ExtensionData["FutureSpoilerPreference"] = extension.RootElement.Clone();
        SpoilerUserResolver.SeedUserStateCacheForTest(ActorId);
        SpoilerUserResolver.SeedUserStateCacheForTest(TargetId);

        var saveController = SpoilerController(ifMatch: 6);
        var saveEnvelope = AssertOkEnvelope(
            saveController.SaveTargetSpoilerGuardPreferences(TargetId, candidate));
        Assert.Equal(7, Property<long>(saveEnvelope, "Revision"));
        Assert.Equal("\"7\"", saveController.Response.Headers.ETag.ToString());
        Assert.Matches("^[0-9a-f]{64}$", Property<string>(saveEnvelope, "ContentHash"));
        Assert.Equal(6, candidate.Revision);
        Assert.False(SpoilerUserResolver.IsUserStateCachedForTest(TargetId));
        Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(ActorId));

        var storedTarget = _manager.GetUserConfigurationStrict<UserSpoilerBlur>(
            TargetId,
            SpoilerFile);
        AssertCompleteSpoilerPreferences(storedTarget.Prefs, expectedRevision: 7);
        Assert.Equal("Keep series", Assert.Single(storedTarget.Series).Value.SeriesName);
        Assert.Equal("Keep movie", Assert.Single(storedTarget.Movies).Value.MovieName);
        Assert.Equal(
            "Keep collection",
            Assert.Single(storedTarget.Collections).Value.CollectionName);
        Assert.Equal("Keep pending", Assert.Single(storedTarget.PendingTmdb).Value.DisplayName);
        Assert.True(
            storedTarget.Prefs.ExtensionData["FutureSpoilerPreference"]
                .GetProperty("future")
                .GetProperty("kept")
                .GetBoolean());

        var storedActor = _manager.GetUserConfigurationStrict<UserSpoilerBlur>(
            ActorId,
            SpoilerFile);
        Assert.Equal(11, storedActor.Prefs.Revision);
        Assert.True(storedActor.Prefs.HideTags);
        Assert.Equal("Actor series", Assert.Single(storedActor.Series).Value.SeriesName);

        var readController = SpoilerController();
        var readEnvelope = AssertOkEnvelope(
            readController.GetTargetSpoilerGuardPreferences(
                _target.Id.ToString("D")));
        AssertCompleteSpoilerPreferences(
            Property<SpoilerBlurUserPrefs>(readEnvelope, "Data"),
            expectedRevision: 7);
        Assert.Equal("\"7\"", readController.Response.Headers.ETag.ToString());
    }

    [Fact]
    public void SpoilerOverrides_RoundTripAllSectionsPreservesPrefsStoreExtensionsAndActor()
    {
        var actorSeries = Guid.NewGuid().ToString("N");
        _manager.SaveUserConfiguration(ActorId, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 12,
            Prefs = new SpoilerBlurUserPrefs { Revision = 11, HideTags = true },
            Series = new Dictionary<string, SpoilerBlurSeriesEntry>
            {
                [actorSeries] = new()
                {
                    SeriesId = actorSeries,
                    SeriesName = "Actor series"
                }
            }
        });

        const string stalePendingKey = "tv:111";
        using var topExtension = JsonDocument.Parse("""{"owner":"store"}""");
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 7,
            Prefs = new SpoilerBlurUserPrefs
            {
                Revision = 42,
                HideReviews = false,
                SkipDisableConfirm = true
            },
            PendingTmdb = new Dictionary<string, SpoilerBlurPendingEntry>
            {
                [stalePendingKey] = new()
                {
                    MediaType = "tv",
                    TmdbId = "111",
                    DisplayName = "Old pending"
                }
            },
            ExtensionData = new Dictionary<string, JsonElement>
            {
                ["UnrelatedStoreField"] = topExtension.RootElement.Clone()
            }
        });

        var seriesKey = Guid.NewGuid().ToString("N");
        var movieKey = Guid.NewGuid().ToString("N");
        var collectionKey = Guid.NewGuid().ToString("N");
        _library.GetItemByIdUserHook = (id, scopedUser) =>
        {
            Assert.Equal(_target.Id, scopedUser?.Id);
            if (id == Guid.Parse(seriesKey))
            {
                return new MediaBrowser.Controller.Entities.TV.Series
                {
                    Id = id,
                    Name = "Trusted series"
                };
            }

            if (id == Guid.Parse(movieKey))
            {
                return new MediaBrowser.Controller.Entities.Movies.Movie
                {
                    Id = id,
                    Name = "Trusted movie"
                };
            }

            if (id == Guid.Parse(collectionKey))
            {
                return new MediaBrowser.Controller.Entities.Movies.BoxSet
                {
                    Id = id,
                    Name = "Trusted collection"
                };
            }

            return null;
        };
        const string pendingKey = "movie:54321";
        using var entryExtension = JsonDocument.Parse("""{"future":["entry",3]}""");
        using var resourceExtension = JsonDocument.Parse("""{"future":{"resource":true}}""");
        var candidate = new SpoilerGuardOverrides
        {
            Revision = 7,
            Series = new Dictionary<string, SpoilerBlurSeriesEntry>
            {
                [seriesKey] = new()
                {
                    SeriesId = seriesKey.ToUpperInvariant(),
                    SeriesName = "New series",
                    EnabledAt = "2026-07-26T01:02:03.0000000Z",
                    ExtensionData = new Dictionary<string, JsonElement>
                    {
                        ["FutureSeriesEntry"] = entryExtension.RootElement.Clone()
                    }
                }
            },
            Movies = new Dictionary<string, SpoilerBlurMovieEntry>
            {
                [movieKey] = new()
                {
                    MovieId = movieKey.ToUpperInvariant(),
                    MovieName = "New movie"
                }
            },
            Collections = new Dictionary<string, SpoilerBlurCollectionEntry>
            {
                [collectionKey] = new()
                {
                    CollectionId = collectionKey.ToUpperInvariant(),
                    CollectionName = "New collection"
                }
            },
            PendingTmdb = new Dictionary<string, SpoilerBlurPendingEntry>
            {
                [pendingKey] = new()
                {
                    MediaType = "movie",
                    TmdbId = "54321",
                    DisplayName = "New pending"
                }
            },
            ExtensionData = new Dictionary<string, JsonElement>
            {
                ["FutureOverrideResource"] = resourceExtension.RootElement.Clone()
            }
        };
        SpoilerSeerrPendingPromoter.RegisterPending(stalePendingKey, _target.Id);
        SpoilerUserResolver.SeedUserStateCacheForTest(ActorId);
        SpoilerUserResolver.SeedUserStateCacheForTest(TargetId);

        try
        {
            var saveController = SpoilerController(ifMatch: 7);
            var envelope = AssertOkEnvelope(
                saveController.SaveTargetSpoilerGuardOverrides(TargetId, candidate));
            Assert.Equal(8, Property<long>(envelope, "Revision"));
            Assert.Equal("\"8\"", saveController.Response.Headers.ETag.ToString());
            Assert.Matches("^[0-9a-f]{64}$", Property<string>(envelope, "ContentHash"));
            Assert.Equal(TargetId, Property<string>(envelope, "TargetUserId"));
            Assert.Equal(_target.Username, Property<string>(envelope, "TargetDisplayName"));
            Assert.Equal(7, candidate.Revision);
            var acknowledged = Property<SpoilerGuardOverrides>(envelope, "Data");
            Assert.Equal("New series", Assert.Single(acknowledged.Series).Value.SeriesName);
            Assert.Equal("New movie", Assert.Single(acknowledged.Movies).Value.MovieName);
            Assert.Equal(
                "New collection",
                Assert.Single(acknowledged.Collections).Value.CollectionName);
            Assert.Equal(
                seriesKey.ToUpperInvariant(),
                Assert.Single(acknowledged.Series).Value.SeriesId);
            Assert.Equal(
                movieKey.ToUpperInvariant(),
                Assert.Single(acknowledged.Movies).Value.MovieId);
            Assert.Equal(
                collectionKey.ToUpperInvariant(),
                Assert.Single(acknowledged.Collections).Value.CollectionId);
            Assert.Equal(3, _library.GetItemByIdUserCallCount);
            Assert.False(SpoilerUserResolver.IsUserStateCachedForTest(TargetId));
            Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(ActorId));

            var stored = _manager.GetUserConfigurationStrict<UserSpoilerBlur>(
                TargetId,
                SpoilerFile);
            Assert.Equal(8, stored.OverridesRevision);
            Assert.Equal(42, stored.Prefs.Revision);
            Assert.False(stored.Prefs.HideReviews);
            Assert.True(stored.Prefs.SkipDisableConfirm);
            Assert.Equal("New series", Assert.Single(stored.Series).Value.SeriesName);
            Assert.Equal("New movie", Assert.Single(stored.Movies).Value.MovieName);
            Assert.Equal(
                "New collection",
                Assert.Single(stored.Collections).Value.CollectionName);
            Assert.Equal(seriesKey.ToUpperInvariant(), stored.Series[seriesKey].SeriesId);
            Assert.Equal(movieKey.ToUpperInvariant(), stored.Movies[movieKey].MovieId);
            Assert.Equal(
                collectionKey.ToUpperInvariant(),
                stored.Collections[collectionKey].CollectionId);
            Assert.Equal("New pending", Assert.Single(stored.PendingTmdb).Value.DisplayName);
            Assert.Equal(
                "store",
                stored.ExtensionData["UnrelatedStoreField"]
                    .GetProperty("owner")
                    .GetString());
            Assert.True(
                stored.OverridesExtensionData["FutureOverrideResource"]
                    .GetProperty("future")
                    .GetProperty("resource")
                    .GetBoolean());
            Assert.Equal(
                "entry",
                stored.Series[seriesKey].ExtensionData["FutureSeriesEntry"]
                    .GetProperty("future")[0]
                    .GetString());

            var actor = _manager.GetUserConfigurationStrict<UserSpoilerBlur>(
                ActorId,
                SpoilerFile);
            Assert.Equal(12, actor.OverridesRevision);
            Assert.Equal("Actor series", Assert.Single(actor.Series).Value.SeriesName);
            Assert.True(actor.Prefs.HideTags);

            Assert.False(SpoilerSeerrPendingPromoter.IsKeyRegisteredForTest(stalePendingKey));
            Assert.True(SpoilerSeerrPendingPromoter.IsKeyRegisteredForTest(pendingKey));

            var readController = SpoilerController();
            var readEnvelope = AssertOkEnvelope(
                readController.GetTargetSpoilerGuardOverrides(
                    _target.Id.ToString("D")));
            var read = Property<SpoilerGuardOverrides>(readEnvelope, "Data");
            Assert.Equal(8, read.Revision);
            Assert.Equal("New series", Assert.Single(read.Series).Value.SeriesName);
            Assert.Equal("New movie", Assert.Single(read.Movies).Value.MovieName);
            Assert.Equal(
                "New collection",
                Assert.Single(read.Collections).Value.CollectionName);
            Assert.Equal("New pending", Assert.Single(read.PendingTmdb).Value.DisplayName);
            Assert.Equal("\"8\"", readController.Response.Headers.ETag.ToString());
        }
        finally
        {
            SpoilerSeerrPendingPromoter.UnregisterPending(stalePendingKey, _target.Id);
            SpoilerSeerrPendingPromoter.UnregisterPending(pendingKey, _target.Id);
        }
    }

    [Fact]
    public void TargetPreferenceWrites_PreserveExactOpaqueNumbersFromBrowserLossyEchoes()
    {
        const string exactNumbers = """{"big":9007199254740993,"huge":1e400}""";
        using var exactDocument = JsonDocument.Parse(exactNumbers);
        using var lossyDocument = JsonDocument.Parse(
            """{"big":9007199254740992,"huge":null}""");
        using var markerDocument = JsonDocument.Parse("""{"marker":"kept"}""");

        Dictionary<string, JsonElement> ExactExtensions()
            => new(StringComparer.Ordinal)
            {
                ["zOpaque"] = exactDocument.RootElement.Clone(),
                ["aOpaque"] = markerDocument.RootElement.Clone()
            };
        Dictionary<string, JsonElement> LossyExtensions()
            => new(StringComparer.Ordinal)
            {
                ["zOpaque"] = lossyDocument.RootElement.Clone(),
                ["aOpaque"] = markerDocument.RootElement.Clone()
            };

        _manager.SaveUserConfiguration(TargetId, HiddenFile, new UserHiddenContent
        {
            Settings = new HiddenContentSettings
            {
                Revision = 1,
                Enabled = true,
                ExtensionData = ExactExtensions()
            }
        });
        var hiddenResult = AssertOkEnvelope(
            HiddenController(ifMatch: 1).SaveTargetHiddenContentSettings(
                TargetId,
                new HiddenContentSettings
                {
                    Revision = 1,
                    Enabled = false,
                    ExtensionData = LossyExtensions()
                }));
        Assert.Equal(2, Property<long>(hiddenResult, "Revision"));
        var storedHidden = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            TargetId,
            HiddenFile);
        Assert.Equal(
            exactNumbers,
            storedHidden.Settings.ExtensionData["zOpaque"].GetRawText());
        var hiddenNoOp = AssertOkEnvelope(
            HiddenController(ifMatch: 2).SaveTargetHiddenContentSettings(
                TargetId,
                new HiddenContentSettings
                {
                    Revision = 2,
                    Enabled = false,
                    ExtensionData = LossyExtensions()
                }));
        Assert.Equal(2, Property<long>(hiddenNoOp, "Revision"));
        storedHidden = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            TargetId,
            HiddenFile);
        Assert.Equal(2, storedHidden.Settings.Revision);
        Assert.Equal(
            exactNumbers,
            storedHidden.Settings.ExtensionData["zOpaque"].GetRawText());

        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            Prefs = new SpoilerBlurUserPrefs
            {
                Revision = 2,
                HideTags = true,
                ExtensionData = ExactExtensions()
            }
        });
        var prefsResult = AssertOkEnvelope(
            SpoilerController(ifMatch: 2).SaveTargetSpoilerGuardPreferences(
                TargetId,
                new SpoilerBlurUserPrefs
                {
                    Revision = 2,
                    HideTags = false,
                    ExtensionData = LossyExtensions()
                }));
        Assert.Equal(3, Property<long>(prefsResult, "Revision"));
        var storedSpoiler = _manager.GetUserConfigurationStrict<UserSpoilerBlur>(
            TargetId,
            SpoilerFile);
        Assert.Equal(
            exactNumbers,
            storedSpoiler.Prefs.ExtensionData["zOpaque"].GetRawText());
        var prefsNoOp = AssertOkEnvelope(
            SpoilerController(ifMatch: 3).SaveTargetSpoilerGuardPreferences(
                TargetId,
                new SpoilerBlurUserPrefs
                {
                    Revision = 3,
                    HideTags = false,
                    ExtensionData = LossyExtensions()
                }));
        Assert.Equal(3, Property<long>(prefsNoOp, "Revision"));
        storedSpoiler = _manager.GetUserConfigurationStrict<UserSpoilerBlur>(
            TargetId,
            SpoilerFile);
        Assert.Equal(3, storedSpoiler.Prefs.Revision);
        Assert.Equal(
            exactNumbers,
            storedSpoiler.Prefs.ExtensionData["zOpaque"].GetRawText());

        var seriesKey = Guid.NewGuid().ToString("N");
        var movieKey = Guid.NewGuid().ToString("N");
        var collectionKey = Guid.NewGuid().ToString("N");
        const string pendingKey = "tv:123";
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 3,
            Prefs = new SpoilerBlurUserPrefs { Revision = 3 },
            OverridesExtensionData = ExactExtensions(),
            Series = new Dictionary<string, SpoilerBlurSeriesEntry>
            {
                [seriesKey] = new()
                {
                    SeriesId = seriesKey,
                    SeriesName = "Series",
                    ExtensionData = ExactExtensions()
                }
            },
            Movies = new Dictionary<string, SpoilerBlurMovieEntry>
            {
                [movieKey] = new()
                {
                    MovieId = movieKey,
                    MovieName = "Movie",
                    ExtensionData = ExactExtensions()
                }
            },
            Collections = new Dictionary<string, SpoilerBlurCollectionEntry>
            {
                [collectionKey] = new()
                {
                    CollectionId = collectionKey,
                    CollectionName = "Collection",
                    ExtensionData = ExactExtensions()
                }
            },
            PendingTmdb = new Dictionary<string, SpoilerBlurPendingEntry>
            {
                [pendingKey] = new()
                {
                    MediaType = "tv",
                    TmdbId = "123",
                    DisplayName = "Pending",
                    ExtensionData = ExactExtensions()
                }
            }
        });
        var overrideCandidate = new SpoilerGuardOverrides
        {
            Revision = 3,
            ExtensionData = LossyExtensions(),
            Series = new Dictionary<string, SpoilerBlurSeriesEntry>
            {
                [seriesKey] = new()
                {
                    SeriesId = seriesKey,
                    SeriesName = "Series",
                    ExtensionData = LossyExtensions()
                }
            },
            Movies = new Dictionary<string, SpoilerBlurMovieEntry>
            {
                [movieKey] = new()
                {
                    MovieId = movieKey,
                    MovieName = "Movie",
                    ExtensionData = LossyExtensions()
                }
            },
            Collections = new Dictionary<string, SpoilerBlurCollectionEntry>
            {
                [collectionKey] = new()
                {
                    CollectionId = collectionKey,
                    CollectionName = "Collection",
                    ExtensionData = LossyExtensions()
                }
            },
            PendingTmdb = new Dictionary<string, SpoilerBlurPendingEntry>
            {
                [pendingKey] = new()
                {
                    MediaType = "tv",
                    TmdbId = "123",
                    DisplayName = "Changed pending",
                    ExtensionData = LossyExtensions()
                }
            }
        };
        var overridesResult = AssertOkEnvelope(
            SpoilerController(ifMatch: 3).SaveTargetSpoilerGuardOverrides(
                TargetId,
                overrideCandidate));
        Assert.Equal(4, Property<long>(overridesResult, "Revision"));
        overrideCandidate.Revision = 4;
        overrideCandidate.ExtensionData = LossyExtensions();
        overrideCandidate.Series[seriesKey].ExtensionData = LossyExtensions();
        overrideCandidate.Movies[movieKey].ExtensionData = LossyExtensions();
        overrideCandidate.Collections[collectionKey].ExtensionData = LossyExtensions();
        overrideCandidate.PendingTmdb[pendingKey].ExtensionData = LossyExtensions();
        var overridesNoOp = AssertOkEnvelope(
            SpoilerController(ifMatch: 4).SaveTargetSpoilerGuardOverrides(
                TargetId,
                overrideCandidate));
        Assert.Equal(4, Property<long>(overridesNoOp, "Revision"));
        storedSpoiler = _manager.GetUserConfigurationStrict<UserSpoilerBlur>(
            TargetId,
            SpoilerFile);
        Assert.Equal(4, storedSpoiler.OverridesRevision);
        Assert.Equal(
            exactNumbers,
            storedSpoiler.OverridesExtensionData["zOpaque"].GetRawText());
        Assert.Equal(
            exactNumbers,
            storedSpoiler.Series[seriesKey]
                .ExtensionData["zOpaque"]
                .GetRawText());
        Assert.Equal(
            exactNumbers,
            storedSpoiler.Movies[movieKey]
                .ExtensionData["zOpaque"]
                .GetRawText());
        Assert.Equal(
            exactNumbers,
            storedSpoiler.Collections[collectionKey]
                .ExtensionData["zOpaque"]
                .GetRawText());
        Assert.Equal(
            exactNumbers,
            storedSpoiler.PendingTmdb[pendingKey]
                .ExtensionData["zOpaque"]
                .GetRawText());
        Assert.Equal(0, _library.GetItemByIdUserCallCount);
        SpoilerSeerrPendingPromoter.UnregisterPending(pendingKey, _target.Id);
    }

    [Fact]
    public void SpoilerOverrideWrite_TargetScopedValidationRejectsMixedBatchAtomically()
    {
        var validSeriesId = Guid.Parse("11111111-2222-3333-4444-555555555555");
        var inaccessibleMovieId = Guid.Parse("66666666-7777-8888-9999-aaaaaaaaaaaa");
        const string pendingKey = "tv:77";
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 4,
            PendingTmdb = new Dictionary<string, SpoilerBlurPendingEntry>
            {
                [pendingKey] = new()
                {
                    MediaType = "tv",
                    TmdbId = "77",
                    DisplayName = "Keep pending"
                }
            }
        });
        _library.GetItemByIdUserHook = (id, scopedUser) =>
        {
            Assert.Same(_target, scopedUser);
            return id == validSeriesId
                ? new MediaBrowser.Controller.Entities.TV.Series
                {
                    Id = id,
                    Name = "Library series name"
                }
                : null;
        };
        var before = File.ReadAllBytes(UserFile(_target.Id, SpoilerFile));
        SpoilerUserResolver.SeedUserStateCacheForTest(TargetId);
        SpoilerSeerrPendingPromoter.RegisterPending(pendingKey, _target.Id);

        try
        {
            var result = Assert.IsType<NotFoundObjectResult>(
                SpoilerController(ifMatch: 4).SaveTargetSpoilerGuardOverrides(
                    TargetId,
                    new SpoilerGuardOverrides
                    {
                        Revision = 4,
                        Series = new Dictionary<string, SpoilerBlurSeriesEntry>
                        {
                            [validSeriesId.ToString("N")] = new()
                            {
                                SeriesId = validSeriesId.ToString("N"),
                                SeriesName = "Submitted series name"
                            }
                        },
                        Movies = new Dictionary<string, SpoilerBlurMovieEntry>
                        {
                            [inaccessibleMovieId.ToString("N")] = new()
                            {
                                MovieId = inaccessibleMovieId.ToString("N"),
                                MovieName = "Actor-visible only"
                            }
                        },
                        PendingTmdb = new Dictionary<string, SpoilerBlurPendingEntry>
                        {
                            [pendingKey] = new()
                            {
                                MediaType = "tv",
                                TmdbId = "77",
                                DisplayName = "Keep pending"
                            }
                        }
                    }));

            var error = JsonSerializer.SerializeToElement(result.Value);
            Assert.Equal(
                "spoiler_override_item_unavailable",
                error.GetProperty("code").GetString());
            Assert.Equal(2, _library.GetItemByIdUserCallCount);
            Assert.Equal(before, File.ReadAllBytes(UserFile(_target.Id, SpoilerFile)));
            Assert.Equal(
                4,
                _manager.GetUserConfigurationStrict<UserSpoilerBlur>(
                    TargetId,
                    SpoilerFile).OverridesRevision);
            Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(TargetId));
            Assert.True(SpoilerSeerrPendingPromoter.IsKeyRegisteredForTest(pendingKey));
        }
        finally
        {
            SpoilerSeerrPendingPromoter.UnregisterPending(pendingKey, _target.Id);
        }
    }

    [Fact]
    public void SpoilerOverrideWrite_WrongTargetItemTypeIsRejectedWithoutMutation()
    {
        var collectionId = Guid.Parse("bbbbbbbb-cccc-dddd-eeee-ffffffffffff");
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 2
        });
        _library.GetItemByIdUserHook = (id, scopedUser) =>
        {
            Assert.Equal(collectionId, id);
            Assert.Same(_target, scopedUser);
            return new MediaBrowser.Controller.Entities.Movies.Movie
            {
                Id = id,
                Name = "Not a box set"
            };
        };
        var before = File.ReadAllBytes(UserFile(_target.Id, SpoilerFile));

        var result = Assert.IsType<BadRequestObjectResult>(
            SpoilerController(ifMatch: 2).SaveTargetSpoilerGuardOverrides(
                TargetId,
                new SpoilerGuardOverrides
                {
                    Revision = 2,
                    Collections = new Dictionary<string, SpoilerBlurCollectionEntry>
                    {
                        [collectionId.ToString("N")] = new()
                        {
                            CollectionId = collectionId.ToString("N"),
                            CollectionName = "Submitted collection"
                        }
                    }
                }));

        var error = JsonSerializer.SerializeToElement(result.Value);
        Assert.Equal(
            "spoiler_override_item_type_mismatch",
            error.GetProperty("code").GetString());
        Assert.Equal(before, File.ReadAllBytes(UserFile(_target.Id, SpoilerFile)));
        Assert.Equal(1, _library.GetItemByIdUserCallCount);
    }

    [Fact]
    public void SpoilerOverrideWrite_TargetLookupFailureReturns503WithoutMutation()
    {
        var movieId = Guid.Parse("12345678-90ab-cdef-1234-567890abcdef");
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 9
        });
        _library.GetItemByIdUserHook = (_, scopedUser) =>
        {
            Assert.Same(_target, scopedUser);
            throw new IOException("deterministic target lookup failure");
        };
        var before = File.ReadAllBytes(UserFile(_target.Id, SpoilerFile));
        SpoilerUserResolver.SeedUserStateCacheForTest(TargetId);

        var result = Assert.IsType<ObjectResult>(
            SpoilerController(ifMatch: 9).SaveTargetSpoilerGuardOverrides(
                TargetId,
                new SpoilerGuardOverrides
                {
                    Revision = 9,
                    Movies = new Dictionary<string, SpoilerBlurMovieEntry>
                    {
                        [movieId.ToString("N")] = new()
                        {
                            MovieId = movieId.ToString("N"),
                            MovieName = "Submitted movie"
                        }
                    }
                }));

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, result.StatusCode);
        var error = JsonSerializer.SerializeToElement(result.Value);
        Assert.Equal(
            "spoiler_override_item_lookup_unavailable",
            error.GetProperty("code").GetString());
        Assert.Equal(before, File.ReadAllBytes(UserFile(_target.Id, SpoilerFile)));
        Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(TargetId));
    }

    [Fact]
    public void SpoilerOverrideWrite_UnchangedInaccessibleRowsAndTheirRemovalNeedNoLookup()
    {
        var keepSeriesId = Guid.Parse("10101010-2020-3030-4040-505050505050")
            .ToString("N");
        var removeMovieId = Guid.Parse("60606060-7070-8080-9090-a0a0a0a0a0a0")
            .ToString("N");
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 5,
            Series = new Dictionary<string, SpoilerBlurSeriesEntry>
            {
                [keepSeriesId] = new()
                {
                    SeriesId = keepSeriesId,
                    SeriesName = "Legacy inaccessible series"
                }
            },
            Movies = new Dictionary<string, SpoilerBlurMovieEntry>
            {
                [removeMovieId] = new()
                {
                    MovieId = removeMovieId,
                    MovieName = "Legacy inaccessible movie"
                }
            }
        });

        var envelope = AssertOkEnvelope(
            SpoilerController(ifMatch: 5).SaveTargetSpoilerGuardOverrides(
                TargetId,
                new SpoilerGuardOverrides
                {
                    Revision = 5,
                    Series = new Dictionary<string, SpoilerBlurSeriesEntry>
                    {
                        [keepSeriesId] = new()
                        {
                            SeriesId = keepSeriesId,
                            SeriesName = "Legacy inaccessible series"
                        }
                    }
                }));

        Assert.Equal(6, Property<long>(envelope, "Revision"));
        Assert.Equal(0, _library.GetItemByIdUserCallCount);
        var stored = _manager.GetUserConfigurationStrict<UserSpoilerBlur>(
            TargetId,
            SpoilerFile);
        Assert.Single(stored.Series);
        Assert.Empty(stored.Movies);
    }

    [Fact]
    public void SpoilerOverrideWrite_PendingAdmissionUses500CapButAllowsLegacyRepair()
    {
        var legacy = new Dictionary<string, SpoilerBlurPendingEntry>(
            StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < 502; index++)
        {
            var tmdb = (100_000 + index).ToString();
            legacy[$"tv:{tmdb}"] = new SpoilerBlurPendingEntry
            {
                MediaType = "tv",
                TmdbId = tmdb,
                DisplayName = $"Legacy {index}"
            };
        }
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 6,
            PendingTmdb = legacy
        });

        var repaired = legacy
            .Take(501)
            .ToDictionary(
                static pair => pair.Key,
                static pair => new SpoilerBlurPendingEntry
                {
                    MediaType = pair.Value.MediaType,
                    TmdbId = pair.Value.TmdbId,
                    DisplayName = pair.Value.DisplayName
                },
                StringComparer.OrdinalIgnoreCase);
        repaired["tv:100000"].DisplayName = "Repaired while legacy over-cap";
        var allKeys = new HashSet<string>(legacy.Keys, StringComparer.OrdinalIgnoreCase);
        const string newPendingKey = "movie:999999";
        allKeys.Add(newPendingKey);

        try
        {
            var repair = AssertOkEnvelope(
                SpoilerController(ifMatch: 6).SaveTargetSpoilerGuardOverrides(
                    TargetId,
                    new SpoilerGuardOverrides
                    {
                        Revision = 6,
                        PendingTmdb = repaired
                    }));
            Assert.Equal(7, Property<long>(repair, "Revision"));
            var afterRepair = _manager.GetUserConfigurationStrict<UserSpoilerBlur>(
                TargetId,
                SpoilerFile);
            Assert.Equal(501, afterRepair.PendingTmdb.Count);
            Assert.Equal(
                "Repaired while legacy over-cap",
                afterRepair.PendingTmdb["tv:100000"].DisplayName);

            var overCapAddition = repaired.ToDictionary(
                static pair => pair.Key,
                static pair => pair.Value,
                StringComparer.OrdinalIgnoreCase);
            overCapAddition[newPendingKey] = new SpoilerBlurPendingEntry
            {
                MediaType = "movie",
                TmdbId = "999999",
                DisplayName = "Must be rejected"
            };
            var beforeRejectedAdd = File.ReadAllBytes(UserFile(_target.Id, SpoilerFile));
            SpoilerUserResolver.SeedUserStateCacheForTest(TargetId);

            var rejected = Assert.IsType<BadRequestObjectResult>(
                SpoilerController(ifMatch: 7).SaveTargetSpoilerGuardOverrides(
                    TargetId,
                    new SpoilerGuardOverrides
                    {
                        Revision = 7,
                        PendingTmdb = overCapAddition
                    }));

            var error = JsonSerializer.SerializeToElement(rejected.Value);
            Assert.Equal("pending_cap_exceeded", error.GetProperty("code").GetString());
            Assert.Equal(500, error.GetProperty("maximum").GetInt32());
            Assert.Equal(
                beforeRejectedAdd,
                File.ReadAllBytes(UserFile(_target.Id, SpoilerFile)));
            Assert.Equal(
                7,
                _manager.GetUserConfigurationStrict<UserSpoilerBlur>(
                    TargetId,
                    SpoilerFile).OverridesRevision);
            Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(TargetId));
        }
        finally
        {
            foreach (var key in allKeys)
            {
                SpoilerSeerrPendingPromoter.UnregisterPending(key, _target.Id);
            }
        }
    }

    [Fact]
    public void HiddenWrite_EnforcesPreconditionsAndReturnsAuthoritativeConflict()
    {
        _manager.SaveUserConfiguration(TargetId, HiddenFile, new UserHiddenContent
        {
            Settings = new HiddenContentSettings { Revision = 2, Enabled = true }
        });
        var before = File.ReadAllBytes(UserFile(_target.Id, HiddenFile));

        var missing = Assert.IsType<ObjectResult>(
            HiddenController().SaveTargetHiddenContentSettings(
                TargetId,
                new HiddenContentSettings { Revision = 2, Enabled = false }));
        Assert.Equal(StatusCodes.Status428PreconditionRequired, missing.StatusCode);

        var weak = Assert.IsAssignableFrom<ObjectResult>(
            HiddenController(rawIfMatch: "W/\"2\"").SaveTargetHiddenContentSettings(
                TargetId,
                new HiddenContentSettings { Revision = 2, Enabled = false }));
        Assert.Equal(StatusCodes.Status428PreconditionRequired, weak.StatusCode);
        Assert.IsType<BadRequestObjectResult>(
            HiddenController(ifMatch: 2).SaveTargetHiddenContentSettings(
                TargetId,
                new HiddenContentSettings { Revision = 3, Enabled = false }));
        Assert.Equal(before, File.ReadAllBytes(UserFile(_target.Id, HiddenFile)));

        var committed = AssertOkEnvelope(
            HiddenController(ifMatch: 2).SaveTargetHiddenContentSettings(
                TargetId,
                new HiddenContentSettings { Revision = 2, Enabled = false }));
        Assert.Equal(3, Property<long>(committed, "Revision"));

        var staleController = HiddenController(ifMatch: 2);
        var conflictResult = Assert.IsType<ConflictObjectResult>(
            staleController.SaveTargetHiddenContentSettings(
                TargetId,
                new HiddenContentSettings { Revision = 2, FilterSearch = true }));
        var conflict = conflictResult.Value
            ?? throw new InvalidOperationException("Missing conflict response.");
        Assert.True(Property<bool>(conflict, "Conflict"));
        Assert.Equal(3, Property<long>(conflict, "Revision"));
        Assert.False(Property<HiddenContentSettings>(conflict, "Data").Enabled);
        Assert.Equal("\"3\"", staleController.Response.Headers.ETag.ToString());
    }

    [Fact]
    public void SpoilerWrite_EnforcesPreconditionsAndReturnsAuthoritativeConflict()
    {
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            Prefs = new SpoilerBlurUserPrefs { Revision = 2 }
        });
        var before = File.ReadAllBytes(UserFile(_target.Id, SpoilerFile));

        var missing = Assert.IsType<ObjectResult>(
            SpoilerController().SaveTargetSpoilerGuardPreferences(
                TargetId,
                new SpoilerBlurUserPrefs { Revision = 2, HideTags = true }));
        Assert.Equal(StatusCodes.Status428PreconditionRequired, missing.StatusCode);

        var weak = Assert.IsAssignableFrom<ObjectResult>(
            SpoilerController(rawIfMatch: "W/\"2\"").SaveTargetSpoilerGuardPreferences(
                TargetId,
                new SpoilerBlurUserPrefs { Revision = 2, HideTags = true }));
        Assert.Equal(StatusCodes.Status428PreconditionRequired, weak.StatusCode);
        Assert.IsType<BadRequestObjectResult>(
            SpoilerController(ifMatch: 2).SaveTargetSpoilerGuardPreferences(
                TargetId,
                new SpoilerBlurUserPrefs { Revision = 3, HideTags = true }));
        Assert.Equal(before, File.ReadAllBytes(UserFile(_target.Id, SpoilerFile)));

        var committed = AssertOkEnvelope(
            SpoilerController(ifMatch: 2).SaveTargetSpoilerGuardPreferences(
                TargetId,
                new SpoilerBlurUserPrefs { Revision = 2, HideTags = true }));
        Assert.Equal(3, Property<long>(committed, "Revision"));

        var staleController = SpoilerController(ifMatch: 2);
        var conflictResult = Assert.IsType<ConflictObjectResult>(
            staleController.SaveTargetSpoilerGuardPreferences(
                TargetId,
                new SpoilerBlurUserPrefs { Revision = 2, HideTags = false }));
        var conflict = conflictResult.Value
            ?? throw new InvalidOperationException("Missing conflict response.");
        Assert.True(Property<bool>(conflict, "Conflict"));
        Assert.Equal(3, Property<long>(conflict, "Revision"));
        Assert.True(Property<SpoilerBlurUserPrefs>(conflict, "Data").HideTags);
        Assert.Equal("\"3\"", staleController.Response.Headers.ETag.ToString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SpoilerPreferenceReadAndWrite_InvalidExistingOverridesFailClosedWithoutDiskMutation(
        bool overCap)
    {
        var state = new UserSpoilerBlur
        {
            OverridesRevision = 8,
            Prefs = new SpoilerBlurUserPrefs
            {
                Revision = 5,
                HideTags = false
            }
        };
        if (overCap)
        {
            for (var index = 1;
                 index <= PersistedPayloadPolicy.MaximumSpoilerEntriesPerDictionary + 1;
                 index++)
            {
                var key = Guid.Parse(index.ToString("x32")).ToString("N");
                state.Movies[key] = new SpoilerBlurMovieEntry
                {
                    MovieId = key,
                    MovieName = "Movie"
                };
            }
        }
        else
        {
            var key = Guid.Parse("30303030-1111-2222-3333-444444444444")
                .ToString("N");
            state.Movies[key] = new SpoilerBlurMovieEntry
            {
                MovieId = Guid.Parse("40404040-1111-2222-3333-444444444444")
                    .ToString("N"),
                MovieName = "Mismatched identity"
            };
        }

        _manager.SaveUserConfiguration(TargetId, SpoilerFile, state);
        var before = File.ReadAllBytes(UserFile(_target.Id, SpoilerFile));

        var read = Assert.IsType<ObjectResult>(
            SpoilerController().GetTargetSpoilerGuardPreferences(TargetId));
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, read.StatusCode);
        Assert.Equal(before, File.ReadAllBytes(UserFile(_target.Id, SpoilerFile)));

        var write = Assert.IsType<ObjectResult>(
            SpoilerController(ifMatch: 5).SaveTargetSpoilerGuardPreferences(
                TargetId,
                new SpoilerBlurUserPrefs
                {
                    Revision = 5,
                    HideTags = true
                }));
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, write.StatusCode);
        Assert.Equal(before, File.ReadAllBytes(UserFile(_target.Id, SpoilerFile)));
    }

    [Fact]
    public void SpoilerOverrideReadAndWrite_InvalidExistingPrefsFailClosedWithoutDiskMutation()
    {
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 4,
            Prefs = new SpoilerBlurUserPrefs
            {
                Revision = -1,
                HideTags = true
            }
        });
        var before = File.ReadAllBytes(UserFile(_target.Id, SpoilerFile));

        var read = Assert.IsType<ObjectResult>(
            SpoilerController().GetTargetSpoilerGuardOverrides(TargetId));
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, read.StatusCode);
        Assert.Equal(before, File.ReadAllBytes(UserFile(_target.Id, SpoilerFile)));

        var write = Assert.IsType<ObjectResult>(
            SpoilerController(ifMatch: 4).SaveTargetSpoilerGuardOverrides(
                TargetId,
                new SpoilerGuardOverrides
                {
                    Revision = 4,
                    PendingTmdb = new Dictionary<string, SpoilerBlurPendingEntry>
                    {
                        ["movie:123"] = new()
                        {
                            MediaType = "movie",
                            TmdbId = "123",
                            DisplayName = "Must not be written"
                        }
                    }
                }));
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, write.StatusCode);
        Assert.Equal(before, File.ReadAllBytes(UserFile(_target.Id, SpoilerFile)));
    }

    [Fact]
    public void SpoilerOverrideWrite_EnforcesPreconditionsAndReturnsAuthoritativeConflict()
    {
        var seriesKey = Guid.NewGuid().ToString("N");
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 2,
            Series = new Dictionary<string, SpoilerBlurSeriesEntry>
            {
                [seriesKey] = new()
                {
                    SeriesId = seriesKey,
                    SeriesName = "Before"
                }
            }
        });
        var before = File.ReadAllBytes(UserFile(_target.Id, SpoilerFile));

        var missing = Assert.IsType<ObjectResult>(
            SpoilerController().SaveTargetSpoilerGuardOverrides(
                TargetId,
                new SpoilerGuardOverrides { Revision = 2 }));
        Assert.Equal(StatusCodes.Status428PreconditionRequired, missing.StatusCode);

        var weak = Assert.IsAssignableFrom<ObjectResult>(
            SpoilerController(rawIfMatch: "W/\"2\"")
                .SaveTargetSpoilerGuardOverrides(
                    TargetId,
                    new SpoilerGuardOverrides { Revision = 2 }));
        Assert.Equal(StatusCodes.Status428PreconditionRequired, weak.StatusCode);
        Assert.IsType<BadRequestObjectResult>(
            SpoilerController(ifMatch: 2).SaveTargetSpoilerGuardOverrides(
                TargetId,
                new SpoilerGuardOverrides { Revision = 3 }));
        Assert.Equal(before, File.ReadAllBytes(UserFile(_target.Id, SpoilerFile)));

        var committed = AssertOkEnvelope(
            SpoilerController(ifMatch: 2).SaveTargetSpoilerGuardOverrides(
                TargetId,
                new SpoilerGuardOverrides { Revision = 2 }));
        Assert.Equal(3, Property<long>(committed, "Revision"));

        var movieKey = Guid.NewGuid().ToString("N");
        var staleController = SpoilerController(ifMatch: 2);
        var conflictResult = Assert.IsType<ConflictObjectResult>(
            staleController.SaveTargetSpoilerGuardOverrides(
                TargetId,
                new SpoilerGuardOverrides
                {
                    Revision = 2,
                    Movies = new Dictionary<string, SpoilerBlurMovieEntry>
                    {
                        [movieKey] = new()
                        {
                            MovieId = movieKey,
                            MovieName = "Stale"
                        }
                    }
                }));
        var conflict = conflictResult.Value
            ?? throw new InvalidOperationException("Missing conflict response.");
        Assert.True(Property<bool>(conflict, "Conflict"));
        Assert.Equal(3, Property<long>(conflict, "Revision"));
        var authoritative = Property<SpoilerGuardOverrides>(conflict, "Data");
        Assert.Empty(authoritative.Series);
        Assert.Empty(authoritative.Movies);
        Assert.Equal("\"3\"", staleController.Response.Headers.ETag.ToString());
    }

    [Fact]
    public void SpoilerOverrideWrite_RejectsMalformedEntriesWithoutTouchingStore()
    {
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 3,
            Prefs = new SpoilerBlurUserPrefs { Revision = 8, HideTags = true }
        });
        var before = File.ReadAllBytes(UserFile(_target.Id, SpoilerFile));
        var key = Guid.NewGuid().ToString("N");
        var mismatched = Guid.NewGuid().ToString("N");

        var result = SpoilerController(ifMatch: 3).SaveTargetSpoilerGuardOverrides(
            TargetId,
            new SpoilerGuardOverrides
            {
                Revision = 3,
                Series = new Dictionary<string, SpoilerBlurSeriesEntry>
                {
                    [key] = new()
                    {
                        SeriesId = mismatched,
                        SeriesName = "Mismatched identity"
                    }
                }
            });

        Assert.IsType<BadRequestObjectResult>(result);
        Assert.Equal(before, File.ReadAllBytes(UserFile(_target.Id, SpoilerFile)));
        var stored = _manager.GetUserConfigurationStrict<UserSpoilerBlur>(
            TargetId,
            SpoilerFile);
        Assert.Equal(3, stored.OverridesRevision);
        Assert.Equal(8, stored.Prefs.Revision);
        Assert.True(stored.Prefs.HideTags);
    }

    [Theory]
    [InlineData("0001")]
    [InlineData("2147483648")]
    public void SpoilerOverrideWrite_RejectsNonCanonicalPendingTmdbWithoutTouchingStore(
        string tmdbId)
    {
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 3,
            Prefs = new SpoilerBlurUserPrefs { Revision = 8, HideTags = true }
        });
        var before = File.ReadAllBytes(UserFile(_target.Id, SpoilerFile));

        var result = SpoilerController(ifMatch: 3).SaveTargetSpoilerGuardOverrides(
            TargetId,
            new SpoilerGuardOverrides
            {
                Revision = 3,
                PendingTmdb = new Dictionary<string, SpoilerBlurPendingEntry>
                {
                    [$"tv:{tmdbId}"] = new()
                    {
                        MediaType = "tv",
                        TmdbId = tmdbId,
                        DisplayName = "Invalid pending identity"
                    }
                }
            });

        Assert.IsType<BadRequestObjectResult>(result);
        Assert.Equal(before, File.ReadAllBytes(UserFile(_target.Id, SpoilerFile)));
    }

    [Fact]
    public void NoOpWrites_KeepRevisionDiskAndCachesUnchanged()
    {
        var noOpMovieKey = Guid.NewGuid().ToString("N");
        _manager.SaveUserConfiguration(TargetId, HiddenFile, new UserHiddenContent
        {
            Settings = new HiddenContentSettings
            {
                Revision = 8,
                Enabled = false,
                FilterSearch = true
            },
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["keep"] = new() { Name = "Keep", HideScope = "global" }
            }
        });
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 10,
            Prefs = new SpoilerBlurUserPrefs
            {
                Revision = 9,
                HideTags = false,
                SkipDisableConfirm = true
            },
            Movies = new Dictionary<string, SpoilerBlurMovieEntry>
            {
                [noOpMovieKey] = new()
                {
                    MovieId = noOpMovieKey,
                    MovieName = "Keep"
                }
            }
        });
        var hiddenBefore = File.ReadAllBytes(UserFile(_target.Id, HiddenFile));
        var spoilerBefore = File.ReadAllBytes(UserFile(_target.Id, SpoilerFile));
        HiddenContentResponseFilter.SeedCacheForTest(TargetId);
        SpoilerUserResolver.SeedUserStateCacheForTest(TargetId);

        var hidden = AssertOkEnvelope(
            HiddenController(ifMatch: 8).SaveTargetHiddenContentSettings(
                TargetId,
                new HiddenContentSettings
                {
                    Revision = 8,
                    Enabled = false,
                    FilterSearch = true
                }));
        var spoiler = AssertOkEnvelope(
            SpoilerController(ifMatch: 9).SaveTargetSpoilerGuardPreferences(
                TargetId,
                new SpoilerBlurUserPrefs
                {
                    Revision = 9,
                    HideTags = false,
                    SkipDisableConfirm = true
                }));
        var spoilerOverrides = AssertOkEnvelope(
            SpoilerController(ifMatch: 10).SaveTargetSpoilerGuardOverrides(
                TargetId,
                new SpoilerGuardOverrides
                {
                    Revision = 10,
                    Movies = new Dictionary<string, SpoilerBlurMovieEntry>
                    {
                        [noOpMovieKey] = new()
                        {
                            MovieId = noOpMovieKey,
                            MovieName = "Keep"
                        }
                    }
                }));

        Assert.Equal(8, Property<long>(hidden, "Revision"));
        Assert.Equal(9, Property<long>(spoiler, "Revision"));
        Assert.Equal(10, Property<long>(spoilerOverrides, "Revision"));
        Assert.Equal(hiddenBefore, File.ReadAllBytes(UserFile(_target.Id, HiddenFile)));
        Assert.Equal(spoilerBefore, File.ReadAllBytes(UserFile(_target.Id, SpoilerFile)));
        Assert.True(HiddenContentResponseFilter.IsCachedForTest(TargetId));
        Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(TargetId));
    }

    [Fact]
    public void CorruptTargetStores_FailClosedWithoutChangingActorOrInvalidatingCaches()
    {
        _manager.SaveUserConfiguration(ActorId, HiddenFile, new UserHiddenContent
        {
            Settings = new HiddenContentSettings { Revision = 12 }
        });
        _manager.SaveUserConfiguration(ActorId, SpoilerFile, new UserSpoilerBlur
        {
            Prefs = new SpoilerBlurUserPrefs { Revision = 13 }
        });
        _manager.SaveUserConfiguration(TargetId, HiddenFile, new UserHiddenContent
        {
            Settings = new HiddenContentSettings { Revision = 4 }
        });
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            Prefs = new SpoilerBlurUserPrefs { Revision = 5 }
        });
        var actorHiddenBefore = File.ReadAllBytes(UserFile(_actor.Id, HiddenFile));
        var actorSpoilerBefore = File.ReadAllBytes(UserFile(_actor.Id, SpoilerFile));
        File.WriteAllText(UserFile(_target.Id, HiddenFile), "{{ corrupt hidden");
        File.WriteAllText(UserFile(_target.Id, SpoilerFile), "{{ corrupt spoiler");
        HiddenContentResponseFilter.SeedCacheForTest(TargetId);
        SpoilerUserResolver.SeedUserStateCacheForTest(TargetId);

        var hiddenWrite = Assert.IsType<ObjectResult>(
            HiddenController(ifMatch: 4).SaveTargetHiddenContentSettings(
                TargetId,
                new HiddenContentSettings { Revision = 4, Enabled = false }));
        var spoilerWrite = Assert.IsType<ObjectResult>(
            SpoilerController(ifMatch: 5).SaveTargetSpoilerGuardPreferences(
                TargetId,
                new SpoilerBlurUserPrefs { Revision = 5, HideTags = true }));
        var spoilerOverrideWrite = Assert.IsType<ObjectResult>(
            SpoilerController(ifMatch: 0).SaveTargetSpoilerGuardOverrides(
                TargetId,
                new SpoilerGuardOverrides { Revision = 0 }));

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, hiddenWrite.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, spoilerWrite.StatusCode);
        Assert.Equal(
            StatusCodes.Status503ServiceUnavailable,
            spoilerOverrideWrite.StatusCode);
        Assert.Equal(
            StatusCodes.Status503ServiceUnavailable,
            Assert.IsType<ObjectResult>(
                HiddenController().GetTargetHiddenContentSettings(TargetId)).StatusCode);
        Assert.Equal(
            StatusCodes.Status503ServiceUnavailable,
            Assert.IsType<ObjectResult>(
                SpoilerController().GetTargetSpoilerGuardPreferences(TargetId)).StatusCode);
        Assert.Equal(
            StatusCodes.Status503ServiceUnavailable,
            Assert.IsType<ObjectResult>(
                SpoilerController().GetTargetSpoilerGuardOverrides(TargetId)).StatusCode);
        Assert.Equal(actorHiddenBefore, File.ReadAllBytes(UserFile(_actor.Id, HiddenFile)));
        Assert.Equal(actorSpoilerBefore, File.ReadAllBytes(UserFile(_actor.Id, SpoilerFile)));
        Assert.True(HiddenContentResponseFilter.IsCachedForTest(TargetId));
        Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(TargetId));
    }

    [Fact]
    public void OversizedTargetStores_FailClosedForTargetReadsAndInventoryWithoutSideEffects()
    {
        var hiddenPath = UserFile(_target.Id, HiddenFile);
        var spoilerPath = UserFile(_target.Id, SpoilerFile);
        Directory.CreateDirectory(Path.GetDirectoryName(hiddenPath)!);
        using (var hidden = new FileStream(
                   hiddenPath,
                   FileMode.CreateNew,
                   FileAccess.Write,
                   FileShare.None))
        {
            hidden.SetLength(PersistedPayloadPolicy.AbsolutePersistedBytes + 1L);
        }

        using (var spoiler = new FileStream(
                   spoilerPath,
                   FileMode.CreateNew,
                   FileAccess.Write,
                   FileShare.None))
        {
            spoiler.SetLength(PersistedPayloadPolicy.AbsolutePersistedBytes + 1L);
        }

        var hiddenPreferences = Assert.IsType<ObjectResult>(
            HiddenController().GetTargetHiddenContentSettings(TargetId));
        var hiddenItems = Assert.IsType<ObjectResult>(
            HiddenController().GetUserHiddenContentForAdmin(TargetId));
        var inventory = Assert.IsType<ObjectResult>(
            HiddenController().GetHiddenContentUsers(limit: 100));
        var spoilerPreferences = Assert.IsType<ObjectResult>(
            SpoilerController().GetTargetSpoilerGuardPreferences(TargetId));
        var spoilerOverrides = Assert.IsType<ObjectResult>(
            SpoilerController().GetTargetSpoilerGuardOverrides(TargetId));

        Assert.Equal(
            StatusCodes.Status503ServiceUnavailable,
            hiddenPreferences.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, hiddenItems.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, inventory.StatusCode);
        Assert.Equal(
            StatusCodes.Status503ServiceUnavailable,
            spoilerPreferences.StatusCode);
        Assert.Equal(
            StatusCodes.Status503ServiceUnavailable,
            spoilerOverrides.StatusCode);
        Assert.Equal(
            PersistedPayloadPolicy.AbsolutePersistedBytes + 1L,
            new FileInfo(hiddenPath).Length);
        Assert.Equal(
            PersistedPayloadPolicy.AbsolutePersistedBytes + 1L,
            new FileInfo(spoilerPath).Length);
        Assert.False(File.Exists(hiddenPath + ".unhealthy"));
        Assert.False(File.Exists(spoilerPath + ".unhealthy"));
        Assert.Empty(Directory.GetFiles(
            Path.GetDirectoryName(hiddenPath)!,
            "*.corrupt-*"));
    }

    [Fact]
    public void UnavailableHiddenPath_IsNotMisclassifiedAsMissingPreferencesOrItems()
    {
        var hiddenPath = UserFile(_target.Id, HiddenFile);
        Directory.CreateDirectory(hiddenPath);

        var preferences = Assert.IsType<ObjectResult>(
            HiddenController().GetTargetHiddenContentSettings(TargetId));
        var items = Assert.IsType<ObjectResult>(
            HiddenController().GetUserHiddenContentForAdmin(TargetId));
        var preferenceWrite = Assert.IsType<ObjectResult>(
            HiddenController(ifMatch: 0).SaveTargetHiddenContentSettings(
                TargetId,
                new HiddenContentSettings { Revision = 0 }));
        var unhide = Assert.IsType<ObjectResult>(
            HiddenController(ifMatch: 0).AdminUnhideForUser(
                TargetId,
                new List<string> { "missing-item" }));

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, preferences.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, items.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, preferenceWrite.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, unhide.StatusCode);
        Assert.True(Directory.Exists(hiddenPath));
        Assert.False(File.Exists(hiddenPath));
    }

    [Fact]
    public void UnavailableSpoilerPath_FailsClosedForTargetGetAndNoOpPost()
    {
        var spoilerPath = UserFile(_target.Id, SpoilerFile);
        Directory.CreateDirectory(spoilerPath);

        var read = Assert.IsType<ObjectResult>(
            SpoilerController().GetTargetSpoilerGuardPreferences(TargetId));
        var noOpWrite = Assert.IsType<ObjectResult>(
            SpoilerController(ifMatch: 0).SaveTargetSpoilerGuardPreferences(
                TargetId,
                new SpoilerBlurUserPrefs { Revision = 0 }));
        var overrideRead = Assert.IsType<ObjectResult>(
            SpoilerController().GetTargetSpoilerGuardOverrides(TargetId));
        var overrideNoOpWrite = Assert.IsType<ObjectResult>(
            SpoilerController(ifMatch: 0).SaveTargetSpoilerGuardOverrides(
                TargetId,
                new SpoilerGuardOverrides { Revision = 0 }));

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, read.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, noOpWrite.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, overrideRead.StatusCode);
        Assert.Equal(
            StatusCodes.Status503ServiceUnavailable,
            overrideNoOpWrite.StatusCode);
        Assert.True(Directory.Exists(spoilerPath));
        Assert.False(File.Exists(spoilerPath));
    }

    [Fact]
    public void MissingStores_WithUnavailablePluginConfiguration_Return503WithoutMaterializingDefaults()
    {
        _provider.Current = null;

        var hiddenRead = Assert.IsType<ObjectResult>(
            HiddenController().GetTargetHiddenContentSettings(TargetId));
        var hiddenWrite = Assert.IsType<ObjectResult>(
            HiddenController(ifMatch: 0).SaveTargetHiddenContentSettings(
                TargetId,
                new HiddenContentSettings { Revision = 0 }));
        var exactHiddenRead = Assert.IsType<ObjectResult>(
            HiddenController().GetUserHiddenContentForAdmin(TargetId));
        var firstAdminHide = Assert.IsType<ObjectResult>(
            HiddenController(ifMatch: 0).AdminHideForUser(
                TargetId,
                new List<HiddenContentItem>
                {
                    new() { ItemId = "admin-first", Name = "Admin first" }
                }));
        var spoilerRead = Assert.IsType<ObjectResult>(
            SpoilerController().GetTargetSpoilerGuardPreferences(TargetId));
        var spoilerWrite = Assert.IsType<ObjectResult>(
            SpoilerController(ifMatch: 0).SaveTargetSpoilerGuardPreferences(
                TargetId,
                new SpoilerBlurUserPrefs { Revision = 0 }));
        var spoilerOverrideRead = Assert.IsType<ObjectResult>(
            SpoilerController().GetTargetSpoilerGuardOverrides(TargetId));
        var spoilerOverrideWrite = Assert.IsType<ObjectResult>(
            SpoilerController(ifMatch: 0).SaveTargetSpoilerGuardOverrides(
                TargetId,
                new SpoilerGuardOverrides { Revision = 0 }));
        var selfSpoilerRead = Assert.IsType<ObjectResult>(
            SpoilerController().GetUserSpoilerBlur(ActorId));
        var selfSpoilerSeries = Assert.IsType<ObjectResult>(
            SpoilerController().GetSpoilerBlurSeries());
        var selfSpoilerPreferences = Assert.IsType<ObjectResult>(
            SpoilerController().GetSpoilerBlurUserPrefs());

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, hiddenRead.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, hiddenWrite.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, exactHiddenRead.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, firstAdminHide.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, spoilerRead.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, spoilerWrite.StatusCode);
        Assert.Equal(
            StatusCodes.Status503ServiceUnavailable,
            spoilerOverrideRead.StatusCode);
        Assert.Equal(
            StatusCodes.Status503ServiceUnavailable,
            spoilerOverrideWrite.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, selfSpoilerRead.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, selfSpoilerSeries.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, selfSpoilerPreferences.StatusCode);
        Assert.False(File.Exists(UserFile(_target.Id, HiddenFile)));
        Assert.False(File.Exists(UserFile(_target.Id, SpoilerFile)));
        Assert.False(File.Exists(UserFile(_actor.Id, SpoilerFile)));
    }

    [Fact]
    public async Task HiddenPreferenceWrite_PreservesAConcurrentItemRmw()
    {
        _manager.SaveUserConfiguration(TargetId, HiddenFile, new UserHiddenContent
        {
            Settings = new HiddenContentSettings { Revision = 1 },
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["before"] = new() { Name = "Before", HideScope = "global" }
            }
        });
        using var itemEntered = new ManualResetEventSlim();
        using var allowItemCommit = new ManualResetEventSlim();
        var itemWrite = Task.Run(() =>
            _manager.RmwUserConfiguration<UserHiddenContent>(
                TargetId,
                HiddenFile,
                state =>
                {
                    itemEntered.Set();
                    if (!allowItemCommit.Wait(TimeSpan.FromSeconds(10)))
                    {
                        throw new TimeoutException("Timed out releasing hidden item writer.");
                    }

                    state.Items["during"] = new HiddenContentItem
                    {
                        Name = "During",
                        HideScope = "global"
                    };
                    HiddenContentRevision.AdvanceItems(state);
                    return 1;
                }));
        Assert.True(itemEntered.Wait(TimeSpan.FromSeconds(10)));

        Task<IActionResult> preferenceWrite;
        try
        {
            preferenceWrite = Task.Run(() =>
                HiddenController(ifMatch: 1).SaveTargetHiddenContentSettings(
                    TargetId,
                    new HiddenContentSettings { Revision = 1, FilterSearch = true }));
        }
        finally
        {
            allowItemCommit.Set();
        }

        await itemWrite;
        AssertOkEnvelope(await preferenceWrite);
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            TargetId,
            HiddenFile);
        Assert.Equal(2, stored.Settings.Revision);
        Assert.Equal(1, stored.ItemsRevision);
        Assert.True(stored.Settings.FilterSearch);
        Assert.Equal(new[] { "before", "during" }, stored.Items.Keys.Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task SpoilerPreferenceWrite_PreservesAConcurrentSeriesRmw()
    {
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            Prefs = new SpoilerBlurUserPrefs { Revision = 1 }
        });
        var seriesKey = Guid.NewGuid().ToString("N");
        using var itemEntered = new ManualResetEventSlim();
        using var allowItemCommit = new ManualResetEventSlim();
        var seriesWrite = Task.Run(() =>
            _manager.RmwUserConfiguration<UserSpoilerBlur>(
                TargetId,
                SpoilerFile,
                state =>
                {
                    itemEntered.Set();
                    if (!allowItemCommit.Wait(TimeSpan.FromSeconds(10)))
                    {
                        throw new TimeoutException("Timed out releasing Spoiler Guard series writer.");
                    }

                    state.Series[seriesKey] = new SpoilerBlurSeriesEntry
                    {
                        SeriesId = seriesKey,
                        SeriesName = "During"
                    };
                    return 1;
                }));
        Assert.True(itemEntered.Wait(TimeSpan.FromSeconds(10)));

        Task<IActionResult> preferenceWrite;
        try
        {
            preferenceWrite = Task.Run(() =>
                SpoilerController(ifMatch: 1).SaveTargetSpoilerGuardPreferences(
                    _target.Id.ToString("D"),
                    new SpoilerBlurUserPrefs { Revision = 1, HideTags = true }));
        }
        finally
        {
            allowItemCommit.Set();
        }

        await seriesWrite;
        AssertOkEnvelope(await preferenceWrite);
        var stored = _manager.GetUserConfigurationStrict<UserSpoilerBlur>(
            TargetId,
            SpoilerFile);
        Assert.Equal(2, stored.Prefs.Revision);
        Assert.True(stored.Prefs.HideTags);
        Assert.Equal("During", Assert.Single(stored.Series).Value.SeriesName);
    }

    [Fact]
    public async Task SpoilerOverrideWrite_QueuedBehindOverrideMutationReturnsAuthoritativeConflict()
    {
        var existingSeriesKey = Guid.NewGuid().ToString("N");
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 4,
            Series = new Dictionary<string, SpoilerBlurSeriesEntry>
            {
                [existingSeriesKey] = new()
                {
                    SeriesId = existingSeriesKey,
                    SeriesName = "Before"
                }
            }
        });
        var submittedCollectionKey = Guid.NewGuid().ToString("N");
        var concurrentMovieKey = Guid.NewGuid().ToString("N");
        using var adminQueuedAtStore = new ManualResetEventSlim();
        _manager.UserFileLockObserverForTests = observation =>
        {
            if (observation.Operation == "transaction"
                && observation.UserId == TargetId
                && observation.FileName == SpoilerFile
                && observation.Phase == UserFileLockPhase.Waiting)
            {
                adminQueuedAtStore.Set();
            }
        };

        Task<IActionResult> adminWrite;
        try
        {
            lock (_manager.GetUserFileLock(TargetId, SpoilerFile))
            {
                adminWrite = Task.Run(() =>
                    SpoilerController(ifMatch: 4).SaveTargetSpoilerGuardOverrides(
                        TargetId,
                        new SpoilerGuardOverrides
                        {
                            Revision = 4,
                            Series = new Dictionary<string, SpoilerBlurSeriesEntry>
                            {
                                [existingSeriesKey] = new()
                                {
                                    SeriesId = existingSeriesKey,
                                    SeriesName = "Before"
                                }
                            },
                            Collections = new Dictionary<string, SpoilerBlurCollectionEntry>
                            {
                                [submittedCollectionKey] = new()
                                {
                                    CollectionId = submittedCollectionKey,
                                    CollectionName = "Stale admin edit"
                                }
                            }
                        }));
                Assert.True(adminQueuedAtStore.Wait(TimeSpan.FromSeconds(10)));

                var state = _manager.GetUserConfigurationStrict<UserSpoilerBlur>(
                    TargetId,
                    SpoilerFile);
                state.Movies[concurrentMovieKey] = new SpoilerBlurMovieEntry
                {
                    MovieId = concurrentMovieKey,
                    MovieName = "Concurrent writer"
                };
                SpoilerGuardOverridesRevision.Advance(state);
                _manager.SaveUserConfiguration(TargetId, SpoilerFile, state);
            }

            var conflictResult = Assert.IsType<ConflictObjectResult>(await adminWrite);
            var conflict = conflictResult.Value
                ?? throw new InvalidOperationException("Missing conflict response.");
            Assert.Equal(5, Property<long>(conflict, "Revision"));
            var authoritative = Property<SpoilerGuardOverrides>(conflict, "Data");
            Assert.True(authoritative.Series.ContainsKey(existingSeriesKey));
            Assert.True(authoritative.Movies.ContainsKey(concurrentMovieKey));
            Assert.Empty(authoritative.Collections);

            var stored = _manager.GetUserConfigurationStrict<UserSpoilerBlur>(
                TargetId,
                SpoilerFile);
            Assert.Equal(5, stored.OverridesRevision);
            Assert.True(stored.Movies.ContainsKey(concurrentMovieKey));
            Assert.Empty(stored.Collections);
        }
        finally
        {
            _manager.UserFileLockObserverForTests = null;
        }
    }

    [Fact]
    public void SpoilerOverrideWrite_PostCommitGateFailureStillAcknowledgesDurableRevision()
    {
        _manager.SaveUserConfiguration(TargetId, SpoilerFile, new UserSpoilerBlur
        {
            OverridesRevision = 1
        });
        const string pendingKey = "movie:9090";
        SpoilerUserResolver.SeedUserStateCacheForTest(TargetId);
        SpoilerSeerrPendingPromoter.BeforeAuthoritativeGateReconcileForTests =
            (userKey, _) =>
            {
                if (userKey == TargetId)
                {
                    throw new IOException("deterministic post-commit gate failure");
                }
            };

        try
        {
            var result = SpoilerController(ifMatch: 1)
                .SaveTargetSpoilerGuardOverrides(
                    TargetId,
                    new SpoilerGuardOverrides
                    {
                        Revision = 1,
                        PendingTmdb = new Dictionary<string, SpoilerBlurPendingEntry>
                        {
                            [pendingKey] = new()
                            {
                                MediaType = "movie",
                                TmdbId = "9090",
                                DisplayName = "Committed"
                            }
                        }
                    });

            var envelope = AssertOkEnvelope(result);
            Assert.Equal(2, Property<long>(envelope, "Revision"));
            Assert.False(SpoilerUserResolver.IsUserStateCachedForTest(TargetId));
            var stored = _manager.GetUserConfigurationStrict<UserSpoilerBlur>(
                TargetId,
                SpoilerFile);
            Assert.Equal(2, stored.OverridesRevision);
            Assert.Equal(
                "Committed",
                stored.PendingTmdb[pendingKey].DisplayName);
        }
        finally
        {
            SpoilerSeerrPendingPromoter.BeforeAuthoritativeGateReconcileForTests = null;
            SpoilerSeerrPendingPromoter.UnregisterPending(pendingKey, _target.Id);
        }
    }

    private string ActorId => _actor.Id.ToString("N");

    private string TargetId => _target.Id.ToString("N");

    private string UserDirectory(Guid userId)
        => Path.Combine(
            _baseDir,
            "configurations",
            "Jellyfin.Plugin.JellyfinCanopy",
            userId.ToString("N"));

    private string UserFile(Guid userId, string fileName)
        => Path.Combine(UserDirectory(userId), fileName);

    private HiddenContentController HiddenController(
        long? ifMatch = null,
        string? rawIfMatch = null)
    {
        var controller = new HiddenContentController(
            new RecordingHttpClientFactory(new HttpClientHandler()),
            NullLogger<HiddenContentController>.Instance,
            _userManager,
            new SeerrCache(_provider),
            _provider,
            _manager,
            _library);
        ConfigureController(controller, ifMatch, rawIfMatch);
        return controller;
    }

    private SpoilerGuardController SpoilerController(
        long? ifMatch = null,
        string? rawIfMatch = null)
    {
        var pending = new SpoilerPendingService(
            _manager,
            _library,
            _userManager,
            NullLogger<SpoilerPendingService>.Instance);
        var sessions = new CountingSessionManager();
        var requestIdentity = new RequestIdentityService(
            sessions,
            _userManager,
            new SpoilerIdentityService(
                _userManager,
                NullLogger<SpoilerIdentityService>.Instance),
            NullLogger<RequestIdentityService>.Instance);
        var resolver = new SpoilerUserResolver(
            _manager,
            _library,
            NullLogger<SpoilerUserResolver>.Instance,
            requestIdentity);
        var controller = new SpoilerGuardController(
            new RecordingHttpClientFactory(new HttpClientHandler()),
            NullLogger<SpoilerGuardController>.Instance,
            _userManager,
            new SeerrCache(_provider),
            _provider,
            _manager,
            _library,
            pending,
            resolver,
            new StubUserDataManager());
        ConfigureController(controller, ifMatch, rawIfMatch);
        return controller;
    }

    private void ConfigureController(
        ControllerBase controller,
        long? ifMatch,
        string? rawIfMatch)
    {
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                    new[]
                    {
                        new Claim("Jellyfin-UserId", _actor.Id.ToString()),
                        new Claim(ClaimTypes.Role, "Administrator")
                    },
                    "TestAuth"))
            }
        };
        if (ifMatch.HasValue)
        {
            controller.Request.Headers.IfMatch = $"\"{ifMatch.Value}\"";
        }
        else if (rawIfMatch != null)
        {
            controller.Request.Headers.IfMatch = rawIfMatch;
        }
    }

    private void AssertHiddenItemsConflict(
        ConflictObjectResult result,
        HiddenContentController controller,
        long expectedRevision)
    {
        var evidence = JsonSerializer.SerializeToElement(result.Value);
        Assert.False(evidence.GetProperty("success").GetBoolean());
        Assert.True(evidence.GetProperty("conflict").GetBoolean());
        Assert.Equal(
            "hidden_content_items_conflict",
            evidence.GetProperty("code").GetString());
        Assert.Equal(TargetId, evidence.GetProperty("userId").GetString());
        Assert.Equal(TargetId, evidence.GetProperty("targetUserId").GetString());
        Assert.Equal(_target.Username, evidence.GetProperty("userName").GetString());
        Assert.Equal(
            _target.Username,
            evidence.GetProperty("targetDisplayName").GetString());
        Assert.Equal(expectedRevision, evidence.GetProperty("itemsRevision").GetInt64());
        Assert.False(evidence.TryGetProperty("hiddenContent", out _));
        Assert.False(evidence.TryGetProperty("items", out _));
        Assert.Equal(
            $"\"{expectedRevision}\"",
            controller.Response.Headers.ETag.ToString());
    }

    private static HiddenContentSettings CompleteHiddenPreferences(long revision)
        => new()
        {
            Revision = revision,
            Enabled = false,
            FilterLibrary = false,
            FilterDiscovery = true,
            FilterUpcoming = false,
            FilterCalendar = true,
            FilterSearch = true,
            FilterRecommendations = false,
            FilterRequests = true,
            FilterNextUp = false,
            FilterContinueWatching = true,
            ShowHideButtons = false,
            ShowHideConfirmation = true,
            ShowButtonSeerr = false,
            ShowButtonLibrary = true,
            ShowButtonDetails = false,
            ShowButtonCast = true,
            ExperimentalHideCollections = true
        };

    private static SpoilerBlurUserPrefs CompleteSpoilerPreferences(long revision)
        => new()
        {
            Revision = revision,
            HideEpisodeDescriptions = true,
            HideTags = false,
            HideChapterNames = null,
            HideTaglines = true,
            HideRatings = false,
            HideAirDate = null,
            ReplaceEpisodeTitles = true,
            HideCast = false,
            HideReviews = null,
            SkipDisableConfirm = true
        };

    private static void AssertCompleteHiddenPreferences(
        HiddenContentSettings value,
        long expectedRevision)
    {
        Assert.Equal(expectedRevision, value.Revision);
        Assert.False(value.Enabled);
        Assert.False(value.FilterLibrary);
        Assert.True(value.FilterDiscovery);
        Assert.False(value.FilterUpcoming);
        Assert.True(value.FilterCalendar);
        Assert.True(value.FilterSearch);
        Assert.False(value.FilterRecommendations);
        Assert.True(value.FilterRequests);
        Assert.False(value.FilterNextUp);
        Assert.True(value.FilterContinueWatching);
        Assert.False(value.ShowHideButtons);
        Assert.True(value.ShowHideConfirmation);
        Assert.False(value.ShowButtonSeerr);
        Assert.True(value.ShowButtonLibrary);
        Assert.False(value.ShowButtonDetails);
        Assert.True(value.ShowButtonCast);
        Assert.True(value.ExperimentalHideCollections);
    }

    private static void AssertCompleteSpoilerPreferences(
        SpoilerBlurUserPrefs value,
        long expectedRevision)
    {
        Assert.Equal(expectedRevision, value.Revision);
        Assert.True(value.HideEpisodeDescriptions);
        Assert.False(value.HideTags);
        Assert.Null(value.HideChapterNames);
        Assert.True(value.HideTaglines);
        Assert.False(value.HideRatings);
        Assert.Null(value.HideAirDate);
        Assert.True(value.ReplaceEpisodeTitles);
        Assert.False(value.HideCast);
        Assert.Null(value.HideReviews);
        Assert.True(value.SkipDisableConfirm);
    }

    private static object AssertOkEnvelope(IActionResult result)
    {
        var ok = Assert.IsType<OkObjectResult>(result);
        var envelope = ok.Value
            ?? throw new InvalidOperationException("Missing preference response.");
        Assert.True(Property<bool>(envelope, "Success"));
        Assert.False(Property<bool>(envelope, "Conflict"));
        var data = envelope.GetType().GetProperty("Data")?.GetValue(envelope);
        Assert.NotNull(data);
        return envelope;
    }

    private static T Property<T>(object value, string propertyName)
    {
        var property = value.GetType().GetProperty(propertyName)
            ?? throw new InvalidOperationException(
                $"Missing {propertyName} on {value.GetType().Name}.");
        return Assert.IsType<T>(property.GetValue(value));
    }

    private static void AssertGet(
        Type controllerType,
        string methodName,
        params string[] routes)
    {
        var method = controllerType.GetMethod(methodName)
            ?? throw new InvalidOperationException(methodName);
        Assert.Equal(
            routes.Order(StringComparer.Ordinal),
            method.GetCustomAttributes<HttpGetAttribute>()
                .Select(static attribute => attribute.Template)
                .Order(StringComparer.Ordinal));
        Assert.Equal(
            Policies.RequiresElevation,
            method.GetCustomAttribute<AuthorizeAttribute>()?.Policy);
    }

    private static void AssertPost(
        Type controllerType,
        string methodName,
        string route,
        long requestBytes = PreferenceRequestBytes)
    {
        var method = controllerType.GetMethod(methodName)
            ?? throw new InvalidOperationException(methodName);
        Assert.Equal(route, method.GetCustomAttribute<HttpPostAttribute>()?.Template);
        Assert.Equal(
            Policies.RequiresElevation,
            method.GetCustomAttribute<AuthorizeAttribute>()?.Policy);
        Assert.Equal(
            requestBytes,
            Assert.IsAssignableFrom<IRequestSizeLimitMetadata>(
                Assert.Single(method.GetCustomAttributes<RequestSizeLimitAttribute>()))
                .MaxRequestBodySize);
    }
}
