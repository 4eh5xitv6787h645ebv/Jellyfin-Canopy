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

        private void SeedTheme(long revision = 0, string preset = "canopy")
        {
            var theme = UserThemeConfiguration.CreateDefault(preset, "canopy-night");
            theme.Revision = revision;
            _manager.SaveUserConfiguration(UserId, "theme.json", theme);
        }

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
        public void ThemeGet_SeedsValidatedAdministratorDefaultsWithEvidence()
        {
            _provider.Current = new PluginConfiguration
            {
                ThemeStudioDefaultPreset = "glass",
                ThemeStudioDefaultPalette = "catppuccin"
            };

            var controller = Controller();
            var result = Assert.IsType<OkObjectResult>(controller.GetUserSettingsTheme(UserId));
            var theme = Assert.IsType<UserThemeConfiguration>(result.Value);

            Assert.Equal(ThemeConfigurationPolicy.CurrentSchemaVersion, theme.SchemaVersion);
            Assert.Equal("glass", Assert.Single(theme.Profiles).BasePreset);
            Assert.Equal("catppuccin", theme.Profiles[0].Palette);
            Assert.Equal("palette", theme.Profiles[0].Accent);
            Assert.Equal("\"0\"", controller.Response.Headers.ETag.ToString());
            Assert.Matches("^[0-9a-f]{64}$", controller.Response.Headers["X-JC-Content-Hash"].ToString());
            Assert.True(File.Exists(FilePath("theme.json")));
        }

        [Fact]
        public void ThemeGet_NormalizesLegacyFreeTextAdministratorPaletteDefault()
        {
            _provider.Current = new PluginConfiguration
            {
                ThemeStudioDefaultPreset = "glass",
                ThemeStudioDefaultPalette = "former-custom-palette"
            };

            var theme = Assert.IsType<UserThemeConfiguration>(
                Assert.IsType<OkObjectResult>(Controller().GetUserSettingsTheme(UserId)).Value);

            Assert.Equal(ThemeConfigurationPolicy.CurrentSchemaVersion, theme.SchemaVersion);
            Assert.Equal("glass", Assert.Single(theme.Profiles).BasePreset);
            Assert.Equal("canopy-night", theme.Profiles[0].Palette);
            Assert.Equal("canopy-night", _manager
                .GetUserConfigurationStrict<UserThemeConfiguration>(UserId, "theme.json")
                .Profiles[0].Palette);
        }

        [Fact]
        public void ThemeGet_AtomicallyMigratesOlderSchemaAndAdvancesEvidence()
        {
            var legacy = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
            legacy.SchemaVersion = 0;
            legacy.Revision = 4;
            legacy.LegacyMigration.JellyfishTheme = "Ocean";
            _manager.SaveUserConfiguration(UserId, "theme.json", legacy);

            var controller = Controller();
            var theme = Assert.IsType<UserThemeConfiguration>(
                Assert.IsType<OkObjectResult>(controller.GetUserSettingsTheme(UserId)).Value);

            Assert.Equal(ThemeConfigurationPolicy.CurrentSchemaVersion, theme.SchemaVersion);
            Assert.Equal(5, theme.Revision);
            Assert.Equal("jellyfish-ocean", theme.Profiles[0].Palette);
            Assert.True(theme.LegacyMigration.Completed);
            Assert.Equal("\"5\"", controller.Response.Headers.ETag.ToString());

            var durable = _manager.GetUserConfigurationStrict<UserThemeConfiguration>(UserId, "theme.json");
            Assert.Equal(5, durable.Revision);
            Assert.Equal("jellyfish-ocean", durable.Profiles[0].Palette);
        }

        [Fact]
        public void ThemeSave_UsesRevisionContractAndEvidenceRead()
        {
            SeedTheme(revision: 2);
            var candidate = UserThemeConfiguration.CreateDefault("material", "canopy-night");
            candidate.Revision = 2;

            var saved = Controller(2).SaveUserSettingsTheme(UserId, candidate);
            var acknowledgement = Assert.IsType<UserSettingsController.UserFileMutationResponse<UserThemeConfiguration>>(
                Assert.IsType<OkObjectResult>(saved).Value);
            Assert.True(acknowledgement.Success);
            Assert.Equal(3, acknowledgement.Revision);
            Assert.Equal("material", acknowledgement.Data!.Profiles[0].BasePreset);

            var evidenceController = Controller();
            var evidence = Assert.IsType<UserSettingsController.UserFileMutationResponse<UserThemeConfiguration>>(
                Assert.IsType<OkObjectResult>(evidenceController.GetUserFileEvidence(UserId, "theme.json")).Value);
            Assert.Equal(3, evidence.Revision);
            Assert.Equal(acknowledgement.ContentHash, evidence.ContentHash);

            var staleCandidate = UserThemeConfiguration.CreateDefault("minimal", "canopy-night");
            staleCandidate.Revision = 2;
            var stale = Controller(2).SaveUserSettingsTheme(UserId, staleCandidate);
            Assert.IsType<ConflictObjectResult>(stale);
            Assert.Equal("material", _manager.GetUserConfigurationStrict<UserThemeConfiguration>(UserId, "theme.json").Profiles[0].BasePreset);
        }

        [Fact]
        public void ThemeImportValidation_IsNonMutatingAndExportOmitsRevisionAndMigration()
        {
            var import = new ThemeExportDocument
            {
                SchemaVersion = ThemeConfigurationPolicy.CurrentSchemaVersion,
                ActiveProfileId = ThemeProfile.DefaultId,
                Profiles = new List<ThemeProfile> { ThemeProfile.CreateDefault("cinematic", "canopy-night") }
            };

            var validated = Assert.IsType<OkObjectResult>(
                Controller().ValidateUserSettingsThemeImport(UserId, import));
            Assert.Contains("\"valid\":true", JsonSerializer.Serialize(validated.Value), StringComparison.OrdinalIgnoreCase);
            Assert.False(File.Exists(FilePath("theme.json")));

            SeedTheme(revision: 9, preset: "cinematic");
            var exported = Assert.IsType<ThemeExportDocument>(
                Assert.IsType<OkObjectResult>(Controller().ExportUserSettingsTheme(UserId)).Value);
            var json = JsonSerializer.Serialize(exported);
            Assert.DoesNotContain("Revision", json, StringComparison.Ordinal);
            Assert.DoesNotContain("LegacyMigration", json, StringComparison.Ordinal);
            Assert.Equal("cinematic", Assert.Single(exported.Profiles).BasePreset);
        }

        [Fact]
        public void ThemeImportValidation_MigratesOlderSchemaWithoutAliasingOrWriting()
        {
            var profile = ThemeProfile.CreateDefault("canopy", "canopy-night");
            var import = new ThemeExportDocument
            {
                SchemaVersion = 0,
                ActiveProfileId = ThemeProfile.DefaultId,
                Profiles = new List<ThemeProfile> { profile }
            };

            var validated = Assert.IsType<OkObjectResult>(
                Controller().ValidateUserSettingsThemeImport(UserId, import));
            var json = JsonSerializer.Serialize(validated.Value);
            Assert.Contains(
                $"\"schemaVersion\":{ThemeConfigurationPolicy.CurrentSchemaVersion}",
                json,
                StringComparison.OrdinalIgnoreCase);
            Assert.False(File.Exists(FilePath("theme.json")));
            Assert.Equal(0, import.SchemaVersion);
            Assert.Same(profile, import.Profiles[0]);
        }

        [Fact]
        public void ThemeImportValidation_PreservesSchemaOneJellyfishPaletteWithoutLegacyMetadata()
        {
            var profile = ThemeProfile.CreateDefault("canopy", "jellyfish-ocean");
            profile.Accent = "violet";
            var import = new ThemeExportDocument
            {
                SchemaVersion = 1,
                ActiveProfileId = ThemeProfile.DefaultId,
                Profiles = new List<ThemeProfile> { profile }
            };

            var validated = Assert.IsType<OkObjectResult>(
                Controller().ValidateUserSettingsThemeImport(UserId, import));
            var json = JsonSerializer.Serialize(validated.Value);
            Assert.Contains("\"Palette\":\"jellyfish-ocean\"", json, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("\"Accent\":\"palette\"", json, StringComparison.OrdinalIgnoreCase);
            Assert.Equal("violet", profile.Accent);
            Assert.False(File.Exists(FilePath("theme.json")));
        }

        [Fact]
        public void ThemeJellyfishMigration_IsAllowlistedStagedAndNonMutating()
        {
            var accepted = Assert.IsType<OkObjectResult>(
                Controller().ValidateLegacyJellyfishThemeMigration(
                    UserId,
                    new ThemeLegacyJellyfishSelection { Theme = "ocean" }));
            var json = JsonSerializer.Serialize(accepted.Value);
            Assert.Contains("jellyfish-ocean", json, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("Ocean", json, StringComparison.Ordinal);
            Assert.False(File.Exists(FilePath("theme.json")));

            Assert.IsType<BadRequestObjectResult>(
                Controller().ValidateLegacyJellyfishThemeMigration(
                    UserId,
                    new ThemeLegacyJellyfishSelection { Theme = "@import url(ocean.css)" }));
            Assert.False(File.Exists(FilePath("theme.json")));
        }

        [Fact]
        public void Theme_InvalidTypedValuesAndInvalidAdministratorDefaultsAreRejected()
        {
            SeedTheme(revision: 4);
            var invalid = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
            invalid.Revision = 4;
            using var css = JsonDocument.Parse("\"url(https://example.invalid/theme.css)\"");
            invalid.Profiles[0].Tokens["color.primary"] = css.RootElement.Clone();

            Assert.IsType<BadRequestObjectResult>(Controller(4).SaveUserSettingsTheme(UserId, invalid));
            Assert.Equal(4, _manager.GetUserConfigurationStrict<UserThemeConfiguration>(UserId, "theme.json").Revision);

            var otherUser = new User("other", "Provider", "PasswordProvider");
            var invalidProvider = new FakePluginConfigProvider(new PluginConfiguration
            {
                ThemeStudioDefaultPreset = "unknown-preset",
                ThemeStudioDefaultPalette = "canopy-night"
            });
            var controller = new UserSettingsController(
                new RecordingHttpClientFactory(new HttpClientHandler()),
                NullLogger<UserSettingsController>.Instance,
                new StubUserManager(otherUser),
                new SeerrCache(invalidProvider),
                invalidProvider,
                _manager,
                new CountingLibraryManager());
            controller.ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(
                        new[] { new Claim("Jellyfin-UserId", otherUser.Id.ToString()) },
                        "TestAuth"))
                }
            };

            var result = controller.GetUserSettingsTheme(otherUser.Id.ToString("N"));
            Assert.Equal(StatusCodes.Status503ServiceUnavailable, Assert.IsType<ObjectResult>(result).StatusCode);
        }

        [Fact]
        public void Theme_AdministratorCapabilityPolicyRejectsImportAndSchedules()
        {
            _provider.Current = new PluginConfiguration
            {
                ThemeStudioAllowProfileImport = false,
                ThemeStudioAllowSeasonalScheduling = false
            };

            var import = new ThemeExportDocument
            {
                Profiles = new List<ThemeProfile> { ThemeProfile.CreateDefault("canopy", "canopy-night") }
            };
            var importResult = Controller().ValidateUserSettingsThemeImport(UserId, import);
            Assert.Equal(StatusCodes.Status403Forbidden, Assert.IsType<ObjectResult>(importResult).StatusCode);

            SeedTheme();
            var scheduled = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
            scheduled.Schedule.Add(new ThemeScheduleEntry
            {
                Id = "winter",
                ProfileId = ThemeProfile.DefaultId,
                StartMonthDay = "12-01",
                EndMonthDay = "02-29"
            });
            Assert.IsType<BadRequestObjectResult>(Controller(0).SaveUserSettingsTheme(UserId, scheduled));
            Assert.Empty(_manager.GetUserConfigurationStrict<UserThemeConfiguration>(UserId, "theme.json").Schedule);
        }

        [Fact]
        public void Theme_DisabledSchedulingAllowsProfileEditsWithUnchangedDormantSchedule()
        {
            _provider.Current = new PluginConfiguration
            {
                ThemeStudioAllowProfileImport = true,
                ThemeStudioAllowSeasonalScheduling = false
            };
            var stored = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
            stored.Schedule.Add(new ThemeScheduleEntry
            {
                Id = "winter",
                ProfileId = ThemeProfile.DefaultId,
                StartMonthDay = "12-01",
                EndMonthDay = "02-29"
            });
            _manager.SaveUserConfiguration(UserId, "theme.json", stored);
            var candidate = _manager.GetUserConfigurationStrict<UserThemeConfiguration>(UserId, "theme.json");
            candidate.Profiles[0].Name = "Edited while scheduling is disabled";

            var result = Controller(0).SaveUserSettingsTheme(UserId, candidate);

            Assert.IsType<OkObjectResult>(result);
            var saved = _manager.GetUserConfigurationStrict<UserThemeConfiguration>(UserId, "theme.json");
            Assert.Equal("Edited while scheduling is disabled", saved.Profiles[0].Name);
            Assert.Equal("winter", Assert.Single(saved.Schedule).Id);
        }

        [Fact]
        public void Theme_DisabledSchedulingRejectsClearingDormantSchedule()
        {
            _provider.Current = new PluginConfiguration
            {
                ThemeStudioAllowProfileImport = true,
                ThemeStudioAllowSeasonalScheduling = false
            };
            var stored = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
            stored.Schedule.Add(new ThemeScheduleEntry
            {
                Id = "winter",
                ProfileId = ThemeProfile.DefaultId,
                StartMonthDay = "12-01",
                EndMonthDay = "02-29"
            });
            _manager.SaveUserConfiguration(UserId, "theme.json", stored);
            var candidate = _manager.GetUserConfigurationStrict<UserThemeConfiguration>(UserId, "theme.json");
            candidate.Schedule.Clear();

            var result = Controller(0).SaveUserSettingsTheme(UserId, candidate);

            var response = Assert.IsType<UserSettingsController.UserFileMutationResponse<UserThemeConfiguration>>(
                Assert.IsType<BadRequestObjectResult>(result).Value);
            Assert.Equal("theme_schedule_disabled", response.Code);
            Assert.Equal("winter", Assert.Single(
                _manager.GetUserConfigurationStrict<UserThemeConfiguration>(UserId, "theme.json").Schedule).Id);
        }

        [Fact]
        public void Theme_DisabledSchedulingChecksScheduleInsideTheCommitTransaction()
        {
            _provider.Current = new PluginConfiguration
            {
                ThemeStudioAllowProfileImport = true,
                ThemeStudioAllowSeasonalScheduling = false
            };
            var stored = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
            stored.Schedule.Add(new ThemeScheduleEntry
            {
                Id = "winter",
                ProfileId = ThemeProfile.DefaultId,
                StartMonthDay = "12-01",
                EndMonthDay = "02-29"
            });
            _manager.SaveUserConfiguration(UserId, "theme.json", stored);
            var candidate = _manager.GetUserConfigurationStrict<UserThemeConfiguration>(UserId, "theme.json");
            candidate.Profiles[0].Name = "Candidate profile edit";
            var raced = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
            raced.Schedule.Add(new ThemeScheduleEntry
            {
                Id = "summer",
                ProfileId = ThemeProfile.DefaultId,
                StartMonthDay = "06-01",
                EndMonthDay = "08-31"
            });
            var injected = 0;
            _manager.UserFileLockObserverForTests = observation =>
            {
                if (observation.Operation == "transaction"
                    && observation.FileName == "theme.json"
                    && observation.Phase == UserFileLockPhase.Waiting
                    && Interlocked.Exchange(ref injected, 1) == 0)
                {
                    _manager.SaveUserConfiguration(UserId, "theme.json", raced);
                }
            };

            try
            {
                var result = Controller(0).SaveUserSettingsTheme(UserId, candidate);
                var response = Assert.IsType<UserSettingsController.UserFileMutationResponse<UserThemeConfiguration>>(
                    Assert.IsType<BadRequestObjectResult>(result).Value);
                Assert.Equal("theme_schedule_disabled", response.Code);
            }
            finally
            {
                _manager.UserFileLockObserverForTests = null;
            }

            var durable = _manager.GetUserConfigurationStrict<UserThemeConfiguration>(UserId, "theme.json");
            Assert.Equal("summer", Assert.Single(durable.Schedule).Id);
            Assert.Equal("Default", durable.Profiles[0].Name);
        }

        [Fact]
        public void Theme_DisabledSchedulingSurfacesCorruptStoreAsUnavailable()
        {
            _provider.Current = new PluginConfiguration
            {
                ThemeStudioAllowProfileImport = true,
                ThemeStudioAllowSeasonalScheduling = false
            };
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath("theme.json"))!);
            File.WriteAllText(FilePath("theme.json"), "{ malformed");
            var candidate = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");

            var result = Controller(0).SaveUserSettingsTheme(UserId, candidate);

            Assert.Equal(
                StatusCodes.Status503ServiceUnavailable,
                Assert.IsType<ObjectResult>(result).StatusCode);
        }

        [Fact]
        public void Theme_DisabledSchedulingSurfacesUnreadableStorePathAsUnavailable()
        {
            _provider.Current = new PluginConfiguration
            {
                ThemeStudioAllowProfileImport = true,
                ThemeStudioAllowSeasonalScheduling = false
            };
            Directory.CreateDirectory(FilePath("theme.json"));
            var candidate = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
            candidate.Profiles[0].Name = "Requires a real write";

            var result = Controller(0).SaveUserSettingsTheme(UserId, candidate);

            Assert.Equal(
                StatusCodes.Status503ServiceUnavailable,
                Assert.IsType<ObjectResult>(result).StatusCode);
        }

        [Fact]
        public void Theme_DisabledSchedulingAllowsEmptyScheduleForFirstSave()
        {
            _provider.Current = new PluginConfiguration
            {
                ThemeStudioAllowProfileImport = true,
                ThemeStudioAllowSeasonalScheduling = false
            };
            var candidate = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");

            var result = Controller(0).SaveUserSettingsTheme(UserId, candidate);

            Assert.IsType<OkObjectResult>(result);
            Assert.Empty(_manager.GetUserConfigurationStrict<UserThemeConfiguration>(UserId, "theme.json").Schedule);
        }

        [Fact]
        public void Theme_DisabledSchedulingRejectsScheduledImports()
        {
            _provider.Current = new PluginConfiguration
            {
                ThemeStudioAllowProfileImport = true,
                ThemeStudioAllowSeasonalScheduling = false
            };
            var scheduled = UserThemeConfiguration.CreateDefault("canopy", "canopy-night");
            scheduled.Schedule.Add(new ThemeScheduleEntry
            {
                Id = "winter",
                ProfileId = ThemeProfile.DefaultId,
                StartMonthDay = "12-01",
                EndMonthDay = "02-29"
            });

            var result = Controller().ValidateUserSettingsThemeImport(
                UserId,
                ThemeExportDocument.FromConfiguration(scheduled));

            Assert.IsType<BadRequestObjectResult>(result);
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
            SeedTheme(revision: 5, preset: "glass");
            var reset = Controller().ResetAllUsersSettings();
            Assert.IsType<OkObjectResult>(reset);
            Assert.Equal(9, _manager.GetUserConfigurationStrict<UserSettings>(UserId, "settings.json").Revision);
            var resetTheme = _manager.GetUserConfigurationStrict<UserThemeConfiguration>(UserId, "theme.json");
            Assert.Equal(6, resetTheme.Revision);
            Assert.Equal("canopy", Assert.Single(resetTheme.Profiles).BasePreset);

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
