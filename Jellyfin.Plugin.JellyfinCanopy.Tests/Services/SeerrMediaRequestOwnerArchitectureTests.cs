using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class SeerrMediaRequestOwnerArchitectureTests
{
    [Fact]
    public void OwnerInterfaceAcceptsOnlyAuthoritativeClosedInputs()
    {
        var method = Assert.Single(typeof(ISeerrMediaRequestOwner).GetMethods());

        Assert.Equal("RequestAsync", method.Name);
        Assert.Equal(typeof(Task<SeerrMediaRequestResult>), method.ReturnType);
        Assert.Equal(
            new[]
            {
                typeof(PlatformActor),
                typeof(HostAccessibleItem),
                typeof(SeerrMediaRequestVariant),
                typeof(PlatformIdempotencyKey),
                typeof(CancellationToken),
            },
            method.GetParameters().Select(parameter => parameter.ParameterType));
        Assert.DoesNotContain(method.GetParameters(), parameter => parameter.ParameterType == typeof(string));
        Assert.DoesNotContain(method.GetParameters(), parameter => parameter.ParameterType == typeof(Uri));
        Assert.DoesNotContain(method.GetParameters(), parameter => parameter.ParameterType == typeof(HttpMethod));
    }

    [Fact]
    public void ResultIsBoundedClosedAndCarriesNoProviderData()
    {
        Assert.Empty(typeof(SeerrMediaRequestResult).GetConstructors());
        Assert.Equal(
            new Dictionary<string, Type>(StringComparer.Ordinal)
            {
                ["Outcome"] = typeof(SeerrMediaRequestOutcome),
                ["ProviderAccepted"] = typeof(bool),
                ["SpoilerIntentRecorded"] = typeof(bool),
                ["SpoilerIntentRequired"] = typeof(bool),
            },
            typeof(SeerrMediaRequestResult)
                .GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .ToDictionary(property => property.Name, property => property.PropertyType, StringComparer.Ordinal));
        Assert.DoesNotContain(
            typeof(SeerrMediaRequestResult).GetProperties(BindingFlags.Public | BindingFlags.Instance),
            property => property.PropertyType == typeof(string)
                || property.PropertyType == typeof(object)
                || property.PropertyType == typeof(JsonElement));
    }

    [Fact]
    public void OwnerHasOneFixedMutationDispatchAndNoGenericProxyDependency()
    {
        var source = PlatformHostSeamTests.CodeOnly(File.ReadAllText(OwnerSource()));

        Assert.Contains("private const string RequestPath = \"/api/v1/request\"", source, StringComparison.Ordinal);
        Assert.Single(Regex.Matches(source, @"\bSeerrHttpHelper\.SendResponseHeadersReadAsync\s*\(").Cast<Match>());
        Assert.Contains("PlatformIdempotencyKey.HeaderName, idempotencyKey.Value", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ISeerrClient", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ProxyRequestAsync", source, StringComparison.Ordinal);
        Assert.DoesNotContain("IActionResult", source, StringComparison.Ordinal);
        Assert.DoesNotContain("HttpContext", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Controller", source, StringComparison.Ordinal);
        Assert.DoesNotContain("foreach", source, StringComparison.Ordinal);
        Assert.DoesNotContain("while", source, StringComparison.Ordinal);

        Assert.Contains("_host.Users.Find(actor.UserId)", source, StringComparison.Ordinal);
        Assert.Contains("_host.Library.FindAccessible(actor.UserId, item.Id)", source, StringComparison.Ordinal);
        Assert.Contains("admitted.ProviderReferences.SequenceEqual(current.ProviderReferences)", source, StringComparison.Ordinal);
        Assert.True(
            source.LastIndexOf("SeerrRequestIdentityResolutionMode.FinalPreDispatch", StringComparison.Ordinal)
                < source.IndexOf("_host.Users.Find(actor.UserId)", StringComparison.Ordinal));
        Assert.True(
            source.IndexOf("SeerrHttpHelper.CreateClient", StringComparison.Ordinal)
                < source.IndexOf("_host.Users.Find(actor.UserId)", StringComparison.Ordinal));
        Assert.True(
            source.IndexOf("SeerrHttpHelper.BuildRequest", StringComparison.Ordinal)
                < source.IndexOf("_host.Users.Find(actor.UserId)", StringComparison.Ordinal));
        Assert.True(
            source.IndexOf("PlatformIdempotencyKey.HeaderName, idempotencyKey.Value", StringComparison.Ordinal)
                < source.IndexOf("_host.Users.Find(actor.UserId)", StringComparison.Ordinal));
        Assert.True(
            source.IndexOf("_host.Library.FindAccessible(actor.UserId, item.Id)", StringComparison.Ordinal)
                < source.IndexOf("SeerrHttpHelper.SendResponseHeadersReadAsync", StringComparison.Ordinal));

        var constructor = Assert.Single(typeof(SeerrMediaRequestOwner).GetConstructors(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic));
        Assert.Contains(constructor.GetParameters(), parameter => parameter.ParameterType == typeof(IPlatformHost));
    }

    [Fact]
    public void PlatformAndLegacyCompatibilitySurfacesCannotCallEachOther()
    {
        var platformSources = Directory
            .EnumerateFiles(PlatformRoot(), "*.cs", SearchOption.AllDirectories)
            .Select(File.ReadAllText)
            .Select(PlatformHostSeamTests.CodeOnly)
            .ToArray();
        Assert.DoesNotContain(platformSources, source => source.Contains("ISeerrClient", StringComparison.Ordinal));
        Assert.DoesNotContain(platformSources, source => source.Contains("ProxyRequestAsync", StringComparison.Ordinal));

        foreach (var controller in new[] { "SeerrProxyController.cs", "SeerrUserController.cs" })
        {
            var source = PlatformHostSeamTests.CodeOnly(File.ReadAllText(Path.Combine(ProductionRoot(), "Controllers", controller)));
            Assert.DoesNotContain(nameof(ISeerrMediaRequestOwner), source, StringComparison.Ordinal);
            Assert.DoesNotContain(nameof(SeerrMediaRequestOwner), source, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void AdmissionSeamCannotExposeGenericTransportAuthority()
    {
        var methods = typeof(ISeerrMediaRequestAdmission).GetMethods();

        Assert.Equal(
            new[] { "Get4kCapabilityAsync", "InvalidateIdentity", "ResolveAsync" },
            methods.Select(method => method.Name).OrderBy(name => name, StringComparer.Ordinal));
        Assert.DoesNotContain(
            methods.SelectMany(method => method.GetParameters()),
            parameter => parameter.ParameterType == typeof(string)
                || parameter.ParameterType == typeof(Uri)
                || parameter.ParameterType == typeof(HttpMethod));
        Assert.DoesNotContain(methods, method => method.ReturnType == typeof(object));

        var capability = Assert.Single(methods, method => method.Name == "Get4kCapabilityAsync");
        Assert.Equal(typeof(SeerrRequestIdentity), capability.GetParameters()[0].ParameterType);

        var clientSource = PlatformHostSeamTests.CodeOnly(File.ReadAllText(Path.Combine(
            ProductionRoot(),
            "Services",
            "Seerr",
            "SeerrClient.cs")));
        Assert.Contains(
            "allowAutoImport: mode == SeerrRequestIdentityResolutionMode.InitialAdmission",
            clientSource,
            StringComparison.Ordinal);

        var boundStart = clientSource.IndexOf(
            "private async Task<Seerr4kCapability> GetBoundSeerr4kCapabilityAsync",
            StringComparison.Ordinal);
        var legacyStart = clientSource.IndexOf(
            "private async Task<Seerr4kCapability> GetSeerr4kCapabilityCoreAsync",
            boundStart,
            StringComparison.Ordinal);
        Assert.True(boundStart >= 0 && legacyStart > boundStart);
        Assert.DoesNotContain(
            "ResolveSeerrUser",
            clientSource[boundStart..legacyStart],
            StringComparison.Ordinal);
    }

    [Fact]
    public void DispatchFenceRejectionIsTypedAndConstructedOnlyOnThePreSendBranch()
    {
        Assert.True(typeof(InvalidOperationException).IsAssignableFrom(typeof(SeerrDispatchNotAttemptedException)));
        Assert.True(typeof(SeerrDispatchNotAttemptedException).IsSealed);

        var helperSource = PlatformHostSeamTests.CodeOnly(File.ReadAllText(Path.Combine(
            ProductionRoot(),
            "Helpers",
            "Seerr",
            "SeerrHttpHelper.cs")));
        Assert.Matches(
            new Regex(
                @"dispatchFence\.CanDispatch\(request\.RequestUri\)\s*\?\s*httpClient\.SendAsync\([\s\S]{0,240}?\:\s*Task\.FromException<HttpResponseMessage>\(\s*new SeerrDispatchNotAttemptedException\(\)\)",
                RegexOptions.CultureInvariant),
            helperSource);
    }

    private static string OwnerSource([CallerFilePath] string sourceFile = "")
        => Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "Jellyfin.Plugin.JellyfinCanopy",
            "Services",
            "Seerr",
            "SeerrMediaRequestOwner.cs"));

    private static string ProductionRoot([CallerFilePath] string sourceFile = "")
        => Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "Jellyfin.Plugin.JellyfinCanopy"));

    private static string PlatformRoot([CallerFilePath] string sourceFile = "")
        => Path.Combine(ProductionRoot(sourceFile), "Platform");
}
