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

        private UserSettingsController Controller(
            long? ifMatch = null,
            IPluginConfigProvider? configProvider = null)
        {
            configProvider ??= _provider;
            var controller = new UserSettingsController(
                new RecordingHttpClientFactory(new HttpClientHandler()),
                NullLogger<UserSettingsController>.Instance,
                new StubUserManager(_user),
                new SeerrCache(configProvider),
                configProvider,
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

        private sealed class DelegatingConfigProvider : IPluginConfigProvider
        {
            private readonly Func<PluginConfiguration?> _get;

            public DelegatingConfigProvider(Func<PluginConfiguration?> get)
            {
                _get = get;
            }

            public PluginConfiguration Configuration =>
                ConfigurationOrNull ?? throw new InvalidOperationException("Plugin configuration unavailable.");

            public PluginConfiguration? ConfigurationOrNull => _get();

            public long ConfigurationRevision => 1;
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
        public async Task FirstGetPausedAfterMissing_PostQueuesThenWinsDurably()
        {
            using var defaultFactoryEntered = new ManualResetEventSlim();
            using var releaseDefaultFactory = new ManualResetEventSlim();
            using var postQueuedAtStore = new ManualResetEventSlim();
            var provider = new DelegatingConfigProvider(() =>
            {
                defaultFactoryEntered.Set();
                if (!releaseDefaultFactory.Wait(TimeSpan.FromSeconds(10)))
                {
                    throw new TimeoutException("Default factory barrier was not released.");
                }

                return new PluginConfiguration { WatchProgressDefaultMode = "percentage" };
            });

            var getTask = Task.Run(() => Controller(configProvider: provider).GetUserSettingsSettings(UserId));
            Assert.True(defaultFactoryEntered.Wait(TimeSpan.FromSeconds(10)));

            _manager.UserFileLockObserverForTests = observation =>
            {
                if (observation.Operation == "transaction"
                    && observation.FileName == "settings.json"
                    && observation.Phase == UserFileLockPhase.Waiting)
                {
                    postQueuedAtStore.Set();
                }
            };

            try
            {
                var postTask = Task.Run(() => Controller(0, provider).SaveUserSettingsSettings(
                    UserId,
                    new UserSettings { Revision = 0, WatchProgressMode = "time" }));
                Assert.True(postQueuedAtStore.Wait(TimeSpan.FromSeconds(10)));

                releaseDefaultFactory.Set();

                var get = Assert.IsType<OkObjectResult>(await getTask.WaitAsync(TimeSpan.FromSeconds(10)));
                var getState = Assert.IsType<UserSettings>(get.Value);
                Assert.Equal("percentage", getState.WatchProgressMode);
                Assert.Equal(0, getState.Revision);

                var post = Assert.IsType<OkObjectResult>(await postTask.WaitAsync(TimeSpan.FromSeconds(10)));
                var acknowledgement = Assert.IsType<UserSettingsController.UserFileMutationResponse<UserSettings>>(post.Value);
                Assert.True(acknowledgement.Success);
                Assert.Equal("time", acknowledgement.Data!.WatchProgressMode);
                Assert.Equal(1, acknowledgement.Revision);

                var durable = _manager.GetUserConfigurationStrict<UserSettings>(UserId, "settings.json");
                Assert.Equal("time", durable.WatchProgressMode);
                Assert.Equal(1, durable.Revision);
            }
            finally
            {
                releaseDefaultFactory.Set();
                _manager.UserFileLockObserverForTests = null;
            }
        }

        [Fact]
        public void PostCommittedBeforeFirstGet_GetReturnsPostWithoutConsultingDefaults()
        {
            var provider = new DelegatingConfigProvider(() =>
                throw new InvalidOperationException("Defaults must not be read after POST committed."));
            var post = Controller(0, provider).SaveUserSettingsSettings(
                UserId,
                new UserSettings { Revision = 0, WatchProgressMode = "time" });
            Assert.IsType<OkObjectResult>(post);

            var get = Assert.IsType<OkObjectResult>(Controller(configProvider: provider).GetUserSettingsSettings(UserId));
            var state = Assert.IsType<UserSettings>(get.Value);
            Assert.Equal("time", state.WatchProgressMode);
            Assert.Equal(1, state.Revision);

            var durable = _manager.GetUserConfigurationStrict<UserSettings>(UserId, "settings.json");
            Assert.Equal("time", durable.WatchProgressMode);
            Assert.Equal(1, durable.Revision);
        }

        [Fact]
        public async Task ConcurrentFirstGets_ConstructAndCommitExactlyOneLogicalInitialValue()
        {
            using var firstFactoryEntered = new ManualResetEventSlim();
            using var releaseFirstFactory = new ManualResetEventSlim();
            using var secondGetQueuedAtStore = new ManualResetEventSlim();
            var factoryCalls = 0;
            var provider = new DelegatingConfigProvider(() =>
            {
                Interlocked.Increment(ref factoryCalls);
                firstFactoryEntered.Set();
                if (!releaseFirstFactory.Wait(TimeSpan.FromSeconds(10)))
                {
                    throw new TimeoutException("First default factory barrier was not released.");
                }

                return new PluginConfiguration { WatchProgressDefaultMode = "time" };
            });

            var first = Task.Run(() => Controller(configProvider: provider).GetUserSettingsSettings(UserId));
            Assert.True(firstFactoryEntered.Wait(TimeSpan.FromSeconds(10)));

            _manager.UserFileLockObserverForTests = observation =>
            {
                if (observation.Operation == "get-or-create"
                    && observation.FileName == "settings.json"
                    && observation.Phase == UserFileLockPhase.Waiting)
                {
                    secondGetQueuedAtStore.Set();
                }
            };

            try
            {
                var second = Task.Run(() => Controller(configProvider: provider).GetUserSettingsSettings(UserId));
                Assert.True(secondGetQueuedAtStore.Wait(TimeSpan.FromSeconds(10)));
                releaseFirstFactory.Set();

                var firstState = Assert.IsType<UserSettings>(
                    Assert.IsType<OkObjectResult>(await first.WaitAsync(TimeSpan.FromSeconds(10))).Value);
                var secondState = Assert.IsType<UserSettings>(
                    Assert.IsType<OkObjectResult>(await second.WaitAsync(TimeSpan.FromSeconds(10))).Value);

                Assert.Equal(1, Volatile.Read(ref factoryCalls));
                Assert.Equal("time", firstState.WatchProgressMode);
                Assert.Equal("time", secondState.WatchProgressMode);
                Assert.Equal(firstState.Revision, secondState.Revision);

                var durable = _manager.GetUserConfigurationStrict<UserSettings>(UserId, "settings.json");
                Assert.Equal("time", durable.WatchProgressMode);
                Assert.Equal(0, durable.Revision);
            }
            finally
            {
                releaseFirstFactory.Set();
                _manager.UserFileLockObserverForTests = null;
            }
        }

        [Fact]
        public void InitializationPersistenceFailure_Returns503AndRetryCreatesFreshState()
        {
            var providerReads = 0;
            var provider = new DelegatingConfigProvider(() =>
            {
                if (Interlocked.Increment(ref providerReads) == 1)
                {
                    Directory.CreateDirectory(FilePath("settings.json"));
                }

                return new PluginConfiguration { WatchProgressDefaultMode = "time" };
            });

            var failed = Controller(configProvider: provider).GetUserSettingsSettings(UserId);
            Assert.Equal(StatusCodes.Status503ServiceUnavailable, Assert.IsType<ObjectResult>(failed).StatusCode);
            Assert.True(Directory.Exists(FilePath("settings.json")));
            Assert.Empty(Directory.GetFiles(
                Path.GetDirectoryName(FilePath("settings.json"))!,
                "settings.json.tmp.*"));

            Directory.Delete(FilePath("settings.json"));
            var retry = Assert.IsType<OkObjectResult>(Controller(configProvider: provider).GetUserSettingsSettings(UserId));
            var state = Assert.IsType<UserSettings>(retry.Value);
            Assert.Equal("time", state.WatchProgressMode);
            Assert.Equal(2, providerReads);
            Assert.True(File.Exists(FilePath("settings.json")));
            Assert.Equal("time", _manager.GetUserConfigurationStrict<UserSettings>(UserId, "settings.json").WatchProgressMode);
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
        public void CorruptStore_FailsReadAndWriteWhileQuarantiningExactRawBytes()
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
            var settingsPath = FilePath("settings.json");
            Assert.False(File.Exists(settingsPath));
            Assert.True(File.Exists(settingsPath + ".unhealthy"));
            Assert.Equal(
                raw,
                File.ReadAllText(Assert.Single(Directory.GetFiles(Path.GetDirectoryName(settingsPath)!, "settings.json.corrupt-*"))));
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

        [Fact]
        public void AdminReset_ReportsQuarantinedHiddenContentAndContinuesOtherUsers()
        {
            SeedSettings(revision: 4, mode: "time");
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath("hidden-content.json"))!);
            File.WriteAllText(FilePath("hidden-content.json"), "{{{ corrupt hidden content");
            Assert.Throws<UserStoreUnhealthyException>(() =>
                _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json"));

            var reset = Assert.IsType<OkObjectResult>(Controller().ResetAllUsersSettings());

            Assert.Equal(5, _manager.GetUserConfigurationStrict<UserSettings>(UserId, "settings.json").Revision);
            Assert.True(File.Exists(FilePath("hidden-content.json.unhealthy")));
            var responseJson = JsonSerializer.Serialize(reset.Value);
            Assert.Contains(UserId, responseJson, StringComparison.Ordinal);
            Assert.Contains("skippedHcUserIds", responseJson, StringComparison.Ordinal);
        }
    }
}
