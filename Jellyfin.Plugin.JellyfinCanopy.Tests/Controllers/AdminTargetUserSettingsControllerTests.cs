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
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class AdminTargetUserSettingsControllerTests : IDisposable
{
    private readonly string _baseDir;
    private readonly UserConfigurationManager _manager;
    private readonly User _actor;
    private readonly User _target;
    private readonly StubUserManager _userManager;
    private readonly FakePluginConfigProvider _provider;

    public AdminTargetUserSettingsControllerTests()
    {
        _baseDir = Path.Combine(
            Path.GetTempPath(),
            "jc-admin-target-settings-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_baseDir);
        _manager = new UserConfigurationManager(
            new StubAppPaths(_baseDir),
            NullLogger<UserConfigurationManager>.Instance);
        _actor = new User("admin-actor", "Provider", "PasswordProvider");
        _actor.SetPermission(PermissionKind.IsAdministrator, true);
        _target = new User("Target <User> & Co", "Provider", "PasswordProvider");
        _userManager = new StubUserManager(_actor, _target);
        _provider = new FakePluginConfigProvider(new PluginConfiguration());
    }

    public void Dispose()
    {
        try { Directory.Delete(_baseDir, recursive: true); } catch { /* best effort */ }
    }

    [Fact]
    public void AdminTargetEndpoints_HaveExactRoutesPoliciesAndPayloadLimits()
    {
        AssertGet(
            nameof(UserSettingsController.GetAdminTargetUserSettings),
            "admin/user-settings/{targetUserId}/settings.json");
        AssertGet(
            nameof(UserSettingsController.GetAdminTargetUserShortcuts),
            "admin/user-settings/{targetUserId}/shortcuts.json");
        AssertGet(
            nameof(UserSettingsController.GetAdminTargetUserFileEvidence),
            "admin/user-settings/{targetUserId}/{fileName}/evidence");
        AssertPost(
            nameof(UserSettingsController.SaveAdminTargetUserSettings),
            "admin/user-settings/{targetUserId}/settings.json");
        AssertPost(
            nameof(UserSettingsController.SaveAdminTargetUserShortcuts),
            "admin/user-settings/{targetUserId}/shortcuts.json");
    }

    [Fact]
    public void AdminReads_ReturnCanonicalServerResolvedTargetAndStrongEvidence()
    {
        _manager.SaveUserConfiguration(TargetId, "settings.json", new UserSettings
        {
            Revision = 5,
            WatchProgressMode = "time",
            IsAdmin = true
        });
        _manager.SaveUserConfiguration(TargetId, "shortcuts.json", new UserShortcuts
        {
            Revision = 2,
            Shortcuts = new List<Shortcut>
            {
                new() { Name = "Open", Key = "O", Label = "Open", Category = "Global" }
            }
        });

        var settingsController = Controller();
        var settings = AssertResponse<UserSettings>(
            settingsController.GetAdminTargetUserSettings(_target.Id.ToString("D")));
        Assert.Equal(TargetId, settings.TargetUserId);
        Assert.Equal(_target.Username, settings.TargetDisplayName);
        Assert.Equal(5, settings.Revision);
        Assert.Equal("time", settings.Data!.WatchProgressMode);
        Assert.False(settings.Data.IsAdmin);
        Assert.Equal("\"5\"", settingsController.Response.Headers.ETag.ToString());
        Assert.Equal(
            settings.ContentHash,
            settingsController.Response.Headers["X-JC-Content-Hash"].ToString());

        var shortcutsController = Controller();
        var shortcuts = AssertResponse<UserShortcuts>(
            shortcutsController.GetAdminTargetUserShortcuts(_target.Id.ToString("D").ToUpperInvariant()));
        Assert.Equal(TargetId, shortcuts.TargetUserId);
        Assert.Equal(_target.Username, shortcuts.TargetDisplayName);
        Assert.Equal(2, shortcuts.Revision);
        Assert.Single(shortcuts.Data!.Shortcuts);
        Assert.Equal("\"2\"", shortcutsController.Response.Headers.ETag.ToString());

        var evidenceController = Controller();
        var evidence = AssertResponse<UserSettings>(
            evidenceController.GetAdminTargetUserFileEvidence(TargetId, "settings.json"));
        Assert.Equal(TargetId, evidence.TargetUserId);
        Assert.Equal(_target.Username, evidence.TargetDisplayName);
        Assert.Equal(settings.ContentHash, evidence.ContentHash);

        _target.SetPermission(PermissionKind.IsAdministrator, true);
        var elevatedTarget = AssertResponse<UserSettings>(
            Controller().GetAdminTargetUserSettings(TargetId));
        Assert.True(elevatedTarget.Data!.IsAdmin);
    }

    [Fact]
    public void AdminWrites_CommitOnlyTargetAndPreserveRevisionConflictAndExtensions()
    {
        _manager.SaveUserConfiguration(ActorId, "settings.json", new UserSettings
        {
            Revision = 11,
            WatchProgressMode = "actor-mode"
        });
        _manager.SaveUserConfiguration(TargetId, "settings.json", new UserSettings
        {
            Revision = 3,
            WatchProgressMode = "percentage"
        });
        _manager.SaveUserConfiguration(TargetId, "shortcuts.json", new UserShortcuts
        {
            Revision = 7
        });

        using var extensionDocument = JsonDocument.Parse("""{"nested":["kept",2]}""");
        var candidate = new UserSettings
        {
            Revision = 3,
            WatchProgressMode = "time",
            IsAdmin = true
        };
        candidate.ExtensionData["FutureSetting"] = extensionDocument.RootElement.Clone();

        var saveController = Controller(ifMatch: 3);
        var committed = AssertResponse<UserSettings>(
            saveController.SaveAdminTargetUserSettings(_target.Id.ToString("D"), candidate));
        Assert.Equal(4, committed.Revision);
        Assert.Equal(TargetId, committed.TargetUserId);
        Assert.Equal(_target.Username, committed.TargetDisplayName);
        Assert.Equal("time", committed.Data!.WatchProgressMode);
        Assert.False(committed.Data.IsAdmin);
        Assert.Equal("\"4\"", saveController.Response.Headers.ETag.ToString());

        var targetStored = _manager.GetUserConfigurationStrict<UserSettings>(
            TargetId,
            "settings.json");
        Assert.Equal(4, targetStored.Revision);
        Assert.Equal("time", targetStored.WatchProgressMode);
        Assert.Equal(
            "kept",
            targetStored.ExtensionData["FutureSetting"].GetProperty("nested")[0].GetString());
        var actorStored = _manager.GetUserConfigurationStrict<UserSettings>(
            ActorId,
            "settings.json");
        Assert.Equal(11, actorStored.Revision);
        Assert.Equal("actor-mode", actorStored.WatchProgressMode);

        var staleController = Controller(ifMatch: 3);
        var staleResult = staleController.SaveAdminTargetUserSettings(TargetId, new UserSettings
        {
            Revision = 3,
            WatchProgressMode = "stale"
        });
        var conflict = Assert.IsType<ConflictObjectResult>(staleResult);
        var conflictState = Assert.IsType<
            UserSettingsController.UserFileMutationResponse<UserSettings>>(conflict.Value);
        Assert.True(conflictState.Conflict);
        Assert.Equal(4, conflictState.Revision);
        Assert.Equal("time", conflictState.Data!.WatchProgressMode);
        Assert.Equal(TargetId, conflictState.TargetUserId);
        Assert.Equal("\"4\"", staleController.Response.Headers.ETag.ToString());

        var missingController = Controller();
        var missing = Assert.IsType<ObjectResult>(
            missingController.SaveAdminTargetUserSettings(TargetId, new UserSettings
            {
                Revision = 4,
                WatchProgressMode = "missing"
            }));
        Assert.Equal(StatusCodes.Status428PreconditionRequired, missing.StatusCode);

        var weakController = Controller(rawIfMatch: "W/\"4\"");
        var weak = Assert.IsType<ObjectResult>(
            weakController.SaveAdminTargetUserSettings(TargetId, new UserSettings
            {
                Revision = 4,
                WatchProgressMode = "weak"
            }));
        Assert.Equal(StatusCodes.Status428PreconditionRequired, weak.StatusCode);
        Assert.Equal(
            "time",
            _manager.GetUserConfigurationStrict<UserSettings>(
                TargetId,
                "settings.json").WatchProgressMode);

        var shortcutController = Controller(ifMatch: 7);
        using var shortcutExtensionDocument = JsonDocument.Parse("""{"preserved":true}""");
        using var shortcutEntryExtensionDocument = JsonDocument.Parse(
            """{"futureEntry":["kept",3]}""");
        var shortcutEntry = new Shortcut
        {
            Name = "Pause",
            Key = string.Empty,
            Label = "Pause",
            Category = "Playback"
        };
        shortcutEntry.ExtensionData["FutureShortcutEntry"] =
            shortcutEntryExtensionDocument.RootElement.Clone();
        var shortcutCandidate = new UserShortcuts
        {
            Revision = 7,
            Shortcuts = new List<Shortcut> { shortcutEntry }
        };
        shortcutCandidate.ExtensionData["FutureShortcutSetting"] =
            shortcutExtensionDocument.RootElement.Clone();
        var shortcutCommit = AssertResponse<UserShortcuts>(
            shortcutController.SaveAdminTargetUserShortcuts(TargetId, shortcutCandidate));
        Assert.Equal(8, shortcutCommit.Revision);
        Assert.Equal(TargetId, shortcutCommit.TargetUserId);
        var storedShortcuts = _manager.GetUserConfigurationStrict<UserShortcuts>(
            TargetId,
            "shortcuts.json");
        Assert.Single(storedShortcuts.Shortcuts);
        Assert.Equal(string.Empty, Assert.Single(storedShortcuts.Shortcuts).Key);
        Assert.True(
            storedShortcuts.ExtensionData["FutureShortcutSetting"]
                .GetProperty("preserved")
                .GetBoolean());
        Assert.Equal(
            "kept",
            Assert.Single(storedShortcuts.Shortcuts)
                .ExtensionData["FutureShortcutEntry"]
                .GetProperty("futureEntry")[0]
                .GetString());

        var roundTrip = AssertResponse<UserShortcuts>(
            Controller().GetAdminTargetUserShortcuts(TargetId));
        Assert.Equal(string.Empty, Assert.Single(roundTrip.Data!.Shortcuts).Key);
        Assert.Equal(
            3,
            Assert.Single(roundTrip.Data!.Shortcuts)
                .ExtensionData["FutureShortcutEntry"]
                .GetProperty("futureEntry")[1]
                .GetInt32());
    }

    [Fact]
    public void AdminWrites_PreserveExactOpaqueNumbersFromBrowserLossyEchoes()
    {
        const string exactNumbers = """{"big":9007199254740993,"huge":1e400}""";
        using var exactDocument = JsonDocument.Parse(exactNumbers);
        using var lossyDocument = JsonDocument.Parse(
            """{"big":9007199254740992,"huge":null}""");
        using var markerDocument = JsonDocument.Parse("""{"marker":"kept"}""");
        _manager.SaveUserConfiguration(TargetId, "settings.json", new UserSettings
        {
            Revision = 1,
            WatchProgressMode = "percentage",
            ExtensionData = new Dictionary<string, JsonElement>
            {
                ["zOpaque"] = exactDocument.RootElement.Clone(),
                ["aOpaque"] = markerDocument.RootElement.Clone()
            }
        });

        var settingsCandidate = new UserSettings
        {
            Revision = 1,
            WatchProgressMode = "time",
            ExtensionData = new Dictionary<string, JsonElement>
            {
                ["zOpaque"] = lossyDocument.RootElement.Clone(),
                ["aOpaque"] = markerDocument.RootElement.Clone()
            }
        };
        var settingsResult = AssertResponse<UserSettings>(
            Controller(ifMatch: 1).SaveAdminTargetUserSettings(
                TargetId,
                settingsCandidate));
        Assert.Equal(2, settingsResult.Revision);
        var storedSettings = _manager.GetUserConfigurationStrict<UserSettings>(
            TargetId,
            "settings.json");
        Assert.Equal(exactNumbers, storedSettings.ExtensionData["zOpaque"].GetRawText());

        // A lossy echo with no schema-owned edit is an exact no-op: it must not
        // rewrite the file or advance its CAS revision.
        var noOpResult = AssertResponse<UserSettings>(
            Controller(ifMatch: 2).SaveAdminTargetUserSettings(
                TargetId,
                new UserSettings
                {
                    Revision = 2,
                    WatchProgressMode = "time",
                    ExtensionData = new Dictionary<string, JsonElement>
                    {
                        ["zOpaque"] = lossyDocument.RootElement.Clone(),
                        ["aOpaque"] = markerDocument.RootElement.Clone()
                    }
                }));
        Assert.Equal(2, noOpResult.Revision);
        storedSettings = _manager.GetUserConfigurationStrict<UserSettings>(
            TargetId,
            "settings.json");
        Assert.Equal(2, storedSettings.Revision);
        Assert.Equal(exactNumbers, storedSettings.ExtensionData["zOpaque"].GetRawText());

        _manager.SaveUserConfiguration(TargetId, "shortcuts.json", new UserShortcuts
        {
            Revision = 4,
            ExtensionData = new Dictionary<string, JsonElement>
            {
                ["zOpaque"] = exactDocument.RootElement.Clone(),
                ["aOpaque"] = markerDocument.RootElement.Clone()
            },
            Shortcuts = new List<Shortcut>
            {
                new()
                {
                    Name = "Pause",
                    Key = "Space",
                    ExtensionData = new Dictionary<string, JsonElement>
                    {
                        ["zOpaque"] = exactDocument.RootElement.Clone(),
                        ["aOpaque"] = markerDocument.RootElement.Clone()
                    }
                }
            }
        });
        var shortcutResult = AssertResponse<UserShortcuts>(
            Controller(ifMatch: 4).SaveAdminTargetUserShortcuts(
                TargetId,
                new UserShortcuts
                {
                    Revision = 4,
                    ExtensionData = new Dictionary<string, JsonElement>
                    {
                        ["zOpaque"] = lossyDocument.RootElement.Clone(),
                        ["aOpaque"] = markerDocument.RootElement.Clone()
                    },
                    Shortcuts = new List<Shortcut>
                    {
                        new()
                        {
                            Name = "Pause",
                            Key = "P",
                            ExtensionData = new Dictionary<string, JsonElement>
                            {
                                ["zOpaque"] = lossyDocument.RootElement.Clone(),
                                ["aOpaque"] = markerDocument.RootElement.Clone()
                            }
                        }
                    }
                }));
        Assert.Equal(5, shortcutResult.Revision);
        var storedShortcuts = _manager.GetUserConfigurationStrict<UserShortcuts>(
            TargetId,
            "shortcuts.json");
        Assert.Equal(
            exactNumbers,
            storedShortcuts.ExtensionData["zOpaque"].GetRawText());
        Assert.Equal(
            exactNumbers,
            Assert.Single(storedShortcuts.Shortcuts)
                .ExtensionData["zOpaque"]
                .GetRawText());
        var shortcutNoOp = AssertResponse<UserShortcuts>(
            Controller(ifMatch: 5).SaveAdminTargetUserShortcuts(
                TargetId,
                new UserShortcuts
                {
                    Revision = 5,
                    ExtensionData = new Dictionary<string, JsonElement>
                    {
                        ["zOpaque"] = lossyDocument.RootElement.Clone(),
                        ["aOpaque"] = markerDocument.RootElement.Clone()
                    },
                    Shortcuts = new List<Shortcut>
                    {
                        new()
                        {
                            Name = "Pause",
                            Key = "P",
                            ExtensionData = new Dictionary<string, JsonElement>
                            {
                                ["zOpaque"] = lossyDocument.RootElement.Clone(),
                                ["aOpaque"] = markerDocument.RootElement.Clone()
                            }
                        }
                    }
                }));
        Assert.Equal(5, shortcutNoOp.Revision);
        storedShortcuts = _manager.GetUserConfigurationStrict<UserShortcuts>(
            TargetId,
            "shortcuts.json");
        Assert.Equal(5, storedShortcuts.Revision);
        Assert.Equal(
            exactNumbers,
            Assert.Single(storedShortcuts.Shortcuts)
                .ExtensionData["zOpaque"]
                .GetRawText());

        _manager.SaveUserConfiguration(TargetId, "shortcuts.json", new UserShortcuts
        {
            Revision = 8,
            Shortcuts = new List<Shortcut>
            {
                new()
                {
                    Name = "Duplicate",
                    Key = "X",
                    ExtensionData = new Dictionary<string, JsonElement>
                    {
                        ["Opaque"] = markerDocument.RootElement.Clone()
                    }
                },
                new()
                {
                    Name = "Duplicate",
                    Key = "Y",
                    ExtensionData = new Dictionary<string, JsonElement>
                    {
                        ["Opaque"] = exactDocument.RootElement.Clone()
                    }
                }
            }
        });
        var shiftedDuplicate = AssertResponse<UserShortcuts>(
            Controller(ifMatch: 8).SaveAdminTargetUserShortcuts(
                TargetId,
                new UserShortcuts
                {
                    Revision = 8,
                    Shortcuts = new List<Shortcut>
                    {
                        new()
                        {
                            Name = "Duplicate",
                            Key = "Y",
                            ExtensionData = new Dictionary<string, JsonElement>
                            {
                                ["Opaque"] = lossyDocument.RootElement.Clone()
                            }
                        }
                    }
                }));
        Assert.Equal(9, shiftedDuplicate.Revision);
        Assert.Equal(
            exactNumbers,
            Assert.Single(
                    _manager.GetUserConfigurationStrict<UserShortcuts>(
                        TargetId,
                        "shortcuts.json").Shortcuts)
                .ExtensionData["Opaque"]
                .GetRawText());

        using var integerDocument = JsonDocument.Parse("1");
        using var decimalDocument = JsonDocument.Parse("1.0");
        _manager.SaveUserConfiguration(TargetId, "shortcuts.json", new UserShortcuts
        {
            Revision = 10,
            Shortcuts = new List<Shortcut>
            {
                new()
                {
                    Name = "Indistinguishable",
                    Key = "I",
                    ExtensionData = new Dictionary<string, JsonElement>
                    {
                        ["Opaque"] = integerDocument.RootElement.Clone()
                    }
                },
                new()
                {
                    Name = "Indistinguishable",
                    Key = "I",
                    ExtensionData = new Dictionary<string, JsonElement>
                    {
                        ["Opaque"] = decimalDocument.RootElement.Clone()
                    }
                }
            }
        });
        Assert.IsType<BadRequestObjectResult>(
            Controller(ifMatch: 10).SaveAdminTargetUserShortcuts(
                TargetId,
                new UserShortcuts
                {
                    Revision = 10,
                    Shortcuts = new List<Shortcut>
                    {
                        new()
                        {
                            Name = "Indistinguishable",
                            Key = "I",
                            ExtensionData = new Dictionary<string, JsonElement>
                            {
                                ["Opaque"] = integerDocument.RootElement.Clone()
                            }
                        }
                    }
                }));
        var ambiguousStored = _manager.GetUserConfigurationStrict<UserShortcuts>(
            TargetId,
            "shortcuts.json");
        Assert.Equal(10, ambiguousStored.Revision);
        Assert.Equal(2, ambiguousStored.Shortcuts.Count);
        Assert.Equal(
            "1.0",
            ambiguousStored.Shortcuts[1]
                .ExtensionData["Opaque"]
                .GetRawText());
    }

    [Fact]
    public void AdminWriteSuccessLogsActorTargetFileAndRevisionWithoutContentOrHash()
    {
        const string secretMode = "SECRET-PREFERENCE-CONTENT";
        const string secretShortcut = "SECRET-SHORTCUT-CONTENT";
        const string legacySecret = "SECRET-LEGACY-ROUTE-CONTENT";
        _manager.SaveUserConfiguration(TargetId, "settings.json", new UserSettings
        {
            Revision = 1,
            WatchProgressMode = "percentage"
        });
        _manager.SaveUserConfiguration(TargetId, "shortcuts.json", new UserShortcuts
        {
            Revision = 2
        });
        var logger = new CollectingLogger<UserSettingsController>();

        var settings = AssertResponse<UserSettings>(
            Controller(ifMatch: 1, logger: logger).SaveAdminTargetUserSettings(
                TargetId,
                new UserSettings
                {
                    Revision = 1,
                    WatchProgressMode = secretMode
                }));
        var shortcuts = AssertResponse<UserShortcuts>(
            Controller(ifMatch: 2, logger: logger).SaveAdminTargetUserShortcuts(
                TargetId,
                new UserShortcuts
                {
                    Revision = 2,
                    Shortcuts = new List<Shortcut>
                    {
                        new()
                        {
                            Name = secretShortcut,
                            Key = "K",
                            Label = "Secret",
                            Category = "Global"
                        }
                    }
                }));
        var legacyCrossUser = AssertResponse<UserSettings>(
            Controller(ifMatch: 2, logger: logger).SaveUserSettingsSettings(
                TargetId,
                new UserSettings
                {
                    Revision = 2,
                    WatchProgressMode = legacySecret
                }));
        var newlyInitializedTarget = new User(
            "New target",
            "Provider",
            "PasswordProvider");
        _userManager.AddUser(newlyInitializedTarget);
        AssertResponse<UserSettings>(
            Controller(logger: logger).GetAdminTargetUserSettings(
                newlyInitializedTarget.Id.ToString("N")));

        var log = string.Join('\n', logger.Messages);
        Assert.Contains(
            $"Admin {_actor.Username} ({ActorId}) saved settings.json for target " +
            $"{_target.Username} ({TargetId}) at revision 2.",
            log);
        Assert.Contains(
            $"Admin {_actor.Username} ({ActorId}) saved shortcuts.json for target " +
            $"{_target.Username} ({TargetId}) at revision 3.",
            log);
        Assert.Contains(
            $"Admin {_actor.Username} ({ActorId}) saved settings.json for target " +
            $"{_target.Username} ({TargetId}) at revision 3.",
            log);
        Assert.Contains(
            $"Admin {_actor.Username} ({ActorId}) created default settings.json for target " +
            $"{newlyInitializedTarget.Username} ({newlyInitializedTarget.Id:N}) at revision 0.",
            log);
        Assert.DoesNotContain(secretMode, log, StringComparison.Ordinal);
        Assert.DoesNotContain(secretShortcut, log, StringComparison.Ordinal);
        Assert.DoesNotContain(legacySecret, log, StringComparison.Ordinal);
        Assert.DoesNotContain(settings.ContentHash, log, StringComparison.Ordinal);
        Assert.DoesNotContain(shortcuts.ContentHash, log, StringComparison.Ordinal);
        Assert.DoesNotContain(legacyCrossUser.ContentHash, log, StringComparison.Ordinal);
    }

    [Fact]
    public void ElevatedRoleWithoutCanonicalActorCannotWriteLegacyCrossUserRoute()
    {
        _manager.SaveUserConfiguration(TargetId, "settings.json", new UserSettings
        {
            Revision = 3,
            WatchProgressMode = "before"
        });

        var result = Controller(
            ifMatch: 3,
            includeActorIdClaim: false).SaveUserSettingsSettings(
                TargetId,
                new UserSettings
                {
                    Revision = 3,
                    WatchProgressMode = "must-not-write"
                });

        Assert.IsType<ForbidResult>(result);
        var stored = _manager.GetUserConfigurationStrict<UserSettings>(
            TargetId,
            "settings.json");
        Assert.Equal(3, stored.Revision);
        Assert.Equal("before", stored.WatchProgressMode);
    }

    [Theory]
    [InlineData("\"04\"")]
    [InlineData("\"+4\"")]
    [InlineData("\" 4\"")]
    [InlineData("\"4\",\"5\"")]
    public void AdminWrites_RejectNonCanonicalStrongRevisionTags(string ifMatch)
    {
        _manager.SaveUserConfiguration(TargetId, "settings.json", new UserSettings
        {
            Revision = 4,
            WatchProgressMode = "time"
        });

        var result = Controller(rawIfMatch: ifMatch).SaveAdminTargetUserSettings(
            TargetId,
            new UserSettings
            {
                Revision = 4,
                WatchProgressMode = "percentage"
            });

        Assert.Equal(
            StatusCodes.Status428PreconditionRequired,
            Assert.IsType<ObjectResult>(result).StatusCode);
        var stored = _manager.GetUserConfigurationStrict<UserSettings>(
            TargetId,
            "settings.json");
        Assert.Equal(4, stored.Revision);
        Assert.Equal("time", stored.WatchProgressMode);
    }

    [Fact]
    public void OversizedAdminTargetPayload_Returns413WithoutMutatingEitherUser()
    {
        _manager.SaveUserConfiguration(ActorId, "shortcuts.json", new UserShortcuts
        {
            Revision = 8,
            Shortcuts = new List<Shortcut>
            {
                new() { Name = "Actor", Key = "A" }
            }
        });
        _manager.SaveUserConfiguration(TargetId, "shortcuts.json", new UserShortcuts
        {
            Revision = 3,
            Shortcuts = new List<Shortcut>
            {
                new() { Name = "Target", Key = "T" }
            }
        });
        var maximumString = new string('x', PersistedPayloadPolicy.MaximumStandardStringLength);
        var oversized = new UserShortcuts
        {
            Revision = 3,
            Shortcuts = Enumerable.Range(0, PersistedPayloadPolicy.MaximumShortcuts)
                .Select(index => new Shortcut
                {
                    Name = maximumString,
                    Key = maximumString,
                    Label = maximumString,
                    Category = index.ToString()
                })
                .ToList()
        };

        var result = Controller(ifMatch: 3).SaveAdminTargetUserShortcuts(
            TargetId,
            oversized);

        Assert.Equal(
            StatusCodes.Status413PayloadTooLarge,
            Assert.IsType<ObjectResult>(result).StatusCode);
        var actor = _manager.GetUserConfigurationStrict<UserShortcuts>(
            ActorId,
            "shortcuts.json");
        var target = _manager.GetUserConfigurationStrict<UserShortcuts>(
            TargetId,
            "shortcuts.json");
        Assert.Equal(8, actor.Revision);
        Assert.Equal("Actor", Assert.Single(actor.Shortcuts).Name);
        Assert.Equal(3, target.Revision);
        Assert.Equal("Target", Assert.Single(target.Shortcuts).Name);
    }

    [Fact]
    public void MalformedAndUnknownTargets_Return400Or404WithoutCreatingAStore()
    {
        var malformed = Controller().GetAdminTargetUserSettings("not-a-guid");
        Assert.IsType<BadRequestObjectResult>(malformed);

        var empty = Controller().GetAdminTargetUserShortcuts(Guid.Empty.ToString("N"));
        Assert.IsType<BadRequestObjectResult>(empty);

        var unknown = Guid.NewGuid();
        Assert.IsType<NotFoundObjectResult>(
            Controller().GetAdminTargetUserSettings(unknown.ToString("D")));
        Assert.IsType<NotFoundObjectResult>(
            Controller(ifMatch: 0).SaveAdminTargetUserShortcuts(
                unknown.ToString("N"),
                new UserShortcuts { Revision = 0 }));
        Assert.IsType<NotFoundObjectResult>(
            Controller().GetAdminTargetUserFileEvidence(
                unknown.ToString("N"),
                "settings.json"));

        Assert.False(Directory.Exists(UserDirectory(unknown)));
        Assert.False(Directory.Exists(UserDirectory(Guid.Empty)));
    }

    [Fact]
    public void LegacyCrossUserRoutes_RejectUnknownAndEmptyTargetsBeforeAnyFileAccess()
    {
        var unknown = Guid.NewGuid();
        var unknownId = unknown.ToString("N");

        Assert.IsType<NotFoundObjectResult>(
            Controller().GetUserSettingsSettings(unknownId));
        Assert.IsType<NotFoundObjectResult>(
            Controller().GetUserSettingsShortcuts(unknownId));
        Assert.IsType<NotFoundObjectResult>(
            Controller().GetUserFileEvidence(unknownId, "settings.json"));
        Assert.IsType<NotFoundObjectResult>(
            Controller().GetUserFileEvidence(unknownId, "shortcuts.json"));
        Assert.IsType<NotFoundObjectResult>(
            Controller(ifMatch: 0).SaveUserSettingsSettings(
                unknownId,
                new UserSettings { Revision = 0 }));
        Assert.IsType<NotFoundObjectResult>(
            Controller(ifMatch: 0).SaveUserSettingsShortcuts(
                unknownId,
                new UserShortcuts { Revision = 0 }));

        var emptyId = Guid.Empty.ToString("N");
        Assert.IsType<BadRequestObjectResult>(
            Controller().GetUserSettingsSettings(emptyId));
        Assert.IsType<BadRequestObjectResult>(
            Controller(ifMatch: 0).SaveUserSettingsShortcuts(
                emptyId,
                new UserShortcuts { Revision = 0 }));
        Assert.False(Directory.Exists(UserDirectory(unknown)));
        Assert.False(Directory.Exists(UserDirectory(Guid.Empty)));
    }

    [Fact]
    public void LegacyCrossUserRoutes_Return503WhenTargetDirectoryLookupThrows()
    {
        var unknown = Guid.NewGuid();
        var unknownId = unknown.ToString("N");
        _userManager.GetUserByIdHook = id =>
            id == unknown
                ? throw new IOException("User directory unavailable.")
                : (id == _actor.Id
                    ? _actor
                    : (id == _target.Id ? _target : null));

        var results = new IActionResult[]
        {
            Controller().GetUserSettingsSettings(unknownId),
            Controller().GetUserSettingsShortcuts(unknownId),
            Controller().GetUserFileEvidence(unknownId, "settings.json"),
            Controller().GetUserFileEvidence(unknownId, "shortcuts.json"),
            Controller(ifMatch: 0).SaveUserSettingsSettings(
                unknownId,
                new UserSettings { Revision = 0 }),
            Controller(ifMatch: 0).SaveUserSettingsShortcuts(
                unknownId,
                new UserShortcuts { Revision = 0 })
        };

        Assert.All(
            results,
            result => Assert.Equal(
                StatusCodes.Status503ServiceUnavailable,
                Assert.IsType<ObjectResult>(result).StatusCode));
        Assert.False(Directory.Exists(UserDirectory(unknown)));
    }

    [Fact]
    public void CorruptTargetStore_FailsClosedAndAdminWriteUsesNormalQuarantine()
    {
        _manager.SaveUserConfiguration(ActorId, "settings.json", new UserSettings
        {
            Revision = 9,
            WatchProgressMode = "actor-mode"
        });
        _manager.SaveUserConfiguration(TargetId, "settings.json", new UserSettings());
        var targetPath = UserFile(_target.Id, "settings.json");
        File.WriteAllText(targetPath, "{{{ corrupt target settings");

        var read = Assert.IsType<ObjectResult>(
            Controller().GetAdminTargetUserSettings(TargetId));
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, read.StatusCode);
        Assert.True(File.Exists(targetPath));

        var write = Assert.IsType<ObjectResult>(
            Controller(ifMatch: 0).SaveAdminTargetUserSettings(
                TargetId,
                new UserSettings { Revision = 0, WatchProgressMode = "time" }));
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, write.StatusCode);
        Assert.False(File.Exists(targetPath));
        Assert.True(File.Exists(targetPath + ".unhealthy"));
        Assert.Single(Directory.GetFiles(
            Path.GetDirectoryName(targetPath)!,
            "settings.json.corrupt-*"));
        Assert.Equal(
            "actor-mode",
            _manager.GetUserConfigurationStrict<UserSettings>(
                ActorId,
                "settings.json").WatchProgressMode);
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

    private UserSettingsController Controller(
        long? ifMatch = null,
        string? rawIfMatch = null,
        ILogger<UserSettingsController>? logger = null,
        bool includeActorIdClaim = true)
    {
        var controller = new UserSettingsController(
            new RecordingHttpClientFactory(new HttpClientHandler()),
            logger ?? NullLogger<UserSettingsController>.Instance,
            _userManager,
            new SeerrCache(_provider),
            _provider,
            _manager,
            new CountingLibraryManager());
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                    includeActorIdClaim
                        ? new[]
                        {
                            new Claim("Jellyfin-UserId", _actor.Id.ToString()),
                            new Claim(ClaimTypes.Role, "Administrator")
                        }
                        : new[]
                        {
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

        return controller;
    }

    private sealed class CollectingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = new();

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
            => Messages.Add(formatter(state, exception));
    }

    private static UserSettingsController.UserFileMutationResponse<T> AssertResponse<T>(
        IActionResult result)
        where T : class, IRevisionedUserConfiguration, new()
    {
        var ok = Assert.IsType<OkObjectResult>(result);
        var response = Assert.IsType<
            UserSettingsController.UserFileMutationResponse<T>>(ok.Value);
        Assert.True(response.Success);
        Assert.Matches("^[0-9a-f]{64}$", response.ContentHash);
        Assert.NotNull(response.Data);
        Assert.Equal(response.Revision, response.Data!.Revision);
        return response;
    }

    private static void AssertGet(string methodName, string route)
    {
        var method = typeof(UserSettingsController).GetMethod(methodName)
            ?? throw new InvalidOperationException(methodName);
        Assert.Equal(route, method.GetCustomAttribute<HttpGetAttribute>()?.Template);
        Assert.Equal(
            Policies.RequiresElevation,
            method.GetCustomAttribute<AuthorizeAttribute>()?.Policy);
    }

    private static void AssertPost(string methodName, string route)
    {
        var method = typeof(UserSettingsController).GetMethod(methodName)
            ?? throw new InvalidOperationException(methodName);
        Assert.Equal(route, method.GetCustomAttribute<HttpPostAttribute>()?.Template);
        Assert.Equal(
            Policies.RequiresElevation,
            method.GetCustomAttribute<AuthorizeAttribute>()?.Policy);
        var limit = Assert.Single(
            method.GetCustomAttributes<PersistedPayloadLimitAttribute>());
        Assert.Equal(PersistedPayloadPolicy.StandardRequestBytes, limit.MaximumBytes);
    }
}
