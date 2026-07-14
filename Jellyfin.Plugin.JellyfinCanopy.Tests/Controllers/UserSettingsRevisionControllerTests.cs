using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    public sealed class UserSettingsRevisionControllerTests : IDisposable
    {
        private readonly string _baseDir;
        private readonly UserConfigurationManager _manager;
        private readonly User _user;
        private readonly FakePluginConfigProvider _provider;

        public UserSettingsRevisionControllerTests()
        {
            _baseDir = Path.Combine(Path.GetTempPath(), "jc-user-settings-revision-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_baseDir);
            _manager = new UserConfigurationManager(new StubAppPaths(_baseDir), NullLogger<UserConfigurationManager>.Instance);
            _user = new User("settings-user", "Provider", "PasswordProvider");
            _provider = new FakePluginConfigProvider(new PluginConfiguration());
        }

        private string UserId => _user.Id.ToString("N");

        private string FilePath(string fileName) => Path.Combine(
            _baseDir,
            "configurations",
            "Jellyfin.Plugin.JellyfinCanopy",
            UserId,
            fileName);

        public void Dispose()
        {
            try { Directory.Delete(_baseDir, recursive: true); } catch { /* best effort */ }
        }

        private UserSettingsController Controller(long? ifMatch = null)
        {
            var controller = new UserSettingsController(
                new RecordingHttpClientFactory(new HttpClientHandler()),
                NullLogger<UserSettingsController>.Instance,
                new StubUserManager(_user),
                new SeerrCache(_provider),
                _provider,
                _manager,
                new CountingLibraryManager());
            controller.ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(
                        new[] { new Claim("Jellyfin-UserId", _user.Id.ToString()) },
                        "TestAuth"))
                }
            };
            if (ifMatch.HasValue) controller.Request.Headers["If-Match"] = $"\"{ifMatch.Value}\"";
            return controller;
        }

        private void SeedSettings(long revision = 0, string mode = "percentage")
            => _manager.SaveUserConfiguration(UserId, "settings.json", new UserSettings
            {
                Revision = revision,
                WatchProgressMode = mode
            });

        [Fact]
        public void SettingsSave_RequiresMatchingStrongRevision()
        {
            SeedSettings();
            var candidate = new UserSettings { Revision = 0, WatchProgressMode = "time" };

            var missing = Controller().SaveUserSettingsSettings(UserId, candidate);
            Assert.Equal(StatusCodes.Status428PreconditionRequired, Assert.IsType<ObjectResult>(missing).StatusCode);

            var weak = Controller();
            weak.Request.Headers["If-Match"] = "W/\"0\"";
            var weakResult = weak.SaveUserSettingsSettings(UserId, candidate);
            Assert.Equal(StatusCodes.Status428PreconditionRequired, Assert.IsType<ObjectResult>(weakResult).StatusCode);

            var mismatch = Controller(0).SaveUserSettingsSettings(
                UserId,
                new UserSettings { Revision = 1, WatchProgressMode = "time" });
            Assert.IsType<BadRequestObjectResult>(mismatch);
            Assert.Equal("percentage", _manager.GetUserConfigurationStrict<UserSettings>(UserId, "settings.json").WatchProgressMode);
        }

        [Fact]
        public void StaleSettingsSave_ReturnsAuthoritativeStateAndDoesNotClobber()
        {
            SeedSettings();
            var first = Controller(0).SaveUserSettingsSettings(
                UserId,
                new UserSettings { Revision = 0, WatchProgressMode = "time" });
            var firstOk = Assert.IsType<OkObjectResult>(first);
            var firstAck = Assert.IsType<UserSettingsController.UserFileMutationResponse<UserSettings>>(firstOk.Value);
            Assert.True(firstAck.Success);
            Assert.Equal(1, firstAck.Revision);
            Assert.Equal("time", firstAck.Data!.WatchProgressMode);
            Assert.Matches("^[0-9a-f]{64}$", firstAck.ContentHash);

            var staleController = Controller(0);
            var stale = staleController.SaveUserSettingsSettings(
                UserId,
                new UserSettings { Revision = 0, WatchProgressMode = "percentage" });
            var conflict = Assert.IsType<ConflictObjectResult>(stale);
            var conflictAck = Assert.IsType<UserSettingsController.UserFileMutationResponse<UserSettings>>(conflict.Value);
            Assert.True(conflictAck.Conflict);
            Assert.Equal(1, conflictAck.Revision);
            Assert.Equal("time", conflictAck.Data!.WatchProgressMode);
            Assert.Equal("\"1\"", staleController.Response.Headers.ETag.ToString());
            Assert.Equal("time", _manager.GetUserConfigurationStrict<UserSettings>(UserId, "settings.json").WatchProgressMode);
        }

        [Fact]
        public void ExactNoOp_IsAcknowledgedWithoutAdvancingRevision()
        {
            SeedSettings(revision: 7, mode: "time");
            var result = Controller(7).SaveUserSettingsSettings(
                UserId,
                new UserSettings { Revision = 7, WatchProgressMode = "time" });

            var ok = Assert.IsType<OkObjectResult>(result);
            var ack = Assert.IsType<UserSettingsController.UserFileMutationResponse<UserSettings>>(ok.Value);
            Assert.Equal(7, ack.Revision);
            Assert.Equal(7, _manager.GetUserConfigurationStrict<UserSettings>(UserId, "settings.json").Revision);
        }

        [Fact]
        public void AdminProjection_IsServerOwnedAndCannotBeSpoofedBySettingsPayload()
        {
            SeedSettings();
            var result = Controller(0).SaveUserSettingsSettings(
                UserId,
                new UserSettings { Revision = 0, WatchProgressMode = "time", IsAdmin = true });

            var ack = Assert.IsType<UserSettingsController.UserFileMutationResponse<UserSettings>>(
                Assert.IsType<OkObjectResult>(result).Value);
            Assert.False(ack.Data!.IsAdmin);
            Assert.False(_manager.GetUserConfigurationStrict<UserSettings>(UserId, "settings.json").IsAdmin);

            var read = Assert.IsType<UserSettings>(
                Assert.IsType<OkObjectResult>(Controller().GetUserSettingsSettings(UserId)).Value);
            Assert.False(read.IsAdmin);
        }

        [Fact]
        public void InvalidRangesAndOversizedStrings_AreRejectedWithoutAdvancingState()
        {
            SeedSettings(revision: 4);

            var invalidRange = Controller(4).SaveUserSettingsSettings(
                UserId,
                new UserSettings { Revision = 4, PauseScreenDelaySeconds = 0 });
            Assert.IsType<BadRequestObjectResult>(invalidRange);

            var oversizedShortcut = Controller(0).SaveUserSettingsShortcuts(
                UserId,
                new UserShortcuts
                {
                    Revision = 0,
                    Shortcuts = new List<Shortcut>
                    {
                        new Shortcut { Name = new string('x', 513), Key = "X" }
                    }
                });
            Assert.IsType<BadRequestObjectResult>(oversizedShortcut);

            var stored = _manager.GetUserConfigurationStrict<UserSettings>(UserId, "settings.json");
            Assert.Equal(4, stored.Revision);
            Assert.Equal("percentage", stored.WatchProgressMode);
        }

        [Fact]
        public void InvalidPluginDefaults_AreNeverSeededOrResetIntoUserFiles()
        {
            _provider.Current = new PluginConfiguration { PauseScreenDelaySeconds = 0 };

            var seed = Controller().GetUserSettingsSettings(UserId);
            Assert.Equal(StatusCodes.Status503ServiceUnavailable, Assert.IsType<ObjectResult>(seed).StatusCode);
            Assert.False(File.Exists(FilePath("settings.json")));

            SeedSettings(revision: 6, mode: "time");
            var reset = Controller().ResetAllUsersSettings();
            Assert.IsType<BadRequestObjectResult>(reset);
            var stored = _manager.GetUserConfigurationStrict<UserSettings>(UserId, "settings.json");
            Assert.Equal(6, stored.Revision);
            Assert.Equal("time", stored.WatchProgressMode);
        }

        [Fact]
        public void ShortcutsAndElsewhere_UseTheSameConditionalContract()
        {
            _manager.SaveUserConfiguration(UserId, "shortcuts.json", new UserShortcuts { Revision = 2 });
            _manager.SaveUserConfiguration(UserId, "elsewhere.json", new ElsewhereSettings { Revision = 4, Region = "AU" });

            var shortcuts = Controller(2).SaveUserSettingsShortcuts(UserId, new UserShortcuts
            {
                Revision = 2,
                Shortcuts = new List<Shortcut> { new Shortcut { Name = "Open", Key = "O" } }
            });
            var shortcutsAck = Assert.IsType<UserSettingsController.UserFileMutationResponse<UserShortcuts>>(
                Assert.IsType<OkObjectResult>(shortcuts).Value);
            Assert.Equal(3, shortcutsAck.Revision);

            var elsewhere = Controller(4).SaveUserSettingsElsewhere(UserId, new ElsewhereSettings
            {
                Revision = 4,
                Region = "NZ"
            });
            var elsewhereAck = Assert.IsType<UserSettingsController.UserFileMutationResponse<ElsewhereSettings>>(
                Assert.IsType<OkObjectResult>(elsewhere).Value);
            Assert.Equal(5, elsewhereAck.Revision);
            Assert.Equal("NZ", elsewhereAck.Data!.Region);
        }

        [Fact]
        public void EvidenceRead_ReturnsExactRevisionHashAndState()
        {
            SeedSettings(revision: 3, mode: "time");
            var controller = Controller();
            var result = controller.GetUserFileEvidence(UserId, "settings.json");

            var ok = Assert.IsType<OkObjectResult>(result);
            var evidence = Assert.IsType<UserSettingsController.UserFileMutationResponse<UserSettings>>(ok.Value);
            Assert.True(evidence.Success);
            Assert.Equal(3, evidence.Revision);
            Assert.Equal("time", evidence.Data!.WatchProgressMode);
            Assert.Equal(evidence.ContentHash, controller.Response.Headers["X-JC-Content-Hash"].ToString());
            Assert.Equal("\"3\"", controller.Response.Headers.ETag.ToString());
        }

        [Fact]
        public void CorruptStore_FailsReadAndWriteWithoutReplacingRawBytes()
        {
            SeedSettings();
            File.WriteAllText(FilePath("settings.json"), "{ malformed settings");
            var raw = File.ReadAllText(FilePath("settings.json"));

            var get = Controller().GetUserSettingsSettings(UserId);
            Assert.Equal(StatusCodes.Status503ServiceUnavailable, Assert.IsType<ObjectResult>(get).StatusCode);

            var save = Controller(0).SaveUserSettingsSettings(
                UserId,
                new UserSettings { Revision = 0, WatchProgressMode = "time" });
            Assert.Equal(StatusCodes.Status503ServiceUnavailable, Assert.IsType<ObjectResult>(save).StatusCode);
            Assert.Equal(raw, File.ReadAllText(FilePath("settings.json")));
        }

        [Fact]
        public void UnknownSettingsFields_RoundTripThroughAcknowledgedCommit()
        {
            SeedSettings();
            using var doc = JsonDocument.Parse("\"kept\"");
            var candidate = new UserSettings { Revision = 0, WatchProgressMode = "time" };
            candidate.ExtensionData["FutureSetting"] = doc.RootElement.Clone();

            var save = Controller(0).SaveUserSettingsSettings(UserId, candidate);
            Assert.IsType<OkObjectResult>(save);

            var stored = _manager.GetUserConfigurationStrict<UserSettings>(UserId, "settings.json");
            Assert.Equal("kept", stored.ExtensionData["FutureSetting"].GetString());
        }

        [Fact]
        public void AdminReset_IncrementsRevisionSoStaleClientsConflict()
        {
            SeedSettings(revision: 8, mode: "time");
            var reset = Controller().ResetAllUsersSettings();
            Assert.IsType<OkObjectResult>(reset);
            Assert.Equal(9, _manager.GetUserConfigurationStrict<UserSettings>(UserId, "settings.json").Revision);

            var stale = Controller(8).SaveUserSettingsSettings(
                UserId,
                new UserSettings { Revision = 8, WatchProgressMode = "percentage" });
            Assert.IsType<ConflictObjectResult>(stale);
        }
    }
}
