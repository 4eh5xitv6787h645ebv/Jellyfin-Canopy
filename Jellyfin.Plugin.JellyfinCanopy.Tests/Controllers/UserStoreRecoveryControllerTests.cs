using System;
using System.IO;
using System.Reflection;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    public sealed class UserStoreRecoveryControllerTests : IDisposable
    {
        private readonly string _baseDir;
        private readonly string _userId = Guid.NewGuid().ToString("N");
        private readonly UserConfigurationManager _manager;

        public UserStoreRecoveryControllerTests()
        {
            _baseDir = Path.Combine(Path.GetTempPath(), "jc-user-recovery-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_baseDir);
            _manager = new UserConfigurationManager(
                new StubAppPaths(_baseDir),
                NullLogger<UserConfigurationManager>.Instance);
        }

        public void Dispose()
        {
            try { Directory.Delete(_baseDir, recursive: true); } catch { }
        }

        private string UserDir
            => Path.Combine(_baseDir, "configurations", "Jellyfin.Plugin.JellyfinCanopy", _userId);

        private UserStoreRecoveryController Controller()
            => new(_manager, NullLogger<UserStoreRecoveryController>.Instance);

        private void QuarantineSettings()
        {
            Directory.CreateDirectory(UserDir);
            File.WriteAllText(Path.Combine(UserDir, "settings.json"), "{{{ corrupt");
            Assert.Throws<UserStoreUnhealthyException>(() =>
                _manager.GetUserConfigurationStrict<UserSettings>(_userId, "settings.json"));
        }

        [Fact]
        public void Controller_IsElevationGatedAtClassBoundary()
        {
            var authorize = typeof(UserStoreRecoveryController).GetCustomAttribute<AuthorizeAttribute>();
            Assert.NotNull(authorize);
            Assert.Equal(Policies.RequiresElevation, authorize!.Policy);
        }

        [Fact]
        public void AdminStatusAndReset_RetireMarkerOnlyAfterEvidenceIsPreserved()
        {
            QuarantineSettings();
            Assert.IsType<OkObjectResult>(Controller().GetUnhealthyStores());

            var result = Controller().ResetUnhealthyStore(_userId, "settings.json");

            Assert.IsType<OkObjectResult>(result);
            Assert.False(File.Exists(Path.Combine(UserDir, "settings.json.unhealthy")));
            Assert.Single(Directory.GetFiles(UserDir, "settings.json.corrupt-*"));
            Assert.Empty(_manager.GetUnhealthyUserStores());
        }

        [Fact]
        public void Reset_RejectsUnknownStoreAndInvalidUser()
        {
            Assert.IsType<BadRequestObjectResult>(
                Controller().ResetUnhealthyStore("not-a-guid", "settings.json"));
            Assert.IsType<BadRequestObjectResult>(
                Controller().ResetUnhealthyStore(_userId, "arbitrary.json"));
        }

        [Fact]
        public void Reset_MalformedMarkerWithoutSource_ReturnsContract503AndKeepsMarker()
        {
            Directory.CreateDirectory(UserDir);
            var marker = Path.Combine(UserDir, "settings.json.unhealthy");
            File.WriteAllText(marker, "{{{ malformed marker");

            var result = Assert.IsType<ObjectResult>(
                Controller().ResetUnhealthyStore(_userId, "settings.json"));

            Assert.Equal(StatusCodes.Status503ServiceUnavailable, result.StatusCode);
            Assert.True(File.Exists(marker));
        }
    }
}
