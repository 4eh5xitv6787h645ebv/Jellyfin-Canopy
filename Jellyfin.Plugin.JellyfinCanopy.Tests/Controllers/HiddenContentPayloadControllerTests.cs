using System.Collections.Immutable;
using System.Security.Claims;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Logging;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class HiddenContentPayloadControllerTests : IDisposable
{
    private readonly string _baseDir;
    private readonly UserConfigurationManager _manager;
    private readonly User _user;
    private readonly FakePluginConfigProvider _provider;

    public HiddenContentPayloadControllerTests()
    {
        _baseDir = Path.Combine(Path.GetTempPath(), "jc-hidden-payload-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_baseDir);
        _manager = new UserConfigurationManager(
            new StubAppPaths(_baseDir),
            NullLogger<UserConfigurationManager>.Instance);
        _user = new User("hidden-user", "Provider", "PasswordProvider");
        _provider = new FakePluginConfigProvider(new PluginConfiguration());
    }

    private string UserId => _user.Id.ToString("N");

    private string HiddenPath => Path.Combine(
        _baseDir,
        "configurations",
        "Jellyfin.Plugin.JellyfinCanopy",
        UserId,
        "hidden-content.json");

    public void Dispose()
    {
        HiddenContentResponseFilter.InvalidateUser(UserId);
        try { Directory.Delete(_baseDir, recursive: true); } catch { /* best effort */ }
    }

    [Fact]
    public async Task FirstGet_QueuedBehindEmptyPreferenceCreation_PreservesTheCreatedStore()
    {
        using var getQueuedAtStore = new ManualResetEventSlim();
        _manager.UserFileLockObserverForTests = observation =>
        {
            if (observation.Operation == "get-or-create"
                && observation.UserId == UserId
                && observation.FileName == "hidden-content.json"
                && observation.Phase == UserFileLockPhase.Waiting)
            {
                getQueuedAtStore.Set();
            }
        };

        Task<IActionResult>? getTask = null;
        try
        {
            lock (_manager.GetUserFileLock(UserId, "hidden-content.json"))
            {
                getTask = Task.Run(() =>
                    Controller(NullLogger<HiddenContentController>.Instance)
                        .GetUserHiddenContent(UserId));
                Assert.True(getQueuedAtStore.Wait(TimeSpan.FromSeconds(10)));

                _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
                {
                    ItemsRevision = 12,
                    Settings = new HiddenContentSettings
                    {
                        Revision = 41,
                        Enabled = false,
                        FilterSearch = true,
                        ShowButtonCast = true
                    }
                });
            }

            var ok = Assert.IsType<OkObjectResult>(
                await getTask.WaitAsync(TimeSpan.FromSeconds(10)));
            var returned = Assert.IsType<UserHiddenContent>(ok.Value);
            Assert.Empty(returned.Items);
            Assert.Equal(12, returned.ItemsRevision);
            Assert.Equal(41, returned.Settings.Revision);
            Assert.False(returned.Settings.Enabled);
            Assert.True(returned.Settings.FilterSearch);
            Assert.True(returned.Settings.ShowButtonCast);

            var durable = _manager.GetUserConfigurationStrict<UserHiddenContent>(
                UserId,
                "hidden-content.json");
            Assert.Empty(durable.Items);
            Assert.Equal(12, durable.ItemsRevision);
            Assert.Equal(41, durable.Settings.Revision);
            Assert.False(durable.Settings.Enabled);
            Assert.True(durable.Settings.FilterSearch);
            Assert.True(durable.Settings.ShowButtonCast);
        }
        finally
        {
            _manager.UserFileLockObserverForTests = null;
        }
    }

    [Fact]
    public void MissingStore_WithUnavailablePluginConfiguration_FailsClosedWithoutMaterializingDefaults()
    {
        _provider.Current = null;
        var itemId = Guid.Parse("10101010-2020-3030-4040-505050505050");
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, _) => id == itemId
                ? new Movie { Id = itemId, Name = "Scoped movie" }
                : null
        };

        var read = Assert.IsType<ObjectResult>(
            Controller(NullLogger<HiddenContentController>.Instance)
                .GetUserHiddenContent(UserId));
        var scopedHide = Assert.IsType<ObjectResult>(
            Controller(NullLogger<HiddenContentController>.Instance, library)
                .HideFromContinueWatching(itemId.ToString()));
        var adminHide = Assert.IsType<ObjectResult>(
            Controller(NullLogger<HiddenContentController>.Instance)
                .AdminHideForUser(
                    UserId,
                    new List<HiddenContentItem>
                    {
                        new() { ItemId = "admin-first", Name = "Admin first" }
                    }));

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, read.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, scopedHide.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, adminHide.StatusCode);
        Assert.Contains(
            "corrupt",
            System.Text.Json.JsonSerializer.Serialize(scopedHide.Value),
            StringComparison.OrdinalIgnoreCase);
        Assert.False(File.Exists(HiddenPath));
    }

    [Fact]
    public void RejectedPayload_LeavesDiskAndCacheUnchanged()
    {
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["old"] = new HiddenContentItem { Name = "old-value", HideScope = "global" }
            }
        });
        var before = File.ReadAllBytes(HiddenPath);
        HiddenContentResponseFilter.SeedCacheForTest(UserId);

        var candidate = new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["new"] = new HiddenContentItem
                {
                    Name = "new-value",
                    PosterPath = new string('x', 513)
                }
            }
        };
        var result = Controller(NullLogger<HiddenContentController>.Instance)
            .SaveUserHiddenContent(UserId, candidate);

        var rejected = Assert.IsType<BadRequestObjectResult>(result);
        var response = Assert.IsType<PersistedPayloadErrorResponse>(rejected.Value);
        Assert.Equal("invalid_hidden_item", response.Code);
        Assert.Equal(before, File.ReadAllBytes(HiddenPath));
        Assert.True(HiddenContentResponseFilter.IsCachedForTest(UserId));
    }

    [Fact]
    public void NormalizationCrossingPersistedCeiling_IsRejectedWithoutDiskOrCacheMutation()
    {
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent());
        var before = File.ReadAllBytes(HiddenPath);
        HiddenContentResponseFilter.SeedCacheForTest(UserId);
        var candidate = BuildNormalizationBoundaryPayload();
        Assert.True(PersistedPayloadPolicy.Validate(candidate).IsValid);
        Assert.Equal(
            PersistedPayloadStatus.TooLarge,
            PersistedPayloadPolicy.Validate(PersistedPayloadPolicy.CloneValidated(candidate)).Status);

        var result = Controller(NullLogger<HiddenContentController>.Instance)
            .SaveUserHiddenContent(UserId, candidate);

        var rejected = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status413PayloadTooLarge, rejected.StatusCode);
        Assert.Equal("payload_too_large", Assert.IsType<PersistedPayloadErrorResponse>(rejected.Value).Code);
        Assert.Equal(before, File.ReadAllBytes(HiddenPath));
        Assert.True(HiddenContentResponseFilter.IsCachedForTest(UserId));
    }

    [Fact]
    public async Task AcceptedPayload_LogsMetadataOnlyToHostAndDedicatedSinks()
    {
        const string secret = "api-key-SUPER-SECRET-sentinel";
        var hostProvider = new CapturingLoggerProvider();
        using var hostFactory = LoggerFactory.Create(builder =>
        {
            builder.SetMinimumLevel(LogLevel.Trace);
            builder.AddProvider(hostProvider);
        });
        using var fileProvider = new JellyfinCanopyFileLoggerProvider(new StubAppPaths(_baseDir));
        var logger = new FileForwardingLogger<HiddenContentController>(fileProvider, hostFactory);
        var candidate = new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["safe-key"] = new HiddenContentItem
                {
                    Name = secret,
                    PosterPath = "/poster/" + secret,
                    HideScope = "series"
                }
            }
        };

        var result = Controller(logger).SaveUserHiddenContent(UserId, candidate);
        Assert.True(await fileProvider.FlushAsync(TimeSpan.FromSeconds(5)));

        Assert.IsType<OkObjectResult>(result);
        Assert.Equal(secret, candidate.Items["safe-key"].Name);
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json");
        Assert.Equal(secret, stored.Items["safe-key"].Name);
        var hostText = string.Join('\n', hostProvider.Messages);
        var fileText = File.ReadAllText(fileProvider.CurrentLogFilePath);
        Assert.DoesNotContain(secret, hostText, StringComparison.Ordinal);
        Assert.DoesNotContain(secret, fileText, StringComparison.Ordinal);
        Assert.Contains("items=1", hostText, StringComparison.Ordinal);
        Assert.Contains("items=1", fileText, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminHide_AdvancesItemsRevisionAndStaleSelfSnapshotCannotEraseIt()
    {
        var adminItemId = Guid.Parse("01010101-1111-2222-3333-444444444444")
            .ToString("N");
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["self-item"] = new() { ItemId = "self-item", Name = "Self item" }
            }
        });
        var staleSelfSnapshot = PersistedPayloadPolicy.CloneValidated(
            _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json"));
        var controller = Controller(NullLogger<HiddenContentController>.Instance);

        Assert.IsType<OkObjectResult>(controller.AdminHideForUser(
            UserId,
            new List<HiddenContentItem>
            {
                new() { ItemId = adminItemId, Name = "Untrusted admin item" }
            }));
        var afterAdmin = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json");
        Assert.Equal(1, afterAdmin.ItemsRevision);
        Assert.True(afterAdmin.Items.ContainsKey(adminItemId));

        staleSelfSnapshot.Items["new-self-item"] = new HiddenContentItem
        {
            ItemId = "new-self-item",
            Name = "New self item"
        };
        var conflict = Assert.IsType<ConflictObjectResult>(
            controller.SaveUserHiddenContent(UserId, staleSelfSnapshot));
        var evidence = System.Text.Json.JsonSerializer.SerializeToElement(conflict.Value);
        Assert.True(evidence.GetProperty("conflict").GetBoolean());
        Assert.Equal(1, evidence.GetProperty("itemsRevision").GetInt64());
        Assert.True(
            evidence.GetProperty("hiddenContent")
                .GetProperty("Items")
                .TryGetProperty(adminItemId, out _));

        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json");
        Assert.Equal(1, stored.ItemsRevision);
        Assert.True(stored.Items.ContainsKey(adminItemId));
        Assert.False(stored.Items.ContainsKey("new-self-item"));
    }

    [Fact]
    public void FirstAdminHide_SeedsConfiguredDefaultsWithoutForcingEnabled()
    {
        var adminItemId = Guid.Parse("02020202-1111-2222-3333-444444444444")
            .ToString("N");
        _provider.Current!.HiddenContentDefaultEnabled = false;
        _provider.Current.HiddenContentDefaultFilterLibrary = false;
        _provider.Current.HiddenContentDefaultFilterSearch = true;
        _provider.Current.HiddenContentDefaultShowButtonCast = true;
        Assert.False(_manager.UserConfigurationExists(UserId, "hidden-content.json"));

        var result = Assert.IsType<OkObjectResult>(
            Controller(NullLogger<HiddenContentController>.Instance)
                .AdminHideForUser(
                    UserId,
                    new List<HiddenContentItem>
                    {
                        new() { ItemId = adminItemId, Name = "Untrusted admin item" }
                    }));
        var acknowledgement = System.Text.Json.JsonSerializer.SerializeToElement(result.Value);
        Assert.Equal(1, acknowledgement.GetProperty("added").GetInt32());
        Assert.Equal(1, acknowledgement.GetProperty("itemsRevision").GetInt64());

        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json");
        Assert.Single(stored.Items);
        Assert.Equal(1, stored.ItemsRevision);
        Assert.Equal(0, stored.Settings.Revision);
        Assert.False(stored.Settings.Enabled);
        Assert.False(stored.Settings.FilterLibrary);
        Assert.True(stored.Settings.FilterSearch);
        Assert.True(stored.Settings.ShowButtonCast);
    }

    [Fact]
    public void AdminHide_PreservesAnExistingEmptyPreferenceStore()
    {
        var adminItemId = Guid.Parse("03030303-1111-2222-3333-444444444444")
            .ToString("N");
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            ItemsRevision = 9,
            Settings = new HiddenContentSettings
            {
                Revision = 21,
                Enabled = false,
                FilterSearch = true,
                ShowButtonCast = true
            }
        });

        Assert.IsType<OkObjectResult>(
            Controller(NullLogger<HiddenContentController>.Instance)
                .AdminHideForUser(
                    UserId,
                    new List<HiddenContentItem>
                    {
                        new() { ItemId = adminItemId, Name = "Untrusted admin item" }
                    }));

        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json");
        Assert.Single(stored.Items);
        Assert.Equal(10, stored.ItemsRevision);
        Assert.Equal(21, stored.Settings.Revision);
        Assert.False(stored.Settings.Enabled);
        Assert.True(stored.Settings.FilterSearch);
        Assert.True(stored.Settings.ShowButtonCast);
    }

    [Fact]
    public void AdminUnhide_AdvancesItemsRevisionAndStaleSelfSnapshotCannotRestoreIt()
    {
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            ItemsRevision = 6,
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["keep"] = new() { ItemId = "keep", Name = "Keep" },
                ["remove"] = new() { ItemId = "remove", Name = "Remove" }
            }
        });
        var staleSelfSnapshot = PersistedPayloadPolicy.CloneValidated(
            _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json"));
        var controller = Controller(NullLogger<HiddenContentController>.Instance);

        Assert.IsType<OkObjectResult>(controller.AdminUnhideForUser(
            UserId,
            new List<string> { "remove" }));
        var afterAdmin = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json");
        Assert.Equal(7, afterAdmin.ItemsRevision);
        Assert.False(afterAdmin.Items.ContainsKey("remove"));

        staleSelfSnapshot.Items["another-self-item"] = new HiddenContentItem
        {
            ItemId = "another-self-item",
            Name = "Another self item"
        };
        Assert.IsType<ConflictObjectResult>(
            controller.SaveUserHiddenContent(UserId, staleSelfSnapshot));

        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json");
        Assert.Equal(7, stored.ItemsRevision);
        Assert.False(stored.Items.ContainsKey("remove"));
        Assert.False(stored.Items.ContainsKey("another-self-item"));
    }

    [Fact]
    public void SelfFullPosts_AdvanceItemsRevisionSequentiallyAndPreserveNoOpRevision()
    {
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent());
        var controller = Controller(NullLogger<HiddenContentController>.Instance);
        var first = PersistedPayloadPolicy.CloneValidated(
            _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json"));
        first.Items["first"] = new HiddenContentItem { ItemId = "first", Name = "First" };

        var firstResult = Assert.IsType<OkObjectResult>(
            controller.SaveUserHiddenContent(UserId, first));
        var firstAck = System.Text.Json.JsonSerializer.SerializeToElement(firstResult.Value);
        Assert.Equal(1, firstAck.GetProperty("itemsRevision").GetInt64());

        var second = PersistedPayloadPolicy.CloneValidated(
            _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json"));
        second.Items["second"] = new HiddenContentItem { ItemId = "second", Name = "Second" };
        var secondResult = Assert.IsType<OkObjectResult>(
            controller.SaveUserHiddenContent(UserId, second));
        var secondAck = System.Text.Json.JsonSerializer.SerializeToElement(secondResult.Value);
        Assert.Equal(2, secondAck.GetProperty("itemsRevision").GetInt64());

        var noOp = PersistedPayloadPolicy.CloneValidated(
            _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json"));
        Assert.IsType<OkObjectResult>(controller.SaveUserHiddenContent(UserId, noOp));
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json");
        Assert.Equal(2, stored.ItemsRevision);
        Assert.Equal(new[] { "first", "second" }, stored.Items.Keys.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void AdminItemAuditLogs_IncludeActorAndTargetButNotItemContent()
    {
        const string itemSecret = "ITEM-CONTENT-MUST-NOT-APPEAR";
        var itemId = Guid.Parse("04040404-1111-2222-3333-444444444444")
            .ToString("N");
        var hostProvider = new CapturingLoggerProvider();
        using var hostFactory = LoggerFactory.Create(builder =>
        {
            builder.SetMinimumLevel(LogLevel.Trace);
            builder.AddProvider(hostProvider);
        });
        var logger = hostFactory.CreateLogger<HiddenContentController>();
        var controller = Controller(logger);

        Assert.IsType<OkObjectResult>(controller.AdminHideForUser(
            UserId,
            new List<HiddenContentItem>
            {
                new() { ItemId = itemId, Name = itemSecret }
            }));
        controller.Request.Headers.IfMatch = "\"1\"";
        Assert.IsType<OkObjectResult>(controller.AdminUnhideForUser(
            UserId,
            new List<string> { itemId }));

        var text = string.Join('\n', hostProvider.Messages);
        Assert.Contains(
            $"Admin {_user.Username} ({UserId}) hid items in hidden-content.json for target " +
            $"{_user.Username} ({UserId}) at revision itemsRevision=1.",
            text);
        Assert.Contains(
            $"Admin {_user.Username} ({UserId}) unhid items in hidden-content.json for target " +
            $"{_user.Username} ({UserId}) at revision itemsRevision=2.",
            text);
        Assert.DoesNotContain(itemSecret, text, StringComparison.Ordinal);
        Assert.DoesNotContain("1 item(s)", text, StringComparison.Ordinal);
        Assert.DoesNotContain(itemId, text, StringComparison.Ordinal);
    }

    [Fact]
    public void LegacyFullSave_CrossUserAuditNamesActorAndTargetWithoutContentOrCounts()
    {
        const string itemSecret = "HIDDEN-ITEM-CONTENT-MUST-NOT-APPEAR";
        var admin = new User("hidden-admin", "Provider", "PasswordProvider");
        admin.SetPermission(
            Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator,
            true);
        var userManager = new StubUserManager(admin, _user);
        var itemId = Guid.Parse("41414141-5252-6363-7474-858585858585")
            .ToString("N");
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            ItemsRevision = 6,
            Settings = new HiddenContentSettings
            {
                Revision = 4,
                Enabled = false
            }
        });
        var hostProvider = new CapturingLoggerProvider();
        using var hostFactory = LoggerFactory.Create(builder =>
        {
            builder.SetMinimumLevel(LogLevel.Trace);
            builder.AddProvider(hostProvider);
        });
        var controller = new HiddenContentController(
            new RecordingHttpClientFactory(new HttpClientHandler()),
            hostFactory.CreateLogger<HiddenContentController>(),
            userManager,
            new SeerrCache(_provider),
            _provider,
            _manager,
            new CountingLibraryManager(),
            new HiddenContentItemActionOwner(_manager, _provider));
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                    new[]
                    {
                        new Claim("Jellyfin-UserId", admin.Id.ToString()),
                        new Claim(ClaimTypes.Role, "Administrator")
                    },
                    "TestAuth"))
            }
        };

        Assert.IsType<OkObjectResult>(
            controller.SaveUserHiddenContent(
                UserId,
                new UserHiddenContent
                {
                    ItemsRevision = 6,
                    Settings = new HiddenContentSettings
                    {
                        Revision = 4,
                        Enabled = true
                    },
                    Items = new Dictionary<string, HiddenContentItem>
                    {
                        [itemId] = new()
                        {
                            ItemId = itemId,
                            Name = itemSecret,
                            HideScope = "global"
                        }
                    }
                }));

        var text = string.Join('\n', hostProvider.Messages);
        Assert.Contains(
            $"Admin {admin.Username} ({admin.Id:N}) saved hidden-content.json for target " +
            $"{_user.Username} ({UserId}) at revision settingsRevision=5,itemsRevision=7.",
            text);
        Assert.DoesNotContain(itemSecret, text, StringComparison.Ordinal);
        Assert.DoesNotContain("(items=", text, StringComparison.Ordinal);
        Assert.DoesNotContain("bytes=", text, StringComparison.Ordinal);
    }

    [Fact]
    public void LegacyGetMaterialization_RequiresCanonicalActorAndAuditsWithoutContent()
    {
        var admin = new User("hidden-admin", "Provider", "PasswordProvider");
        admin.SetPermission(
            Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator,
            true);
        var userManager = new StubUserManager(admin, _user);
        var hostProvider = new CapturingLoggerProvider();
        using var hostFactory = LoggerFactory.Create(builder =>
        {
            builder.SetMinimumLevel(LogLevel.Trace);
            builder.AddProvider(hostProvider);
        });

        HiddenContentController Build(bool includeActorClaim)
        {
            var controller = new HiddenContentController(
                new RecordingHttpClientFactory(new HttpClientHandler()),
                hostFactory.CreateLogger<HiddenContentController>(),
                userManager,
                new SeerrCache(_provider),
                _provider,
                _manager,
                new CountingLibraryManager(),
                new HiddenContentItemActionOwner(_manager, _provider));
            controller.ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(
                        includeActorClaim
                            ? new[]
                            {
                                new Claim("Jellyfin-UserId", admin.Id.ToString()),
                                new Claim(ClaimTypes.Role, "Administrator")
                            }
                            : new[]
                            {
                                new Claim(ClaimTypes.Role, "Administrator")
                            },
                        "TestAuth"))
                }
            };
            return controller;
        }

        Assert.IsType<OkObjectResult>(
            Build(includeActorClaim: true).GetUserHiddenContent(UserId));
        File.Delete(HiddenPath);
        Assert.IsType<ForbidResult>(
            Build(includeActorClaim: false).GetUserHiddenContent(UserId));
        Assert.False(File.Exists(HiddenPath));

        var text = string.Join('\n', hostProvider.Messages);
        Assert.Contains(
            $"Admin {admin.Username} ({admin.Id:N}) seeded defaults in hidden-content.json " +
            $"for target {_user.Username} ({UserId}) at revision " +
            "settingsRevision=0,itemsRevision=0.",
            text);
        Assert.DoesNotContain("elevated-principal", text, StringComparison.Ordinal);
        Assert.DoesNotContain("HiddenContentDefault", text, StringComparison.Ordinal);
        Assert.DoesNotContain("bytes=", text, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminHide_UsesTypedProviderKeysAndNeverCreatesAnAmbiguousBareTmdbRow()
    {
        var localItemId = Guid.Parse("05050505-1111-2222-3333-444444444444");
        var localMovie = new Movie { Id = localItemId, Name = "Canonical local" };
        localMovie.ProviderIds["Tmdb"] = "552";
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, scopedUser) =>
                id == localItemId && scopedUser?.Id == _user.Id ? localMovie : null
        };
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["tmdb-549"] = new() { Name = "Legacy movie", Type = "Movie", TmdbId = "549" }
            }
        });
        var controller = Controller(NullLogger<HiddenContentController>.Instance, library);
        var result = controller.AdminHideForUser(UserId, new List<HiddenContentItem>
        {
            new() { Name = "Legacy movie", Type = "Movie", TmdbId = "549" },
            new() { Name = "Movie 550", Type = "Movie", TmdbId = "550" },
            new() { Name = "TV 550", Type = "Series", TmdbId = "550" },
            new() { Name = "Ambiguous 551", TmdbId = "551" },
            new()
            {
                ItemId = localItemId.ToString("N"),
                Name = "Untrusted local",
                TmdbId = "999"
            }
        });

        Assert.IsType<OkObjectResult>(result);
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json");
        Assert.Equal(4, stored.Items.Count);
        Assert.True(stored.Items.ContainsKey("tmdb-549"));
        Assert.False(stored.Items.ContainsKey("hc1:tmdb:movie:549"));
        Assert.Equal("movie", stored.Items["hc1:tmdb:movie:550"].Identity?.MediaType);
        Assert.Equal("tv", stored.Items["hc1:tmdb:tv:550"].Identity?.MediaType);
        Assert.True(stored.Items.ContainsKey(localItemId.ToString("N")));
        Assert.Equal(
            "Canonical local",
            stored.Items[localItemId.ToString("N")].Name);
        Assert.Equal("552", stored.Items[localItemId.ToString("N")].TmdbId);
        Assert.Equal(
            new[] { "tmdb-549" },
            stored.Items.Keys.Where(static key => key.StartsWith("tmdb-", StringComparison.Ordinal)));

        controller.Request.Headers.IfMatch = "\"1\"";
        Assert.IsType<OkObjectResult>(controller.AdminUnhideForUser(
            UserId,
            new List<string> { "hc1:tmdb:movie:550" }));
        stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json");
        Assert.False(stored.Items.ContainsKey("hc1:tmdb:movie:550"));
        Assert.True(stored.Items.ContainsKey("hc1:tmdb:tv:550"));
    }

    [Fact]
    public void AdminHide_SkipsInvalidExplicitIdentitiesAndPreservesDistinctExactItems()
    {
        var firstId = Guid.Parse("06060606-1111-2222-3333-444444444444");
        var secondId = Guid.Parse("07070707-1111-2222-3333-444444444444");
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, scopedUser) =>
            {
                if (scopedUser?.Id != _user.Id || (id != firstId && id != secondId))
                    return null;
                var movie = new Movie
                {
                    Id = id,
                    Name = id == firstId ? "Edition one" : "Edition two"
                };
                movie.ProviderIds["Tmdb"] = "550";
                return movie;
            }
        };
        var controller = Controller(NullLogger<HiddenContentController>.Instance, library);
        var result = controller.AdminHideForUser(UserId, new List<HiddenContentItem>
        {
            new()
            {
                ItemId = firstId.ToString("N"),
                Name = "Edition one",
                Type = "Movie",
                TmdbId = "550",
                Identity = new HiddenContentIdentity
                {
                    Version = 1,
                    Provider = "tmdb",
                    MediaType = "movie",
                    Id = "550"
                }
            },
            new()
            {
                ItemId = secondId.ToString("N"),
                Name = "Edition two",
                Type = "Movie",
                TmdbId = "550",
                Identity = new HiddenContentIdentity
                {
                    Version = 1,
                    Provider = "tmdb",
                    MediaType = "movie",
                    Id = "550"
                }
            },
            new()
            {
                Type = "Movie",
                TmdbId = "551",
                Identity = new HiddenContentIdentity
                {
                    Version = 2,
                    Provider = "tmdb",
                    MediaType = "movie",
                    Id = "551"
                }
            },
            new()
            {
                Type = "Movie",
                TmdbId = "552",
                Identity = new HiddenContentIdentity
                {
                    Version = 1,
                    Provider = "tmdb",
                    MediaType = "movie",
                    Id = "not-decimal"
                }
            }
        });

        Assert.IsType<OkObjectResult>(result);
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json");
        Assert.Equal(
            new[] { firstId.ToString("N"), secondId.ToString("N") },
            stored.Items.Keys.Order(StringComparer.Ordinal));
        Assert.All(stored.Items.Values, item =>
        {
            Assert.Equal("550", item.TmdbId);
            Assert.Equal("movie", item.Identity?.MediaType);
        });
    }

    [Fact]
    public void ScopedHide_AtomicallyPrefersAlternateTypedMetadataOverCanonicalLegacyMetadata()
    {
        var itemId = Guid.Parse("11111111-2222-3333-4444-555555555555");
        var dashed = itemId.ToString();
        var compact = itemId.ToString("N");
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                [dashed] = new()
                {
                    ItemId = dashed,
                    Name = "Legacy Movie 550",
                    TmdbId = "550",
                    HideScope = "continuewatching"
                },
                [compact] = new()
                {
                    ItemId = compact,
                    Name = "Movie 551",
                    Type = "Movie",
                    TmdbId = "551",
                    Identity = new HiddenContentIdentity
                    {
                        Version = 1,
                        Provider = "tmdb",
                        MediaType = "movie",
                        Id = "551"
                    },
                    HideScope = "nextup"
                }
            }
        });
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, _) => id == itemId
                ? new Movie { Id = itemId, Name = "Movie 550" }
                : null
        };

        var result = Controller(NullLogger<HiddenContentController>.Instance, library)
            .HideFromContinueWatching(compact);

        var ok = Assert.IsType<OkObjectResult>(result);
        var acknowledgement = System.Text.Json.JsonSerializer.SerializeToElement(ok.Value);
        Assert.Equal(1, acknowledgement.GetProperty("itemsRevision").GetInt64());
        Assert.False(acknowledgement.GetProperty("settingsChanged").GetBoolean());
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json");
        Assert.Equal(1, stored.ItemsRevision);
        var item = Assert.Single(stored.Items, pair => pair.Key == dashed).Value;
        Assert.Equal(dashed, item.ItemId);
        Assert.Equal("551", item.TmdbId);
        Assert.Equal("movie", item.Identity?.MediaType);
        Assert.Equal("551", item.Identity?.Id);
        Assert.Equal("homesections", item.HideScope);
    }

    [Fact]
    public void LibraryDerivedHiddenWriters_BoundMetadataAndRemainReadableByAdmin()
    {
        _provider.Current!.HiddenContentAdmin = true;
        var scopedId = Guid.Parse("13131313-2424-3535-4646-575757575757");
        var adminId = Guid.Parse("14141414-2525-3636-4747-585858585858");
        var seriesId = Guid.Parse("15151515-2626-3737-4848-595959595959");
        var longItemName = new string('i', 700);
        var longSeriesName = new string('s', 700);
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, scopedUser) =>
            {
                if (scopedUser?.Id != _user.Id || (id != scopedId && id != adminId))
                {
                    return null;
                }

                return new Episode
                {
                    Id = id,
                    Name = longItemName,
                    SeriesId = seriesId,
                    SeriesName = longSeriesName,
                    ParentIndexNumber = -1,
                    IndexNumber = PersistedPayloadPolicy.MaximumHiddenIndex + 1
                };
            }
        };

        Assert.IsType<OkObjectResult>(
            Controller(NullLogger<HiddenContentController>.Instance, library)
                .HideFromContinueWatching(scopedId.ToString()));
        Assert.IsType<OkObjectResult>(
            Controller(NullLogger<HiddenContentController>.Instance, library)
                .AdminHideForUser(
                    UserId,
                    new List<HiddenContentItem>
                    {
                        new() { ItemId = adminId.ToString("N") }
                    }));

        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json");
        Assert.Equal(2, stored.Items.Count);
        Assert.All(stored.Items.Values, item =>
        {
            Assert.Equal(512, item.Name.Length);
            Assert.Equal(512, item.SeriesName.Length);
            Assert.Null(item.SeasonNumber);
            Assert.Null(item.EpisodeNumber);
        });
        Assert.IsType<OkObjectResult>(
            Controller(NullLogger<HiddenContentController>.Instance, library)
                .GetUserHiddenContentForAdmin(UserId));
    }

    [Fact]
    public void FullSelfHidePost_BoundsMetadataAndRemainsReadableByAdmin()
    {
        _provider.Current!.HiddenContentAdmin = true;
        _manager.SaveUserConfiguration(
            UserId,
            "hidden-content.json",
            new UserHiddenContent());
        var itemId = Guid.Parse("17171717-2828-3939-5050-616161616161");
        var candidate = new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                [itemId.ToString()] = new()
                {
                    ItemId = itemId.ToString(),
                    Name = new string('n', 700),
                    SeriesName = new string('s', 700),
                    SeasonNumber = -1,
                    EpisodeNumber =
                        PersistedPayloadPolicy.MaximumHiddenIndex + 1,
                    HideScope = "global"
                }
            }
        };
        var controller = Controller(
            NullLogger<HiddenContentController>.Instance);

        Assert.IsType<OkObjectResult>(
            controller.SaveUserHiddenContent(UserId, candidate));

        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json");
        var item = Assert.Single(stored.Items).Value;
        Assert.Equal(512, item.Name.Length);
        Assert.Equal(512, item.SeriesName.Length);
        Assert.Null(item.SeasonNumber);
        Assert.Null(item.EpisodeNumber);
        Assert.Equal(1, stored.ItemsRevision);
        var beforeGet = File.ReadAllBytes(HiddenPath);
        Assert.IsType<OkObjectResult>(
            controller.GetUserHiddenContentForAdmin(UserId));
        Assert.Equal(beforeGet, File.ReadAllBytes(HiddenPath));
    }

    [Fact]
    public void LegacyMetadata_GetFirstIsDetachedThenItemMutationRepairsOnce()
    {
        _provider.Current!.HiddenContentAdmin = true;
        var removedId = Guid.Parse("18181818-2929-4040-5151-626262626262");
        var survivingId = Guid.Parse("19191919-3030-4141-5252-636363636363");
        var legacy = new UserHiddenContent
        {
            ItemsRevision = 7,
            Settings = new HiddenContentSettings { Revision = 3 },
            Items = new Dictionary<string, HiddenContentItem>
            {
                [removedId.ToString()] = new()
                {
                    ItemId = removedId.ToString(),
                    Name = new string('r', 700),
                    HideScope = "continuewatching"
                },
                [survivingId.ToString()] = new()
                {
                    ItemId = survivingId.ToString(),
                    Name = new string('n', 700),
                    SeriesName = new string('s', 700),
                    SeasonNumber = -1,
                    EpisodeNumber =
                        PersistedPayloadPolicy.MaximumHiddenIndex + 1,
                    HideScope = "global"
                }
            }
        };
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", legacy);
        var beforeGet = File.ReadAllBytes(HiddenPath);
        var controller = Controller(
            NullLogger<HiddenContentController>.Instance);

        var self = Assert.IsType<OkObjectResult>(
            controller.GetUserHiddenContent(UserId));
        var selfView = Assert.IsType<UserHiddenContent>(self.Value);
        Assert.All(selfView.Items.Values, item =>
        {
            Assert.InRange(item.Name.Length, 0, 512);
            Assert.InRange(item.SeriesName.Length, 0, 512);
        });
        Assert.IsType<OkObjectResult>(
            controller.GetUserHiddenContentForAdmin(UserId));
        Assert.IsType<OkObjectResult>(
            controller.GetTargetHiddenContentSettings(UserId));
        Assert.Equal(beforeGet, File.ReadAllBytes(HiddenPath));
        var stillLegacy = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json");
        Assert.Equal(7, stillLegacy.ItemsRevision);
        Assert.Equal(700, stillLegacy.Items[survivingId.ToString()].Name.Length);

        var settingsCandidate = new HiddenContentSettings
        {
            Revision = 3,
            Enabled = false
        };
        controller.Request.Headers.IfMatch = "\"3\"";
        var settingsResult = Assert.IsType<OkObjectResult>(
            controller.SaveTargetHiddenContentSettings(
                UserId,
                settingsCandidate));
        var afterSettings =
            _manager.GetUserConfigurationStrict<UserHiddenContent>(
                UserId,
                "hidden-content.json");
        Assert.Equal(4, afterSettings.Settings.Revision);
        Assert.False(afterSettings.Settings.Enabled);
        Assert.Equal(7, afterSettings.ItemsRevision);
        Assert.Equal(
            700,
            afterSettings.Items[survivingId.ToString()].Name.Length);
        Assert.Equal(
            700,
            afterSettings.Items[survivingId.ToString()].SeriesName.Length);

        Assert.IsType<OkObjectResult>(
            controller.UnhideFromContinueWatching(removedId.ToString()));
        var repaired = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json");
        Assert.Equal(8, repaired.ItemsRevision);
        var survivor = Assert.Single(repaired.Items).Value;
        Assert.Equal(512, survivor.Name.Length);
        Assert.Equal(512, survivor.SeriesName.Length);
        Assert.Null(survivor.SeasonNumber);
        Assert.Null(survivor.EpisodeNumber);
        Assert.True(PersistedPayloadPolicy.Validate(repaired).IsValid);
    }

    [Fact]
    public void ScopedHide_InvalidCoResidentStateFailsClosedWithoutDiskMutation()
    {
        var itemId = Guid.Parse("16161616-2727-3838-4949-606060606060");
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["invalid"] = new()
                {
                    Name = "Invalid co-resident item",
                    PosterPath = new string('x', 513),
                    HideScope = "global"
                }
            }
        });
        var before = File.ReadAllBytes(HiddenPath);
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, scopedUser) =>
                id == itemId && scopedUser?.Id == _user.Id
                    ? new Movie { Id = itemId, Name = "New scoped movie" }
                    : null
        };

        var result = Assert.IsType<ObjectResult>(
            Controller(NullLogger<HiddenContentController>.Instance, library)
                .HideFromContinueWatching(itemId.ToString()));

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, result.StatusCode);
        Assert.Equal(before, File.ReadAllBytes(HiddenPath));
    }

    [Fact]
    public void ScopedUnhide_ReturnsTheAdvancedItemsRevision()
    {
        var itemId = Guid.Parse("12121212-3434-5656-7878-909090909090");
        var dashed = itemId.ToString();
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            ItemsRevision = 4,
            Items = new Dictionary<string, HiddenContentItem>
            {
                [dashed] = new()
                {
                    ItemId = dashed,
                    Name = "Scoped item",
                    HideScope = "continuewatching"
                }
            }
        });

        var result = Controller(NullLogger<HiddenContentController>.Instance)
            .UnhideFromContinueWatching(dashed);

        var ok = Assert.IsType<OkObjectResult>(result);
        var acknowledgement = System.Text.Json.JsonSerializer.SerializeToElement(ok.Value);
        Assert.Equal(5, acknowledgement.GetProperty("itemsRevision").GetInt64());
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json");
        Assert.Equal(5, stored.ItemsRevision);
        Assert.Empty(stored.Items);
    }

    [Fact]
    public void FirstScopedHide_AdvancesForcedPreferenceRevisionSoAStaleAdminSaveConflicts()
    {
        _provider.Current!.HiddenContentAdmin = true;
        _provider.Current.HiddenContentDefaultEnabled = false;
        var itemId = Guid.Parse("23232323-4545-6767-8989-010101010101");
        var movie = new Movie { Id = itemId, Name = "Scoped movie" };
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, _) => id == itemId ? movie : null
        };
        var controller = Controller(
            NullLogger<HiddenContentController>.Instance,
            library);

        var read = Assert.IsType<OkObjectResult>(
            controller.GetTargetHiddenContentSettings(UserId));
        var candidate = Assert.IsType<HiddenContentSettings>(
            read.Value!.GetType().GetProperty("Data")!.GetValue(read.Value));
        Assert.Equal(0, candidate.Revision);
        Assert.False(candidate.Enabled);
        Assert.False(_manager.UserConfigurationExists(UserId, "hidden-content.json"));

        var hide = Assert.IsType<OkObjectResult>(
            controller.HideFromContinueWatching(itemId.ToString()));
        var acknowledgement = System.Text.Json.JsonSerializer.SerializeToElement(hide.Value);
        Assert.Equal(1, acknowledgement.GetProperty("itemsRevision").GetInt64());
        Assert.Equal(1, acknowledgement.GetProperty("settingsRevision").GetInt64());
        Assert.True(acknowledgement.GetProperty("hiddenContentEnabled").GetBoolean());
        Assert.True(acknowledgement.GetProperty("settingsChanged").GetBoolean());

        controller.Request.Headers.IfMatch = "\"0\"";
        var staleSave = controller.SaveTargetHiddenContentSettings(UserId, candidate);
        Assert.IsType<ConflictObjectResult>(staleSave);
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json");
        Assert.Equal(1, stored.Settings.Revision);
        Assert.True(stored.Settings.Enabled);
        Assert.Equal(1, stored.ItemsRevision);
    }

    [Fact]
    public void FirstScopedHide_WithEnabledDefault_DoesNotAdvanceSettingsRevision()
    {
        _provider.Current!.HiddenContentDefaultEnabled = true;
        var itemId = Guid.Parse("24242424-4646-6868-8080-020202020202");
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, _) => id == itemId
                ? new Movie { Id = itemId, Name = "Scoped movie" }
                : null
        };

        var hide = Assert.IsType<OkObjectResult>(
            Controller(NullLogger<HiddenContentController>.Instance, library)
                .HideFromContinueWatching(itemId.ToString()));
        var acknowledgement = System.Text.Json.JsonSerializer.SerializeToElement(hide.Value);
        Assert.Equal(1, acknowledgement.GetProperty("itemsRevision").GetInt64());
        Assert.Equal(0, acknowledgement.GetProperty("settingsRevision").GetInt64());
        Assert.True(acknowledgement.GetProperty("hiddenContentEnabled").GetBoolean());
        Assert.False(acknowledgement.GetProperty("settingsChanged").GetBoolean());

        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json");
        Assert.Equal(0, stored.Settings.Revision);
        Assert.True(stored.Settings.Enabled);
        Assert.Equal(1, stored.ItemsRevision);
    }

    [Fact]
    public async Task ScopedHide_QueuedBehindEmptyPreferenceCreation_PreservesSettings()
    {
        var itemId = Guid.Parse("25252525-4747-6969-8181-030303030303");
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, _) => id == itemId
                ? new Movie { Id = itemId, Name = "Scoped movie" }
                : null
        };
        using var transactionQueuedAtStore = new ManualResetEventSlim();
        _manager.UserFileLockObserverForTests = observation =>
        {
            if (observation.Operation == "transaction"
                && observation.UserId == UserId
                && observation.FileName == "hidden-content.json"
                && observation.Phase == UserFileLockPhase.Waiting)
            {
                transactionQueuedAtStore.Set();
            }
        };

        Task<IActionResult>? hideTask = null;
        try
        {
            lock (_manager.GetUserFileLock(UserId, "hidden-content.json"))
            {
                hideTask = Task.Run(() =>
                    Controller(NullLogger<HiddenContentController>.Instance, library)
                        .HideFromContinueWatching(itemId.ToString()));
                Assert.True(transactionQueuedAtStore.Wait(TimeSpan.FromSeconds(10)));

                _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
                {
                    ItemsRevision = 12,
                    Settings = new HiddenContentSettings
                    {
                        Revision = 41,
                        Enabled = false,
                        FilterSearch = true,
                        ShowButtonCast = true
                    }
                });
            }

            var ok = Assert.IsType<OkObjectResult>(
                await hideTask.WaitAsync(TimeSpan.FromSeconds(10)));
            var acknowledgement = System.Text.Json.JsonSerializer.SerializeToElement(ok.Value);
            Assert.Equal(13, acknowledgement.GetProperty("itemsRevision").GetInt64());
            Assert.Equal(41, acknowledgement.GetProperty("settingsRevision").GetInt64());
            Assert.False(acknowledgement.GetProperty("hiddenContentEnabled").GetBoolean());
            Assert.False(acknowledgement.GetProperty("settingsChanged").GetBoolean());

            var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(
                UserId,
                "hidden-content.json");
            Assert.Single(stored.Items);
            Assert.Equal(13, stored.ItemsRevision);
            Assert.Equal(41, stored.Settings.Revision);
            Assert.False(stored.Settings.Enabled);
            Assert.True(stored.Settings.FilterSearch);
            Assert.True(stored.Settings.ShowButtonCast);
        }
        finally
        {
            _manager.UserFileLockObserverForTests = null;
        }
    }

    [Fact]
    public void ScopedHide_ExactBoundaryAdds10000ButNever10001()
    {
        var admittedId = Guid.Parse("31313131-4242-5353-6464-757575757575");
        var rejectedId = Guid.Parse("81818181-9292-a3a3-b4b4-c5c5c5c5c5c5");
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, scopedUser) =>
                scopedUser?.Id == _user.Id && (id == admittedId || id == rejectedId)
                    ? new Movie { Id = id, Name = $"Movie {id:N}" }
                    : null
        };
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            ItemsRevision = 21,
            Items = BuildHiddenItems(PersistedPayloadPolicy.MaximumHiddenItems - 1)
        });
        var controller = Controller(NullLogger<HiddenContentController>.Instance, library);

        Assert.IsType<OkObjectResult>(
            controller.HideFromContinueWatching(admittedId.ToString()));
        var atCapacity = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json");
        Assert.Equal(PersistedPayloadPolicy.MaximumHiddenItems, atCapacity.Items.Count);
        Assert.Equal(22, atCapacity.ItemsRevision);
        Assert.True(atCapacity.Items.ContainsKey(admittedId.ToString()));
        var beforeRejectedAdd = File.ReadAllBytes(HiddenPath);
        HiddenContentResponseFilter.SeedCacheForTest(UserId);

        var rejected = Assert.IsType<ObjectResult>(
            controller.HideFromNextUp(rejectedId.ToString()));

        Assert.Equal(StatusCodes.Status413PayloadTooLarge, rejected.StatusCode);
        var error = System.Text.Json.JsonSerializer.SerializeToElement(rejected.Value);
        Assert.Equal("hidden_content_cap_exceeded", error.GetProperty("code").GetString());
        Assert.Equal(
            PersistedPayloadPolicy.MaximumHiddenItems,
            error.GetProperty("maximum").GetInt32());
        Assert.Equal(beforeRejectedAdd, File.ReadAllBytes(HiddenPath));
        var unchanged = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json");
        Assert.Equal(PersistedPayloadPolicy.MaximumHiddenItems, unchanged.Items.Count);
        Assert.Equal(22, unchanged.ItemsRevision);
        Assert.DoesNotContain(rejectedId.ToString(), unchanged.Items.Keys);
        Assert.True(HiddenContentResponseFilter.IsCachedForTest(UserId));
    }

    [Fact]
    public void AdminHide_AtItemCapReturnsExplicit413AndLeavesOriginalUntouched()
    {
        var newItemId = Guid.Parse("d1d1d1d1-e2e2-f3f3-a4a4-b5b5b5b5b5b5");
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, scopedUser) =>
                id == newItemId && scopedUser?.Id == _user.Id
                    ? new Movie { Id = id, Name = "Validated new movie" }
                    : null
        };
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            ItemsRevision = 31,
            Items = BuildHiddenItems(PersistedPayloadPolicy.MaximumHiddenItems)
        });
        var before = File.ReadAllBytes(HiddenPath);
        HiddenContentResponseFilter.SeedCacheForTest(UserId);

        var result = Assert.IsType<ObjectResult>(
            Controller(NullLogger<HiddenContentController>.Instance, library)
                .AdminHideForUser(
                    UserId,
                    new List<HiddenContentItem>
                    {
                        new()
                        {
                            ItemId = newItemId.ToString("N"),
                            Name = "Untrusted submitted name"
                        }
                    }));

        Assert.Equal(StatusCodes.Status413PayloadTooLarge, result.StatusCode);
        var error = System.Text.Json.JsonSerializer.SerializeToElement(result.Value);
        Assert.Equal("hidden_content_cap_exceeded", error.GetProperty("code").GetString());
        Assert.Equal(
            PersistedPayloadPolicy.MaximumHiddenItems,
            error.GetProperty("maximum").GetInt32());
        Assert.Equal(before, File.ReadAllBytes(HiddenPath));
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json");
        Assert.Equal(PersistedPayloadPolicy.MaximumHiddenItems, stored.Items.Count);
        Assert.Equal(31, stored.ItemsRevision);
        Assert.DoesNotContain(newItemId.ToString("N"), stored.Items.Keys);
        Assert.True(HiddenContentResponseFilter.IsCachedForTest(UserId));
    }

    [Fact]
    public void ScopedHide_ReconcilesFreshTypedIdentityWithLegacyTmdbMetadata()
    {
        var itemId = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        var dashed = itemId.ToString();
        var compact = itemId.ToString("N");
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                [compact] = new()
                {
                    ItemId = compact,
                    Name = "Legacy Movie 550",
                    Type = "Movie",
                    TmdbId = "550",
                    HideScope = "continuewatching"
                }
            }
        });
        var movie = new Movie { Id = itemId, Name = "Movie 551" };
        movie.ProviderIds["Tmdb"] = "551";
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, _) => id == itemId ? movie : null
        };

        var result = Controller(NullLogger<HiddenContentController>.Instance, library)
            .HideFromNextUp(dashed);

        Assert.IsType<OkObjectResult>(result);
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json");
        var item = Assert.Single(stored.Items, pair => pair.Key == dashed).Value;
        Assert.Equal("551", item.TmdbId);
        Assert.Equal("tmdb", item.Identity?.Provider);
        Assert.Equal("movie", item.Identity?.MediaType);
        Assert.Equal("551", item.Identity?.Id);
        Assert.Equal("homesections", item.HideScope);
    }

    [Fact]
    public void ScopedHide_PreservesUnsupportedIdentityAndTmdbAsAnOpaquePair()
    {
        var itemId = Guid.Parse("99999999-8888-7777-6666-555555555555");
        var dashed = itemId.ToString();
        var futureId = new string('f', 96);
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                [dashed] = new()
                {
                    ItemId = dashed,
                    Name = "Future identity",
                    Type = "Movie",
                    TmdbId = "550",
                    Identity = new HiddenContentIdentity
                    {
                        Version = 2,
                        Provider = "imdb",
                        MediaType = "movie",
                        Id = futureId,
                        ExtensionData = new Dictionary<string, System.Text.Json.JsonElement>
                        {
                            ["FutureIdentity"] = System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(
                                "{\"nested\":[1,{\"marker\":\"kept\"}]}")
                        }
                    },
                    HideScope = "continuewatching"
                }
            }
        });
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, _) => id == itemId
                ? new Movie { Id = itemId, Name = "Future identity" }
                : null
        };

        var result = Assert.IsType<OkObjectResult>(
            Controller(NullLogger<HiddenContentController>.Instance, library)
                .HideFromContinueWatching(dashed));

        var acknowledgement = System.Text.Json.JsonSerializer.SerializeToElement(result.Value);
        var responseIdentity = acknowledgement.GetProperty("entry").GetProperty("Identity");
        Assert.Equal(2, responseIdentity.GetProperty("Version").GetInt32());
        Assert.Equal(futureId, responseIdentity.GetProperty("Id").GetString());
        Assert.Equal(
            "kept",
            responseIdentity.GetProperty("FutureIdentity")
                .GetProperty("nested")[1]
                .GetProperty("marker")
                .GetString());
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json");
        var item = Assert.Single(stored.Items).Value;
        Assert.Equal("550", item.TmdbId);
        Assert.Equal(2, item.Identity?.Version);
        Assert.Equal("imdb", item.Identity?.Provider);
        Assert.Equal(futureId, item.Identity?.Id);
        Assert.Equal(
            "kept",
            item.Identity?.ExtensionData["FutureIdentity"]
                .GetProperty("nested")[1]
                .GetProperty("marker")
                .GetString());

        var responseEntry = Assert.IsType<HiddenContentItem>(
            result.Value!.GetType().GetProperty("entry")!.GetValue(result.Value));
        responseEntry.Identity!.ExtensionData.Clear();
        Assert.True(_manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json")
            .Items.Single().Value.Identity!.ExtensionData.ContainsKey("FutureIdentity"));
    }

    [Fact]
    public void SupportedScopedHide_InvokesSharedOwnerExactlyOnce()
    {
        var itemId = Guid.NewGuid();
        var recording = new RecordingHiddenContentOwner();
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, _) => id == itemId
                ? new Movie { Id = itemId, Name = "Accessible" }
                : null
        };

        var result = Controller(
            NullLogger<HiddenContentController>.Instance,
            library,
            hiddenContentItemActionOwner: recording)
            .HideFromContinueWatching(itemId.ToString());

        Assert.IsType<OkObjectResult>(result);
        Assert.Equal(1, recording.ConfigureCalls);
        Assert.Equal(_user.Id, recording.Actor?.UserId);
        Assert.Equal(itemId, recording.Item?.ItemId);
        Assert.True(recording.Configuration?.Hidden);
    }

    [Fact]
    public void InaccessibleScopedUnhide_UsesLegacyRepairWithoutOwnerInvocation()
    {
        var itemId = Guid.NewGuid();
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            ItemsRevision = 3,
            Items = new Dictionary<string, HiddenContentItem>
            {
                [itemId.ToString()] = new()
                {
                    ItemId = itemId.ToString(),
                    HideScope = "continuewatching"
                }
            }
        });
        var recording = new RecordingHiddenContentOwner();
        var library = new CountingLibraryManager { GetItemByIdUserHook = (_, _) => null };

        var result = Controller(
            NullLogger<HiddenContentController>.Instance,
            library,
            hiddenContentItemActionOwner: recording)
            .UnhideFromContinueWatching(itemId.ToString());

        Assert.IsType<OkObjectResult>(result);
        Assert.Equal(0, recording.ConfigureCalls);
        Assert.Empty(_manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json").Items);
    }

    [Fact]
    public void FailedScopedUnhideAccessLookup_FailsClosedWithoutOwnerOrRepairMutation()
    {
        var itemId = Guid.NewGuid();
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            ItemsRevision = 3,
            Items = new Dictionary<string, HiddenContentItem>
            {
                [itemId.ToString()] = new()
                {
                    ItemId = itemId.ToString(),
                    HideScope = "continuewatching"
                }
            }
        });
        var path = HiddenPath;
        var before = File.ReadAllBytes(path);
        var recording = new RecordingHiddenContentOwner();
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (_, _) => throw new IOException("library unavailable")
        };

        var result = Assert.IsType<ObjectResult>(Controller(
            NullLogger<HiddenContentController>.Instance,
            library,
            hiddenContentItemActionOwner: recording)
            .UnhideFromContinueWatching(itemId.ToString()));

        Assert.Equal(500, result.StatusCode);
        Assert.Equal(0, recording.ConfigureCalls);
        Assert.Equal(before, File.ReadAllBytes(path));
    }

    [Fact]
    public void LegacyAndPlatformAdapters_ProduceEquivalentScopedOwnerState()
    {
        var legacyItemId = Guid.NewGuid();
        var platformItemId = Guid.NewGuid();
        var platformUserId = Guid.NewGuid();
        var initial = new UserHiddenContent
        {
            ItemsRevision = 4,
            Settings = new HiddenContentSettings { Revision = 3, Enabled = false }
        };
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", initial);
        _manager.SaveUserConfiguration(
            platformUserId.ToString("N"),
            "hidden-content.json",
            new UserHiddenContent
            {
                ItemsRevision = 4,
                Settings = new HiddenContentSettings { Revision = 3, Enabled = false }
            });
        var owner = new HiddenContentItemActionOwner(_manager, _provider);
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, _) => id == legacyItemId
                ? new Movie
                {
                    Id = legacyItemId,
                    Name = "Legacy title",
                    ProviderIds = new Dictionary<string, string> { ["Tmdb"] = "123" }
                }
                : null
        };

        var legacyResult = Controller(
            NullLogger<HiddenContentController>.Instance,
            library,
            hiddenContentItemActionOwner: owner)
            .HideFromContinueWatching(legacyItemId.ToString());
        var platformResult = new HiddenContentPlatformItemActionAdapter(owner).Configure(
            new PlatformActor(platformUserId, false, "correlation", null, null),
            new HostAccessibleItem(
                platformItemId,
                HostItemKind.Movie,
                null,
                ImmutableArray.Create(new HostProviderReference("tmdb", "123"))),
            HiddenContentItemConfiguration.Exact(
                true,
                HiddenContentItemScope.ContinueWatching,
                expectedItemsRevision: 4));

        Assert.IsType<OkObjectResult>(legacyResult);
        Assert.Equal(HiddenContentItemActionOutcome.Configured, platformResult.Outcome);
        var legacyState = _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json");
        var platformState = _manager.GetUserConfigurationStrict<UserHiddenContent>(
            platformUserId.ToString("N"),
            "hidden-content.json");
        var legacyEntry = Assert.Single(legacyState.Items).Value;
        var platformEntry = Assert.Single(platformState.Items).Value;
        Assert.Equal(legacyEntry.HideScope, platformEntry.HideScope);
        Assert.Equal(legacyEntry.Type, platformEntry.Type);
        Assert.Equal(legacyEntry.TmdbId, platformEntry.TmdbId);
        Assert.Equal(legacyEntry.Identity?.Provider, platformEntry.Identity?.Provider);
        Assert.Equal(legacyEntry.Identity?.MediaType, platformEntry.Identity?.MediaType);
        Assert.Equal(legacyEntry.Identity?.Id, platformEntry.Identity?.Id);
        Assert.Equal(legacyState.ItemsRevision, platformState.ItemsRevision);
        Assert.Equal(legacyState.Settings.Revision, platformState.Settings.Revision);
        Assert.Equal(legacyState.Settings.Enabled, platformState.Settings.Enabled);
    }

    [Fact]
    public void LegacyEpisodeHide_PreservesDashedSeriesIdAndClearsPosterLikePriorRoute()
    {
        var episodeId = Guid.NewGuid();
        var seriesId = Guid.NewGuid();
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                [episodeId.ToString()] = new()
                {
                    ItemId = episodeId.ToString(),
                    PosterPath = "/old-poster.jpg",
                    HideScope = "nextup"
                }
            }
        });
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, _) => id == episodeId
                ? new Episode
                {
                    Id = episodeId,
                    Name = "Episode",
                    SeriesId = seriesId,
                    SeriesName = "Series",
                    ParentIndexNumber = 2,
                    IndexNumber = 3
                }
                : null
        };

        var result = Controller(NullLogger<HiddenContentController>.Instance, library)
            .HideFromContinueWatching(episodeId.ToString());

        Assert.IsType<OkObjectResult>(result);
        var entry = Assert.Single(_manager.GetUserConfigurationStrict<UserHiddenContent>(
            UserId,
            "hidden-content.json").Items).Value;
        Assert.Equal(seriesId.ToString(), entry.SeriesId);
        Assert.Equal(string.Empty, entry.PosterPath);
        Assert.Equal("homesections", entry.HideScope);
    }

    private HiddenContentController Controller(
        ILogger<HiddenContentController> logger,
        CountingLibraryManager? libraryManager = null,
        bool includeAdminItemsIfMatch = true,
        long? adminItemsIfMatch = null,
        IHiddenContentItemActionOwner? hiddenContentItemActionOwner = null)
    {
        libraryManager ??= new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, scopedUser) =>
                scopedUser?.Id == _user.Id
                    ? new Movie { Id = id, Name = "Canonical library item" }
                    : null
        };
        var controller = new HiddenContentController(
            new RecordingHttpClientFactory(new HttpClientHandler()),
            logger,
            new StubUserManager(_user),
            new SeerrCache(_provider),
            _provider,
            _manager,
            libraryManager,
            hiddenContentItemActionOwner
                ?? new HiddenContentItemActionOwner(_manager, _provider));
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                    new[] { new Claim("Jellyfin-UserId", _user.Id.ToString()) },
                    "TestAuth"))
            }
        };
        if (includeAdminItemsIfMatch)
        {
            var classified = _manager.ReadUserConfiguration<UserHiddenContent>(
                UserId,
                "hidden-content.json");
            var revision = adminItemsIfMatch
                ?? (classified.HasUsableValue && classified.Value != null
                    ? classified.Value.ItemsRevision
                    : 0);
            controller.Request.Headers.IfMatch = $"\"{revision}\"";
        }
        return controller;
    }

    private static UserHiddenContent BuildNormalizationBoundaryPayload()
    {
        var payload = new UserHiddenContent();
        for (var i = 0; i < PersistedPayloadPolicy.MaximumHiddenItems; i++)
        {
            payload.Items.Add(i.ToString("x32"), new HiddenContentItem { HideScope = null! });
        }

        // null -> "global" adds exactly four UTF-8 bytes per item. Place the
        // bound graph 20,000 bytes below the ceiling, so only normalization
        // crosses it. ASCII field padding changes serialized size one-for-one.
        var targetBytes = PersistedPayloadPolicy.HiddenContentPersistedBytes - 20_000;
        var baseBytes = PersistedPayloadPolicy.ValidateSerializedSize(payload, int.MaxValue).SerializedBytes;
        var remaining = targetBytes - baseBytes;
        Assert.True(remaining > 0, "boundary fixture base unexpectedly exceeds its target");
        foreach (var item in payload.Items.Values)
        {
            item.Name = Padding(ref remaining, 512);
            item.SeriesName = Padding(ref remaining, 512);
            item.PosterPath = Padding(ref remaining, 512);
            if (remaining == 0)
            {
                break;
            }
        }

        Assert.Equal(0, remaining);
        Assert.Equal(
            targetBytes,
            PersistedPayloadPolicy.ValidateSerializedSize(payload, int.MaxValue).SerializedBytes);
        return payload;
    }

    private static Dictionary<string, HiddenContentItem> BuildHiddenItems(int count)
    {
        var items = new Dictionary<string, HiddenContentItem>(
            count,
            StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < count; index++)
        {
            var key = index.ToString("x32");
            items[key] = new HiddenContentItem
            {
                ItemId = key,
                Name = $"Hidden {index}",
                HideScope = "global"
            };
        }

        return items;
    }

    private static string Padding(ref int remaining, int maximum)
    {
        var length = Math.Min(remaining, maximum);
        remaining -= length;
        return new string('x', length);
    }

    private sealed class CapturingLoggerProvider : ILoggerProvider
    {
        public List<string> Messages { get; } = new();

        public ILogger CreateLogger(string categoryName) => new CapturingLogger(Messages);

        public void Dispose()
        {
        }

        private sealed class CapturingLogger : ILogger
        {
            private readonly List<string> _messages;

            public CapturingLogger(List<string> messages) => _messages = messages;

            public IDisposable? BeginScope<TState>(TState state)
                where TState : notnull
                => null;

            public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
                => _messages.Add(formatter(state, exception));
        }
    }

    private sealed class RecordingHiddenContentOwner :
        IHiddenContentItemActionOwner,
        IHiddenContentLegacyItemActionOwner
    {
        public int ConfigureCalls { get; private set; }

        public HiddenContentActorProjection? Actor { get; private set; }

        public HiddenContentItemProjection? Item { get; private set; }

        public HiddenContentItemConfiguration? Configuration { get; private set; }

        public HiddenContentItemActionResult GetState(
            HiddenContentActorProjection actor,
            HiddenContentItemProjection item,
            HiddenContentItemScope scope)
            => Result();

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

        public HiddenContentLegacyItemActionResult ConfigureLegacyHomeSurface(
            HiddenContentActorProjection actor,
            HiddenContentItemProjection item,
            HiddenContentItemConfiguration configuration)
            => new(
                Configure(actor, item, configuration),
                new HiddenContentItem
                {
                    ItemId = "item-key",
                    HideScope = "continuewatching"
                });

        private static HiddenContentItemActionResult Result() => new(
            HiddenContentItemActionOutcome.Configured,
            hidden: true,
            changed: true,
            "item-key",
            new HiddenContentItemState(
                "item-key",
                string.Empty,
                string.Empty,
                string.Empty,
                identity: null,
                string.Empty,
                string.Empty,
                string.Empty,
                string.Empty,
                seasonNumber: null,
                episodeNumber: null,
                "continuewatching"),
            itemsRevision: 1,
            settingsRevision: 0,
            hiddenContentEnabled: true,
            settingsChanged: false);
    }
}
