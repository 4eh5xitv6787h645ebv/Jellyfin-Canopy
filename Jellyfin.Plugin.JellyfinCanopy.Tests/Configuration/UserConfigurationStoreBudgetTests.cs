using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration;

public sealed class UserConfigurationStoreBudgetTests : IDisposable
{
    private readonly string _baseDir;
    private readonly UserConfigurationManager _manager;

    public UserConfigurationStoreBudgetTests()
    {
        _baseDir = Path.Combine(Path.GetTempPath(), "jc-store-budget-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_baseDir);
        _manager = new UserConfigurationManager(
            new StubAppPaths(_baseDir),
            NullLogger<UserConfigurationManager>.Instance);
    }

    public void Dispose()
    {
        try { Directory.Delete(_baseDir, recursive: true); } catch { /* best effort */ }
    }

    [Fact]
    public void AbsoluteStoreBudget_AllowsExactBytesAndRejectsNPlusOneWithoutMutation()
    {
        const string userId = "0123456789abcdef0123456789abcdef";
        const string fileName = "large.json";
        var exact = new string('x', PersistedPayloadPolicy.AbsolutePersistedBytes - 2);
        _manager.SaveUserConfiguration(userId, fileName, exact);

        var path = Path.Combine(
            _baseDir,
            "configurations",
            "Jellyfin.Plugin.JellyfinCanopy",
            userId,
            fileName);
        var before = File.ReadAllBytes(path);
        Assert.Equal(PersistedPayloadPolicy.AbsolutePersistedBytes, before.Length);

        var over = new string('x', PersistedPayloadPolicy.AbsolutePersistedBytes - 1);
        Assert.Throws<InvalidDataException>(() => _manager.SaveUserConfiguration(userId, fileName, over));
        Assert.Equal(before, File.ReadAllBytes(path));
    }

    [Fact]
    public void RejectedAbsoluteBudget_DoesNotCreateUserDirectory()
    {
        const string userId = "fedcba9876543210fedcba9876543210";
        var over = new string('x', PersistedPayloadPolicy.AbsolutePersistedBytes - 1);

        Assert.Throws<InvalidDataException>(() => _manager.SaveUserConfiguration(userId, "large.json", over));
        Assert.False(Directory.Exists(Path.Combine(
            _baseDir,
            "configurations",
            "Jellyfin.Plugin.JellyfinCanopy",
            userId)));
    }
}
