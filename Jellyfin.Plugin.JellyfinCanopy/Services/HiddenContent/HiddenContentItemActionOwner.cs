using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>Closed installed item kinds supported by Hidden Content's native pilot.</summary>
    public enum HiddenContentItemKind
    {
        /// <summary>A Jellyfin movie.</summary>
        Movie,

        /// <summary>A Jellyfin series.</summary>
        Series,

        /// <summary>A Jellyfin episode.</summary>
        Episode,
    }

    /// <summary>The exact persisted filtering scope selected for one installed item.</summary>
    public enum HiddenContentItemScope
    {
        /// <summary>Every enabled Hidden Content surface.</summary>
        Global,

        /// <summary>Continue Watching only.</summary>
        ContinueWatching,

        /// <summary>Next Up only.</summary>
        NextUp,

        /// <summary>Continue Watching and Next Up.</summary>
        HomeSections,
    }

    /// <summary>Authoritative acting-user projection accepted below transport boundaries.</summary>
    public sealed class HiddenContentActorProjection
    {
        internal HiddenContentActorProjection(Guid userId)
        {
            if (userId == Guid.Empty)
            {
                throw new ArgumentException("A Hidden Content actor must have a non-empty user id.", nameof(userId));
            }

            UserId = userId;
        }

        /// <summary>Gets the authenticated acting Jellyfin user.</summary>
        public Guid UserId { get; }
    }

    /// <summary>
    /// Bounded server-derived installed-item projection. Only a boundary that has
    /// completed a fresh user-scoped access lookup may construct this value.
    /// </summary>
    public sealed class HiddenContentItemProjection
    {
        internal HiddenContentItemProjection(
            Guid itemId,
            HiddenContentItemKind kind,
            string? displayName,
            string? tmdbId,
            Guid? seriesId,
            string? seriesName,
            int? seasonNumber,
            int? episodeNumber)
        {
            if (itemId == Guid.Empty)
            {
                throw new ArgumentException("A Hidden Content item must have a non-empty id.", nameof(itemId));
            }

            if (!Enum.IsDefined(kind))
            {
                throw new ArgumentOutOfRangeException(nameof(kind));
            }

            ItemId = itemId;
            Kind = kind;
            DisplayName = PersistedPayloadPolicy.ClampPersistedDisplayName(displayName);
            TmdbId = NormalizeTmdbId(tmdbId);
            SeriesId = kind == HiddenContentItemKind.Episode
                && seriesId.HasValue
                && seriesId.Value != Guid.Empty
                    ? seriesId
                    : null;
            SeriesName = kind == HiddenContentItemKind.Episode
                ? PersistedPayloadPolicy.ClampPersistedDisplayName(seriesName)
                : null;
            SeasonNumber = kind == HiddenContentItemKind.Episode
                ? PersistedPayloadPolicy.NormalizeHiddenIndex(seasonNumber)
                : null;
            EpisodeNumber = kind == HiddenContentItemKind.Episode
                ? PersistedPayloadPolicy.NormalizeHiddenIndex(episodeNumber)
                : null;
        }

        /// <summary>Gets the exact accessible Jellyfin item id.</summary>
        public Guid ItemId { get; }

        /// <summary>Gets the closed server-derived item kind.</summary>
        public HiddenContentItemKind Kind { get; }

        /// <summary>Gets optional server-derived presentation text.</summary>
        public string? DisplayName { get; }

        /// <summary>Gets an optional canonical positive TMDB id.</summary>
        public string? TmdbId { get; }

        /// <summary>Gets server-derived series ancestry for an episode.</summary>
        public Guid? SeriesId { get; }

        /// <summary>Gets optional server-derived series presentation text.</summary>
        public string? SeriesName { get; }

        /// <summary>Gets the bounded season index, when available.</summary>
        public int? SeasonNumber { get; }

        /// <summary>Gets the bounded episode index, when available.</summary>
        public int? EpisodeNumber { get; }

        private static string? NormalizeTmdbId(string? value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 32 || value.All(character => character == '0'))
            {
                return null;
            }

            return value.All(character => character is >= '0' and <= '9') ? value : null;
        }
    }

    /// <summary>Validated desired state for one exact installed item.</summary>
    public sealed class HiddenContentItemConfiguration
    {
        private HiddenContentItemConfiguration(
            bool hidden,
            HiddenContentItemScope scope,
            bool enableOnFirstScopedHide,
            bool legacyHomeSurfaceSemantics,
            long? expectedItemsRevision)
        {
            if (!Enum.IsDefined(scope))
            {
                throw new ArgumentOutOfRangeException(nameof(scope));
            }

            Hidden = hidden;
            Scope = scope;
            EnableOnFirstScopedHide = enableOnFirstScopedHide;
            LegacyHomeSurfaceSemantics = legacyHomeSurfaceSemantics;
            ExpectedItemsRevision = expectedItemsRevision;
        }

        /// <summary>Gets the desired hidden membership.</summary>
        public bool Hidden { get; }

        /// <summary>Gets the desired exact filtering scope.</summary>
        public HiddenContentItemScope Scope { get; }

        internal bool EnableOnFirstScopedHide { get; }

        internal bool LegacyHomeSurfaceSemantics { get; }

        /// <summary>Gets the exact item-resource revision required by a native mutation.</summary>
        public long? ExpectedItemsRevision { get; }

        internal static HiddenContentItemConfiguration Exact(
            bool hidden,
            HiddenContentItemScope scope,
            long expectedItemsRevision)
        {
            if (expectedItemsRevision < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(expectedItemsRevision));
            }

            return new(
                hidden,
                scope,
                enableOnFirstScopedHide: false,
                legacyHomeSurfaceSemantics: false,
                expectedItemsRevision);
        }

        internal static HiddenContentItemConfiguration LegacyHomeSurface(
            bool hidden,
            HiddenContentItemScope scope)
        {
            if (scope is not (HiddenContentItemScope.ContinueWatching or HiddenContentItemScope.NextUp))
            {
                throw new ArgumentOutOfRangeException(nameof(scope));
            }

            return new(
                hidden,
                scope,
                enableOnFirstScopedHide: hidden,
                legacyHomeSurfaceSemantics: true,
                expectedItemsRevision: null);
        }
    }

    /// <summary>Closed semantic result from one exact-item owner invocation.</summary>
    public enum HiddenContentItemActionOutcome
    {
        /// <summary>The desired state was applied or was already present.</summary>
        Configured,

        /// <summary>A new row could not be admitted at the fixed item cap.</summary>
        CapacityExceeded,

        /// <summary>The resulting complete persisted graph exceeded its byte budget.</summary>
        PayloadTooLarge,

        /// <summary>The current item-resource revision did not match the native precondition.</summary>
        RevisionConflict,
    }

    /// <summary>Minimal bounded identity evidence returned by the installed-item owner.</summary>
    public sealed class HiddenContentItemIdentityState
    {
        internal HiddenContentItemIdentityState(int version, string provider, string mediaType, string id)
        {
            Version = version;
            Provider = provider;
            MediaType = mediaType;
            Id = id;
        }

        /// <summary>Gets the identity schema version.</summary>
        public int Version { get; }

        /// <summary>Gets the provider name.</summary>
        public string Provider { get; }

        /// <summary>Gets the provider media type.</summary>
        public string MediaType { get; }

        /// <summary>Gets the provider item id.</summary>
        public string Id { get; }
    }

    /// <summary>
    /// Minimal bounded installed-item evidence. Opaque durable extension data is
    /// deliberately excluded so one action result always remains safely replayable.
    /// </summary>
    public sealed class HiddenContentItemState
    {
        internal HiddenContentItemState(
            string itemId,
            string name,
            string type,
            string tmdbId,
            HiddenContentItemIdentityState? identity,
            string hiddenAt,
            string posterPath,
            string seriesId,
            string seriesName,
            int? seasonNumber,
            int? episodeNumber,
            string hideScope)
        {
            ItemId = itemId;
            Name = name;
            Type = type;
            TmdbId = tmdbId;
            Identity = identity;
            HiddenAt = hiddenAt;
            PosterPath = posterPath;
            SeriesId = seriesId;
            SeriesName = seriesName;
            SeasonNumber = seasonNumber;
            EpisodeNumber = episodeNumber;
            HideScope = hideScope;
        }

        /// <summary>Gets the Jellyfin item id.</summary>
        public string ItemId { get; }

        /// <summary>Gets bounded presentation text.</summary>
        public string Name { get; }

        /// <summary>Gets the stored item kind.</summary>
        public string Type { get; }

        /// <summary>Gets the legacy TMDB id.</summary>
        public string TmdbId { get; }

        /// <summary>Gets typed identity evidence when present.</summary>
        public HiddenContentItemIdentityState? Identity { get; }

        /// <summary>Gets the original hide timestamp.</summary>
        public string HiddenAt { get; }

        /// <summary>Gets the bounded legacy poster path.</summary>
        public string PosterPath { get; }

        /// <summary>Gets episode series ancestry.</summary>
        public string SeriesId { get; }

        /// <summary>Gets bounded episode series presentation text.</summary>
        public string SeriesName { get; }

        /// <summary>Gets the bounded season index.</summary>
        public int? SeasonNumber { get; }

        /// <summary>Gets the bounded episode index.</summary>
        public int? EpisodeNumber { get; }

        /// <summary>Gets the stored hide scope.</summary>
        public string HideScope { get; }
    }

    /// <summary>HTTP-independent item state and revision evidence.</summary>
    public sealed class HiddenContentItemActionResult
    {
        internal HiddenContentItemActionResult(
            HiddenContentItemActionOutcome outcome,
            bool hidden,
            bool changed,
            string key,
            HiddenContentItemState? entry,
            long itemsRevision,
            long settingsRevision,
            bool hiddenContentEnabled,
            bool settingsChanged)
        {
            Outcome = outcome;
            Hidden = hidden;
            Changed = changed;
            Key = key;
            Entry = entry;
            ItemsRevision = itemsRevision;
            SettingsRevision = settingsRevision;
            HiddenContentEnabled = hiddenContentEnabled;
            SettingsChanged = settingsChanged;
        }

        /// <summary>Gets the closed result.</summary>
        public HiddenContentItemActionOutcome Outcome { get; }

        /// <summary>Gets whether the requested exact scope is present.</summary>
        public bool Hidden { get; }

        /// <summary>Gets whether durable state changed.</summary>
        public bool Changed { get; }

        /// <summary>Gets the canonical legacy-compatible storage key.</summary>
        public string Key { get; }

        /// <summary>Gets the committed row for a successful hide.</summary>
        public HiddenContentItemState? Entry { get; }

        /// <summary>Gets the item-resource revision after the decision.</summary>
        public long ItemsRevision { get; }

        /// <summary>Gets the preference revision after the decision.</summary>
        public long SettingsRevision { get; }

        /// <summary>Gets the persisted per-user master switch.</summary>
        public bool HiddenContentEnabled { get; }

        /// <summary>Gets whether first-use initialization enabled filtering.</summary>
        public bool SettingsChanged { get; }
    }

    /// <summary>Single HTTP-free owner for accessible installed-item configuration.</summary>
    public interface IHiddenContentItemActionOwner
    {
        /// <summary>Reads exact installed-item state from the actor's policy store.</summary>
        HiddenContentItemActionResult GetState(
            HiddenContentActorProjection actor,
            HiddenContentItemProjection item,
            HiddenContentItemScope scope);

        /// <summary>Applies one validated desired state.</summary>
        HiddenContentItemActionResult Configure(
            HiddenContentActorProjection actor,
            HiddenContentItemProjection item,
            HiddenContentItemConfiguration configuration);
    }

    /// <summary>
    /// Assembly-internal legacy response channel. Platform adapters cannot
    /// return or serialize this full persisted-row evidence.
    /// </summary>
    internal interface IHiddenContentLegacyItemActionOwner
    {
        HiddenContentLegacyItemActionResult ConfigureLegacyHomeSurface(
            HiddenContentActorProjection actor,
            HiddenContentItemProjection item,
            HiddenContentItemConfiguration configuration);
    }

    internal sealed class HiddenContentLegacyItemActionResult
    {
        internal HiddenContentLegacyItemActionResult(
            HiddenContentItemActionResult action,
            HiddenContentItem? entry)
        {
            Action = action;
            Entry = entry;
        }

        internal HiddenContentItemActionResult Action { get; }

        internal HiddenContentItem? Entry { get; }
    }

    /// <summary>Locked persistence implementation for exact installed-item state.</summary>
    public sealed class HiddenContentItemActionOwner :
        IHiddenContentItemActionOwner,
        IHiddenContentLegacyItemActionOwner
    {
        private const string FileName = "hidden-content.json";
        private readonly UserConfigurationManager _configurationManager;
        private readonly IPluginConfigProvider _configProvider;
        private readonly TimeProvider _timeProvider;

        /// <summary>Initializes the production owner.</summary>
        public HiddenContentItemActionOwner(
            UserConfigurationManager configurationManager,
            IPluginConfigProvider configProvider)
            : this(configurationManager, configProvider, TimeProvider.System)
        {
        }

        internal HiddenContentItemActionOwner(
            UserConfigurationManager configurationManager,
            IPluginConfigProvider configProvider,
            TimeProvider timeProvider)
        {
            _configurationManager = configurationManager ?? throw new ArgumentNullException(nameof(configurationManager));
            _configProvider = configProvider ?? throw new ArgumentNullException(nameof(configProvider));
            _timeProvider = timeProvider ?? throw new ArgumentNullException(nameof(timeProvider));
        }

        /// <inheritdoc />
        public HiddenContentItemActionResult GetState(
            HiddenContentActorProjection actor,
            HiddenContentItemProjection item,
            HiddenContentItemScope scope)
        {
            ValidateArguments(actor, item, scope);
            var userKey = actor.UserId.ToString("N");
            var read = _configurationManager.ReadUserConfiguration<UserHiddenContent>(userKey, FileName);
            if (!read.HasUsableValue || read.Value == null
                || !PersistedPayloadPolicy.ValidateMutationSource(read.Value).IsValid)
            {
                throw new IOException("Hidden-content state is unavailable.");
            }

            var state = read.Value;
            var matches = MatchingRows(state, item.ItemId).ToArray();
            return Result(
                HiddenContentItemActionOutcome.Configured,
                HasScope(matches, scope),
                changed: false,
                item.ItemId.ToString(),
                matches.Select(pair => pair.Value).FirstOrDefault(),
                state,
                settingsChanged: false);
        }

        /// <inheritdoc />
        public HiddenContentItemActionResult Configure(
            HiddenContentActorProjection actor,
            HiddenContentItemProjection item,
            HiddenContentItemConfiguration configuration)
            => ConfigureCore(actor, item, configuration, captureLegacyEntry: false).Action;

        HiddenContentLegacyItemActionResult IHiddenContentLegacyItemActionOwner.ConfigureLegacyHomeSurface(
            HiddenContentActorProjection actor,
            HiddenContentItemProjection item,
            HiddenContentItemConfiguration configuration)
        {
            ArgumentNullException.ThrowIfNull(configuration);
            if (!configuration.LegacyHomeSurfaceSemantics)
            {
                throw new ArgumentException(
                    "The legacy response channel only accepts a legacy home-surface configuration.",
                    nameof(configuration));
            }

            var completed = ConfigureCore(actor, item, configuration, captureLegacyEntry: true);
            return new HiddenContentLegacyItemActionResult(completed.Action, completed.LegacyEntry);
        }

        private OwnerCompletion ConfigureCore(
            HiddenContentActorProjection actor,
            HiddenContentItemProjection item,
            HiddenContentItemConfiguration configuration,
            bool captureLegacyEntry)
        {
            ArgumentNullException.ThrowIfNull(configuration);
            ValidateArguments(actor, item, configuration.Scope);
            var userKey = actor.UserId.ToString("N");
            HiddenContentItemActionResult? result = null;
            HiddenContentItem? legacyEntry = null;

            _configurationManager.TransactUserConfiguration<UserHiddenContent, int>(
                userKey,
                FileName,
                state =>
                {
                    var read = _configurationManager.ReadUserConfiguration<UserHiddenContent>(userKey, FileName);
                    var missing = RequireMutationRead(userKey, read) == UserConfigReadStatus.Missing;
                    if (!PersistedPayloadPolicy.ValidateMutationSource(state).IsValid)
                    {
                        throw new InvalidDataException("Hidden-content state is invalid.");
                    }

                    var matches = MatchingRowsForMutation(state, item.ItemId, configuration).ToArray();
                    var authoritative = MutationEvidence.Capture(state, matches, configuration.Scope);

                    if (configuration.ExpectedItemsRevision is long expectedRevision
                        && state.ItemsRevision != expectedRevision)
                    {
                        result = RejectedResult(
                            HiddenContentItemActionOutcome.RevisionConflict,
                            item.ItemId.ToString(),
                            authoritative);
                        return 0;
                    }

                    var settingsChanged = false;
                    if (missing && configuration.Hidden)
                    {
                        if (_configProvider.ConfigurationOrNull is not PluginConfiguration defaults)
                        {
                            throw new InvalidDataException("Configured Hidden Content defaults are unavailable.");
                        }

                        state.Settings = HiddenContentDefaults.Create(defaults);
                        if (configuration.EnableOnFirstScopedHide && !state.Settings.Enabled)
                        {
                            state.Settings.Enabled = true;
                            state.Settings.Revision = checked(state.Settings.Revision + 1);
                            settingsChanged = true;
                        }
                    }

                    if (configuration.Hidden)
                    {
                        if (matches.Length == 0 && state.Items.Count >= PersistedPayloadPolicy.MaximumHiddenItems)
                        {
                            result = RejectedResult(
                                HiddenContentItemActionOutcome.CapacityExceeded,
                                item.ItemId.ToString(),
                                authoritative);
                            return 0;
                        }

                        var entry = BuildEntry(
                            item,
                            matches,
                            configuration.Scope,
                            configuration.LegacyHomeSurfaceSemantics);
                        foreach (var pair in matches)
                        {
                            state.Items.Remove(pair.Key);
                        }

                        var key = item.ItemId.ToString();
                        state.Items[key] = entry;
                        HiddenContentRevision.AdvanceItems(state);
                        PersistedPayloadPolicy.NormalizeLegacyRuntimeState(state);
                        var validation = PersistedPayloadPolicy.ValidateMutationCandidate(state);
                        if (!validation.IsValid)
                        {
                            result = validation.Status == PersistedPayloadStatus.TooLarge
                                ? RejectedResult(HiddenContentItemActionOutcome.PayloadTooLarge, key, authoritative)
                                : null;
                            if (result == null)
                            {
                                throw new InvalidDataException("Hidden-content candidate state is invalid.");
                            }

                            return 0;
                        }

                        _configurationManager.SaveUserConfiguration(userKey, FileName, state);
                        if (captureLegacyEntry)
                        {
                            legacyEntry = CloneFullEntry(entry);
                        }

                        result = Result(
                            HiddenContentItemActionOutcome.Configured,
                            hidden: true,
                            changed: true,
                            key,
                            entry,
                            state,
                            settingsChanged);
                        return 1;
                    }

                    var removed = 0;
                    foreach (var pair in matches)
                    {
                        if (!configuration.LegacyHomeSurfaceSemantics
                            || configuration.Scope == HiddenContentItemScope.Global
                            || string.Equals(pair.Value.HideScope, ScopeValue(configuration.Scope), StringComparison.OrdinalIgnoreCase))
                        {
                            state.Items.Remove(pair.Key);
                            removed++;
                        }
                    }

                    if (removed > 0)
                    {
                        HiddenContentRevision.AdvanceItems(state);
                        PersistedPayloadPolicy.NormalizeLegacyRuntimeState(state);
                        var validation = PersistedPayloadPolicy.ValidateMutationCandidate(state);
                        if (!validation.IsValid)
                        {
                            if (validation.Status == PersistedPayloadStatus.TooLarge)
                            {
                                result = RejectedResult(
                                    HiddenContentItemActionOutcome.PayloadTooLarge,
                                    item.ItemId.ToString(),
                                    authoritative);
                                return 0;
                            }

                            throw new InvalidDataException("Hidden-content candidate state is invalid.");
                        }

                        _configurationManager.SaveUserConfiguration(userKey, FileName, state);
                    }

                    result = Result(
                        HiddenContentItemActionOutcome.Configured,
                        hidden: false,
                        changed: removed > 0,
                        item.ItemId.ToString(),
                        entry: null,
                        state,
                        settingsChanged: false);
                    return removed;
                });

            var completed = result ?? throw new InvalidOperationException("Hidden Content owner did not produce a result.");
            if (completed.Outcome == HiddenContentItemActionOutcome.Configured && completed.Changed)
            {
                HiddenContentResponseFilter.InvalidateUser(userKey);
            }

            return new OwnerCompletion(completed, legacyEntry);
        }

        private UserConfigReadStatus RequireMutationRead(
            string userKey,
            UserConfigReadResult<UserHiddenContent> read)
        {
            if (read.HasUsableValue && read.Value != null)
            {
                return read.Status;
            }

            if (string.Equals(read.FaultDetail, "quarantined-recovery-required", StringComparison.Ordinal))
            {
                throw new UserStoreUnhealthyException(FileName, newlyQuarantined: false);
            }

            if (read.Status == UserConfigReadStatus.Unavailable)
            {
                throw new IOException("Hidden-content state is temporarily unavailable.");
            }

            _configurationManager.GetUserConfigurationStrict<UserHiddenContent>(userKey, FileName);
            throw new InvalidDataException("Hidden-content state is corrupt.");
        }

        private HiddenContentItem BuildEntry(
            HiddenContentItemProjection item,
            IReadOnlyCollection<KeyValuePair<string, HiddenContentItem>> matches,
            HiddenContentItemScope requestedScope,
            bool legacyHomeSurfaceSemantics)
        {
            var existing = matches.Select(pair => pair.Value).Where(value => value != null).ToArray();
            var identitySource = existing.FirstOrDefault(value => value.Identity != null);
            HiddenContentIdentity? identity = identitySource?.Identity == null
                ? BuildTmdbIdentity(item)
                : CloneIdentity(identitySource.Identity);
            var tmdbId = identitySource?.Identity != null
                ? IsSupportedTmdbIdentity(identitySource.Identity)
                    ? identitySource.Identity.Id
                    : identitySource.TmdbId
                : identity?.Id ?? existing.Select(value => value.TmdbId).FirstOrDefault(value => !string.IsNullOrEmpty(value)) ?? string.Empty;
            var hiddenAt = existing.Select(value => value.HiddenAt)
                .Where(value => DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out _))
                .OrderBy(value => DateTime.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind))
                .FirstOrDefault()
                ?? _timeProvider.GetUtcNow().UtcDateTime.ToString("o", CultureInfo.InvariantCulture);
            var scope = legacyHomeSurfaceSemantics
                ? MergeLegacyHomeScope(
                    existing.Select(value => value.HideScope)
                        .Aggregate((string?)null, WiderLegacyStoredScope),
                    ScopeValue(requestedScope))
                : ScopeValue(requestedScope);
            var seriesId = legacyHomeSurfaceSemantics
                ? item.SeriesId?.ToString() ?? string.Empty
                : item.SeriesId?.ToString()
                    ?? existing.Select(value => value.SeriesId).FirstOrDefault(value => !string.IsNullOrEmpty(value))
                    ?? string.Empty;

            return new HiddenContentItem
            {
                ItemId = item.ItemId.ToString(),
                Name = PersistedPayloadPolicy.ClampPersistedDisplayName(
                    legacyHomeSurfaceSemantics
                        ? item.DisplayName
                        : item.DisplayName ?? existing.Select(value => value.Name).FirstOrDefault(value => !string.IsNullOrEmpty(value))),
                Type = item.Kind.ToString(),
                TmdbId = tmdbId ?? string.Empty,
                Identity = identity,
                HiddenAt = hiddenAt,
                PosterPath = legacyHomeSurfaceSemantics
                    ? string.Empty
                    : existing.Select(value => value.PosterPath).FirstOrDefault(value => !string.IsNullOrEmpty(value)) ?? string.Empty,
                SeriesId = seriesId,
                SeriesName = PersistedPayloadPolicy.ClampPersistedDisplayName(
                    legacyHomeSurfaceSemantics
                        ? item.SeriesName
                        : item.SeriesName ?? existing.Select(value => value.SeriesName).FirstOrDefault(value => !string.IsNullOrEmpty(value))),
                SeasonNumber = legacyHomeSurfaceSemantics
                    ? item.SeasonNumber
                    : item.SeasonNumber ?? existing.Select(value => value.SeasonNumber).FirstOrDefault(value => value.HasValue),
                EpisodeNumber = legacyHomeSurfaceSemantics
                    ? item.EpisodeNumber
                    : item.EpisodeNumber ?? existing.Select(value => value.EpisodeNumber).FirstOrDefault(value => value.HasValue),
                HideScope = scope,
                ExtensionData = legacyHomeSurfaceSemantics
                    ? new Dictionary<string, System.Text.Json.JsonElement>(StringComparer.Ordinal)
                    : MergeItemExtensionData(existing),
            };
        }

        private static HiddenContentIdentity? BuildTmdbIdentity(HiddenContentItemProjection item)
        {
            var mediaType = item.Kind switch
            {
                HiddenContentItemKind.Movie => "movie",
                HiddenContentItemKind.Series => "tv",
                _ => null,
            };
            return mediaType == null || item.TmdbId == null
                ? null
                : new HiddenContentIdentity
                {
                    Version = 1,
                    Provider = "tmdb",
                    MediaType = mediaType,
                    Id = item.TmdbId,
                };
        }

        private static HiddenContentIdentity CloneIdentity(HiddenContentIdentity identity)
            => new()
            {
                Version = identity.Version,
                Provider = identity.Provider,
                MediaType = identity.MediaType,
                Id = identity.Id,
                ExtensionData = identity.ExtensionData?.ToDictionary(pair => pair.Key, pair => pair.Value.Clone(), StringComparer.Ordinal)
                    ?? new Dictionary<string, System.Text.Json.JsonElement>(StringComparer.Ordinal),
            };

        private static HiddenContentItem CloneFullEntry(HiddenContentItem entry)
            => new()
            {
                ItemId = entry.ItemId,
                Name = entry.Name,
                Type = entry.Type,
                TmdbId = entry.TmdbId,
                Identity = entry.Identity == null ? null : CloneIdentity(entry.Identity),
                HiddenAt = entry.HiddenAt,
                PosterPath = entry.PosterPath,
                SeriesId = entry.SeriesId,
                SeriesName = entry.SeriesName,
                SeasonNumber = entry.SeasonNumber,
                EpisodeNumber = entry.EpisodeNumber,
                HideScope = entry.HideScope,
                ExtensionData = PersistedPayloadPolicy.CloneExtensionData(entry.ExtensionData),
            };

        private static bool IsSupportedTmdbIdentity(HiddenContentIdentity identity)
            => identity.Version == 1
                && string.Equals(identity.Provider, "tmdb", StringComparison.Ordinal)
                && (string.Equals(identity.MediaType, "movie", StringComparison.Ordinal)
                    || string.Equals(identity.MediaType, "tv", StringComparison.Ordinal))
                && identity.Id.Length <= 32
                && identity.Id.All(character => character is >= '0' and <= '9')
                && identity.Id.Any(character => character != '0');

        private static Dictionary<string, System.Text.Json.JsonElement> MergeItemExtensionData(
            IEnumerable<HiddenContentItem> entries)
        {
            var merged = new Dictionary<string, System.Text.Json.JsonElement>(StringComparer.Ordinal);
            var nodeCount = 0;
            foreach (var entry in entries)
            {
                foreach (var pair in entry.ExtensionData)
                {
                    if (!PersistedPayloadPolicy.TryAddMergedExtensionValue(
                            merged,
                            pair.Key,
                            pair.Value,
                            ref nodeCount))
                    {
                        throw new InvalidDataException(
                            "Merged hidden-content extension data exceeds supported bounds.");
                    }
                }
            }

            return merged;
        }

        private static HiddenContentItemState? ProjectResultEntry(HiddenContentItem? entry)
        {
            if (entry == null)
            {
                return null;
            }

            var identity = entry.Identity == null
                ? null
                : new HiddenContentItemIdentityState(
                    entry.Identity.Version,
                    Bounded(entry.Identity.Provider, 64),
                    Bounded(entry.Identity.MediaType, 64),
                    Bounded(entry.Identity.Id, 32));
            return new HiddenContentItemState(
                Bounded(entry.ItemId, 128),
                Bounded(entry.Name, 512),
                Bounded(entry.Type, 64),
                Bounded(entry.TmdbId, 32),
                identity,
                Bounded(entry.HiddenAt, 64),
                Bounded(entry.PosterPath, 512),
                Bounded(entry.SeriesId, 128),
                Bounded(entry.SeriesName, 512),
                PersistedPayloadPolicy.NormalizeHiddenIndex(entry.SeasonNumber),
                PersistedPayloadPolicy.NormalizeHiddenIndex(entry.EpisodeNumber),
                Bounded(entry.HideScope, 64));
        }

        private static string Bounded(string? value, int maximum)
        {
            if (string.IsNullOrEmpty(value))
            {
                return string.Empty;
            }

            if (value.Length <= maximum)
            {
                return value;
            }

            var length = maximum;
            if (char.IsHighSurrogate(value[length - 1])
                && char.IsLowSurrogate(value[length]))
            {
                length--;
            }

            return value[..length];
        }

        private static IEnumerable<KeyValuePair<string, HiddenContentItem>> MatchingRows(
            UserHiddenContent state,
            Guid itemId)
            => state.Items.Where(pair =>
                (Guid.TryParse(pair.Key, out var keyId) && keyId == itemId)
                || (pair.Value != null
                    && Guid.TryParse(pair.Value.ItemId, out var valueId)
                    && valueId == itemId));

        private static IEnumerable<KeyValuePair<string, HiddenContentItem>> MatchingRowsForMutation(
            UserHiddenContent state,
            Guid itemId,
            HiddenContentItemConfiguration configuration)
        {
            if (!configuration.LegacyHomeSurfaceSemantics)
            {
                return MatchingRows(state, itemId);
            }

            return configuration.Hidden
                ? LegacyHideRows(state, itemId)
                : state.Items.Where(pair => pair.Value != null
                    && Guid.TryParse(pair.Value.ItemId, out var valueId)
                    && valueId == itemId);
        }

        private static IEnumerable<KeyValuePair<string, HiddenContentItem>> LegacyHideRows(
            UserHiddenContent state,
            Guid itemId)
        {
            var dashed = itemId.ToString();
            if (state.Items.TryGetValue(dashed, out var dashedEntry))
            {
                yield return new KeyValuePair<string, HiddenContentItem>(dashed, dashedEntry);
            }

            var compact = itemId.ToString("N");
            if (!string.Equals(dashed, compact, StringComparison.OrdinalIgnoreCase)
                && state.Items.TryGetValue(compact, out var compactEntry))
            {
                yield return new KeyValuePair<string, HiddenContentItem>(compact, compactEntry);
            }
        }

        private static bool HasScope(
            IEnumerable<KeyValuePair<string, HiddenContentItem>> matches,
            HiddenContentItemScope scope)
            => matches.Any(pair => scope == HiddenContentItemScope.Global
                ? string.Equals(pair.Value.HideScope, "global", StringComparison.OrdinalIgnoreCase)
                : string.Equals(pair.Value.HideScope, ScopeValue(scope), StringComparison.OrdinalIgnoreCase));

        private static string ScopeValue(HiddenContentItemScope scope) => scope switch
        {
            HiddenContentItemScope.Global => "global",
            HiddenContentItemScope.ContinueWatching => "continuewatching",
            HiddenContentItemScope.NextUp => "nextup",
            HiddenContentItemScope.HomeSections => "homesections",
            _ => throw new ArgumentOutOfRangeException(nameof(scope)),
        };

        private static string? WiderLegacyStoredScope(string? current, string? candidate)
        {
            if (string.IsNullOrEmpty(current)) return candidate;
            if (string.IsNullOrEmpty(candidate)) return current;
            var currentRank = LegacyScopeRank(current);
            var candidateRank = LegacyScopeRank(candidate);
            if (currentRank == 2
                && candidateRank == 2
                && !string.Equals(current, candidate, StringComparison.OrdinalIgnoreCase))
            {
                return "homesections";
            }

            return currentRank >= candidateRank ? current : candidate;
        }

        private static int LegacyScopeRank(string scope)
        {
            if (string.Equals(scope, "global", StringComparison.OrdinalIgnoreCase)) return 4;
            if (string.Equals(scope, "homesections", StringComparison.OrdinalIgnoreCase)) return 3;
            if (string.Equals(scope, "continuewatching", StringComparison.OrdinalIgnoreCase)
                || string.Equals(scope, "nextup", StringComparison.OrdinalIgnoreCase)) return 2;
            return 1;
        }

        private static string MergeLegacyHomeScope(string? existing, string requested)
        {
            if (string.IsNullOrEmpty(existing)) return requested;
            if (string.Equals(existing, "global", StringComparison.OrdinalIgnoreCase)) return "global";
            if (string.Equals(existing, "homesections", StringComparison.OrdinalIgnoreCase)) return "homesections";
            if (string.Equals(existing, requested, StringComparison.OrdinalIgnoreCase)) return requested;
            return "homesections";
        }

        private static HiddenContentItemActionResult Result(
            HiddenContentItemActionOutcome outcome,
            bool hidden,
            bool changed,
            string key,
            HiddenContentItem? entry,
            UserHiddenContent state,
            bool settingsChanged)
            => new(
                outcome,
                hidden,
                changed,
                key,
                ProjectResultEntry(entry),
                state.ItemsRevision,
                state.Settings.Revision,
                state.Settings.Enabled,
                settingsChanged);

        private static HiddenContentItemActionResult RejectedResult(
            HiddenContentItemActionOutcome outcome,
            string key,
            MutationEvidence evidence)
            => new(
                outcome,
                evidence.Hidden,
                changed: false,
                key,
                evidence.Entry,
                evidence.ItemsRevision,
                evidence.SettingsRevision,
                evidence.HiddenContentEnabled,
                settingsChanged: false);

        private readonly record struct MutationEvidence(
            bool Hidden,
            HiddenContentItemState? Entry,
            long ItemsRevision,
            long SettingsRevision,
            bool HiddenContentEnabled)
        {
            internal static MutationEvidence Capture(
                UserHiddenContent state,
                IReadOnlyCollection<KeyValuePair<string, HiddenContentItem>> matches,
                HiddenContentItemScope scope)
            {
                return new MutationEvidence(
                    HasScope(matches, scope),
                    ProjectResultEntry(matches.Select(pair => pair.Value).FirstOrDefault()),
                    state.ItemsRevision,
                    state.Settings.Revision,
                    state.Settings.Enabled);
            }
        }

        private readonly record struct OwnerCompletion(
            HiddenContentItemActionResult Action,
            HiddenContentItem? LegacyEntry);

        private static void ValidateArguments(
            HiddenContentActorProjection actor,
            HiddenContentItemProjection item,
            HiddenContentItemScope scope)
        {
            ArgumentNullException.ThrowIfNull(actor);
            ArgumentNullException.ThrowIfNull(item);
            if (!Enum.IsDefined(scope))
            {
                throw new ArgumentOutOfRangeException(nameof(scope));
            }
        }
    }
}
