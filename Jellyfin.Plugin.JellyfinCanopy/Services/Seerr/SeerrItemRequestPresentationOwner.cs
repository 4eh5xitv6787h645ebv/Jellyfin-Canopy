using System;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Seerr
{
    /// <summary>Closed request states released to first-party presentation composition.</summary>
    public enum SeerrItemRequestStatus
    {
        /// <summary>No current request state is present or this edition is not authorized.</summary>
        Unavailable,

        /// <summary>A provider request already exists and is being processed.</summary>
        AlreadyRequested,

        /// <summary>A request is waiting for approval.</summary>
        Pending,

        /// <summary>A request was approved or the edition is available.</summary>
        Approved,

        /// <summary>A request was declined or the title was blocked.</summary>
        Denied,

        /// <summary>Only part of the requested title is available.</summary>
        Partial,

        /// <summary>A valid provider request row reports a terminal failure.</summary>
        Failed,
    }

    /// <summary>
    /// Bounded semantic presentation evidence. Revisions are opaque 67-character
    /// SHA-256 tokens; no URL, key, provider payload, user name or policy body is
    /// released through this owner contract.
    /// </summary>
    public sealed class SeerrItemRequestPresentation
    {
        private SeerrItemRequestPresentation(
            bool isVisible,
            bool standardRequestAvailable,
            bool fourKRequestAvailable,
            SeerrItemRequestStatus standardStatus,
            SeerrItemRequestStatus fourKStatus,
            string configurationRevision,
            string userRevision,
            string itemRevision,
            string providerRevision)
        {
            IsVisible = isVisible;
            StandardRequestAvailable = standardRequestAvailable;
            FourKRequestAvailable = fourKRequestAvailable;
            StandardStatus = standardStatus;
            FourKStatus = fourKStatus;
            ConfigurationRevision = configurationRevision;
            UserRevision = userRevision;
            ItemRevision = itemRevision;
            ProviderRevision = providerRevision;
        }

        /// <summary>Whether an authorized Seerr contribution may be composed.</summary>
        public bool IsVisible { get; }

        /// <summary>Whether a Standard request action is currently safe to prepare.</summary>
        public bool StandardRequestAvailable { get; }

        /// <summary>Whether a 4K request action is currently safe to prepare.</summary>
        public bool FourKRequestAvailable { get; }

        /// <summary>Current closed Standard-edition state.</summary>
        public SeerrItemRequestStatus StandardStatus { get; }

        /// <summary>Current closed 4K-edition state.</summary>
        public SeerrItemRequestStatus FourKStatus { get; }

        /// <summary>Opaque exact saved-configuration generation.</summary>
        public string ConfigurationRevision { get; }

        /// <summary>Opaque exact linked identity, permission and host-user generation.</summary>
        public string UserRevision { get; }

        /// <summary>Opaque exact accessible-item projection generation.</summary>
        public string ItemRevision { get; }

        /// <summary>Opaque provider semantic generation, empty when no safe read completed.</summary>
        public string ProviderRevision { get; }

        internal static SeerrItemRequestPresentation Invisible()
            => new(
                isVisible: false,
                standardRequestAvailable: false,
                fourKRequestAvailable: false,
                SeerrItemRequestStatus.Unavailable,
                SeerrItemRequestStatus.Unavailable,
                string.Empty,
                string.Empty,
                string.Empty,
                string.Empty);

        internal static SeerrItemRequestPresentation Available(
            bool standardRequestAvailable,
            bool fourKRequestAvailable,
            SeerrItemRequestStatus standardStatus,
            SeerrItemRequestStatus fourKStatus,
            string configurationRevision,
            string userRevision,
            string itemRevision,
            string providerRevision)
            => new(
                isVisible: true,
                standardRequestAvailable,
                fourKRequestAvailable,
                standardStatus,
                fourKStatus,
                configurationRevision,
                userRevision,
                itemRevision,
                providerRevision);
    }

    /// <summary>
    /// Sole native read owner for an exact installed Movie/Series Seerr
    /// presentation. Inputs are minted by authenticated Platform/host boundaries.
    /// </summary>
    public interface ISeerrItemRequestPresentationOwner
    {
        /// <summary>Resolves one current, bounded, provider-body-free presentation.</summary>
        Task<SeerrItemRequestPresentation> ResolveItemRequestPresentationAsync(
            PlatformActor actor,
            HostAccessibleItem item,
            CancellationToken cancellationToken);
    }

    /// <summary>Fixed-target, source-bound read implementation for native composition.</summary>
    internal sealed class SeerrItemRequestPresentationOwner : ISeerrItemRequestPresentationOwner
    {
        private const int MaximumProviderBodyBytes = 256 * 1024;
        private const int MaximumProviderDepth = 16;
        private const int MaximumRequestRows = 64;
        private const int MaximumRequestProperties = 32;
        private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(15);

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly IPluginConfigProvider _configProvider;
        private readonly IPlatformHost _host;
        private readonly ISeerrMediaRequestAdmission _admission;
        private readonly ISeerrParentalFilter _parentalFilter;
        private readonly ISeerrItemPresentationRevisionAuthority _revisionAuthority;
        private readonly ILogger<SeerrItemRequestPresentationOwner> _logger;

        public SeerrItemRequestPresentationOwner(
            IHttpClientFactory httpClientFactory,
            IPluginConfigProvider configProvider,
            IPlatformHost host,
            ISeerrMediaRequestAdmission admission,
            ISeerrParentalFilter parentalFilter,
            ISeerrItemPresentationRevisionAuthority revisionAuthority,
            ILogger<SeerrItemRequestPresentationOwner> logger)
        {
            _httpClientFactory = httpClientFactory ?? throw new ArgumentNullException(nameof(httpClientFactory));
            _configProvider = configProvider ?? throw new ArgumentNullException(nameof(configProvider));
            _host = host ?? throw new ArgumentNullException(nameof(host));
            _admission = admission ?? throw new ArgumentNullException(nameof(admission));
            _parentalFilter = parentalFilter ?? throw new ArgumentNullException(nameof(parentalFilter));
            _revisionAuthority = revisionAuthority ?? throw new ArgumentNullException(nameof(revisionAuthority));
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        }

        public async Task<SeerrItemRequestPresentation> ResolveItemRequestPresentationAsync(
            PlatformActor actor,
            HostAccessibleItem item,
            CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(actor);
            cancellationToken.ThrowIfCancellationRequested();
            if (!SeerrMediaTargetPolicy.TryProject(item, out var target))
            {
                return SeerrItemRequestPresentation.Invisible();
            }

            if (!CurrentHostMatches(actor, item, target))
            {
                cancellationToken.ThrowIfCancellationRequested();
                return SeerrItemRequestPresentation.Invisible();
            }

            cancellationToken.ThrowIfCancellationRequested();

            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            var config = integration.Configuration;
            if (!integration.IsActive || config == null)
            {
                return SeerrItemRequestPresentation.Invisible();
            }

            var initialResolution = await _admission.ResolveAsync(
                actor.UserId,
                SeerrRequestIdentityResolutionMode.FinalPreDispatch,
                cancellationToken).ConfigureAwait(false);
            if (!integration.IsCurrent(_configProvider)
                || !TryAdmitIdentity(initialResolution, integration.Urls, out var identity))
            {
                return SeerrItemRequestPresentation.Invisible();
            }

            var standardAuthorized = actor.IsElevated || SeerrMediaTargetPolicy.HasPermission(
                identity.Permissions,
                target.Kind,
                SeerrMediaRequestVariant.Standard);
            var fourKAuthorized = actor.IsElevated || SeerrMediaTargetPolicy.HasPermission(
                identity.Permissions,
                target.Kind,
                SeerrMediaRequestVariant.FourK);
            var fourKMasterEnabled = target.Kind == SeerrMediaRequestKind.Series
                ? config.SeerrEnable4KTvRequests
                : config.SeerrEnable4KRequests;
            var initial4kCapability = new Seerr4kCapability(false, false, false, false);
            if (fourKAuthorized && fourKMasterEnabled)
            {
                initial4kCapability = await _admission.Get4kCapabilityAsync(
                    identity,
                    actor.IsElevated,
                    cancellationToken).ConfigureAwait(false);
                if (!integration.IsCurrent(_configProvider))
                {
                    return SeerrItemRequestPresentation.Invisible();
                }
            }

            var fourKCapable = target.Kind == SeerrMediaRequestKind.Series
                ? initial4kCapability.CanRequest4kTv
                : initial4kCapability.CanRequest4kMovie;
            var fourKAdmitted = fourKAuthorized && fourKMasterEnabled && fourKCapable;
            if (!standardAuthorized && !fourKAdmitted)
            {
                return SeerrItemRequestPresentation.Invisible();
            }

            var caller = new SeerrCaller(actor.UserId.ToString("D"), actor.IsElevated);
            if (await _parentalFilter.IsBlockedAsync(
                    target.MediaType,
                    target.TmdbId,
                    caller,
                    cancellationToken).ConfigureAwait(false)
                || !integration.IsCurrent(_configProvider))
            {
                return SeerrItemRequestPresentation.Invisible();
            }

            string requestUri;
            HttpClient httpClient;
            HttpRequestMessage request;
            try
            {
                requestUri = string.Concat(
                    identity.SourceUrl,
                    "/api/v1/",
                    target.MediaType,
                    "/",
                    target.TmdbId.ToString(CultureInfo.InvariantCulture));
                httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);
                httpClient.Timeout = ReadTimeout;
                request = SeerrHttpHelper.BuildRequest(
                    HttpMethod.Get,
                    requestUri,
                    integration.ApiKey,
                    identity.UserId.ToString(CultureInfo.InvariantCulture));
            }
            catch (Exception exception) when (exception is not OutOfMemoryException)
            {
                cancellationToken.ThrowIfCancellationRequested();
                _logger.LogWarning(
                    "The bounded Seerr item-presentation request could not be constructed ({ExceptionType}).",
                    exception.GetType().Name);
                return SeerrItemRequestPresentation.Invisible();
            }

            using (request)
            {
                // Factory/request construction are arbitrary-code boundaries. Re-enter
                // the host immediately before the fixed GET dispatch.
                cancellationToken.ThrowIfCancellationRequested();
                if (!CurrentHostMatches(actor, item, target))
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    return SeerrItemRequestPresentation.Invisible();
                }

                cancellationToken.ThrowIfCancellationRequested();

                string? json;
                SeerrError? error;
                int status;
                try
                {
                    (json, error, status) = await SeerrHttpHelper.SendAndReadJsonAsync(
                        httpClient,
                        request,
                        requestUri,
                        MaximumProviderBodyBytes,
                        integration.CreateDispatchFence(_configProvider),
                        cancellationToken).ConfigureAwait(false);
                }
                catch (SeerrDispatchNotAttemptedException)
                {
                    return SeerrItemRequestPresentation.Invisible();
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception exception) when (exception is not OutOfMemoryException)
                {
                    _logger.LogWarning(
                        "The bounded Seerr item-presentation read failed ({ExceptionType}).",
                        exception.GetType().Name);
                    return SeerrItemRequestPresentation.Invisible();
                }

                if (!integration.IsCurrent(_configProvider)
                    || error != null
                    || status is < 200 or >= 300
                    || json == null
                    || !TryParseProviderState(json, out var providerState))
                {
                    return SeerrItemRequestPresentation.Invisible();
                }

                return await PublishAuthorizedStateAsync(
                    actor,
                    item,
                    target,
                    identity,
                    integration,
                    caller,
                    standardAuthorized,
                    fourKAuthorized,
                    fourKMasterEnabled,
                    fourKAdmitted,
                    initial4kCapability,
                    providerState,
                    cancellationToken).ConfigureAwait(false);
            }
        }

        private async Task<SeerrItemRequestPresentation> PublishAuthorizedStateAsync(
            PlatformActor actor,
            HostAccessibleItem item,
            SeerrMediaTarget target,
            SeerrRequestIdentity identity,
            SeerrIntegrationPolicy.SeerrIntegrationSnapshot integration,
            SeerrCaller caller,
            bool standardAuthorized,
            bool fourKAuthorized,
            bool fourKMasterEnabled,
            bool fourKAdmitted,
            Seerr4kCapability initial4kCapability,
            ProviderState providerState,
            CancellationToken cancellationToken)
        {
            // Re-resolve source-local identity after the provider await. A cached
            // positive binding, permission mask or instance-local id cannot authorize
            // publication after revocation/rebinding.
            var finalResolution = await _admission.ResolveAsync(
                actor.UserId,
                SeerrRequestIdentityResolutionMode.FinalPreDispatch,
                cancellationToken).ConfigureAwait(false);
            if (!integration.IsCurrent(_configProvider)
                || !TryAdmitIdentity(finalResolution, integration.Urls, out var finalIdentity)
                || !identity.Equals(finalIdentity))
            {
                _admission.InvalidateIdentity(actor.UserId);
                return SeerrItemRequestPresentation.Invisible();
            }

            if (fourKAuthorized && fourKMasterEnabled)
            {
                var final4kCapability = await _admission.Get4kCapabilityAsync(
                    finalIdentity,
                    actor.IsElevated,
                    cancellationToken).ConfigureAwait(false);
                if (!integration.IsCurrent(_configProvider)
                    || !Equals(initial4kCapability, final4kCapability))
                {
                    return SeerrItemRequestPresentation.Invisible();
                }
            }

            // Parental policy is user-local mutable authority, independent of the
            // provider response. Re-evaluate it after every provider await.
            if (await _parentalFilter.IsBlockedAsync(
                    target.MediaType,
                    target.TmdbId,
                    caller,
                    cancellationToken).ConfigureAwait(false)
                || !integration.IsCurrent(_configProvider))
            {
                return SeerrItemRequestPresentation.Invisible();
            }

            if (!CurrentHostMatches(actor, item, target))
            {
                cancellationToken.ThrowIfCancellationRequested();
                return SeerrItemRequestPresentation.Invisible();
            }

            cancellationToken.ThrowIfCancellationRequested();
            if (!integration.IsCurrent(_configProvider))
            {
                return SeerrItemRequestPresentation.Invisible();
            }

            var standardStatus = standardAuthorized
                ? providerState.StandardStatus
                : SeerrItemRequestStatus.Unavailable;
            var fourKStatus = fourKAdmitted
                ? providerState.FourKStatus
                : SeerrItemRequestStatus.Unavailable;
            return SeerrItemRequestPresentation.Available(
                standardAuthorized && providerState.StandardRequestable,
                fourKAdmitted && providerState.FourKRequestable,
                standardStatus,
                fourKStatus,
                _revisionAuthority.Create("configuration", integration.GenerationIdentity),
                UserRevision(actor, identity),
                ItemRevision(item, target),
                ProviderRevision(
                    standardAuthorized,
                    fourKAdmitted,
                    standardStatus,
                    fourKStatus,
                    standardAuthorized && providerState.StandardRequestable,
                    fourKAdmitted && providerState.FourKRequestable));
        }

        private bool CurrentHostMatches(
            PlatformActor actor,
            HostAccessibleItem admittedItem,
            SeerrMediaTarget admittedTarget)
        {
            try
            {
                var user = _host.Users.Find(actor.UserId);
                var access = _host.Library.FindAccessible(actor.UserId, admittedItem.Id);
                return user.HasValue
                    && (!actor.IsElevated || user.Value.IsAdministrator)
                    && access.Item is HostAccessibleItem currentItem
                    && SameAuthoritativeItem(admittedItem, currentItem)
                    && SeerrMediaTargetPolicy.TryProject(currentItem, out var currentTarget)
                    && admittedTarget.Equals(currentTarget);
            }
            catch
            {
                return false;
            }
        }

        private static bool SameAuthoritativeItem(
            HostAccessibleItem admitted,
            HostAccessibleItem current)
            => admitted.Id == current.Id
                && admitted.Kind == current.Kind
                && admitted.SeriesId == current.SeriesId
                && admitted.ProviderReferences.SequenceEqual(current.ProviderReferences);

        private static bool TryAdmitIdentity(
            SeerrRequestIdentityResolution resolution,
            string[] configuredSources,
            out SeerrRequestIdentity identity)
        {
            identity = resolution.Identity;
            if (!resolution.IsFound)
            {
                return false;
            }

            foreach (var source in configuredSources)
            {
                if (string.Equals(source, identity.SourceUrl, StringComparison.Ordinal))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool TryParseProviderState(
            string json,
            out ProviderState state)
        {
            state = default;
            try
            {
                using var document = JsonDocument.Parse(
                    json,
                    new JsonDocumentOptions
                    {
                        AllowTrailingCommas = false,
                        CommentHandling = JsonCommentHandling.Disallow,
                        MaxDepth = MaximumProviderDepth,
                    });
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                {
                    return false;
                }

                if (!root.TryGetProperty("mediaInfo", out var mediaInfo)
                    || mediaInfo.ValueKind == JsonValueKind.Null)
                {
                    state = new ProviderState(
                        SeerrItemRequestStatus.Unavailable,
                        SeerrItemRequestStatus.Unavailable,
                        StandardRequestable: true,
                        FourKRequestable: true);
                    return true;
                }

                if (mediaInfo.ValueKind != JsonValueKind.Object
                    || !TryReadMediaStatus(mediaInfo, "status", out var standardMediaStatus)
                    || !TryReadMediaStatus(mediaInfo, "status4k", out var fourKMediaStatus))
                {
                    return false;
                }

                var standardRequests = default(RequestAggregate);
                var fourKRequests = default(RequestAggregate);
                if (mediaInfo.TryGetProperty("requests", out var requests))
                {
                    if (requests.ValueKind != JsonValueKind.Array
                        || requests.GetArrayLength() > MaximumRequestRows)
                    {
                        return false;
                    }

                    foreach (var row in requests.EnumerateArray())
                    {
                        if (row.ValueKind != JsonValueKind.Object
                            || row.EnumerateObject().Take(MaximumRequestProperties + 1).Count() > MaximumRequestProperties
                            || !row.TryGetProperty("status", out var statusElement)
                            || statusElement.ValueKind != JsonValueKind.Number
                            || !statusElement.TryGetInt32(out var requestStatus)
                            || requestStatus is < 1 or > 5)
                        {
                            return false;
                        }

                        var is4k = false;
                        if (row.TryGetProperty("is4k", out var is4kElement))
                        {
                            if (is4kElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                            {
                                return false;
                            }

                            is4k = is4kElement.GetBoolean();
                        }

                        if (is4k)
                        {
                            fourKRequests = fourKRequests.Add(requestStatus);
                        }
                        else
                        {
                            standardRequests = standardRequests.Add(requestStatus);
                        }
                    }
                }

                var standardStatus = MapStatus(standardMediaStatus, standardRequests);
                var fourKStatus = MapStatus(fourKMediaStatus, fourKRequests);
                state = new ProviderState(
                    standardStatus,
                    fourKStatus,
                    IsRequestable(standardMediaStatus, standardStatus),
                    IsRequestable(fourKMediaStatus, fourKStatus));
                return true;
            }
            catch (JsonException)
            {
                return false;
            }
        }

        private static bool TryReadMediaStatus(
            JsonElement mediaInfo,
            string propertyName,
            out int status)
        {
            if (!mediaInfo.TryGetProperty(propertyName, out var element))
            {
                status = 1;
                return true;
            }

            status = default;
            return element.ValueKind == JsonValueKind.Number
                && element.TryGetInt32(out status)
                && status is >= 1 and <= 7;
        }

        private static SeerrItemRequestStatus MapStatus(
            int mediaStatus,
            RequestAggregate requests)
            => mediaStatus switch
            {
                2 => SeerrItemRequestStatus.Pending,
                3 => SeerrItemRequestStatus.AlreadyRequested,
                4 => SeerrItemRequestStatus.Partial,
                5 => SeerrItemRequestStatus.Approved,
                6 => SeerrItemRequestStatus.Denied,
                _ when requests.Pending => SeerrItemRequestStatus.Pending,
                _ when requests.ApprovedOrCompleted => SeerrItemRequestStatus.Approved,
                _ when requests.Failed => SeerrItemRequestStatus.Failed,
                _ when requests.Declined => SeerrItemRequestStatus.Denied,
                _ => SeerrItemRequestStatus.Unavailable,
            };

        private static bool IsRequestable(
            int mediaStatus,
            SeerrItemRequestStatus status)
            => mediaStatus is 1 or 7
                && status is SeerrItemRequestStatus.Unavailable
                    or SeerrItemRequestStatus.Denied
                    or SeerrItemRequestStatus.Failed;

        private string UserRevision(
            PlatformActor actor,
            SeerrRequestIdentity identity)
            => _revisionAuthority.Create(
                "user",
                actor.UserId.ToString("N"),
                actor.IsElevated ? "1" : "0",
                identity.UserId.ToString(CultureInfo.InvariantCulture),
                ((long)identity.Permissions).ToString(CultureInfo.InvariantCulture),
                identity.SourceUrl);

        private string ItemRevision(
            HostAccessibleItem item,
            SeerrMediaTarget target)
        {
            var material = new StringBuilder(256)
                .Append(item.Id.ToString("N"))
                .Append('|')
                .Append((int)item.Kind)
                .Append('|')
                .Append(item.SeriesId?.ToString("N") ?? string.Empty)
                .Append('|')
                .Append(target.MediaType)
                .Append('|')
                .Append(target.TmdbId.ToString(CultureInfo.InvariantCulture));
            foreach (var reference in item.ProviderReferences)
            {
                material.Append('|').Append(reference.Provider).Append('=').Append(reference.Value);
            }

            return _revisionAuthority.Create("item", material.ToString());
        }

        private string ProviderRevision(
            bool standardVisible,
            bool fourKVisible,
            SeerrItemRequestStatus standardStatus,
            SeerrItemRequestStatus fourKStatus,
            bool standardRequestable,
            bool fourKRequestable)
        {
            if (standardVisible && fourKVisible)
            {
                return _revisionAuthority.Create(
                    "provider",
                    "standard",
                    ((int)standardStatus).ToString(CultureInfo.InvariantCulture),
                    standardRequestable ? "requestable" : "closed",
                    "four-k",
                    ((int)fourKStatus).ToString(CultureInfo.InvariantCulture),
                    fourKRequestable ? "requestable" : "closed");
            }

            if (standardVisible)
            {
                return _revisionAuthority.Create(
                    "provider",
                    "standard",
                    ((int)standardStatus).ToString(CultureInfo.InvariantCulture),
                    standardRequestable ? "requestable" : "closed");
            }

            return _revisionAuthority.Create(
                "provider",
                "four-k",
                ((int)fourKStatus).ToString(CultureInfo.InvariantCulture),
                fourKRequestable ? "requestable" : "closed");
        }

        private readonly record struct ProviderState(
            SeerrItemRequestStatus StandardStatus,
            SeerrItemRequestStatus FourKStatus,
            bool StandardRequestable,
            bool FourKRequestable);

        private readonly record struct RequestAggregate(int Mask)
        {
            internal bool Pending => (Mask & (1 << 1)) != 0;

            internal bool ApprovedOrCompleted => (Mask & ((1 << 2) | (1 << 5))) != 0;

            internal bool Declined => (Mask & (1 << 3)) != 0;

            internal bool Failed => (Mask & (1 << 4)) != 0;

            internal RequestAggregate Add(int status) => new(Mask | (1 << status));
        }
    }
}
