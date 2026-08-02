using System.Collections.Immutable;
using System.Net;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class SeerrItemRequestPresentationOwnerTests
{
    [Fact]
    public async Task ExactMovieRead_UsesSourceBoundIdentityAndReturnsOnlyOpaqueRevisions()
    {
        var harness = new Harness();
        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "603"));

        Assert.True(result.IsVisible);
        Assert.True(result.StandardRequestAvailable);
        Assert.True(result.FourKRequestAvailable);
        Assert.Equal(SeerrItemRequestStatus.Unavailable, result.StandardStatus);
        Assert.Equal(SeerrItemRequestStatus.Unavailable, result.FourKStatus);
        AssertRevisions(result);
        var request = Assert.Single(harness.Handler.Requests);
        Assert.Equal(HttpMethod.Get, request.Method);
        Assert.Equal("/root/api/v1/movie/603", request.RequestUri!.AbsolutePath);
        Assert.Equal("27", Assert.Single(request.Headers.GetValues("X-Api-User")));
        Assert.Equal("saved-api-key", Assert.Single(request.Headers.GetValues("X-Api-Key")));
        Assert.Equal(
            new[]
            {
                SeerrRequestIdentityResolutionMode.FinalPreDispatch,
                SeerrRequestIdentityResolutionMode.FinalPreDispatch,
            },
            harness.Admission.ResolutionModes);
        Assert.Equal(2, harness.Admission.CapabilityCalls);
    }

    [Fact]
    public async Task ExactSeriesRead_UsesOnlyFixedTvDetailTarget()
    {
        var harness = new Harness();

        var result = await harness.InvokeAsync(Item(HostItemKind.Series, "1399"));

        Assert.True(result.IsVisible);
        Assert.Equal("/root/api/v1/tv/1399", Assert.Single(harness.Handler.Sent).Path);
    }

    [Theory]
    [InlineData(HostItemKind.Episode, "603")]
    [InlineData(HostItemKind.Movie, "0")]
    [InlineData(HostItemKind.Movie, "not-a-number")]
    public async Task UnsupportedOrMalformedAuthoritativeTarget_IsInvisibleWithoutProviderRead(
        HostItemKind kind,
        string tmdbId)
    {
        var harness = new Harness();

        var result = await harness.InvokeAsync(Item(kind, tmdbId));

        AssertInvisible(result);
        Assert.Equal(0, harness.Admission.ResolutionCalls);
        Assert.Empty(harness.Handler.Sent);
    }

    [Fact]
    public async Task MissingOrAmbiguousTmdbTarget_IsInvisible()
    {
        var harness = new Harness();
        var missing = new HostAccessibleItem(
            Guid.NewGuid(),
            HostItemKind.Movie,
            null,
            ImmutableArray.Create(new HostProviderReference("Tvdb", "7")));
        var ambiguous = new HostAccessibleItem(
            Guid.NewGuid(),
            HostItemKind.Movie,
            null,
            ImmutableArray.Create(
                new HostProviderReference("Tmdb", "7"),
                new HostProviderReference("Tmdb", "8")));

        AssertInvisible(await harness.InvokeAsync(missing));
        AssertInvisible(await harness.InvokeAsync(ambiguous));
        Assert.Empty(harness.Handler.Sent);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public async Task UnlinkedBlockedOrUnavailableIdentity_IsInvisible(
        int identityStatus)
    {
        var harness = new Harness();
        harness.Admission.SetResolutions(new SeerrRequestIdentityResolution(
            (SeerrRequestIdentityStatus)identityStatus,
            default));

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "11"));

        AssertInvisible(result);
        Assert.Empty(harness.Handler.Sent);
    }

    [Fact]
    public async Task IdentitySourceMustRemainInExactCapturedConfiguration()
    {
        var harness = new Harness();
        harness.Admission.SetResolutions(Found(source: "https://other.example/root"));

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "12"));

        AssertInvisible(result);
        Assert.Empty(harness.Handler.Sent);
    }

    [Fact]
    public async Task PermissionAnd4kMasterCapabilityAreFoldedIntoEditionAvailability()
    {
        var standardOnly = new Harness();
        standardOnly.Admission.SetResolutions(Found(permissions: SeerrPermission.REQUEST_MOVIE));
        var standard = await standardOnly.InvokeAsync(Item(HostItemKind.Movie, "13"));
        Assert.True(standard.IsVisible);
        Assert.True(standard.StandardRequestAvailable);
        Assert.False(standard.FourKRequestAvailable);
        Assert.Equal(SeerrItemRequestStatus.Unavailable, standard.FourKStatus);
        Assert.Equal(0, standardOnly.Admission.CapabilityCalls);

        var fourKOnly = new Harness();
        fourKOnly.Admission.SetResolutions(Found(permissions: SeerrPermission.REQUEST_4K_MOVIE));
        var fourK = await fourKOnly.InvokeAsync(Item(HostItemKind.Movie, "13"));
        Assert.True(fourK.IsVisible);
        Assert.False(fourK.StandardRequestAvailable);
        Assert.True(fourK.FourKRequestAvailable);
        Assert.Equal(SeerrItemRequestStatus.Unavailable, fourK.StandardStatus);

        var masterOff = new Harness();
        masterOff.Config.SeerrEnable4KRequests = false;
        masterOff.Admission.SetResolutions(Found(permissions: SeerrPermission.REQUEST_4K_MOVIE));
        AssertInvisible(await masterOff.InvokeAsync(Item(HostItemKind.Movie, "13")));

        var providerOff = new Harness();
        providerOff.Admission.SetResolutions(Found(permissions: SeerrPermission.REQUEST_4K_MOVIE));
        providerOff.Admission.SetCapabilities(new Seerr4kCapability(false, false, false, false));
        AssertInvisible(await providerOff.InvokeAsync(Item(HostItemKind.Movie, "13")));
    }

    [Fact]
    public async Task JellyfinAdministratorBypassesIdentityPermissionsButNot4kMasterSwitch()
    {
        var harness = new Harness(isElevated: true);
        harness.Admission.SetResolutions(Found(permissions: SeerrPermission.NONE));
        harness.Config.SeerrEnable4KRequests = false;

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "14"));

        Assert.True(result.IsVisible);
        Assert.True(result.StandardRequestAvailable);
        Assert.False(result.FourKRequestAvailable);
    }

    [Fact]
    public async Task ParentalDenialIsInvisibleAndNeverReadsProvider()
    {
        var harness = new Harness();
        harness.Parental.Blocked = true;

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "15"));

        AssertInvisible(result);
        Assert.Empty(harness.Handler.Sent);
    }

    [Fact]
    public async Task ParentalPolicyIsRecheckedAfterProviderReadBeforePublication()
    {
        var harness = new Harness();
        harness.Parental.SetDecisions(false, true);

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "151"));

        AssertInvisible(result);
        Assert.Single(harness.Handler.Sent);
        Assert.Equal(2, harness.Parental.Calls);
    }

    [Fact]
    public async Task HostUserOrItemRevocationBeforeDispatchIsInvisible()
    {
        var deletedUser = new Harness();
        deletedUser.Host.UserExists = false;
        AssertInvisible(await deletedUser.InvokeAsync(Item(HostItemKind.Movie, "16")));
        Assert.Empty(deletedUser.Handler.Sent);

        var inaccessibleItem = new Harness();
        inaccessibleItem.Host.ItemAccessible = false;
        AssertInvisible(await inaccessibleItem.InvokeAsync(Item(HostItemKind.Movie, "16")));
        Assert.Empty(inaccessibleItem.Handler.Sent);
    }

    [Fact]
    public async Task HostOrIdentityRevocationDuringProviderReadPreventsPublication()
    {
        var hostHarness = new Harness();
        hostHarness.Handler.BeforeResponse = _ => hostHarness.Host.ItemAccessible = false;
        AssertInvisible(await hostHarness.InvokeAsync(Item(HostItemKind.Movie, "17")));

        var identityHarness = new Harness();
        identityHarness.Admission.SetResolutions(
            Found(userId: 27),
            Found(userId: 91));
        AssertInvisible(await identityHarness.InvokeAsync(Item(HostItemKind.Movie, "17")));
        Assert.Equal(1, identityHarness.Admission.InvalidationCalls);
    }

    [Fact]
    public async Task ProviderReferenceDriftDuringReadPreventsPublication()
    {
        var harness = new Harness();
        harness.Handler.BeforeResponse = _ => harness.Host.ItemTransform = item => new HostAccessibleItem(
            item.Id,
            item.Kind,
            item.SeriesId,
            item.ProviderReferences.Add(new HostProviderReference("Tvdb", "drift")));

        AssertInvisible(await harness.InvokeAsync(Item(HostItemKind.Movie, "18")));
    }

    [Fact]
    public async Task ConfigurationGenerationAtoBtoAIsDetectedAndPublishesNothing()
    {
        var harness = new Harness();
        var original = harness.Config;
        harness.Handler.BeforeResponse = _ =>
        {
            harness.Provider.Current = ActiveConfig(apiKey: "replacement-key");
            harness.Provider.Current = original;
        };

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "19"));

        AssertInvisible(result);
        Assert.Single(harness.Handler.Sent);
    }

    [Theory]
    [InlineData(1, SeerrItemRequestStatus.Unavailable, true)]
    [InlineData(2, SeerrItemRequestStatus.Pending, false)]
    [InlineData(3, SeerrItemRequestStatus.AlreadyRequested, false)]
    [InlineData(4, SeerrItemRequestStatus.Partial, false)]
    [InlineData(5, SeerrItemRequestStatus.Approved, false)]
    [InlineData(6, SeerrItemRequestStatus.Denied, false)]
    [InlineData(7, SeerrItemRequestStatus.Unavailable, true)]
    public async Task ClosedMediaStatusesMapWithoutProviderBodyLeak(
        int providerStatus,
        SeerrItemRequestStatus expected,
        bool requestable)
    {
        var harness = new Harness();
        harness.SetBody(JsonSerializer.Serialize(new
        {
            mediaInfo = new
            {
                status = providerStatus,
                status4k = providerStatus,
                requests = Array.Empty<object>(),
            },
        }));

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "20"));

        Assert.Equal(expected, result.StandardStatus);
        Assert.Equal(expected, result.FourKStatus);
        Assert.Equal(requestable, result.StandardRequestAvailable);
        Assert.Equal(requestable, result.FourKRequestAvailable);
    }

    [Theory]
    [InlineData(1, SeerrItemRequestStatus.Pending, false)]
    [InlineData(2, SeerrItemRequestStatus.Approved, false)]
    [InlineData(3, SeerrItemRequestStatus.Denied, true)]
    [InlineData(4, SeerrItemRequestStatus.Failed, true)]
    [InlineData(5, SeerrItemRequestStatus.Approved, false)]
    public async Task ClosedRequestRowsRefineUnknownOrDeletedState(
        int requestStatus,
        SeerrItemRequestStatus expected,
        bool requestable)
    {
        var harness = new Harness();
        harness.SetBody(JsonSerializer.Serialize(new
        {
            mediaInfo = new
            {
                status = 7,
                status4k = 7,
                requests = new[]
                {
                    new { status = requestStatus, is4k = false },
                    new { status = requestStatus, is4k = true },
                },
            },
        }));

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "21"));

        Assert.Equal(expected, result.StandardStatus);
        Assert.Equal(expected, result.FourKStatus);
        Assert.Equal(requestable, result.StandardRequestAvailable);
        Assert.Equal(requestable, result.FourKRequestAvailable);
    }

    [Fact]
    public async Task AbsentOrNullMediaInfoIsAuthoritativeRequestableUnavailableState()
    {
        var absent = new Harness();
        absent.SetBody("{\"title\":\"no media row\"}");
        var absentResult = await absent.InvokeAsync(Item(HostItemKind.Movie, "22"));
        Assert.Equal(SeerrItemRequestStatus.Unavailable, absentResult.StandardStatus);
        Assert.True(absentResult.StandardRequestAvailable);

        var nullMedia = new Harness();
        nullMedia.SetBody("{\"mediaInfo\":null}");
        var nullResult = await nullMedia.InvokeAsync(Item(HostItemKind.Movie, "22"));
        Assert.Equal(SeerrItemRequestStatus.Unavailable, nullResult.StandardStatus);
        Assert.True(nullResult.StandardRequestAvailable);
    }

    [Fact]
    public async Task ProviderFailureMalformedDeepOrOversizedStateFailsClosedWithNoActions()
    {
        var providerError = new Harness();
        providerError.Handler.ResponseFactory = _ => JsonResponse("{}", HttpStatusCode.InternalServerError);
        AssertInvisible(await providerError.InvokeAsync(Item(HostItemKind.Movie, "23")));

        var transportFailure = new Harness();
        transportFailure.Handler.ResponseFactory = _ => throw new HttpRequestException(
            "https://secret.example/saved-secret-must-not-escape");
        AssertInvisible(await transportFailure.InvokeAsync(Item(HostItemKind.Movie, "23")));

        var malformed = new Harness();
        malformed.SetBody("{\"mediaInfo\":{\"status\":99,\"status4k\":1}}");
        AssertInvisible(await malformed.InvokeAsync(Item(HostItemKind.Movie, "23")));

        var deep = new Harness();
        deep.SetBody("{\"mediaInfo\":null,\"deep\":" + new string('[', 20) + "0" + new string(']', 20) + "}");
        AssertInvisible(await deep.InvokeAsync(Item(HostItemKind.Movie, "23")));

        var oversized = new Harness();
        oversized.SetBody("{\"padding\":\"" + new string('x', (256 * 1024) + 1) + "\"}");
        AssertInvisible(await oversized.InvokeAsync(Item(HostItemKind.Movie, "23")));

        var standardOnly = new Harness();
        standardOnly.Admission.SetResolutions(Found(permissions: SeerrPermission.REQUEST_MOVIE));
        standardOnly.SetBody("{\"mediaInfo\":{\"status\":99}}");
        AssertInvisible(await standardOnly.InvokeAsync(Item(HostItemKind.Movie, "23")));
    }

    [Fact]
    public async Task ProviderFailureOmitsWithoutPublishingIdentityOrRevisionEvidence()
    {
        var harness = new Harness();
        harness.Admission.SetResolutions(
            Found(userId: 27),
            new SeerrRequestIdentityResolution(SeerrRequestIdentityStatus.NotFound, default));
        harness.Handler.ResponseFactory = _ => JsonResponse("{}", HttpStatusCode.InternalServerError);

        var result = await harness.InvokeAsync(Item(HostItemKind.Movie, "231"));

        AssertInvisible(result);
        Assert.Equal(1, harness.Admission.ResolutionCalls);
    }

    [Fact]
    public async Task OversizedOrMalformedRequestRelationFailsClosed()
    {
        var tooMany = new Harness();
        var rows = string.Join(',', Enumerable.Repeat("{\"status\":1,\"is4k\":false}", 65));
        tooMany.SetBody("{\"mediaInfo\":{\"status\":1,\"status4k\":1,\"requests\":[" + rows + "]}}");
        AssertInvisible(await tooMany.InvokeAsync(Item(HostItemKind.Movie, "24")));

        var malformed = new Harness();
        malformed.SetBody("{\"mediaInfo\":{\"status\":1,\"status4k\":1,\"requests\":[{\"status\":\"pending\"}]}}");
        AssertInvisible(await malformed.InvokeAsync(Item(HostItemKind.Movie, "24")));
    }

    [Fact]
    public async Task TwoUsersStaySourceIdentityScopedAndRevisionsDoNotExposeSecretsOrForeignRows()
    {
        const string providerSecret = "provider-secret-value";
        const string foreignName = "other-user@example.invalid";
        var first = new Harness(actorId: Guid.Parse("11111111-1111-1111-1111-111111111111"));
        first.Admission.SetResolutions(Found(userId: 27));
        first.SetBody(JsonSerializer.Serialize(new
        {
            mediaInfo = new
            {
                status = 3,
                status4k = 1,
                requests = new[]
                {
                    new
                    {
                        status = 2,
                        is4k = false,
                        requestedBy = new { displayName = foreignName },
                        apiKey = providerSecret,
                    },
                },
            },
            baseUrl = "https://secret.example",
        }));
        var firstResult = await first.InvokeAsync(Item(HostItemKind.Movie, "25"));

        var second = new Harness(actorId: Guid.Parse("22222222-2222-2222-2222-222222222222"));
        second.Admission.SetResolutions(Found(userId: 91));
        second.SetBody(first.ProviderBody);
        var secondResult = await second.InvokeAsync(Item(HostItemKind.Movie, "25"));

        Assert.NotEqual(firstResult.UserRevision, secondResult.UserRevision);
        Assert.Equal("27", Assert.Single(Assert.Single(first.Handler.Requests).Headers.GetValues("X-Api-User")));
        Assert.Equal("91", Assert.Single(Assert.Single(second.Handler.Requests).Headers.GetValues("X-Api-User")));
        var published = JsonSerializer.Serialize(new[] { firstResult, secondResult });
        Assert.DoesNotContain("saved-api-key", published, StringComparison.Ordinal);
        Assert.DoesNotContain("seerr.example", published, StringComparison.Ordinal);
        Assert.DoesNotContain(providerSecret, published, StringComparison.Ordinal);
        Assert.DoesNotContain(foreignName, published, StringComparison.Ordinal);
        Assert.DoesNotContain("requestedBy", published, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ProviderRevisionIgnoresHiddenEditionAndNonWinningForeignRows()
    {
        var actorId = Guid.Parse("33333333-3333-3333-3333-333333333333");
        var item = Item(HostItemKind.Movie, "251");
        var first = new Harness(actorId: actorId);
        first.Admission.SetResolutions(Found(permissions: SeerrPermission.REQUEST_MOVIE));
        first.SetBody("{\"mediaInfo\":{\"status\":3,\"status4k\":2,\"requests\":[]}}");
        var firstResult = await first.InvokeAsync(item);

        var second = new Harness(actorId: actorId);
        second.Admission.SetResolutions(Found(permissions: SeerrPermission.REQUEST_MOVIE));
        second.SetBody("{\"mediaInfo\":{\"status\":3,\"status4k\":5,\"requests\":["
            + "{\"status\":3,\"is4k\":false,\"requestedBy\":{\"id\":999}},"
            + "{\"status\":4,\"is4k\":false,\"requestedBy\":{\"id\":998}},"
            + "{\"status\":2,\"is4k\":true,\"requestedBy\":{\"id\":997}}]}}");
        var secondResult = await second.InvokeAsync(item);

        Assert.Equal(SeerrItemRequestStatus.AlreadyRequested, firstResult.StandardStatus);
        Assert.Equal(firstResult.StandardStatus, secondResult.StandardStatus);
        Assert.Equal(SeerrItemRequestStatus.Unavailable, firstResult.FourKStatus);
        Assert.Equal(firstResult.FourKStatus, secondResult.FourKStatus);
        Assert.Equal(firstResult.ProviderRevision, secondResult.ProviderRevision);
    }

    [Fact]
    public void RevisionAuthorityUsesProcessSecretAndSeparatesKeysAndDomains()
    {
        const string enumerableMaterial = "27|32|https://seerr.example/root";
        using var first = new SeerrItemPresentationRevisionAuthority(
            Enumerable.Repeat((byte)0x11, 32).ToArray());
        using var second = new SeerrItemPresentationRevisionAuthority(
            Enumerable.Repeat((byte)0x22, 32).ToArray());

        var userRevision = first.Create("user", enumerableMaterial);
        var configurationRevision = first.Create("configuration", enumerableMaterial);
        var otherProcessRevision = second.Create("user", enumerableMaterial);
        var enumerableSha = "r1-" + Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(enumerableMaterial)));

        Assert.Matches("^r1-[0-9A-F]{64}$", userRevision);
        Assert.NotEqual(userRevision, configurationRevision);
        Assert.NotEqual(userRevision, otherProcessRevision);
        Assert.NotEqual(enumerableSha, userRevision);
        Assert.DoesNotContain("seerr", userRevision, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task FactoryAndInvalidSavedHeaderFailuresAreInvisibleAndNeverDispatch()
    {
        var factoryFailure = new Harness(httpClientFactory: new ThrowingHttpClientFactory());
        AssertInvisible(await factoryFailure.InvokeAsync(Item(HostItemKind.Movie, "252")));
        Assert.Empty(factoryFailure.Handler.Sent);

        var invalidHeader = new Harness();
        invalidHeader.Config.SeerrApiKey = "saved-secret\r\ninvalid-header";
        AssertInvisible(await invalidHeader.InvokeAsync(Item(HostItemKind.Movie, "252")));
        Assert.Empty(invalidHeader.Handler.Sent);
    }

    [Theory]
    [InlineData(1, 0)]
    [InlineData(2, 0)]
    [InlineData(3, 1)]
    public async Task CancellationDuringEveryHostLookupWinsBeforeDispatchOrPublication(
        int cancelOnLookup,
        int expectedDispatches)
    {
        var harness = new Harness();
        using var cancellation = new CancellationTokenSource();
        harness.Host.AccessibleLookupCallback = call =>
        {
            if (call == cancelOnLookup)
            {
                cancellation.Cancel();
            }
        };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => harness.InvokeAsync(
            Item(HostItemKind.Movie, "253"),
            cancellation.Token));
        Assert.Equal(expectedDispatches, harness.Handler.Sent.Count);
    }

    [Fact]
    public async Task CancellationPropagatesBeforeAnyProviderRead()
    {
        var harness = new Harness();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => harness.InvokeAsync(
            Item(HostItemKind.Movie, "26"),
            cancellation.Token));
        Assert.Empty(harness.Handler.Sent);
    }

    [Fact]
    public void ContractAndImplementationAreClosedBoundedAndCannotProxyGenericTraffic()
    {
        var method = Assert.Single(typeof(ISeerrItemRequestPresentationOwner).GetMethods());
        Assert.Equal("ResolveItemRequestPresentationAsync", method.Name);
        Assert.Equal(typeof(Task<SeerrItemRequestPresentation>), method.ReturnType);
        Assert.Equal(
            new[] { typeof(PlatformActor), typeof(HostAccessibleItem), typeof(CancellationToken) },
            method.GetParameters().Select(parameter => parameter.ParameterType));
        Assert.DoesNotContain(method.GetParameters(), parameter => parameter.ParameterType == typeof(string));
        Assert.DoesNotContain(method.GetParameters(), parameter => parameter.ParameterType == typeof(Uri));
        Assert.DoesNotContain(method.GetParameters(), parameter => parameter.ParameterType == typeof(HttpMethod));

        Assert.Empty(typeof(SeerrItemRequestPresentation).GetConstructors());
        Assert.All(
            typeof(SeerrItemRequestPresentation).GetProperties(BindingFlags.Public | BindingFlags.Instance),
            property => Assert.Contains(
                property.PropertyType,
                new[] { typeof(bool), typeof(string), typeof(SeerrItemRequestStatus) }));
        Assert.All(Enum.GetValues<SeerrItemRequestStatus>(), value => Assert.InRange((int)value, 0, 6));

        var source = PlatformHostSeamTests.CodeOnly(File.ReadAllText(OwnerSource()));
        Assert.Contains("MaximumProviderBodyBytes = 256 * 1024", source, StringComparison.Ordinal);
        Assert.Contains("MaximumProviderDepth = 16", source, StringComparison.Ordinal);
        Assert.Contains("MaximumRequestRows = 64", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ISeerrClient", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ProxyRequestAsync", source, StringComparison.Ordinal);
        Assert.DoesNotContain("IActionResult", source, StringComparison.Ordinal);
        Assert.DoesNotContain("HttpContext", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Controller", source, StringComparison.Ordinal);
        Assert.DoesNotContain("SeerrApiKey", source, StringComparison.Ordinal);
        Assert.DoesNotContain("SeerrUrls", source, StringComparison.Ordinal);
        Assert.DoesNotContain("exception.Message", source, StringComparison.Ordinal);
        Assert.DoesNotContain("SHA256.HashData", source, StringComparison.Ordinal);
        Assert.Contains("_revisionAuthority.Create", source, StringComparison.Ordinal);

        var constructor = Assert.Single(typeof(SeerrItemRequestPresentationOwner).GetConstructors(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic));
        Assert.Contains(
            constructor.GetParameters(),
            parameter => parameter.ParameterType == typeof(ISeerrItemPresentationRevisionAuthority));

        var authoritySource = PlatformHostSeamTests.CodeOnly(File.ReadAllText(RevisionAuthoritySource()));
        Assert.Contains("IncrementalHash.CreateHMAC", authoritySource, StringComparison.Ordinal);
        Assert.Contains("RandomNumberGenerator.GetBytes", authoritySource, StringComparison.Ordinal);
        Assert.Contains("CryptographicOperations.ZeroMemory", authoritySource, StringComparison.Ordinal);
    }

    private static string OwnerSource([CallerFilePath] string sourceFile = "")
        => Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "Jellyfin.Plugin.JellyfinCanopy",
            "Services",
            "Seerr",
            "SeerrItemRequestPresentationOwner.cs"));

    private static string RevisionAuthoritySource([CallerFilePath] string sourceFile = "")
        => Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "Jellyfin.Plugin.JellyfinCanopy",
            "Services",
            "Seerr",
            "SeerrItemPresentationRevisionAuthority.cs"));

    private static void AssertInvisible(SeerrItemRequestPresentation result)
    {
        Assert.False(result.IsVisible);
        Assert.False(result.StandardRequestAvailable);
        Assert.False(result.FourKRequestAvailable);
        Assert.Equal(SeerrItemRequestStatus.Unavailable, result.StandardStatus);
        Assert.Equal(SeerrItemRequestStatus.Unavailable, result.FourKStatus);
        Assert.Equal(string.Empty, result.ConfigurationRevision);
        Assert.Equal(string.Empty, result.UserRevision);
        Assert.Equal(string.Empty, result.ItemRevision);
        Assert.Equal(string.Empty, result.ProviderRevision);
    }

    private static void AssertRevisions(SeerrItemRequestPresentation result)
    {
        Assert.Matches("^r1-[0-9A-F]{64}$", result.ConfigurationRevision);
        Assert.Matches("^r1-[0-9A-F]{64}$", result.UserRevision);
        Assert.Matches("^r1-[0-9A-F]{64}$", result.ItemRevision);
        Assert.Matches("^r1-[0-9A-F]{64}$", result.ProviderRevision);
    }

    private static HostAccessibleItem Item(HostItemKind kind, string tmdbId)
        => new(
            Guid.NewGuid(),
            kind,
            null,
            ImmutableArray.Create(new HostProviderReference("Tmdb", tmdbId)));

    private static SeerrRequestIdentityResolution Found(
        int userId = 27,
        SeerrPermission permissions = SeerrPermission.REQUEST | SeerrPermission.REQUEST_4K,
        string source = "https://seerr.example/root")
        => new(
            SeerrRequestIdentityStatus.Found,
            new SeerrRequestIdentity(userId, permissions, source));

    private static PluginConfiguration ActiveConfig(string apiKey = "saved-api-key")
        => new()
        {
            SeerrEnabled = true,
            SeerrUrls = "https://seerr.example/root",
            SeerrApiKey = apiKey,
            SeerrEnable4KRequests = true,
            SeerrEnable4KTvRequests = true,
        };

    private static HttpResponseMessage JsonResponse(
        string body,
        HttpStatusCode status = HttpStatusCode.OK)
        => new(status)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };

    private sealed class Harness
    {
        public Harness(
            bool isElevated = false,
            Guid? actorId = null,
            IHttpClientFactory? httpClientFactory = null,
            byte[]? revisionKey = null)
        {
            Config = ActiveConfig();
            Provider = new GenerationConfigProvider(Config);
            Admission.SetResolutions(Found());
            Admission.SetCapabilities(new Seerr4kCapability(true, true, true, true));
            Actor = new PlatformActor(
                actorId ?? Guid.NewGuid(),
                isElevated,
                "correlation",
                null,
                null);
            Host.IsAdministrator = isElevated;
            SetBody("{\"mediaInfo\":{\"status\":1,\"status4k\":1,\"requests\":[]}}");
            Owner = new SeerrItemRequestPresentationOwner(
                httpClientFactory ?? new RecordingHttpClientFactory(Handler),
                Provider,
                Host,
                Admission,
                Parental,
                new SeerrItemPresentationRevisionAuthority(
                    revisionKey ?? Enumerable.Repeat((byte)0x5A, 32).ToArray()),
                NullLogger<SeerrItemRequestPresentationOwner>.Instance);
        }

        public PluginConfiguration Config { get; }

        public GenerationConfigProvider Provider { get; }

        public FakeHost Host { get; } = new();

        public FakeAdmission Admission { get; } = new();

        public FakeParentalFilter Parental { get; } = new();

        public RecordingHttpMessageHandler Handler { get; } = new();

        public SeerrItemRequestPresentationOwner Owner { get; }

        public PlatformActor Actor { get; }

        public string ProviderBody { get; private set; } = string.Empty;

        public void SetBody(string body)
        {
            ProviderBody = body;
            Handler.ResponseFactory = _ => JsonResponse(body);
        }

        public Task<SeerrItemRequestPresentation> InvokeAsync(
            HostAccessibleItem item,
            CancellationToken cancellationToken = default)
        {
            Host.AdmittedItem = item;
            return Owner.ResolveItemRequestPresentationAsync(
                Actor,
                item,
                cancellationToken);
        }
    }

    private sealed class GenerationConfigProvider : IPluginConfigProvider
    {
        private PluginConfiguration? _current;
        private long _revision = 1;

        public GenerationConfigProvider(PluginConfiguration current) => _current = current;

        public PluginConfiguration? Current
        {
            get => _current;
            set
            {
                _current = value;
                _revision++;
            }
        }

        public PluginConfiguration Configuration => Current ?? throw new InvalidOperationException();

        public PluginConfiguration? ConfigurationOrNull => Current;

        public long ConfigurationRevision => _revision;

        public PluginConfigurationSnapshot GetSnapshot() => new(Current, _revision);
    }

    private sealed class FakeAdmission : ISeerrMediaRequestAdmission
    {
        private readonly List<SeerrRequestIdentityResolution> _resolutions = new();
        private readonly List<Seerr4kCapability> _capabilities = new();

        public int ResolutionCalls { get; private set; }

        public int CapabilityCalls { get; private set; }

        public int InvalidationCalls { get; private set; }

        public List<SeerrRequestIdentityResolutionMode> ResolutionModes { get; } = new();

        public void SetResolutions(params SeerrRequestIdentityResolution[] values)
        {
            _resolutions.Clear();
            _resolutions.AddRange(values);
            ResolutionCalls = 0;
            ResolutionModes.Clear();
        }

        public void SetCapabilities(params Seerr4kCapability[] values)
        {
            _capabilities.Clear();
            _capabilities.AddRange(values);
            CapabilityCalls = 0;
        }

        public Task<SeerrRequestIdentityResolution> ResolveAsync(
            Guid jellyfinUserId,
            SeerrRequestIdentityResolutionMode mode,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ResolutionModes.Add(mode);
            var index = Math.Min(ResolutionCalls, _resolutions.Count - 1);
            ResolutionCalls++;
            return Task.FromResult(_resolutions[index]);
        }

        public Task<Seerr4kCapability> Get4kCapabilityAsync(
            SeerrRequestIdentity admittedIdentity,
            bool isAdministrator,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var index = Math.Min(CapabilityCalls, _capabilities.Count - 1);
            CapabilityCalls++;
            return Task.FromResult(_capabilities[index]);
        }

        public void InvalidateIdentity(Guid jellyfinUserId) => InvalidationCalls++;
    }

    private sealed class FakeParentalFilter : ISeerrParentalFilter
    {
        private readonly Queue<bool> _decisions = new();

        public bool Blocked { get; set; }

        public int Calls { get; private set; }

        public void SetDecisions(params bool[] decisions)
        {
            _decisions.Clear();
            foreach (var decision in decisions)
            {
                _decisions.Enqueue(decision);
            }

            Calls = 0;
        }

        public Task<SeerrParentalResult> ApplyAsync(
            string json,
            string apiPath,
            SeerrCaller caller)
            => Task.FromResult(new SeerrParentalResult(false, json));

        public Task<bool> IsBlockedAsync(
            string mediaType,
            int tmdbId,
            SeerrCaller caller)
        {
            Calls++;
            return Task.FromResult(_decisions.Count > 0 ? _decisions.Dequeue() : Blocked);
        }

        public Task<bool> IsTmdbProxyPathBlockedAsync(
            string tmdbApiPath,
            SeerrCaller caller)
            => Task.FromResult(false);
    }

    private sealed class FakeHost : IPlatformHost
    {
        public FakeHost()
        {
            Users = new FakeUsers(this);
            Library = new FakeLibrary(this);
        }

        public bool UserExists { get; set; } = true;

        public bool IsAdministrator { get; set; }

        public bool ItemAccessible { get; set; } = true;

        public HostAccessibleItem AdmittedItem { get; set; }

        public Func<HostAccessibleItem, HostAccessibleItem>? ItemTransform { get; set; }

        public Action<int>? AccessibleLookupCallback { get; set; }

        public int AccessibleLookupCalls { get; private set; }

        public IHostUsers Users { get; }

        public IHostLibrary Library { get; }

        public IHostSessions Sessions { get; } = new EmptySessions();

        public IHostPlugins Plugins { get; } = new EmptyPlugins();

        private sealed class FakeUsers(FakeHost owner) : IHostUsers
        {
            public HostUser? Find(Guid id)
                => owner.UserExists
                    ? new HostUser(id, "current-user", owner.IsAdministrator)
                    : null;

            public IReadOnlyList<HostUser> All() => Array.Empty<HostUser>();
        }

        private sealed class FakeLibrary(FakeHost owner) : IHostLibrary
        {
            public HostItem? Find(Guid id) => null;

            public HostItemAccessResult FindAccessible(Guid userId, Guid itemId)
            {
                owner.AccessibleLookupCalls++;
                owner.AccessibleLookupCallback?.Invoke(owner.AccessibleLookupCalls);
                if (!owner.ItemAccessible
                    || !owner.UserExists
                    || owner.AdmittedItem.Id != itemId)
                {
                    return HostItemAccessResult.NotAccessible;
                }

                return HostItemAccessResult.Accessible(
                    owner.ItemTransform?.Invoke(owner.AdmittedItem) ?? owner.AdmittedItem);
            }

            public IReadOnlyList<HostItem> ChildrenOf(Guid id) => Array.Empty<HostItem>();
        }
    }

    private sealed class EmptySessions : IHostSessions
    {
        public IReadOnlyList<HostSession> Active() => Array.Empty<HostSession>();

        public IReadOnlyList<HostSession> ForUser(Guid userId) => Array.Empty<HostSession>();
    }

    private sealed class EmptyPlugins : IHostPlugins
    {
        public IReadOnlyList<HostPlugin> Installed() => Array.Empty<HostPlugin>();

        public HostPlugin? Find(Guid id) => null;
    }

    private sealed class ThrowingHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name)
            => throw new InvalidOperationException("factory-secret-must-not-escape");
    }
}
