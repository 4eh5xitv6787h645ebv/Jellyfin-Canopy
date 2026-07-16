using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Seerr
{
    /// <summary>
    /// Why the saved Seerr integration is not currently available.
    /// <see cref="Disabled"/> is deliberately distinct from incomplete setup so
    /// callers can report the administrator's master-switch decision without
    /// treating retained credentials as active.
    /// </summary>
    internal enum SeerrIntegrationState
    {
        Active,
        Disabled,
        ConfigurationUnavailable,
        CredentialsMissing,
        UrlsInvalid,
        ConfigurationChanged,
    }

    /// <summary>
    /// The single semantic owner of the Seerr master switch and saved-credential
    /// contract. Every active (non-setup) read, background operation, advertised
    /// capability and mutation must enter through <see cref="Capture"/> or use
    /// <see cref="HasUsableSavedConfiguration"/> for a current-generation fence.
    ///
    /// Administrator setup probes intentionally do not use this policy: they
    /// validate explicitly supplied, potentially unsaved URL/key pairs. Those
    /// exact endpoints are pinned as named exemptions by
    /// <c>SeerrIntegrationEntryPointGuardTests</c>.
    /// </summary>
    public static class SeerrIntegrationPolicy
    {
        /// <summary>
        /// Opaque, fail-closed capability for a single captured Seerr generation.
        /// Transport APIs accept this type instead of arbitrary boolean delegates,
        /// so caller restrictions can only narrow the policy-owned base fence.
        /// </summary>
        public sealed class SeerrDispatchFence
        {
            private readonly SeerrIntegrationSnapshot _snapshot;
            private readonly IPluginConfigProvider _provider;
            private readonly Func<bool>? _restriction;

            private SeerrDispatchFence(
                SeerrIntegrationSnapshot snapshot,
                IPluginConfigProvider provider,
                Func<bool>? restriction)
            {
                _snapshot = snapshot;
                _provider = provider;
                _restriction = restriction;
            }

            internal static SeerrDispatchFence Create(
                SeerrIntegrationSnapshot snapshot,
                IPluginConfigProvider provider)
                => new(snapshot, provider, restriction: null);

            internal SeerrDispatchFence Restrict(Func<bool> restriction)
            {
                ArgumentNullException.ThrowIfNull(restriction);
                return new SeerrDispatchFence(
                    _snapshot,
                    _provider,
                    _restriction == null
                        ? restriction
                        : () => Invoke(_restriction) && Invoke(restriction));
            }

            internal bool CanDispatch()
            {
                try
                {
                    return _snapshot.IsActive
                        && _snapshot.IsCurrent(_provider)
                        && (_restriction == null || Invoke(_restriction));
                }
                catch
                {
                    return false;
                }
            }

            internal bool CanDispatch(Uri? target)
                => CanDispatch() && _snapshot.ContainsTarget(target);

            private static bool Invoke(Func<bool> predicate)
            {
                try
                {
                    return predicate();
                }
                catch
                {
                    return false;
                }
            }
        }

        /// <summary>
        /// One immutable authorization snapshot for a non-setup Seerr operation.
        /// </summary>
        public sealed class SeerrIntegrationSnapshot
        {
            private readonly SeerrMutationConfigStamp _stamp;
            private readonly PluginConfiguration? _configuration;
            private readonly string[] _urls;

            private SeerrIntegrationSnapshot(
                SeerrIntegrationState state,
                PluginConfiguration? configuration,
                long configurationRevision,
                string[] urls,
                string apiKey,
                SeerrMutationConfigStamp stamp)
            {
                State = state;
                _configuration = configuration;
                ConfigurationRevision = configurationRevision;
                _urls = (string[])urls.Clone();
                ApiKey = apiKey;
                _stamp = stamp;
            }

            internal SeerrIntegrationState State { get; }

            public bool IsActive => State == SeerrIntegrationState.Active;

            /// <summary>
            /// Gets an isolated copy of the captured options. Mutating the
            /// returned object cannot alter this snapshot's URL, credential,
            /// option, stamp, or generation projections.
            /// </summary>
            public PluginConfiguration? Configuration => _configuration == null
                ? null
                : SeerrMutationConfigStamp.CloneOwnedConfiguration(_configuration);

            public long ConfigurationRevision { get; }

            public string[] Urls => (string[])_urls.Clone();

            public string ApiKey { get; }

            internal SeerrMutationConfigStamp ConfigurationStamp => _stamp;

            /// <summary>
            /// Opaque owner key for caches, reservations and single-flight work
            /// whose result is valid only for this exact configuration
            /// generation. Identical replacement saves remain distinct while
            /// an unpublished/failed save leaves the identity unchanged.
            /// </summary>
            internal string GenerationIdentity => _stamp.GenerationIdentity;

            internal SeerrDispatchFence CreateDispatchFence(IPluginConfigProvider provider)
                => SeerrDispatchFence.Create(this, provider);

            internal static SeerrIntegrationSnapshot Capture(IPluginConfigProvider provider)
            {
                var liveConfiguration = provider.ConfigurationOrNull;
                var revision = provider.ConfigurationRevision;
                if (liveConfiguration == null)
                {
                    return Inactive(SeerrIntegrationState.ConfigurationUnavailable, revision);
                }

                PluginConfiguration configuration;
                SeerrMutationConfigStamp stamp;
                try
                {
                    (configuration, stamp) = SeerrMutationConfigStamp.CaptureOwnedSnapshot(
                        liveConfiguration,
                        revision);
                }
                catch
                {
                    // A concurrent same-object mutation can make serialization
                    // fail. Capture is an authorization boundary, so it must
                    // return no credentials or targets rather than leak a
                    // partial projection or authorize fail-open.
                    return Inactive(SeerrIntegrationState.ConfigurationChanged, revision);
                }

                if (!AllowsDeferredScheduling(configuration))
                {
                    return Inactive(SeerrIntegrationState.Disabled, revision);
                }

                if (string.IsNullOrWhiteSpace(configuration.SeerrApiKey))
                {
                    return Inactive(SeerrIntegrationState.CredentialsMissing, revision);
                }

                var urls = SeerrUrlIdentity.ParseConfigured(configuration.SeerrUrls);
                if (urls.Length == 0)
                {
                    return Inactive(SeerrIntegrationState.UrlsInvalid, revision);
                }

                var snapshot = new SeerrIntegrationSnapshot(
                    SeerrIntegrationState.Active,
                    configuration,
                    revision,
                    urls,
                    configuration.SeerrApiKey,
                    stamp);
                return snapshot.IsCurrent(provider)
                    ? snapshot
                    : Inactive(SeerrIntegrationState.ConfigurationChanged, provider.ConfigurationRevision);
            }

            public bool IsCurrent(IPluginConfigProvider provider)
            {
                var current = provider.ConfigurationOrNull;
                return HasUsableSavedConfiguration(current)
                    && _stamp.Matches(current, provider.ConfigurationRevision);
            }

            internal bool ContainsTarget(Uri? target)
            {
                if (target == null || !target.IsAbsoluteUri) return false;
                var absolute = target.AbsoluteUri;
                return _urls.Any(source =>
                    string.Equals(absolute, source, StringComparison.Ordinal)
                    || absolute.StartsWith(source + "/", StringComparison.Ordinal));
            }

            private static SeerrIntegrationSnapshot Inactive(
                SeerrIntegrationState state,
                long revision)
                => new(
                    state,
                    configuration: null,
                    revision,
                    System.Array.Empty<string>(),
                    string.Empty,
                    default);
        }

        /// <summary>
        /// Cheap scheduling-only master check for synchronous library-event
        /// handlers. It authorizes no network traffic: the deferred worker must
        /// still obtain a full <see cref="Capture"/> before any outbound call.
        /// </summary>
        public static bool AllowsDeferredScheduling(PluginConfiguration? configuration)
            => configuration?.SeerrEnabled == true;

        /// <summary>
        /// True only when the master is enabled and the saved URL/key material is
        /// usable by an active feature. This is the only production owner that
        /// reads <see cref="PluginConfiguration.SeerrEnabled"/> directly.
        /// </summary>
        public static bool HasUsableSavedConfiguration(PluginConfiguration? configuration)
            => configuration?.SeerrEnabled == true
                && !string.IsNullOrWhiteSpace(configuration.SeerrApiKey)
                && SeerrUrlIdentity.ParseConfigured(configuration.SeerrUrls).Length > 0;

        /// <summary>
        /// Captures one active saved-configuration generation. Inactive states
        /// carry no URL or API key, preventing callers from accidentally using
        /// retained credentials after the master switch is turned off.
        /// </summary>
        public static SeerrIntegrationSnapshot Capture(IPluginConfigProvider provider)
            => SeerrIntegrationSnapshot.Capture(provider);

        /// <summary>
        /// Invalidates both cache domains that can retain active Seerr state.
        /// Each owner is attempted independently so a cancellation callback
        /// failure in the watchlist generation cannot preserve the shared
        /// response/capability caches (or vice versa).
        /// </summary>
        public static IReadOnlyList<(string Owner, Exception Error)> InvalidateCachedActiveState(
            ISeerrCache cache,
            WatchlistMonitor watchlistMonitor)
        {
            var failures = new List<(string Owner, Exception Error)>(2);
            try
            {
                watchlistMonitor.NotifyConfigurationChanged();
            }
            catch (Exception ex)
            {
                failures.Add(("watchlist", ex));
            }

            try
            {
                cache.ClearAllSeerrCachesOnConfigChange();
            }
            catch (Exception ex)
            {
                failures.Add(("shared", ex));
            }

            return failures;
        }

    }
}
