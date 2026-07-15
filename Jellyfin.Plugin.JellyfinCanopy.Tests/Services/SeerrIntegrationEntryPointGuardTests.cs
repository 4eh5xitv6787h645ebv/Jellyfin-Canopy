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
        @"\bSeerrHttpHelper\.(?:CreateClient|BuildRequest|SendAndReadJsonAsync|SendResponseHeadersReadAsync|ReadResponseAsync)\s*\("
        + @"|\bSeerrPaginationHelper\.FetchAll(?:Sources)?Async\s*\("
        + @"|\bSeerrUserImportHelper\.BulkImportAsync\s*\(",
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
        "Services/AutoMovieRequestService.cs:ResolveQualityProfileAsync",
        "Services/AutoSeasonRequestService.cs:GetSeasonStatusFromSeerr",
        "Services/AutoSeasonRequestService.cs:GetSeriesDetailsJsonAsync",
        "Services/AutoSeasonRequestService.cs:GetTotalEpisodesInSeasonFromTmdb",
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

    private static readonly HashSet<string> NamedElevatedSetupMethods = new(StringComparer.Ordinal)
    {
        "Controllers/ArrLinksController.cs:IdentifyUrl",
        "Controllers/ArrLinksController.cs:ValidateArrService",
        "Controllers/SeerrProxyController.cs:ValidateSeerr",
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
                    if (!HasExplicitPolicyGateBefore(method, call.Index - method.Start)
                        && !ReviewedDelegatedTransportMethods.Contains(owner)
                        && !NamedElevatedSetupMethods.Contains(owner))
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

    [Fact]
    public void UnsavedConnectionValidationIsTheNamedElevatedSetupExemption()
    {
        var validate = typeof(SeerrProxyController).GetMethod(nameof(SeerrProxyController.ValidateSeerr));
        Assert.NotNull(validate);
        var authorize = validate!.GetCustomAttribute<Microsoft.AspNetCore.Authorization.AuthorizeAttribute>();
        Assert.Equal(MediaBrowser.Common.Api.Policies.RequiresElevation, authorize?.Policy);

        var proxySource = StripComments(File.ReadAllText(SourcePath("Controllers/SeerrProxyController.cs")));
        var validateBody = ExtractMethod(proxySource, nameof(SeerrProxyController.ValidateSeerr));
        Assert.Contains("SeerrHttpHelper.SendAndReadJsonAsync", validateBody, StringComparison.Ordinal);
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
                    if (!HasExplicitPolicyGateBefore(caller, bodyOffset + call.Index))
                    {
                        offenders.Add(reviewed + " <- " + caller.Name);
                        break;
                    }
                }
            }
        }

        return offenders;
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

    private static bool HasExplicitPolicyGateBefore(MethodSource method, int boundary)
    {
        // Capture is only an immutable snapshot operation. It becomes an
        // authorization gate when that exact local is checked before transport;
        // merely mentioning policy, or calling a separately gated helper, cannot
        // dominate an independent outbound call in this method.
        foreach (Match capturedSnapshot in Regex.Matches(
                     method.Source,
                     @"\bvar\s+(?<snapshot>[A-Za-z_]\w*)\s*=\s*SeerrIntegrationPolicy\.Capture\s*\("))
        {
            var snapshotName = capturedSnapshot.Groups["snapshot"].Value;
            var afterCapture = method.Source[capturedSnapshot.Index..];
            var check = Regex.Match(
                afterCapture,
                @"\b" + Regex.Escape(snapshotName) + @"\.(?:IsActive|IsCurrent)\b");
            if (check.Success && capturedSnapshot.Index + check.Index + check.Length <= boundary)
            {
                return true;
            }
        }

        // Some established entry points retain a named boolean because Seerr is
        // only conditionally needed. Require that boolean to participate in a
        // later condition; an ignored HasUsableSavedConfiguration call is not a
        // gate either.
        foreach (Match savedConfiguration in Regex.Matches(
                     method.Source,
                     @"\bvar\s+(?<gate>[A-Za-z_]\w*)\s*=\s*SeerrIntegrationPolicy\.HasUsableSavedConfiguration\s*\("))
        {
            var gateName = savedConfiguration.Groups["gate"].Value;
            var afterCapture = method.Source[savedConfiguration.Index..];
            var check = Regex.Match(
                afterCapture,
                @"\bif\s*\([\s\S]{0,500}?\b" + Regex.Escape(gateName) + @"\b");
            if (check.Success && savedConfiguration.Index + check.Index + check.Length <= boundary)
            {
                return true;
            }
        }

        var directCheck = Regex.Match(
            method.Source,
            @"\bif\s*\([\s\S]{0,500}?SeerrIntegrationPolicy\.HasUsableSavedConfiguration\s*\(");
        return directCheck.Success && directCheck.Index + directCheck.Length <= boundary;
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
}
