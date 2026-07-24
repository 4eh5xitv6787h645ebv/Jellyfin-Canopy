using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    public sealed class ClientRefreshStateServiceTests
    {
        private const string CanopyBuild = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        private const string JellyfinGeneration = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

        [Fact]
        public void GetState_UsesLiveConfigurationAndClampsPolicy()
        {
            var provider = new FakePluginConfigProvider(new PluginConfiguration
            {
                ClientRefreshMode = "homeonly",
                ClientRefreshOnCanopyUpdate = false,
                ClientRefreshOnJellyfinUpdate = true,
                ClientRefreshOnConfigChange = false,
                ClientRefreshPollSeconds = 1,
                ClientRefreshIdleSeconds = 999,
            });
            var service = new ClientRefreshStateService(
                provider,
                CanopyBuild,
                JellyfinGeneration);

            var first = service.GetState();

            Assert.Equal(1, first.SchemaVersion);
            Assert.Equal(CanopyBuild, first.CanopyBuildId);
            Assert.Equal(JellyfinGeneration, first.JellyfinGeneration);
            Assert.Equal("HomeOnly", first.Policy.Mode);
            Assert.False(first.Policy.OnCanopyUpdate);
            Assert.True(first.Policy.OnJellyfinUpdate);
            Assert.False(first.Policy.OnConfigChange);
            Assert.Equal(5, first.Policy.PollSeconds);
            Assert.Equal(300, first.Policy.IdleSeconds);

            provider.Current = new PluginConfiguration
            {
                ClientRefreshMode = "Notify",
                ClientRefreshPollSeconds = 45,
                ClientRefreshIdleSeconds = 0,
            };
            var second = service.GetState();

            Assert.True(second.ConfigurationRevision > first.ConfigurationRevision);
            Assert.Equal("Notify", second.Policy.Mode);
            Assert.Equal(45, second.Policy.PollSeconds);
            Assert.Equal(0, second.Policy.IdleSeconds);
        }

        [Fact]
        public void RequestRefresh_IncrementsWithoutChangingOtherIdentities()
        {
            var service = new ClientRefreshStateService(
                new FakePluginConfigProvider(new PluginConfiguration()),
                CanopyBuild,
                JellyfinGeneration);

            var before = service.GetState();
            var requested = service.RequestRefresh();
            var after = service.GetState();

            Assert.Equal(before.ForceRevision + 1, requested);
            Assert.Equal(requested, after.ForceRevision);
            Assert.Equal(before.CanopyBuildId, after.CanopyBuildId);
            Assert.Equal(before.JellyfinGeneration, after.JellyfinGeneration);
        }

        [Fact]
        public void GenerationFingerprint_ChangesAcrossSameVersionProcesses()
        {
            var first = ClientRefreshStateService.CreateJellyfinGeneration("12.0.0", "process-a");
            var second = ClientRefreshStateService.CreateJellyfinGeneration("12.0.0", "process-b");

            Assert.Matches("^[a-f0-9]{64}$", first);
            Assert.NotEqual(first, second);
        }

        [Fact]
        public void CanopyFingerprint_IsContentAddressed()
        {
            var buildId = ClientRefreshStateService.ResolveCanopyBuildId(
                typeof(ClientRefreshStateService).Assembly);

            Assert.Matches("^[a-f0-9]{64}$", buildId);
            Assert.DoesNotContain("2.0.0", buildId, StringComparison.Ordinal);
        }
    }
}
