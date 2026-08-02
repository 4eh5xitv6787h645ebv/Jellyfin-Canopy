using System;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Seerr
{
    /// <summary>The only request editions admitted by the exact installed-item owner.</summary>
    public enum SeerrMediaRequestVariant
    {
        /// <summary>Request the ordinary media edition.</summary>
        Standard,

        /// <summary>Request the 4K media edition.</summary>
        FourK,
    }

    /// <summary>Closed, provider-body-free outcomes from one installed-item request.</summary>
    public enum SeerrMediaRequestOutcome
    {
        /// <summary>Seerr accepted the exact request.</summary>
        Requested,

        /// <summary>Seerr reported that the exact request already exists.</summary>
        AlreadyRequested,

        /// <summary>The authoritative item did not carry one supported TMDB target.</summary>
        InvalidTarget,

        /// <summary>The integration or requested edition is not currently enabled.</summary>
        FeatureUnavailable,

        /// <summary>The acting Jellyfin account is not linked to Seerr.</summary>
        Unlinked,

        /// <summary>The acting Jellyfin account is administratively blocked from Seerr.</summary>
        IdentityBlocked,

        /// <summary>The linked identity could not be authoritatively resolved.</summary>
        IdentityUnavailable,

        /// <summary>The linked identity changed during admission.</summary>
        IdentityChanged,

        /// <summary>The current host user or authoritative item projection changed.</summary>
        HostAuthorizationChanged,

        /// <summary>The linked identity lacks the exact media-edition permission.</summary>
        PermissionDenied,

        /// <summary>The current Jellyfin parental policy refused the title.</summary>
        ParentalBlocked,

        /// <summary>The complete saved integration generation changed before dispatch.</summary>
        ConfigurationChanged,

        /// <summary>Seerr returned a definite rejection for the fixed request.</summary>
        ProviderRejected,

        /// <summary>Seerr returned an unusable or unavailable response.</summary>
        ProviderUnavailable,

        /// <summary>
        /// Seerr accepted the request, but the required Spoiler Guard intent could
        /// not be durably recorded. Retrying would risk a duplicate provider mutation.
        /// </summary>
        AcceptedSpoilerIntentFailed,
    }

    /// <summary>Bounded semantic evidence returned by the installed-item owner.</summary>
    public sealed class SeerrMediaRequestResult
    {
        private SeerrMediaRequestResult(
            SeerrMediaRequestOutcome outcome,
            bool providerAccepted,
            bool spoilerIntentRequired,
            bool spoilerIntentRecorded)
        {
            Outcome = outcome;
            ProviderAccepted = providerAccepted;
            SpoilerIntentRequired = spoilerIntentRequired;
            SpoilerIntentRecorded = spoilerIntentRecorded;
        }

        /// <summary>Gets the closed semantic outcome.</summary>
        public SeerrMediaRequestOutcome Outcome { get; }

        /// <summary>Gets whether response headers authoritatively confirmed provider acceptance.</summary>
        public bool ProviderAccepted { get; }

        /// <summary>Gets whether the captured configuration required a durable Spoiler Guard intent.</summary>
        public bool SpoilerIntentRequired { get; }

        /// <summary>Gets whether that required intent was durably recorded.</summary>
        public bool SpoilerIntentRecorded { get; }

        internal static SeerrMediaRequestResult Refused(SeerrMediaRequestOutcome outcome)
            => new(outcome, providerAccepted: false, spoilerIntentRequired: false, spoilerIntentRecorded: false);

        internal static SeerrMediaRequestResult Accepted(bool intentRequired, bool intentRecorded)
            => new(
                intentRequired && !intentRecorded
                    ? SeerrMediaRequestOutcome.AcceptedSpoilerIntentFailed
                    : SeerrMediaRequestOutcome.Requested,
                providerAccepted: true,
                intentRequired,
                intentRecorded);
    }

    /// <summary>
    /// The sole native owner for exact installed Movie/Series Seerr requests. Its
    /// inputs can only be minted by the authenticated Platform and host boundaries;
    /// no caller-selected provider identity enters this contract.
    /// </summary>
    public interface ISeerrMediaRequestOwner
    {
        /// <summary>Requests one exact authoritative installed item.</summary>
        Task<SeerrMediaRequestResult> RequestAsync(
            PlatformActor actor,
            HostAccessibleItem item,
            SeerrMediaRequestVariant variant,
            PlatformIdempotencyKey idempotencyKey,
            CancellationToken cancellationToken);
    }

    internal enum SeerrMediaRequestKind
    {
        Movie,
        Series,
    }

    internal enum SeerrRequestIdentityStatus
    {
        Found,
        NotFound,
        Blocked,
        Unavailable,
    }

    internal enum SeerrRequestIdentityResolutionMode
    {
        InitialAdmission,
        FinalPreDispatch,
    }

    internal readonly record struct SeerrRequestIdentity(
        int UserId,
        SeerrPermission Permissions,
        string SourceUrl);

    internal readonly record struct SeerrRequestIdentityResolution(
        SeerrRequestIdentityStatus Status,
        SeerrRequestIdentity Identity)
    {
        internal bool IsFound => Status == SeerrRequestIdentityStatus.Found
            && Identity.UserId > 0
            && !string.IsNullOrEmpty(Identity.SourceUrl);
    }

    /// <summary>
    /// Narrow identity/capability seam implemented by the shared client without
    /// releasing its generic proxy surface to the native owner.
    /// </summary>
    internal interface ISeerrMediaRequestAdmission
    {
        Task<SeerrRequestIdentityResolution> ResolveAsync(
            Guid jellyfinUserId,
            SeerrRequestIdentityResolutionMode mode,
            CancellationToken cancellationToken);

        Task<Seerr4kCapability> Get4kCapabilityAsync(
            SeerrRequestIdentity admittedIdentity,
            bool isAdministrator,
            CancellationToken cancellationToken);

        void InvalidateIdentity(Guid jellyfinUserId);
    }

    /// <summary>Typed durability seam; raw request JSON never crosses it.</summary>
    internal interface ISeerrSpoilerIntentStore
    {
        bool TryRegister(Guid userId, SeerrMediaRequestKind kind, int tmdbId);
    }

    /// <summary>Single-dispatch implementation behind the closed owner contract.</summary>
    internal sealed class SeerrMediaRequestOwner : ISeerrMediaRequestOwner
    {
        private const string RequestPath = "/api/v1/request";
        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(15);

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly IPluginConfigProvider _configProvider;
        private readonly IPlatformHost _host;
        private readonly ISeerrMediaRequestAdmission _admission;
        private readonly ISeerrParentalFilter _parentalFilter;
        private readonly ISeerrSpoilerIntentStore _spoilerIntentStore;
        private readonly ILogger<SeerrMediaRequestOwner> _logger;

        public SeerrMediaRequestOwner(
            IHttpClientFactory httpClientFactory,
            IPluginConfigProvider configProvider,
            IPlatformHost host,
            ISeerrMediaRequestAdmission admission,
            ISeerrParentalFilter parentalFilter,
            ISeerrSpoilerIntentStore spoilerIntentStore,
            ILogger<SeerrMediaRequestOwner> logger)
        {
            _httpClientFactory = httpClientFactory ?? throw new ArgumentNullException(nameof(httpClientFactory));
            _configProvider = configProvider ?? throw new ArgumentNullException(nameof(configProvider));
            _host = host ?? throw new ArgumentNullException(nameof(host));
            _admission = admission ?? throw new ArgumentNullException(nameof(admission));
            _parentalFilter = parentalFilter ?? throw new ArgumentNullException(nameof(parentalFilter));
            _spoilerIntentStore = spoilerIntentStore ?? throw new ArgumentNullException(nameof(spoilerIntentStore));
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        }

        public async Task<SeerrMediaRequestResult> RequestAsync(
            PlatformActor actor,
            HostAccessibleItem item,
            SeerrMediaRequestVariant variant,
            PlatformIdempotencyKey idempotencyKey,
            CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(actor);
            if (!Enum.IsDefined(variant))
            {
                throw new ArgumentOutOfRangeException(nameof(variant));
            }

            if (string.IsNullOrEmpty(idempotencyKey.Value))
            {
                throw new ArgumentException("A validated Platform idempotency key is required.", nameof(idempotencyKey));
            }

            cancellationToken.ThrowIfCancellationRequested();
            if (!TryProjectTarget(item, out var target))
            {
                return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.InvalidTarget);
            }

            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            var config = integration.Configuration;
            if (!integration.IsActive || config == null)
            {
                return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.FeatureUnavailable);
            }

            var initialResolution = await _admission.ResolveAsync(
                actor.UserId,
                SeerrRequestIdentityResolutionMode.InitialAdmission,
                cancellationToken).ConfigureAwait(false);
            if (!integration.IsCurrent(_configProvider))
            {
                return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.ConfigurationChanged);
            }

            var initialIdentityResult = ValidateIdentity(
                initialResolution,
                integration.Urls,
                target,
                variant,
                actor.IsElevated,
                out var initialIdentity);
            if (initialIdentityResult != null)
            {
                return initialIdentityResult;
            }

            if (variant == SeerrMediaRequestVariant.FourK)
            {
                var masterEnabled = target.Kind == SeerrMediaRequestKind.Series
                    ? config.SeerrEnable4KTvRequests
                    : config.SeerrEnable4KRequests;
                if (!masterEnabled)
                {
                    return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.FeatureUnavailable);
                }

                var capability = await _admission.Get4kCapabilityAsync(
                    initialIdentity,
                    actor.IsElevated,
                    cancellationToken).ConfigureAwait(false);
                if (!integration.IsCurrent(_configProvider))
                {
                    return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.ConfigurationChanged);
                }

                var canRequest = target.Kind == SeerrMediaRequestKind.Series
                    ? capability.CanRequest4kTv
                    : capability.CanRequest4kMovie;
                if (!canRequest)
                {
                    return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.FeatureUnavailable);
                }
            }

            var caller = new SeerrCaller(actor.UserId.ToString("D"), actor.IsElevated);
            var blocked = await _parentalFilter.IsBlockedAsync(
                target.MediaType,
                target.TmdbId,
                caller,
                cancellationToken).ConfigureAwait(false);
            if (!integration.IsCurrent(_configProvider))
            {
                return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.ConfigurationChanged);
            }

            if (blocked)
            {
                return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.ParentalBlocked);
            }

            // Refresh immediately before dispatch. No auto-import is coupled to this
            // mutation, and the exact id/permission/source binding must match every
            // admission decision above.
            var finalResolution = await _admission.ResolveAsync(
                actor.UserId,
                SeerrRequestIdentityResolutionMode.FinalPreDispatch,
                cancellationToken).ConfigureAwait(false);
            if (!integration.IsCurrent(_configProvider))
            {
                return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.ConfigurationChanged);
            }

            var finalIdentityResult = ValidateIdentity(
                finalResolution,
                integration.Urls,
                target,
                variant,
                actor.IsElevated,
                out var finalIdentity);
            if (finalIdentityResult != null)
            {
                _admission.InvalidateIdentity(actor.UserId);
                return finalIdentityResult;
            }

            if (!initialIdentity.Equals(finalIdentity))
            {
                _admission.InvalidateIdentity(actor.UserId);
                return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.IdentityChanged);
            }

            var persistSpoilerIntent = config.SpoilerBlurEnabled
                && config.SpoilerAutoEnableOnSeerrRequest;
            var requestUri = finalIdentity.SourceUrl + RequestPath;
            var requestBody = BuildRequestBody(target, variant);
            var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = RequestTimeout;
            using var request = SeerrHttpHelper.BuildRequest(
                HttpMethod.Post,
                requestUri,
                integration.ApiKey,
                finalIdentity.UserId.ToString(CultureInfo.InvariantCulture),
                requestBody);
            request.Headers.Add(PlatformIdempotencyKey.HeaderName, idempotencyKey.Value);

            // Client factories and request/header construction are arbitrary code
            // boundaries. Re-enter the host only after they finish, then dispatch
            // synchronously through the typed configuration fence with no intervening
            // authority-capable work.
            cancellationToken.ThrowIfCancellationRequested();
            var currentUser = _host.Users.Find(actor.UserId);
            var currentAccess = _host.Library.FindAccessible(actor.UserId, item.Id);
            if (!currentUser.HasValue
                || (actor.IsElevated && !currentUser.Value.IsAdministrator)
                || currentAccess.Item is not HostAccessibleItem currentItem
                || !SameAuthoritativeItem(item, currentItem)
                || !TryProjectTarget(currentItem, out var currentTarget)
                || !target.Equals(currentTarget))
            {
                return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.HostAuthorizationChanged);
            }

            cancellationToken.ThrowIfCancellationRequested();

            HttpResponseMessage response;
            try
            {
                response = await SeerrHttpHelper.SendResponseHeadersReadAsync(
                    httpClient,
                    request,
                    integration.CreateDispatchFence(_configProvider),
                    cancellationToken).ConfigureAwait(false);
            }
            catch (SeerrDispatchNotAttemptedException)
            {
                return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.ConfigurationChanged);
            }

            using (response)
            {
                if (response.IsSuccessStatusCode)
                {
                    // ResponseHeadersRead has confirmed the provider mutation. Fulfil the
                    // frozen local durability obligation synchronously before observing
                    // caller cancellation again or executing any fallible post-work.
                    var intentRecorded = false;
                    if (persistSpoilerIntent)
                    {
                        try
                        {
                            intentRecorded = _spoilerIntentStore.TryRegister(
                                actor.UserId,
                                target.Kind,
                                target.TmdbId);
                        }
                        catch (Exception exception)
                        {
                            _logger.LogError(
                                exception,
                                "Seerr accepted an installed-item request, but its Spoiler Guard intent could not be persisted.");
                        }
                    }

                    if (persistSpoilerIntent && !intentRecorded)
                    {
                        _logger.LogWarning(
                            "Seerr accepted an installed-item request, but Spoiler Guard intent registration failed.");
                    }

                    return SeerrMediaRequestResult.Accepted(persistSpoilerIntent, intentRecorded);
                }

                if (response.StatusCode == HttpStatusCode.Conflict)
                {
                    return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.AlreadyRequested);
                }

                if (response.StatusCode is HttpStatusCode.RequestTimeout
                    or HttpStatusCode.TooManyRequests)
                {
                    return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.ProviderUnavailable);
                }

                if ((int)response.StatusCode is >= 400 and < 500)
                {
                    return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.ProviderRejected);
                }

                return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.ProviderUnavailable);
            }
        }

        private static bool SameAuthoritativeItem(
            HostAccessibleItem admitted,
            HostAccessibleItem current)
            => admitted.Id == current.Id
                && admitted.Kind == current.Kind
                && admitted.SeriesId == current.SeriesId
                && admitted.ProviderReferences.SequenceEqual(current.ProviderReferences);

        private static SeerrMediaRequestResult? ValidateIdentity(
            SeerrRequestIdentityResolution resolution,
            string[] configuredSources,
            RequestTarget target,
            SeerrMediaRequestVariant variant,
            bool isAdministrator,
            out SeerrRequestIdentity identity)
        {
            identity = resolution.Identity;
            if (!resolution.IsFound)
            {
                return SeerrMediaRequestResult.Refused(resolution.Status switch
                {
                    SeerrRequestIdentityStatus.NotFound => SeerrMediaRequestOutcome.Unlinked,
                    SeerrRequestIdentityStatus.Blocked => SeerrMediaRequestOutcome.IdentityBlocked,
                    _ => SeerrMediaRequestOutcome.IdentityUnavailable,
                });
            }

            var sourceUrl = identity.SourceUrl;
            var sourceIsCurrent = configuredSources.Any(source => string.Equals(
                source,
                sourceUrl,
                StringComparison.Ordinal));
            if (!sourceIsCurrent)
            {
                return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.IdentityUnavailable);
            }

            if (!isAdministrator && !HasPermission(identity.Permissions, target.Kind, variant))
            {
                return SeerrMediaRequestResult.Refused(SeerrMediaRequestOutcome.PermissionDenied);
            }

            return null;
        }

        private static bool HasPermission(
            SeerrPermission permissions,
            SeerrMediaRequestKind kind,
            SeerrMediaRequestVariant variant)
        {
            if (SeerrPermissionHelper.HasPermission(permissions, SeerrPermission.ADMIN))
            {
                return true;
            }

            if (variant == SeerrMediaRequestVariant.FourK)
            {
                return SeerrPermissionHelper.CanRequest4k(
                    permissions,
                    isTv: kind == SeerrMediaRequestKind.Series);
            }

            var mediaPermission = kind == SeerrMediaRequestKind.Series
                ? SeerrPermission.REQUEST_TV
                : SeerrPermission.REQUEST_MOVIE;
            return SeerrPermissionHelper.HasAnyPermission(
                permissions,
                SeerrPermission.REQUEST | mediaPermission);
        }

        private static bool TryProjectTarget(HostAccessibleItem item, out RequestTarget target)
        {
            target = default;
            if (item.Id == Guid.Empty
                || item.Kind is not (HostItemKind.Movie or HostItemKind.Series)
                || item.ProviderReferences.IsDefaultOrEmpty)
            {
                return false;
            }

            var tmdbValues = item.ProviderReferences
                .Where(reference => string.Equals(reference.Provider, "Tmdb", StringComparison.Ordinal))
                .Select(reference => reference.Value)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (tmdbValues.Length != 1
                || !int.TryParse(
                    tmdbValues[0],
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out var tmdbId)
                || tmdbId <= 0)
            {
                return false;
            }

            var kind = item.Kind == HostItemKind.Series
                ? SeerrMediaRequestKind.Series
                : SeerrMediaRequestKind.Movie;
            target = new RequestTarget(
                kind,
                tmdbId,
                kind == SeerrMediaRequestKind.Series ? "tv" : "movie");
            return true;
        }

        private static string BuildRequestBody(
            RequestTarget target,
            SeerrMediaRequestVariant variant)
        {
            object body = target.Kind == SeerrMediaRequestKind.Series
                ? new
                {
                    mediaType = target.MediaType,
                    mediaId = target.TmdbId,
                    seasons = "all",
                    is4k = variant == SeerrMediaRequestVariant.FourK,
                }
                : new
                {
                    mediaType = target.MediaType,
                    mediaId = target.TmdbId,
                    is4k = variant == SeerrMediaRequestVariant.FourK,
                };
            return JsonSerializer.Serialize(body);
        }

        private readonly record struct RequestTarget(
            SeerrMediaRequestKind Kind,
            int TmdbId,
            string MediaType);
    }
}
