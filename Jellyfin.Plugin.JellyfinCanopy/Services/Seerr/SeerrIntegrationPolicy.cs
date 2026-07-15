using System;
using System.Collections.Generic;
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
    /// One immutable authorization snapshot for a non-setup Seerr operation.
    /// The complete configuration stamp is retained so callers can re-check the
    /// same generation immediately before publishing data or dispatching a
    /// mutation.
    /// </summary>
    internal sealed class SeerrIntegrationSnapshot
    {
        private readonly SeerrMutationConfigStamp _stamp;

        internal SeerrIntegrationSnapshot(
            SeerrIntegrationState state,
            PluginConfiguration? configuration,
            long configurationRevision,
            string[] urls,
            string apiKey,
            SeerrMutationConfigStamp stamp)
        {
            State = state;
            Configuration = configuration;
            ConfigurationRevision = configurationRevision;
            Urls = urls;
            ApiKey = apiKey;
            _stamp = stamp;
        }

        public SeerrIntegrationState State { get; }

        public bool IsActive => State == SeerrIntegrationState.Active;

        public PluginConfiguration? Configuration { get; }

        public long ConfigurationRevision { get; }

        public string[] Urls { get; }

        public string ApiKey { get; }

        internal SeerrMutationConfigStamp ConfigurationStamp => _stamp;

        /// <summary>
        /// Revalidates the entire configuration generation, including in-place
        /// changes made by test/custom providers. A master-switch disable can
        /// therefore fence an already-prepared read or mutation.
        /// </summary>
        public bool IsCurrent(IPluginConfigProvider provider)
        {
            var current = provider.ConfigurationOrNull;
            return SeerrIntegrationPolicy.HasUsableSavedConfiguration(current)
                && _stamp.Matches(current, provider.ConfigurationRevision);
        }
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
    internal static class SeerrIntegrationPolicy
    {
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
        {
            var configuration = provider.ConfigurationOrNull;
            var revision = provider.ConfigurationRevision;
            if (configuration == null)
            {
                return Inactive(SeerrIntegrationState.ConfigurationUnavailable, revision);
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

            var stamp = SeerrMutationConfigStamp.Capture(configuration, revision);
            var snapshot = new SeerrIntegrationSnapshot(
                SeerrIntegrationState.Active,
                configuration,
                revision,
                urls,
                configuration.SeerrApiKey,
                stamp);

            // Configuration and revision are separate provider reads. Reject a
            // replacement or in-place mutation that raced this capture instead
            // of returning credentials from a mixed generation.
            return snapshot.IsCurrent(provider)
                ? snapshot
                : Inactive(SeerrIntegrationState.ConfigurationChanged, provider.ConfigurationRevision);
        }

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
}
