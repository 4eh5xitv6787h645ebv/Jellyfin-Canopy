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
        var shortcutCandidate = new UserShortcuts
        {
            Revision = 7,
            Shortcuts = new List<Shortcut>
            {
                new() { Name = "Pause", Key = "Space", Label = "Pause", Category = "Playback" }
            }
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
        Assert.True(
            storedShortcuts.ExtensionData["FutureShortcutSetting"]
                .GetProperty("preserved")
                .GetBoolean());
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

    private UserSettingsController Controller(long? ifMatch = null, string? rawIfMatch = null)
    {
        var controller = new UserSettingsController(
            new RecordingHttpClientFactory(new HttpClientHandler()),
            NullLogger<UserSettingsController>.Instance,
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

        return controller;
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
