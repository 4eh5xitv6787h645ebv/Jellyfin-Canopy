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
        => new(new PluginConfiguration
        {
            SeerrEnabled = true,
            SeerrUrls = "http://seerr",
            SeerrApiKey = "key",
        });
}
