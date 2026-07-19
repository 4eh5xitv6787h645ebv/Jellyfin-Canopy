using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

/// <summary>
/// Architecture guard for the Seerr master switch. The old bug existed because
/// several entry points independently interpreted retained URL/key fields as an
/// enabled integration. This guard makes the policy owner and the deliberately
/// narrow administrator setup probes explicit.
/// </summary>
public sealed class SeerrIntegrationEntryPointGuardTests
{
    private static readonly Regex DirectMasterRead = new(
        @"\.SeerrEnabled\b",
        RegexOptions.Compiled);

    private static readonly Regex OutboundSeerrCall = new(
        @"\bSeerrHttpHelper\.(?:CreateClient|BuildRequest|SendAndReadJsonAsync|SendResponseHeadersReadAsync|SendSetupAndReadJsonAsync|ReadResponseAsync)\s*\("
        + @"|\bSeerrPaginationHelper\.FetchAll(?:Sources)?Async\s*\("
        + @"|\bSeerrUserImportHelper\.BulkImportAsync\s*\(",
        RegexOptions.Compiled);

    private static readonly Regex DispatchingSeerrCall = new(
        @"\bSeerrHttpHelper\.(?:SendAndReadJsonAsync|SendResponseHeadersReadAsync|SendSetupAndReadJsonAsync)\s*\("
        + @"|\bSeerrPaginationHelper\.FetchAll(?:Sources)?Async\s*\("
        + @"|\bSeerrUserImportHelper\.BulkImportAsync\s*\(",
        RegexOptions.Compiled);

    private static readonly Regex RawHttpDispatch = new(
        @"\.\s*(?:SendAsync|GetAsync|PostAsync|PutAsync|DeleteAsync|PatchAsync)\s*\(",
        RegexOptions.Compiled);

    private static readonly Regex SeerrClientCreation = new(
        @"\bSeerrHttpHelper\.CreateClient\s*\(|\b_httpClientFactory\.CreateClient\s*\(",
        RegexOptions.Compiled);

    private static readonly Regex MethodDeclaration = new(
        @"(?m)^[ \t]*(?:public|private|protected|internal)\s+"
        + @"(?:(?:static|async|virtual|override|sealed|new|unsafe|readonly|partial|extern)\s+)*"
        + @"[^\r\n{;=]+?\b(?<name>[A-Za-z_]\w*)(?:<[^>{}]*>)?\s*"
        + @"\((?:[^(){};]|\([^(){};]*\))*\)\s*(?:where\s+[^\{=>]+)?(?<body>\{|=>)",
        RegexOptions.Compiled);

    private static readonly HashSet<string> TransportOnlyHelpers = new(StringComparer.Ordinal)
    {
        "Helpers/Seerr/SeerrHttpHelper.cs",
        "Helpers/Seerr/SeerrPaginationHelper.cs",
        "Helpers/Seerr/SeerrUserImportHelper.cs",
    };

    // These exact lower-level methods are transport delegates reached only from
    // policy-gated operations. Keeping the inventory at method granularity means
    // a new outbound method in an otherwise compliant file is rejected.
    private static readonly HashSet<string> ReviewedDelegatedTransportMethods = new(StringComparer.Ordinal)
    {
        "Controllers/ArrRequestsController.cs:EnrichWithTmdbData",
        "Controllers/ArrRequestsController.cs:FetchComingSoonCollectionAsync",
        "Controllers/ArrRequestsController.cs:FetchRequestListCollectionAsync",
        "Controllers/ArrRequestsController.cs:FetchUserRequestSnapshotAsync",
        "Controllers/SeerrProxyController.cs:EnrichQuotaWithResetAsync",
        "Controllers/SeerrProxyController.cs:FetchQuotaRequestHistoryAsync",
        "Controllers/SeerrProxyController.cs:GetSeerrQuota",
        "ScheduledTasks/JellyfinToSeerrWatchlistSyncTask.cs:AddToSeerrWatchlist",
        "ScheduledTasks/JellyfinToSeerrWatchlistSyncTask.cs:FetchSeerrUserMapSnapshotAsync",
        "ScheduledTasks/JellyfinToSeerrWatchlistSyncTask.cs:FetchSeerrUserMapSnapshotsAsync",
        "ScheduledTasks/JellyfinToSeerrWatchlistSyncTask.cs:FetchSeerrWatchlistSnapshotAsync",
        "ScheduledTasks/JellyfinToSeerrWatchlistSyncTask.cs:HasFreshExactBindingAsync",
        "ScheduledTasks/SeerrWatchlistSyncTask.cs:FetchSeerrRequestSnapshotAsync",
        "ScheduledTasks/SeerrWatchlistSyncTask.cs:FetchSeerrUserMapSnapshotAsync",
        "ScheduledTasks/SeerrWatchlistSyncTask.cs:FetchSeerrUserMapSnapshotsAsync",
        "ScheduledTasks/SeerrWatchlistSyncTask.cs:FetchSeerrWatchlistSnapshotAsync",
        "Services/AutoMovieRequestService.cs:GetNextMovieInCollectionAsync",
        "Services/AutoMovieRequestService.cs:GetOriginalMovieQualityProfileAsync",
        "Services/AutoSeasonRequestService.cs:GetSeasonStatusFromSeerr",
        "Services/AutoSeasonRequestService.cs:GetSeriesDetailsJsonAsync",
        "Services/Seerr/AvatarFetchService.cs:CompleteFlightAsync",
        "Services/Seerr/AvatarFetchService.cs:FetchLeaderAsync",
        "Services/Seerr/SeerrClient.cs:FetchExactUserBindingAsync",
        "Services/Seerr/SeerrClient.cs:GetPublic4kSettingsAsync",
        "Services/Seerr/SeerrClient.cs:TryAutoImportSeerrUser",
        "Services/Seerr/SeerrParentalFilter.cs:FetchDetailFromSeerrAsync",
        "Services/Seerr/SeerrParentalFilter.cs:FetchDetailAsync",
        "Services/Seerr/SeerrParentalFilter.cs:FetchSignatureAsync",
        "Services/Seerr/SeerrParentalFilter.cs:FilterListAsync",
        "Services/Seerr/SeerrParentalFilter.cs:GetSignatureAsync",
        "Services/Seerr/SeerrParentalFilter.cs:ApplyAsync",
        "Services/Seerr/SeerrParentalFilter.cs:IsBlockedAsync",
        "Services/Seerr/SeerrParentalFilter.cs:IsTitleBlockedAsync",
        "Services/Seerr/SeerrParentalFilter.cs:IsTmdbProxyPathBlockedAsync",
        "Services/Seerr/SeerrParentalFilter.cs:ResolveScoresAsync",
        "Services/SeerrScanTriggerService.cs:DispatchAsync",
        "Services/SeerrScanTriggerService.cs:ExecutePlanAsync",
        "Services/SeerrScanTriggerService.cs:OnDebounceElapsed",
        "Services/SeerrScanTriggerService.cs:PostScanTrigger",
        "Services/SeerrScanTriggerService.cs:QueueAutomaticPlanLocked",
        "Services/SeerrScanTriggerService.cs:RunWorkerAsync",
        "Services/SeerrScanTriggerService.cs:StartPlanLocked",
        "Services/WatchlistMonitor.cs:GetAllSeerrRequests",
        "Services/WatchlistMonitor.cs:FetchAllRequestsSnapshotAsync",
        "Services/WatchlistMonitor.cs:FetchAllRequestsSnapshotsAsync",
        "Services/WatchlistMonitor.cs:FetchAllUserSnapshotsAsync",
    };

    private static readonly HashSet<string> PinnedElevatedSetupTransportMethods = new(StringComparer.Ordinal)
    {
        "Controllers/ArrLinksController.cs:IdentifyUrl",
        "Controllers/ArrLinksController.cs:ValidateArrService",
        "Controllers/SeerrProxyController.cs:ValidateSeerr",
    };

    private static readonly HashSet<string> ExactElevatedSetupEntryPoints = new(StringComparer.Ordinal)
    {
        "Controllers/ArrLinksController.cs:IdentifyUrl",
        "Controllers/ArrLinksController.cs:ValidateRadarr",
        "Controllers/ArrLinksController.cs:ValidateSonarr",
        "Controllers/SeerrProxyController.cs:ValidateSeerr",
    };

    private static readonly HashSet<string> ElevatedSetupDelegates = new(StringComparer.Ordinal)
    {
        "Controllers/ArrLinksController.cs:ValidateArrService",
    };

    private static readonly HashSet<string> ExactSetupOnlySendOwners = new(StringComparer.Ordinal)
    {
        "Controllers/SeerrProxyController.cs:ValidateSeerr",
    };

    private static readonly Dictionary<string, RawEdgeContract> ExactNonSeerrRawTransportMethods = new(StringComparer.Ordinal)
    {
        ["Controllers/ItemInfoController.cs:GetTmdbPersonData"] = new(1, "CreateTmdbClient", "https://api.themoviedb.org", "httpClient.GetAsync(tmdbUrl)"),
        ["Controllers/SeerrProxyController.cs:ProxyTmdbRequest"] = new(1, "CreateTmdbClient", "https://api.themoviedb.org", ".GetAsync(requestUri, HttpContext.RequestAborted)"),
        ["Controllers/SeerrProxyController.cs:ValidateTmdb"] = new(1, "CreateTmdbClient", "https://api.themoviedb.org", "httpClient.GetAsync(requestUri)"),
        ["Services/Arr/ArrFetchService.cs:SendAndMapAsync"] = new(1, "CreateArrClient", "client.SendAsync(request, ct)"),
        ["Services/Arr/ArrTagService.cs:FetchTagsAndItemsAsync"] = new(2, "CreateArrClient", "httpClient.SendAsync(tagsRequest, ct)", "httpClient.SendAsync(mediaRequest, ct)"),
        ["Services/AssetCacheService.cs:FetchAssetAsync"] = new(1, "CreateAssetsClient", "new HttpRequestMessage(HttpMethod.Get, asset.UpstreamUrl)", "client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)"),
        ["Services/AutoMovieRequestService.cs:GetTmdbCollectionIdAsync"] = new(1, "CreateTmdbClient", "https://api.themoviedb.org", "httpClient.GetAsync(requestUrl)"),
        ["Services/AnimeFiller/JikanAnimeFillerProvider.cs:ResolveAniListIdAsync"] = new(1, "PluginHttpClients.AniListClient", "type: ANIME", "client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, requestDeadline.Token)"),
        ["Services/AnimeFiller/JikanAnimeFillerProvider.cs:GetJikanJsonAsync"] = new(1, "PluginHttpClients.JikanClient", "client.GetAsync(relativePath, HttpCompletionOption.ResponseHeadersRead, requestDeadline.Token)"),
        ["Services/Seerr/SeerrParentalFilter.cs:FetchCertFromTmdbAsync"] = new(1, "CreateTmdbClient", "https://api.themoviedb.org", "httpClient.GetAsync(requestUri, ct)"),
    };

    private static readonly Dictionary<string, RawEdgeContract> ExactSetupRawTransportMethods = new(StringComparer.Ordinal)
    {
        ["Controllers/ArrLinksController.cs:ValidateArrService"] = new(1, "BuildArrRequest", "http.SendAsync(request)"),
        ["Controllers/ArrLinksController.cs:IdentifyUrl"] = new(
            4,
            "http.GetAsync($\"{cleanUrl}/api/v3/system/status\")",
            "http.GetAsync($\"{cleanUrl}/System/Info/Public\")",
            "http.GetAsync($\"{cleanUrl}/api/v1/status\")",
            "http.GetAsync(cleanUrl, HttpCompletionOption.ResponseHeadersRead)"),
    };

    [Fact]
    public void OnlyCentralPolicyReadsTheMasterSwitch()
    {
        var offenders = SourceFiles()
            .Select(path => (Path: path, Relative: Relative(path), Source: StripComments(File.ReadAllText(path))))
            .Where(file => DirectMasterRead.IsMatch(file.Source))
            .Where(file => file.Relative != "Services/Seerr/SeerrIntegrationPolicy.cs")
            // This descriptor only projects the setting to authenticated clients;
            // it does not authorize an outbound operation.
            .Where(file => file.Relative != "Configuration/SettingDescriptors.cs")
            .Select(file => file.Relative)
            .ToArray();

        Assert.True(
            offenders.Length == 0,
            "Production code reads SeerrEnabled outside SeerrIntegrationPolicy: "
            + string.Join(", ", offenders)
            + ". Capture the central policy (or use its scheduling-only gate) instead of interpreting retained credentials locally.");
    }

    [Fact]
    public void OnlyOpaqueDispatchFenceMayStoreBooleanAuthorizationDelegates()
    {
        var offenders = SourceFiles()
            .Select(path => (Relative: Relative(path), Source: StripComments(File.ReadAllText(path))))
            .Where(file => file.Relative != "Services/Seerr/SeerrIntegrationPolicy.cs")
            .Where(file => Regex.IsMatch(file.Source, @"\bFunc\s*<\s*bool\s*>"))
            .Select(file => file.Relative)
            .ToArray();

        Assert.True(
            offenders.Length == 0,
            "Production authorization/publication boundaries use arbitrary Func<bool>: "
            + string.Join(", ", offenders)
            + ". Accept SeerrDispatchFence and narrow it through Restrict instead.");
    }

    [Fact]
    public void NoCacheOnlyStatusOwnerCanPublishActiveOutsideCurrentPolicy()
    {
        var source = StripComments(File.ReadAllText(SourcePath("Services/Seerr/SeerrClient.cs")));

        Assert.DoesNotContain("IsSeerrReachableCached", source, StringComparison.Ordinal);
        Assert.DoesNotContain("SeerrStatusCache.Value.Active", source, StringComparison.Ordinal);
    }

    [Fact]
    public void EveryOutboundOwnerUsesCentralPolicyOrIsReviewedTransportPlumbing()
    {
        var offenders = new List<string>();
        foreach (var path in SourceFiles())
        {
            var relative = Relative(path);
            var source = StripComments(File.ReadAllText(path));
            if (!OutboundSeerrCall.IsMatch(source) || TransportOnlyHelpers.Contains(relative))
            {
                continue;
            }

            var policyDominatedMethods = FindPolicyDominatedMethods(relative, source);

            foreach (Match call in OutboundSeerrCall.Matches(source))
            {
                var method = FindContainingMethod(source, call.Index);
                if (method == null)
                {
                    offenders.Add(relative + " (could not identify outbound owner)");
                }
                else
                {
                    var owner = relative + ":" + method.Name;
                    if (!IsAuthorizedOutboundOwner(
                            method,
                            call.Index - method.Start,
                            owner,
                            ReviewedDelegatedTransportMethods,
                            PinnedElevatedSetupTransportMethods,
                            DispatchingSeerrCall.IsMatch(call.Value)))
                    {
                        offenders.Add(owner);
                    }
                }
            }

            offenders.AddRange(FindUngatedDelegateCallers(
                relative,
                source,
                policyDominatedMethods: policyDominatedMethods));

        }

        Assert.True(
            offenders.Count == 0,
            "Outbound Seerr owner(s) bypass the central integration policy:\n  "
            + string.Join("\n  ", offenders)
            + "\nOnly transport-only helpers and the named elevated setup probes may omit policy capture.");
    }

    [Fact]
    public void EveryRawHttpDispatchIsExactlyClassifiedOrOpaqueFenced()
    {
        var offenders = new List<string>();
        foreach (var path in SourceFiles())
        {
            var relative = Relative(path);
            var source = File.ReadAllText(path);
            foreach (Match dispatch in RawHttpDispatch.Matches(source))
            {
                var method = FindContainingMethod(source, dispatch.Index);
                if (method == null)
                {
                    offenders.Add(relative + " (could not identify raw HTTP owner)");
                    continue;
                }

                var owner = relative + ":" + method.Name;
                if (IsAuthorizedRawTransportHelper(relative, method)
                    || (ExactNonSeerrRawTransportMethods.TryGetValue(owner, out var nonSeerrContract)
                        && RawOwnerMatchesContract(method, nonSeerrContract))
                    || (ExactSetupRawTransportMethods.TryGetValue(owner, out var setupContract)
                        && PinnedElevatedSetupTransportMethods.Contains(owner)
                        && RawOwnerMatchesContract(method, setupContract)))
                {
                    continue;
                }

                if (!IsAuthorizedOutboundOwner(
                        method,
                        dispatch.Index - method.Start,
                        owner,
                        ReviewedDelegatedTransportMethods,
                        PinnedElevatedSetupTransportMethods,
                        requiresFreshFence: true))
                {
                    var contractDetail = ExactNonSeerrRawTransportMethods.TryGetValue(owner, out var expected)
                        ? $" (calls={RawHttpDispatch.Matches(method.Source).Count}/{expected.ExpectedCalls}; missing={string.Join("|", expected.RequiredMarkers.Where(marker => !method.Source.Contains(marker, StringComparison.Ordinal)))})"
                        : string.Empty;
                    offenders.Add(owner + contractDetail);
                }
            }
        }

        Assert.True(
            offenders.Count == 0,
            "Raw HTTP dispatch owner(s) are neither exactly classified nor opaque-fenced:\n  "
            + string.Join("\n  ", offenders));
    }

    [Fact]
    public void SetupOnlySendIsCallableOnlyFromExactElevatedSetupOwner()
    {
        var offenders = new List<string>();
        var owners = new List<string>();
        foreach (var path in SourceFiles())
        {
            var relative = Relative(path);
            if (TransportOnlyHelpers.Contains(relative)) continue;
            var source = StripComments(File.ReadAllText(path));
            foreach (Match call in Regex.Matches(source, @"\bSeerrHttpHelper\.SendSetupAndReadJsonAsync\s*\("))
            {
                var method = Assert.IsType<MethodSource>(FindContainingMethod(source, call.Index));
                var owner = relative + ":" + method.Name;
                owners.Add(owner);
                if (!IsAuthorizedSetupOnlyOwner(relative, source, method)) offenders.Add(owner);
            }
        }

        Assert.Empty(offenders);
        Assert.Equal(ExactSetupOnlySendOwners, owners.ToHashSet(StringComparer.Ordinal));
    }

    [Fact]
    public void NormalPolicyGateCannotAuthorizeSetupOnlyTransport()
    {
        const string source = """
            internal sealed class SyntheticOwner
            {
                public void GatedButNotSetup()
                {
                    var integration = SeerrIntegrationPolicy.Capture(provider);
                    if (!integration.IsActive) return;
                    SeerrHttpHelper.SendSetupAndReadJsonAsync(client, request, url);
            }
            """;
        var method = Assert.Single(EnumerateMethods(source));

        Assert.False(IsAuthorizedSetupOnlyOwner("SyntheticOwner.cs", source, method));
    }

    [Fact]
    public void UnfencedRawTransportHelperIsRejected()
    {
        const string source = """
            internal static class SyntheticTransport
            {
                internal static Task<HttpResponseMessage> SendResponseHeadersReadAsync(
                    HttpClient client,
                    HttpRequestMessage request)
                    => client.SendAsync(request);
            }
            """;
        var method = Assert.Single(EnumerateMethods(source));

        Assert.False(IsAuthorizedRawTransportHelper(
            "Helpers/Seerr/SyntheticTransport.cs",
            method));
    }

    [Fact]
    public void GuardRejectsUngatedMethodEvenWhenAnotherMethodInTheFileUsesPolicy()
    {
        const string source = """
            internal sealed class SyntheticOwner
            {
                public void Gated()
                {
                    var integration = SeerrIntegrationPolicy.Capture(provider);
                    if (!integration.IsActive) return;
                    SeerrHttpHelper.CreateClient(factory);
                }

                public void Bypass()
                {
                    SeerrHttpHelper.CreateClient(factory);
                }
            }
            """;

        var calls = OutboundSeerrCall.Matches(source).Cast<Match>().ToArray();
        Assert.Equal(2, calls.Length);
        Assert.Contains("SeerrIntegrationPolicy.", FindContainingMethod(source, calls[0].Index)!.Source);
        var bypass = FindContainingMethod(source, calls[1].Index);
        Assert.NotNull(bypass);
        Assert.Equal("Bypass", bypass!.Name);
        Assert.DoesNotContain("SeerrIntegrationPolicy.", bypass.Source);
    }

    [Fact]
    public void GuardRejectsCaptureWithoutActiveCheckBeforeDispatch()
    {
        const string relative = "SyntheticOwner.cs";
        const string source = """
            internal sealed class SyntheticOwner
            {
                public void Bypass()
                {
                    var integration = SeerrIntegrationPolicy.Capture(provider);
                    SeerrHttpHelper.CreateClient(factory);
                }
            }
            """;

        var dominated = FindPolicyDominatedMethods(relative, source);

        Assert.DoesNotContain(relative + ":Bypass", dominated);
    }

    [Fact]
    public void GuardRejectsGatedHelperCallFollowedByIndependentDispatch()
    {
        const string relative = "SyntheticOwner.cs";
        const string source = """
            internal sealed class SyntheticOwner
            {
                public void Bypass()
                {
                    GatedHelper();
                    SeerrHttpHelper.CreateClient(factory);
                }

                private void GatedHelper()
                {
                    var integration = SeerrIntegrationPolicy.Capture(provider);
                    if (!integration.IsActive) return;
                }
            }
            """;

        var dominated = FindPolicyDominatedMethods(relative, source);

        Assert.Contains(relative + ":GatedHelper", dominated);
        Assert.DoesNotContain(relative + ":Bypass", dominated);
    }

    [Fact]
    public void GuardRejectsPolicyCheckThatOccursAfterDispatch()
    {
        const string source = """
            internal sealed class SyntheticOwner
            {
                public void Bypass()
                {
                    var integration = SeerrIntegrationPolicy.Capture(provider);
                    SeerrHttpHelper.CreateClient(factory);
                    if (!integration.IsActive) return;
                }
            }
            """;
        var call = Assert.Single(OutboundSeerrCall.Matches(source).Cast<Match>());
        var method = FindContainingMethod(source, call.Index);

        Assert.NotNull(method);
        Assert.False(HasExplicitPolicyGateBefore(method!, call.Index - method!.Start));
    }

    [Fact]
    public void GuardRejectsIgnoredActivePropertyRead()
    {
        const string source = """
            internal sealed class SyntheticOwner
            {
                public void Bypass()
                {
                    var integration = SeerrIntegrationPolicy.Capture(provider);
                    var ignored = integration.IsActive;
                    SeerrHttpHelper.CreateClient(factory);
                }
            }
            """;
        var call = Assert.Single(OutboundSeerrCall.Matches(source).Cast<Match>());
        var method = Assert.IsType<MethodSource>(FindContainingMethod(source, call.Index));

        Assert.False(HasExplicitPolicyGateBefore(method, call.Index - method.Start));
    }

    [Fact]
    public void GuardRejectsEmptyNonExitingActiveCondition()
    {
        const string source = """
            internal sealed class SyntheticOwner
            {
                public void Bypass()
                {
                    var integration = SeerrIntegrationPolicy.Capture(provider);
                    if (!integration.IsActive) { }
                    SeerrHttpHelper.CreateClient(factory);
                }
            }
            """;
        var call = Assert.Single(OutboundSeerrCall.Matches(source).Cast<Match>());
        var method = Assert.IsType<MethodSource>(FindContainingMethod(source, call.Index));

        Assert.False(HasExplicitPolicyGateBefore(method, call.Index - method.Start));
    }

    [Fact]
    public void GuardRejectsReviewedOwnerWithUnfencedDirectDispatch()
    {
        const string relative = "SyntheticOwner.cs";
        const string source = """
            internal sealed class SyntheticOwner
            {
                private void ReviewedTransport()
                {
                    SeerrHttpHelper.CreateClient(factory);
                }
            }
            """;
        var reviewed = new HashSet<string>(StringComparer.Ordinal)
        {
            relative + ":ReviewedTransport",
        };
        var call = Assert.Single(OutboundSeerrCall.Matches(source).Cast<Match>());
        var method = Assert.IsType<MethodSource>(FindContainingMethod(source, call.Index));

        Assert.False(IsAuthorizedOutboundOwner(
            method,
            call.Index - method.Start,
            relative + ":ReviewedTransport",
            reviewed,
            new HashSet<string>(StringComparer.Ordinal),
            requiresFreshFence: true));
    }

    [Fact]
    public void GuardRecognizesFactoryCreatedRawHttpDispatch()
    {
        const string source = """
            internal sealed class SyntheticOwner
            {
                public async Task Bypass()
                {
                    await _httpClientFactory.CreateClient("seerr").SendAsync(request);
                }
            }
            """;
        var method = Assert.Single(EnumerateMethods(source));

        Assert.Matches(SeerrClientCreation, method.Source);
        Assert.Single(RawHttpDispatch.Matches(method.Source).Cast<Match>());
        Assert.False(IsAuthorizedOutboundOwner(
            method,
            RawHttpDispatch.Match(method.Source).Index,
            "SyntheticOwner.cs:Bypass",
            new HashSet<string>(StringComparer.Ordinal),
            new HashSet<string>(StringComparer.Ordinal),
            requiresFreshFence: true));
    }

    [Fact]
    public void GuardRejectsParameterizedClientRawDispatchWithoutOpaqueFence()
    {
        const string source = """
            internal sealed class SyntheticOwner
            {
                public Task<HttpResponseMessage> Bypass(HttpClient client, HttpRequestMessage request)
                    => client.PatchAsync("http://seerr/api/v1/request", request.Content);
            }
            """;
        var method = Assert.Single(EnumerateMethods(source));
        var dispatch = Assert.Single(RawHttpDispatch.Matches(method.Source).Cast<Match>());

        Assert.False(IsAuthorizedOutboundOwner(
            method,
            dispatch.Index,
            "SyntheticOwner.cs:Bypass",
            new HashSet<string>(StringComparer.Ordinal),
            new HashSet<string>(StringComparer.Ordinal),
            requiresFreshFence: true));
    }

    [Fact]
    public void GuardRejectsLaterDispatchAfterAwaitWithoutFreshFence()
    {
        const string source = """
            internal sealed class SyntheticOwner
            {
                public async Task Bypass()
                {
                    var integration = SeerrIntegrationPolicy.Capture(provider);
                    if (!integration.IsActive) return;
                    SeerrHttpHelper.CreateClient(factory);
                    await PrepareAsync();
                    SeerrHttpHelper.CreateClient(factory);
                }
            }
            """;
        var calls = OutboundSeerrCall.Matches(source).Cast<Match>().ToArray();
        Assert.Equal(2, calls.Length);
        var method = Assert.IsType<MethodSource>(FindContainingMethod(source, calls[1].Index));

        Assert.True(HasExplicitPolicyGateBefore(method, calls[0].Index - method.Start));
        Assert.False(HasExplicitPolicyGateBefore(method, calls[1].Index - method.Start));
    }

    [Fact]
    public void GuardRejectsUngatedCallerOfAlreadyReviewedTransportDelegate()
    {
        const string relative = "SyntheticOwner.cs";
        const string source = """
            internal sealed class SyntheticOwner
            {
                public void Gated()
                {
                    var integration = SeerrIntegrationPolicy.Capture(provider);
                    if (!integration.IsActive) return;
                    FetchReviewedAsync();
                }

                public void Bypass()
                {
                    FetchReviewedAsync();
                }

                private void FetchReviewedAsync()
                {
                    SeerrHttpHelper.CreateClient(factory);
                }
            }
            """;
        var reviewed = new HashSet<string>(StringComparer.Ordinal)
        {
            relative + ":FetchReviewedAsync",
        };

        var offenders = FindUngatedDelegateCallers(relative, source, reviewed);

        Assert.Equal(relative + ":FetchReviewedAsync <- Bypass", Assert.Single(offenders));
    }

    [Theory]
    [InlineData("() => integration.IsCurrent(provider) || true")]
    [InlineData("() => integration?.IsCurrent(provider) ?? true")]
    [InlineData("() => !integration.IsCurrent(provider)")]
    public void GuardRejectsFailOpenPredicateArguments(string predicate)
    {
        var source = $$"""
            internal sealed class SyntheticOwner
            {
                public void Bypass()
                {
                    FetchReviewedAsync({{predicate}});
                }
            }
            """;
        var method = Assert.Single(EnumerateMethods(source));
        var call = method.Source.IndexOf("FetchReviewedAsync", StringComparison.Ordinal);

        Assert.False(InvocationPassesLivePredicate(method, call));
    }

    [Fact]
    public void GuardRejectsBlockPredicateThatReturnsAnUnrelatedBoolean()
    {
        const string source = """
            internal sealed class SyntheticOwner
            {
                public void Bypass()
                {
                    bool CanDispatch()
                    {
                        integration.IsCurrent(provider);
                        return allowed;
                    }

                    FetchReviewedAsync(CanDispatch);
                }
            }
            """;
        var method = Assert.Single(EnumerateMethods(source), method => method.Name == "Bypass");
        var call = method.Source.LastIndexOf("FetchReviewedAsync", StringComparison.Ordinal);

        Assert.False(InvocationPassesLivePredicate(method, call));
    }

    [Theory]
    [InlineData("!integration.IsCurrent(provider) && false")]
    [InlineData("!false && integration.IsCurrent(provider)")]
    [InlineData("integration.IsCurrent(provider)")]
    public void GuardRejectsFailOpenOrInvertedTerminalConditions(string condition)
    {
        var source = $$"""
            internal sealed class SyntheticOwner
            {
                public void Bypass()
                {
                    var integration = SeerrIntegrationPolicy.Capture(provider);
                    if ({{condition}}) return;
                    SeerrHttpHelper.CreateClient(factory);
                }
            }
            """;
        var call = Assert.Single(OutboundSeerrCall.Matches(source).Cast<Match>());
        var method = Assert.IsType<MethodSource>(FindContainingMethod(source, call.Index));

        Assert.False(HasExplicitPolicyGateBefore(method, call.Index - method.Start));
    }

    [Fact]
    public void GuardRejectsTruthNamedCurrentFunction()
    {
        const string source = """
            internal sealed class SyntheticOwner
            {
                public void Bypass()
                {
                    bool IsDefinitelyCurrent() => true;
                    if (!IsDefinitelyCurrent()) return;
                    SeerrHttpHelper.CreateClient(factory);
                }
            }
            """;
        var call = Assert.Single(OutboundSeerrCall.Matches(source).Cast<Match>());
        var method = Assert.IsType<MethodSource>(FindContainingMethod(source, call.Index));

        Assert.False(HasExplicitPolicyGateBefore(method, call.Index - method.Start));
    }

    [Fact]
    public void BareAuthorizeCallerCannotAuthorizeAnElevatedSetupDelegate()
    {
        const string relative = "SyntheticOwner.cs";
        const string source = """
            internal sealed class SyntheticOwner
            {
                [Authorize]
                public void BareAuthenticated()
                {
                    ValidateSetup();
                }

                private void ValidateSetup()
                {
                    _httpClientFactory.CreateClient("seerr").SendAsync(request);
                }
            }
            """;
        var delegates = new HashSet<string>(StringComparer.Ordinal)
        {
            relative + ":ValidateSetup",
        };

        var offenders = FindNonElevatedSetupCallers(relative, source, delegates);

        Assert.Equal(relative + ":ValidateSetup <- BareAuthenticated", Assert.Single(offenders));
    }

    [Fact]
    public void SetupTransportDelegatesAreReachableOnlyFromExactElevatedEntryPoints()
    {
        foreach (var entryPoint in ExactElevatedSetupEntryPoints)
        {
            var separator = entryPoint.LastIndexOf(':');
            var relative = entryPoint[..separator];
            var methodName = entryPoint[(separator + 1)..];
            var source = StripComments(File.ReadAllText(SourcePath(relative)));
            Assert.Single(EnumerateMethods(source), method => method.Name == methodName);
            Assert.True(
                HasExactElevationAttribute(source, methodName),
                $"{entryPoint} must retain the exact RequiresElevation policy.");
        }

        foreach (var grouping in ElevatedSetupDelegates.GroupBy(entry => entry[..entry.LastIndexOf(':')]))
        {
            var source = StripComments(File.ReadAllText(SourcePath(grouping.Key)));
            var offenders = FindNonElevatedSetupCallers(
                grouping.Key,
                source,
                grouping.ToHashSet(StringComparer.Ordinal),
                ExactElevatedSetupEntryPoints);
            Assert.True(
                offenders.Count == 0,
                "Setup transport delegate has a non-elevated caller: " + string.Join(", ", offenders));
        }
    }

    [Fact]
    public void UnsavedConnectionValidationIsTheNamedElevatedSetupExemption()
    {
        var validate = typeof(SeerrProxyController).GetMethod(nameof(SeerrProxyController.ValidateSeerr));
        Assert.NotNull(validate);
        var authorize = validate!.GetCustomAttribute<Microsoft.AspNetCore.Authorization.AuthorizeAttribute>();
        Assert.Equal(MediaBrowser.Common.Api.Policies.RequiresElevation, authorize?.Policy);

        var proxySource = StripComments(File.ReadAllText(SourcePath("Controllers/SeerrProxyController.cs")));
        var validateBody = ExtractMethod(proxySource, nameof(SeerrProxyController.ValidateSeerr));
        Assert.Contains("SeerrHttpHelper.SendSetupAndReadJsonAsync", validateBody, StringComparison.Ordinal);
        Assert.DoesNotContain("SeerrIntegrationPolicy.Capture", validateBody, StringComparison.Ordinal);

        var linksSource = StripComments(File.ReadAllText(SourcePath("Controllers/ArrLinksController.cs")));
        Assert.Contains("[Authorize(Policy = Policies.RequiresElevation)]", linksSource, StringComparison.Ordinal);
        Assert.Matches(OutboundSeerrCall, ExtractMethod(linksSource, "ValidateArrService"));
        Assert.Matches(OutboundSeerrCall, ExtractMethod(linksSource, "IdentifyUrl"));
    }

    [Fact]
    public async Task ValidateSeerr_MasterDisabled_AllowsExplicitUnsavedAdministratorProbe()
    {
        var configProvider = new FakePluginConfigProvider(new PluginConfiguration
        {
            SeerrEnabled = false,
            SeerrUrls = "http://retained-old:5055",
            SeerrApiKey = "retained-old-key",
        });
        var cache = new SeerrCache(configProvider);
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v1/user", """{"results":[],"pageInfo":{"page":1,"pages":1,"results":0}}""");
        var controller = new SeerrProxyController(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrProxyController>.Instance,
            null!,
            cache,
            configProvider,
            null!,
            null!,
            null!);

        var result = await controller.ValidateSeerr("http://localhost:5055", "unsaved-new-key");

        Assert.IsType<OkObjectResult>(result);
        var sent = Assert.Single(handler.Sent);
        Assert.Equal("/api/v1/user", sent.Path);
        Assert.Equal("unsaved-new-key", Assert.Single(handler.ApiKeyHeaders));
    }

    private static string StripComments(string source)
    {
        var withoutBlocks = Regex.Replace(source, @"/\*.*?\*/", " ", RegexOptions.Singleline);
        return Regex.Replace(withoutBlocks, @"//[^\n]*", string.Empty);
    }

    private static string ExtractMethod(string source, string methodName)
    {
        var range = ExtractMethodRange(source, methodName);
        return source.Substring(range.Start, range.Length);
    }

    private static IReadOnlyList<string> FindUngatedDelegateCallers(
        string relative,
        string source,
        HashSet<string>? reviewedMethods = null,
        HashSet<string>? policyDominatedMethods = null)
    {
        reviewedMethods ??= ReviewedDelegatedTransportMethods;
        policyDominatedMethods ??= FindPolicyDominatedMethods(relative, source);
        var methods = EnumerateMethods(source);
        var offenders = new List<string>();
        foreach (var reviewed in reviewedMethods.Where(key => key.StartsWith(relative + ":", StringComparison.Ordinal)))
        {
            var separator = reviewed.LastIndexOf(':');
            var delegateName = reviewed[(separator + 1)..];
            var delegateMethod = methods.FirstOrDefault(method =>
                method.Name == delegateName && DispatchingSeerrCall.IsMatch(method.Source));
            if (delegateMethod != null && DelegateHasExactEdgeFence(delegateMethod))
            {
                continue;
            }

            var invocation = new Regex(
                @"\b" + Regex.Escape(delegateName) + @"\s*\(",
                RegexOptions.Compiled);
            foreach (var caller in methods.Where(method => method.Name != delegateName))
            {
                var callerKey = relative + ":" + caller.Name;
                if (reviewedMethods.Contains(callerKey))
                {
                    continue;
                }

                var bodyOffset = caller.Source.IndexOf(caller.Body, StringComparison.Ordinal);
                foreach (Match call in invocation.Matches(caller.Body))
                {
                    var invocationStart = bodyOffset + call.Index;
                    if (!HasExplicitPolicyGateBefore(caller, invocationStart)
                        && !InvocationPassesLivePredicate(caller, invocationStart))
                    {
                        offenders.Add(reviewed + " <- " + caller.Name);
                        break;
                    }
                }
            }
        }

        return offenders;
    }

    private static IReadOnlyList<string> FindNonElevatedSetupCallers(
        string relative,
        string source,
        HashSet<string> setupDelegates,
        HashSet<string>? exactElevatedEntryPoints = null)
    {
        exactElevatedEntryPoints ??= new HashSet<string>(StringComparer.Ordinal);
        var methods = EnumerateMethods(source);
        var offenders = new List<string>();
        foreach (var setupDelegate in setupDelegates.Where(entry =>
                     entry.StartsWith(relative + ":", StringComparison.Ordinal)))
        {
            var separator = setupDelegate.LastIndexOf(':');
            var delegateName = setupDelegate[(separator + 1)..];
            var invocation = new Regex(@"\b" + Regex.Escape(delegateName) + @"\s*\(");
            foreach (var caller in methods.Where(method => method.Name != delegateName))
            {
                if (!invocation.IsMatch(caller.Body)) continue;
                var callerKey = relative + ":" + caller.Name;
                if (!exactElevatedEntryPoints.Contains(callerKey)
                    || !HasExactElevationAttribute(source, caller.Name))
                {
                    offenders.Add(setupDelegate + " <- " + caller.Name);
                }
            }
        }

        return offenders;
    }

    private static bool HasExactElevationAttribute(string source, string methodName)
        => Regex.IsMatch(
            source,
            @"\[Authorize\s*\(\s*Policy\s*=\s*Policies\.RequiresElevation\s*\)\]\s*"
            + @"public\s+(?:async\s+)?[^\r\n{;=]+?\b"
            + Regex.Escape(methodName)
            + @"\s*\(",
            RegexOptions.Singleline);

    private static bool IsAuthorizedSetupOnlyOwner(
        string relative,
        string source,
        MethodSource method)
    {
        var owner = relative + ":" + method.Name;
        return ExactSetupOnlySendOwners.Contains(owner)
            && HasExactElevationAttribute(source, method.Name)
            && EnumerateMethods(source).Count(candidate => candidate.Name == method.Name) == 1;
    }

    private static bool IsAuthorizedRawTransportHelper(string relative, MethodSource method)
    {
        if (!string.Equals(relative, "Helpers/Seerr/SeerrHttpHelper.cs", StringComparison.Ordinal))
        {
            return false;
        }

        if (method.Name == "SendSetupAndReadJsonAsync")
        {
            return RawHttpDispatch.Matches(method.Source).Count == 1
                && method.Source.Contains("httpClient.SendAsync(", StringComparison.Ordinal);
        }

        return method.Name == "SendResponseHeadersReadAsync"
            && RawHttpDispatch.Matches(method.Source).Count == 1
            && Regex.IsMatch(method.Source, @"\bSeerrDispatchFence\s+dispatchFence\b")
            && method.Source.Contains(
                "dispatchFence.CanDispatch(request.RequestUri)",
                StringComparison.Ordinal);
    }

    private static bool RawOwnerMatchesContract(MethodSource method, RawEdgeContract contract)
        => RawHttpDispatch.Matches(method.Source).Count == contract.ExpectedCalls
            && contract.RequiredMarkers.All(marker =>
                method.Source.Contains(marker, StringComparison.Ordinal));

    private static bool DelegateHasExactEdgeFence(MethodSource method)
    {
        var dispatches = DispatchingSeerrCall.Matches(method.Source).Cast<Match>().ToArray();
        return dispatches.Length > 0
            && dispatches.All(call =>
                HasExplicitPolicyGateBefore(method, call.Index)
                || InvocationPassesLivePredicate(method, call.Index));
    }

    private static bool InvocationPassesLivePredicate(MethodSource caller, int invocationStart)
    {
        var open = caller.Source.IndexOf('(', invocationStart);
        if (open < 0) return false;
        var close = FindBalancedParenthesisEnd(caller.Source, open);
        if (close < 0) return false;
        var arguments = SplitTopLevelArguments(caller.Source[(open + 1)..close]);
        if (arguments.Any(argument =>
                argument.Contains(".CreateDispatchFence(", StringComparison.Ordinal)
                || argument.Contains(".Restrict(", StringComparison.Ordinal)))
        {
            return true;
        }

        foreach (var fenceName in DeclaredDispatchFenceNames(caller.Source))
        {
            if (arguments.Any(argument => string.Equals(
                    argument.Trim(),
                    fenceName,
                    StringComparison.Ordinal)))
            {
                return true;
            }
        }

        return false;
    }

    private static IReadOnlySet<string> DeclaredDispatchFenceNames(string source)
    {
        var names = Regex.Matches(
                source,
                @"\bSeerrDispatchFence\s*\??\s+(?<name>[A-Za-z_]\w*)")
            .Cast<Match>()
            .Select(match => match.Groups["name"].Value)
            .ToHashSet(StringComparer.Ordinal);
        foreach (Match inferred in Regex.Matches(
                     source,
                     @"\bvar\s+(?<name>[A-Za-z_]\w*)\s*=\s*[\s\S]{0,240}?(?:\.CreateDispatchFence\s*\(|\.Restrict\s*\()"))
        {
            names.Add(inferred.Groups["name"].Value);
        }

        return names;
    }

    private static IReadOnlyList<string> SplitTopLevelArguments(string source)
    {
        var arguments = new List<string>();
        var start = 0;
        var parentheses = 0;
        var braces = 0;
        var brackets = 0;
        var quote = '\0';
        var escaped = false;
        for (var index = 0; index < source.Length; index++)
        {
            var character = source[index];
            if (quote != '\0')
            {
                if (escaped)
                {
                    escaped = false;
                }
                else if (character == '\\')
                {
                    escaped = true;
                }
                else if (character == quote)
                {
                    quote = '\0';
                }

                continue;
            }

            if (character is '\'' or '"') quote = character;
            else if (character == '(') parentheses++;
            else if (character == ')') parentheses--;
            else if (character == '{') braces++;
            else if (character == '}') braces--;
            else if (character == '[') brackets++;
            else if (character == ']') brackets--;
            else if (character == ',' && parentheses == 0 && braces == 0 && brackets == 0)
            {
                arguments.Add(source[start..index]);
                start = index + 1;
            }
        }

        arguments.Add(source[start..]);
        return arguments;
    }

    private static HashSet<string> FindPolicyDominatedMethods(string relative, string source)
    {
        var methods = EnumerateMethods(source);
        return methods
            .Where(HasExplicitPolicyGate)
            .Select(method => relative + ":" + method.Name)
            .ToHashSet(StringComparer.Ordinal);
    }

    private static bool HasExplicitPolicyGate(MethodSource method)
        => HasExplicitPolicyGateBefore(method, method.Source.Length);

    private static bool IsAuthorizedOutboundOwner(
        MethodSource method,
        int boundary,
        string owner,
        HashSet<string> reviewedMethods,
        HashSet<string> elevatedSetupMethods,
        bool requiresFreshFence)
    {
        if (elevatedSetupMethods.Contains(owner)) return true;
        if (requiresFreshFence && InvocationPassesLivePredicate(method, boundary)) return true;
        if (HasExplicitPolicyGateBefore(method, boundary, requiresFreshFence)) return true;

        // A reviewed transport delegate is not an exemption by name. It must
        // make the live fence part of its API and pass that exact predicate to
        // the lower-level dispatch. FindUngatedDelegateCallers separately proves
        // every production caller supplies it from a fresh policy gate.
        return reviewedMethods.Contains(owner)
            && (!requiresFreshFence || Regex.IsMatch(
                method.Source,
                @"\bSeerrDispatchFence\s+(?<fence>[A-Za-z_]\w*)"))
            && (!requiresFreshFence || ReviewedPredicateIsPassedBefore(method, boundary));
    }

    private static bool ReviewedPredicateIsPassedBefore(MethodSource method, int boundary)
    {
        var parameter = Regex.Match(
            method.Source,
            @"\bSeerrDispatchFence\s+(?<fence>[A-Za-z_]\w*)");
        if (!parameter.Success) return false;

        var fenceName = parameter.Groups["fence"].Value;
        var callStart = Math.Min(boundary, method.Source.Length);
        var open = method.Source.IndexOf('(', callStart);
        if (open < 0) return false;
        var close = FindBalancedParenthesisEnd(method.Source, open);
        if (close < 0) return false;
        var callAndArguments = method.Source[callStart..(close + 1)];
        return Regex.IsMatch(callAndArguments, @"\b" + Regex.Escape(fenceName) + @"\b");
    }

    private static int FindBalancedParenthesisEnd(string source, int open)
    {
        var depth = 0;
        for (var index = open; index < source.Length; index++)
        {
            if (source[index] == '(') depth++;
            else if (source[index] == ')' && --depth == 0) return index;
        }

        return -1;
    }

    private static bool HasExplicitPolicyGateBefore(
        MethodSource method,
        int boundary,
        bool requiresFreshFence = true)
    {
        var bounded = method.Source[..Math.Min(boundary, method.Source.Length)];
        var freshStart = 0;
        foreach (Match completedAwait in Regex.Matches(
                     bounded,
                     @"\bawait\b[^;]*;",
                     RegexOptions.Singleline))
        {
            freshStart = completedAwait.Index + completedAwait.Length;
        }

        var freshPrefix = bounded[(requiresFreshFence ? freshStart : 0)..];

        // Capture alone authorizes nothing. The captured local must participate
        // in a fail-closed branch whose disabled/stale path exits this dispatch
        // edge. Starting after the last completed await forces a new IsCurrent
        // check before every later send.
        foreach (Match capturedSnapshot in Regex.Matches(
                     method.Source,
                     @"\bvar\s+(?<snapshot>[A-Za-z_]\w*)\s*=\s*SeerrIntegrationPolicy\.Capture\s*\("))
        {
            var snapshotName = capturedSnapshot.Groups["snapshot"].Value;
            if (HasTerminatingNegativeCondition(
                    freshPrefix,
                    Regex.Escape(snapshotName) + @"\.(?:IsActive|IsCurrent\s*\([^)]*\))"))
            {
                return true;
            }
        }

        // Some entry points retain a named boolean. It is accepted only when a
        // false value takes a recognized terminating branch at this edge.
        foreach (Match savedConfiguration in Regex.Matches(
                     method.Source,
                     @"\bvar\s+(?<gate>[A-Za-z_]\w*)\s*=\s*SeerrIntegrationPolicy\.HasUsableSavedConfiguration\s*\("))
        {
            var gateName = savedConfiguration.Groups["gate"].Value;
            if (HasTerminatingNegativeCondition(freshPrefix, Regex.Escape(gateName)))
            {
                return true;
            }
        }

        return HasTerminatingNegativeCondition(
                freshPrefix,
                @"SeerrIntegrationPolicy\.HasUsableSavedConfiguration\s*\([^)]*\)")
            || HasTerminatingNegativeCondition(
                freshPrefix,
                @"[A-Za-z_]\w*\.(?:IsCurrent|Matches)\s*\([^)]*\)")
            || DeclaredDispatchFenceNames(method.Source).Any(fenceName =>
                HasTerminatingNegativeCondition(
                    freshPrefix,
                    Regex.Escape(fenceName) + @"(?:\?|)\.CanDispatch\s*\(\s*\)(?:\s*!=\s*true)?"));
    }

    private static bool HasTerminatingNegativeCondition(string source, string positiveExpression)
    {
        foreach (Match branch in Regex.Matches(source, @"\bif\s*\("))
        {
            var open = source.IndexOf('(', branch.Index);
            var close = FindBalancedParenthesisEnd(source, open);
            if (close < 0) continue;
            var condition = source[(open + 1)..close];
            if (!SplitTopLevelOrOperands(condition).Any(operand => Regex.IsMatch(
                    operand,
                    @"^\s*!\s*(?:\(\s*)?" + positiveExpression + @"(?:\s*\))?\s*$",
                    RegexOptions.Singleline)))
            {
                continue;
            }

            var statementStart = close + 1;
            while (statementStart < source.Length && char.IsWhiteSpace(source[statementStart]))
            {
                statementStart++;
            }

            if (statementStart < source.Length && source[statementStart] == '{')
            {
                var bodyEnd = FindBalancedBodyEnd(source, statementStart);
                if (bodyEnd > statementStart
                    && BlockHasTopLevelTerminal(source[(statementStart + 1)..bodyEnd]))
                {
                    return true;
                }

                continue;
            }

            var statementEnd = source.IndexOf(';', statementStart);
            if (statementEnd > statementStart
                && Regex.IsMatch(
                    source[statementStart..(statementEnd + 1)],
                    @"^\s*(?:return|throw|continue|break)\b"))
            {
                return true;
            }
        }

        return false;
    }

    private static IReadOnlyList<string> SplitTopLevelOrOperands(string source)
    {
        var operands = new List<string>();
        var start = 0;
        var parentheses = 0;
        for (var index = 0; index < source.Length - 1; index++)
        {
            if (source[index] == '(')
            {
                parentheses++;
            }
            else if (source[index] == ')')
            {
                parentheses--;
            }
            else if (source[index] == '|'
                && source[index + 1] == '|'
                && parentheses == 0)
            {
                operands.Add(source[start..index]);
                start = index + 2;
                index++;
            }
        }

        operands.Add(source[start..]);
        return operands;
    }

    private static bool BlockHasTopLevelTerminal(string body)
    {
        var depth = 0;
        for (var index = 0; index < body.Length; index++)
        {
            if (body[index] == '{')
            {
                depth++;
                continue;
            }

            if (body[index] == '}')
            {
                depth--;
                continue;
            }

            if (depth != 0 || !char.IsLetter(body[index])) continue;
            var token = Regex.Match(body[index..], @"^(?:return|throw|continue|break)\b");
            if (token.Success) return true;
        }

        return false;
    }

    private static MethodSource? FindContainingMethod(string source, int position)
    {
        MethodSource? containing = null;
        foreach (var candidate in EnumerateMethods(source))
        {
            if (candidate.Start > position) break;
            if (candidate.End < position) continue;
            if (containing == null || candidate.Source.Length < containing.Source.Length)
            {
                containing = candidate;
            }
        }

        return containing;
    }

    private static IReadOnlyList<MethodSource> EnumerateMethods(string source)
    {
        var methods = new List<MethodSource>();
        foreach (Match declaration in MethodDeclaration.Matches(source))
        {
            var bodyToken = declaration.Groups["body"];
            var end = bodyToken.Value == "=>"
                ? source.IndexOf(';', bodyToken.Index)
                : FindBalancedBodyEnd(source, bodyToken.Index);
            if (end < bodyToken.Index) continue;
            methods.Add(new MethodSource(
                declaration.Groups["name"].Value,
                source.Substring(declaration.Index, end - declaration.Index + 1),
                source.Substring(bodyToken.Index, end - bodyToken.Index + 1),
                declaration.Index,
                end));
        }

        return methods;
    }

    private static int FindBalancedBodyEnd(string source, int open)
    {
        var depth = 0;
        for (var index = open; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}' && --depth == 0) return index;
        }

        return -1;
    }

    private static (int Start, int Length) ExtractMethodRange(string source, string methodName)
    {
        var declaration = Regex.Match(
            source,
            @"\b" + Regex.Escape(methodName) + @"\s*\([^;{]*\)\s*\{",
            RegexOptions.Singleline);
        Assert.True(declaration.Success, $"Could not locate method {methodName}.");
        var open = source.IndexOf('{', declaration.Index + declaration.Length - 1);
        var depth = 0;
        for (var index = open; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}' && --depth == 0)
            {
                return (declaration.Index, index - declaration.Index + 1);
            }
        }

        throw new Xunit.Sdk.XunitException($"Method {methodName} has no balanced body.");
    }

    private static IEnumerable<string> SourceFiles()
        => Directory.EnumerateFiles(PluginSourceRoot(), "*.cs", SearchOption.AllDirectories)
            .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")
                && !path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"));

    private static string Relative(string path)
        => Path.GetRelativePath(PluginSourceRoot(), path).Replace(Path.DirectorySeparatorChar, '/');

    private static string SourcePath(string relative)
        => Path.Combine(PluginSourceRoot(), relative.Replace('/', Path.DirectorySeparatorChar));

    private static string PluginSourceRoot([CallerFilePath] string sourceFile = "")
        => Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "Jellyfin.Plugin.JellyfinCanopy"));

    private sealed record MethodSource(
        string Name,
        string Source,
        string Body,
        int Start,
        int End);

    private sealed record RawEdgeContract(int ExpectedCalls, params string[] RequiredMarkers);
}
