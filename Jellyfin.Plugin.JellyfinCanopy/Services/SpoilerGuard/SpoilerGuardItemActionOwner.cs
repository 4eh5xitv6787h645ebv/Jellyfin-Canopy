using System;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>The installed item kinds supported by Spoiler Guard's shared action owner.</summary>
    public enum SpoilerGuardItemKind
    {
        /// <summary>A Jellyfin movie.</summary>
        Movie,

        /// <summary>A Jellyfin series.</summary>
        Series,
    }

    /// <summary>
    /// The authoritative acting-user projection accepted below the HTTP and Platform
    /// admission boundaries. It deliberately carries no principal, token, target user,
    /// request context, or caller attribution.
    /// </summary>
    public sealed class SpoilerGuardActorProjection
    {
        internal SpoilerGuardActorProjection(Guid userId)
        {
            if (userId == Guid.Empty)
            {
                throw new ArgumentException("A Spoiler Guard actor must have a non-empty user id.", nameof(userId));
            }

            UserId = userId;
        }

        /// <summary>Gets the authenticated acting Jellyfin user.</summary>
        public Guid UserId { get; }
    }

    /// <summary>
    /// The bounded installed-item projection accepted by the owner. Positive
    /// configuration requires a current user-scoped item lookup. Legacy removal may
    /// instead carry an actor-owned-removal proof because deleting an entry from the
    /// actor's own store cannot widen access and must keep working after content is gone.
    /// </summary>
    public sealed class SpoilerGuardItemProjection
    {
        private SpoilerGuardItemProjection(
            Guid itemId,
            SpoilerGuardItemKind kind,
            string? displayName,
            bool actorOwnedRemovalOnly)
        {
            if (itemId == Guid.Empty)
            {
                throw new ArgumentException("A Spoiler Guard item must have a non-empty id.", nameof(itemId));
            }

            if (!Enum.IsDefined(kind))
            {
                throw new ArgumentOutOfRangeException(nameof(kind));
            }

            ItemId = itemId;
            Kind = kind;
            DisplayName = displayName;
            ActorOwnedRemovalOnly = actorOwnedRemovalOnly;
        }

        /// <summary>Gets the exact Jellyfin item id admitted by the calling boundary.</summary>
        public Guid ItemId { get; }

        /// <summary>Gets the closed server-derived item kind.</summary>
        public SpoilerGuardItemKind Kind { get; }

        /// <summary>Gets the server-derived, presentation-only display name.</summary>
        public string? DisplayName { get; }

        internal bool ActorOwnedRemovalOnly { get; }

        internal static SpoilerGuardItemProjection CurrentAccessible(
            Guid itemId,
            SpoilerGuardItemKind kind,
            string? displayName)
            => new(itemId, kind, displayName, actorOwnedRemovalOnly: false);

        internal static SpoilerGuardItemProjection ActorOwnedRemoval(
            Guid itemId,
            SpoilerGuardItemKind kind)
            => new(itemId, kind, displayName: null, actorOwnedRemovalOnly: true);
    }

    /// <summary>The validated desired state for the v1 installed-item configuration owner.</summary>
    public sealed class SpoilerGuardItemConfiguration
    {
        internal SpoilerGuardItemConfiguration(bool enabled) => Enabled = enabled;

        /// <summary>Gets whether Spoiler Guard should be enabled for the item.</summary>
        public bool Enabled { get; }
    }

    /// <summary>The closed semantic outcomes returned by the shared item owner.</summary>
    public enum SpoilerGuardItemActionOutcome
    {
        /// <summary>The desired state was reached, including an idempotent no-op.</summary>
        Configured,

        /// <summary>A new entry could not be admitted because its dictionary is full.</summary>
        CapacityExceeded,
    }

    /// <summary>HTTP-independent evidence returned by one owner invocation.</summary>
    public sealed class SpoilerGuardItemActionResult
    {
        private SpoilerGuardItemActionResult(
            SpoilerGuardItemActionOutcome outcome,
            bool enabled,
            bool changed,
            bool removed,
            long revision,
            string? capacityCategory)
        {
            Outcome = outcome;
            Enabled = enabled;
            Changed = changed;
            Removed = removed;
            Revision = revision;
            CapacityCategory = capacityCategory;
        }

        /// <summary>Gets the closed semantic outcome.</summary>
        public SpoilerGuardItemActionOutcome Outcome { get; }

        /// <summary>Gets the desired enabled state.</summary>
        public bool Enabled { get; }

        /// <summary>Gets whether the durable graph changed.</summary>
        public bool Changed { get; }

        /// <summary>Gets whether a disable removed an existing entry.</summary>
        public bool Removed { get; }

        /// <summary>Gets the authoritative override revision observed after the decision.</summary>
        public long Revision { get; }

        /// <summary>Gets <c>series</c> or <c>movies</c> for a capacity refusal.</summary>
        public string? CapacityCategory { get; }

        internal static SpoilerGuardItemActionResult Configured(
            bool enabled,
            bool changed,
            bool removed,
            long revision)
            => new(
                SpoilerGuardItemActionOutcome.Configured,
                enabled,
                changed,
                removed,
                revision,
                capacityCategory: null);

        internal static SpoilerGuardItemActionResult CapacityExceeded(
            bool enabled,
            long revision,
            string category)
            => new(
                SpoilerGuardItemActionOutcome.CapacityExceeded,
                enabled,
                changed: false,
                removed: false,
                revision,
                category);
    }

    /// <summary>
    /// Shared business owner for installed Movie/Series Spoiler Guard configuration.
    /// The interface contains no controller, HTTP, Jellyfin entity, or request type so
    /// the future Platform adapter can reuse it after the invocation coordinator lands.
    /// </summary>
    public interface ISpoilerGuardItemActionOwner
    {
        /// <summary>Applies one validated desired state for the authoritative actor and item.</summary>
        SpoilerGuardItemActionResult Configure(
            SpoilerGuardActorProjection actor,
            SpoilerGuardItemProjection item,
            SpoilerGuardItemConfiguration configuration);
    }

    /// <summary>The single locked persistence owner for installed item configuration.</summary>
    public sealed class SpoilerGuardItemActionOwner : ISpoilerGuardItemActionOwner
    {
        private readonly UserConfigurationManager _userConfigurationManager;
        private readonly TimeProvider _timeProvider;

        /// <summary>Initializes the production owner with the system UTC clock.</summary>
        public SpoilerGuardItemActionOwner(UserConfigurationManager userConfigurationManager)
            : this(userConfigurationManager, TimeProvider.System)
        {
        }

        internal SpoilerGuardItemActionOwner(
            UserConfigurationManager userConfigurationManager,
            TimeProvider timeProvider)
        {
            _userConfigurationManager = userConfigurationManager
                ?? throw new ArgumentNullException(nameof(userConfigurationManager));
            _timeProvider = timeProvider ?? throw new ArgumentNullException(nameof(timeProvider));
        }

        /// <inheritdoc />
        public SpoilerGuardItemActionResult Configure(
            SpoilerGuardActorProjection actor,
            SpoilerGuardItemProjection item,
            SpoilerGuardItemConfiguration configuration)
        {
            ArgumentNullException.ThrowIfNull(actor);
            ArgumentNullException.ThrowIfNull(item);
            ArgumentNullException.ThrowIfNull(configuration);

            if (item.ActorOwnedRemovalOnly && configuration.Enabled)
            {
                throw new ArgumentException(
                    "An actor-owned removal projection cannot authorize enabling an item.",
                    nameof(item));
            }

            var userKey = actor.UserId.ToString("N");
            var itemKey = item.ItemId.ToString("N");
            var changed = false;
            var removed = false;
            var capacityExceeded = false;
            var revision = 0L;

            _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                userKey,
                SpoilerBlurImageFilter.SpoilerBlurFileName,
                state =>
                {
                    if (configuration.Enabled)
                    {
                        changed = Enable(state, item, itemKey, ref capacityExceeded);
                    }
                    else
                    {
                        removed = item.Kind switch
                        {
                            SpoilerGuardItemKind.Series => state.Series.Remove(itemKey),
                            SpoilerGuardItemKind.Movie => state.Movies.Remove(itemKey),
                            _ => throw new ArgumentOutOfRangeException(nameof(item)),
                        };
                        changed = removed;
                        if (changed)
                        {
                            SpoilerGuardOverridesRevision.Advance(state);
                        }
                    }

                    revision = state.OverridesRevision;
                    return changed ? 1 : 0;
                });

            if (capacityExceeded)
            {
                return SpoilerGuardItemActionResult.CapacityExceeded(
                    configuration.Enabled,
                    revision,
                    item.Kind == SpoilerGuardItemKind.Series ? "series" : "movies");
            }

            // A completed strict RMW proves the policy graph is currently readable and
            // valid. Invalidate even for an idempotent no-op so stale fail-closed/LKG
            // enforcement state cannot linger after a successful mutation probe.
            SpoilerUserResolver.InvalidateUser(userKey);
            return SpoilerGuardItemActionResult.Configured(
                configuration.Enabled,
                changed,
                removed,
                revision);
        }

        private bool Enable(
            UserSpoilerBlur state,
            SpoilerGuardItemProjection item,
            string itemKey,
            ref bool capacityExceeded)
        {
            return item.Kind switch
            {
                SpoilerGuardItemKind.Series => EnableSeries(
                    state,
                    item,
                    itemKey,
                    ref capacityExceeded),
                SpoilerGuardItemKind.Movie => EnableMovie(
                    state,
                    item,
                    itemKey,
                    ref capacityExceeded),
                _ => throw new ArgumentOutOfRangeException(nameof(item)),
            };
        }

        private bool EnableSeries(
            UserSpoilerBlur state,
            SpoilerGuardItemProjection item,
            string itemKey,
            ref bool capacityExceeded)
        {
            if (state.Series.TryGetValue(itemKey, out var existing))
            {
                var newName = PersistedPayloadPolicy.ClampPersistedDisplayName(
                    item.DisplayName ?? existing.SeriesName);
                if (string.Equals(existing.SeriesName, newName, StringComparison.Ordinal))
                {
                    return false;
                }

                existing.SeriesName = newName;
                SpoilerGuardOverridesRevision.Advance(state);
                return true;
            }

            if (!SpoilerGuardOverrideCapacity.CanInsert(state.Series, itemKey))
            {
                capacityExceeded = true;
                return false;
            }

            state.Series[itemKey] = new SpoilerBlurSeriesEntry
            {
                SeriesId = itemKey,
                SeriesName = PersistedPayloadPolicy.ClampPersistedDisplayName(item.DisplayName),
                EnabledAt = UtcTimestamp(),
            };
            SpoilerGuardOverridesRevision.Advance(state);
            return true;
        }

        private bool EnableMovie(
            UserSpoilerBlur state,
            SpoilerGuardItemProjection item,
            string itemKey,
            ref bool capacityExceeded)
        {
            var newName = PersistedPayloadPolicy.ClampPersistedDisplayName(item.DisplayName);
            if (state.Movies.TryGetValue(itemKey, out var existing))
            {
                if (string.Equals(existing.MovieName, newName, StringComparison.Ordinal))
                {
                    return false;
                }

                existing.MovieName = newName;
                SpoilerGuardOverridesRevision.Advance(state);
                return true;
            }

            if (!SpoilerGuardOverrideCapacity.CanInsert(state.Movies, itemKey))
            {
                capacityExceeded = true;
                return false;
            }

            state.Movies[itemKey] = new SpoilerBlurMovieEntry
            {
                MovieId = itemKey,
                MovieName = newName,
                EnabledAt = UtcTimestamp(),
            };
            SpoilerGuardOverridesRevision.Advance(state);
            return true;
        }

        private string UtcTimestamp()
            => _timeProvider.GetUtcNow().UtcDateTime.ToString("o", System.Globalization.CultureInfo.InvariantCulture);
    }
}
