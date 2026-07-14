using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    public sealed class MaintenanceModeControllerFailureTests : IDisposable
    {
        private readonly string _baseDir;
        private readonly string _stateFilePath;

        public MaintenanceModeControllerFailureTests()
        {
            _baseDir = Path.Combine(Path.GetTempPath(), "jc-maint-controller-" + Guid.NewGuid().ToString("N"));
            _stateFilePath = Path.Combine(
                _baseDir,
                "configurations",
                "Jellyfin.Plugin.JellyfinCanopy",
                "maintenance-state.json");
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(_baseDir, recursive: true);
            }
            catch
            {
                // Best-effort test cleanup.
            }
        }

        [Fact]
        public async Task DisableFault_ReturnsStructuredConflictInsteadOfUnhandledServerError()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_stateFilePath)!);
            File.WriteAllText(_stateFilePath, "{}");
            var users = new StubUserManager();
            using var service = CreateService(users, static (_, _) => throw new IOException("must not write"));
            var controller = CreateController(users, service);

            var result = Assert.IsType<ObjectResult>(await controller.DisableMaintenanceMode());

            Assert.Equal(StatusCodes.Status409Conflict, result.StatusCode);
            using var body = JsonDocument.Parse(JsonSerializer.Serialize(result.Value));
            Assert.False(body.RootElement.GetProperty("success").GetBoolean());
            Assert.Equal(MaintenancePhases.Faulted, body.RootElement.GetProperty("Phase").GetString());
            Assert.True(body.RootElement.GetProperty("IsActive").GetBoolean());
            Assert.False(body.RootElement.GetProperty("RecoveryAvailable").GetBoolean());
        }

        [Fact]
        public async Task EnablePersistenceFault_ReturnsSafeServiceUnavailableAndMutatesNoAccount()
        {
            var users = new StubUserManager();
            using var service = CreateService(users, static (_, _) => throw new IOException("secret-path-detail"));
            var controller = CreateController(users, service);

            var result = Assert.IsType<ObjectResult>(await controller.EnableMaintenanceMode(new MaintenanceModeRequest
            {
                Message = "maintenance",
                Action = "disable_accounts"
            }));

            Assert.Equal(StatusCodes.Status503ServiceUnavailable, result.StatusCode);
            string bodyJson = JsonSerializer.Serialize(result.Value);
            Assert.DoesNotContain("secret-path-detail", bodyJson, StringComparison.Ordinal);
            using var body = JsonDocument.Parse(bodyJson);
            Assert.False(body.RootElement.GetProperty("success").GetBoolean());
            Assert.Equal(MaintenancePhases.Inactive, body.RootElement.GetProperty("Phase").GetString());
            Assert.False(File.Exists(_stateFilePath));
        }

        private MaintenanceModeService CreateService(StubUserManager users, Action<string, string> writer)
            => new(
                users,
                new StubAppPaths(_baseDir),
                NullLogger<MaintenanceModeService>.Instance,
                TimeProvider.System,
                writer);

        private static MaintenanceModeController CreateController(
            StubUserManager users,
            MaintenanceModeService service)
            => new(
                null!,
                NullLogger<MaintenanceModeController>.Instance,
                users,
                null!,
                null!,
                null!,
                service);
    }
}
