using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class SeerrDispatchFenceTests
{
    [Fact]
    public void CallerRestrictionCannotRestoreDisabledBasePolicy()
    {
        var provider = Provider();
        var fence = SeerrIntegrationPolicy.Capture(provider)
            .CreateDispatchFence(provider)
            .Restrict(static () => true);

        provider.Current!.SeerrEnabled = false;

        Assert.False(fence.CanDispatch());
    }

    [Fact]
    public void CallerRestrictionCanOnlyNarrowAndThrowsFailClosed()
    {
        var provider = Provider();
        var fence = SeerrIntegrationPolicy.Capture(provider).CreateDispatchFence(provider);

        Assert.True(fence.CanDispatch());
        Assert.False(fence.Restrict(static () => false).CanDispatch());
        Assert.False(fence.Restrict(static () => throw new InvalidOperationException("boom")).CanDispatch());
    }

    [Fact]
    public void CapturedSourcesAreImmutableAndFenceIsBoundToActualTarget()
    {
        var provider = Provider();
        var snapshot = SeerrIntegrationPolicy.Capture(provider);
        var exposed = snapshot.Urls;
        exposed[0] = "http://attacker";
        var fence = snapshot.CreateDispatchFence(provider);

        Assert.Equal("http://seerr", Assert.Single(snapshot.Urls));
        Assert.True(fence.CanDispatch(new Uri("http://seerr/api/v1/request")));
        Assert.False(fence.CanDispatch(new Uri("http://attacker/api/v1/request")));
        Assert.False(fence.CanDispatch(new Uri("http://seerr.attacker/api/v1/request")));
    }

    [Fact]
    public void IdenticalReplacementSaveAdvancesGenerationWhileUnpublishedSaveDoesNot()
    {
        var provider = Provider();
        var original = SeerrIntegrationPolicy.Capture(provider);

        // Constructing a candidate is equivalent to a save that failed before
        // publication: the live provider remains unchanged.
        _ = Configuration();
        var afterFailedSave = SeerrIntegrationPolicy.Capture(provider);
        Assert.Equal(original.GenerationIdentity, afterFailedSave.GenerationIdentity);
        Assert.True(original.IsCurrent(provider));

        // Jellyfin publishes a successful save by replacing the configuration
        // object. Even byte-identical settings supersede old in-flight work.
        provider.Current = Configuration();
        var afterIdenticalSave = SeerrIntegrationPolicy.Capture(provider);
        Assert.NotEqual(original.GenerationIdentity, afterIdenticalSave.GenerationIdentity);
        Assert.False(original.IsCurrent(provider));
        Assert.True(afterIdenticalSave.IsCurrent(provider));
    }

    [Theory]
    [InlineData("url")]
    [InlineData("api-key")]
    [InlineData("url-mapping")]
    [InlineData("cache-disable")]
    [InlineData("feature-toggle")]
    public void RelevantInPlaceChangesAdvanceFingerprintWithoutARevisionChange(string change)
    {
        var provider = Provider();
        var original = SeerrIntegrationPolicy.Capture(provider);
        var revision = provider.ConfigurationRevision;

        switch (change)
        {
            case "url":
                provider.Current!.SeerrUrls = "http://replacement";
                break;
            case "api-key":
                provider.Current!.SeerrApiKey = "replacement-key";
                break;
            case "url-mapping":
                provider.Current!.SeerrUrlMappings = "http://internal=>https://external";
                break;
            case "cache-disable":
                provider.Current!.SeerrDisableCache = true;
                break;
            case "feature-toggle":
                provider.Current!.AutoMovieRequestEnabled = true;
                break;
            default:
                throw new InvalidOperationException($"Unknown change {change}.");
        }

        Assert.Equal(revision, provider.ConfigurationRevision);
        var changed = SeerrIntegrationPolicy.Capture(provider);
        Assert.NotEqual(original.GenerationIdentity, changed.GenerationIdentity);
        Assert.False(original.IsCurrent(provider));
        Assert.True(changed.IsCurrent(provider));
    }

    [Fact]
    public void ReplacementDuringCaptureFailsClosedWithoutLeakingEitherCredentialPair()
    {
        var first = Configuration();
        first.SeerrUrls = "http://first";
        first.SeerrApiKey = "first-key";
        var second = Configuration();
        second.SeerrUrls = "http://second";
        second.SeerrApiKey = "second-key";
        var provider = new ReplacingReadProvider(first, second);

        var snapshot = SeerrIntegrationPolicy.Capture(provider);

        Assert.False(snapshot.IsActive);
        Assert.Empty(snapshot.Urls);
        Assert.Empty(snapshot.ApiKey);
    }

    [Fact]
    public void CapturedSnapshotOwnsOneImmutableUrlKeyAndOptionProjection()
    {
        var provider = Provider();
        provider.Current!.AutoMovieRequestEnabled = true;

        var snapshot = SeerrIntegrationPolicy.Capture(provider);
        var callerCopy = snapshot.Configuration!;
        callerCopy.SeerrUrls = "http://caller-mutation";
        callerCopy.SeerrApiKey = "caller-key";
        callerCopy.AutoMovieRequestEnabled = false;

        Assert.NotSame(callerCopy, snapshot.Configuration);
        Assert.Equal("http://seerr", snapshot.Configuration!.SeerrUrls);
        Assert.Equal("key", snapshot.Configuration.SeerrApiKey);
        Assert.True(snapshot.Configuration.AutoMovieRequestEnabled);
        Assert.True(snapshot.IsCurrent(provider));

        provider.Current.SeerrUrls = "http://replacement";
        provider.Current.SeerrApiKey = "replacement-key";
        provider.Current.AutoMovieRequestEnabled = false;

        Assert.True(snapshot.IsActive);
        Assert.Equal(new[] { "http://seerr" }, snapshot.Urls);
        Assert.Equal("key", snapshot.ApiKey);
        Assert.Equal("http://seerr", snapshot.Configuration!.SeerrUrls);
        Assert.Equal("key", snapshot.Configuration.SeerrApiKey);
        Assert.True(snapshot.Configuration.AutoMovieRequestEnabled);
        Assert.False(snapshot.IsCurrent(provider));
        Assert.False(snapshot.CreateDispatchFence(provider).CanDispatch(
            new Uri("http://seerr/api/v1/request")));
    }

    [Fact]
    public void FenceIsOpaqueAndTransportOwnersRequireIt()
    {
        Assert.True(typeof(SeerrDispatchFence).IsSealed);
        Assert.DoesNotContain(
            typeof(SeerrDispatchFence).GetConstructors(
                System.Reflection.BindingFlags.Instance
                | System.Reflection.BindingFlags.Public
                | System.Reflection.BindingFlags.NonPublic),
            constructor => constructor.IsPublic || constructor.IsAssembly);
        Assert.DoesNotContain(
            typeof(SeerrIntegrationSnapshot).GetConstructors(
                System.Reflection.BindingFlags.Instance
                | System.Reflection.BindingFlags.Public
                | System.Reflection.BindingFlags.NonPublic),
            constructor => constructor.IsPublic || constructor.IsAssembly);

        Assert.All(
            typeof(SeerrPaginationHelper).GetMethods()
                .Where(method => method.Name is "FetchAllAsync" or "FetchAllSourcesAsync"),
            method => Assert.Contains(
                method.GetParameters(),
                parameter => parameter.ParameterType == typeof(SeerrDispatchFence)));
        Assert.Contains(
            typeof(SeerrUserImportHelper).GetMethod(nameof(SeerrUserImportHelper.BulkImportAsync))!
                .GetParameters(),
            parameter => parameter.ParameterType == typeof(SeerrDispatchFence));
        Assert.All(
            typeof(SeerrHttpHelper).GetMethods(
                    System.Reflection.BindingFlags.Static
                    | System.Reflection.BindingFlags.Public
                    | System.Reflection.BindingFlags.NonPublic)
                .Where(method => method.Name is "SendAndReadJsonAsync" or "SendResponseHeadersReadAsync"),
            method => Assert.Contains(
                method.GetParameters(),
                parameter => parameter.ParameterType == typeof(SeerrDispatchFence)));
    }

    private static FakePluginConfigProvider Provider()
        => new(Configuration());

    private static PluginConfiguration Configuration()
        => new()
        {
            SeerrEnabled = true,
            SeerrUrls = "http://seerr",
            SeerrApiKey = "key",
        };

    private sealed class ReplacingReadProvider(
        PluginConfiguration first,
        PluginConfiguration second) : Jellyfin.Plugin.JellyfinCanopy.Services.IPluginConfigProvider
    {
        private int _configurationReads;

        public PluginConfiguration Configuration => ConfigurationOrNull!;

        public PluginConfiguration? ConfigurationOrNull =>
            Interlocked.Increment(ref _configurationReads) == 1 ? first : second;

        public long ConfigurationRevision => 2;
    }
}
