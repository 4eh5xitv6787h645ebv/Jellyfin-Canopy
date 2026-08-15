using System;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// Process-wide owner of the effective Continue Watching removal policy.
    /// A persisted per-user setting wins; a missing settings file inherits the
    /// live administrator default. Faults retain bounded last-known-good state
    /// and fail closed on a cold read.
    /// </summary>
    public sealed class RemoveFromHomePolicyService
    {
        private static readonly TimeSpan RefreshInterval = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan Retention = TimeSpan.FromDays(7);

        private readonly UserConfigurationManager _configManager;
        private readonly ILogger<RemoveFromHomePolicyService> _logger;
        private readonly BoundedTtlCache<string, PolicyCacheEntry> _cache = new(
            maximumEntries: 2_048,
            maximumWeight: 2_048,
            comparer: StringComparer.OrdinalIgnoreCase,
            defaultTtl: () => Retention);
        private readonly BoundedTtlCache<Guid, byte> _warnedReadFailure = new(
            maximumEntries: 2_048,
            maximumWeight: 2_048,
            defaultTtl: static () => TimeSpan.FromDays(7));

        private readonly record struct PolicyCacheEntry(
            bool Enabled,
            bool InheritsAdministratorDefault,
            DateTime LoadedAt);

        public RemoveFromHomePolicyService(
            UserConfigurationManager configManager,
            ILogger<RemoveFromHomePolicyService> logger)
        {
            _configManager = configManager;
            _logger = logger;
        }

        /// <summary>
        /// Resolves the effective policy for one already-authenticated/session-owned user.
        /// Full Hidden Content is an independent master switch and avoids any settings read.
        /// </summary>
        public bool ShouldApply(
            Guid userId,
            bool hiddenContentEnabled,
            bool administratorDefault)
        {
            if (userId == Guid.Empty) return false;
            if (hiddenContentEnabled) return true;
            return LoadUserPolicy(userId, administratorDefault);
        }

        /// <summary>
        /// Invalidates only the canonical target user's policy after a durable
        /// settings mutation or recovery reset.
        /// </summary>
        public void Invalidate(string userId)
        {
            if (string.IsNullOrEmpty(userId)) return;
            var cacheKey = userId;
            if (Guid.TryParse(userId, out var userIdGuid))
            {
                cacheKey = userIdGuid.ToString("N");
                _warnedReadFailure.TryRemove(userIdGuid, out _);
            }

            _cache.TryRemove(cacheKey, out _);
        }

        private bool LoadUserPolicy(Guid userId, bool administratorDefault)
        {
            var userIdN = userId.ToString("N");
            var now = DateTime.UtcNow;
            if (_cache.TryGetValue(userIdN, out var cached)
                && (now - cached.LoadedAt) < RefreshInterval)
            {
                return Effective(cached, administratorDefault);
            }

            // Serialize the read with settings.json writers. Publishing while
            // this lock is held prevents a successful writer invalidation from
            // racing behind a stale post-write cache insertion.
            lock (_configManager.GetUserFileLock(userIdN, "settings.json"))
            {
                now = DateTime.UtcNow;
                if (_cache.TryGetValue(userIdN, out cached)
                    && (now - cached.LoadedAt) < RefreshInterval)
                {
                    return Effective(cached, administratorDefault);
                }

                var read = _configManager.ReadUserConfiguration<UserSettings>(
                    userIdN,
                    "settings.json");
                if (read.HasUsableValue
                    && read.Value != null
                    && !PersistedPayloadPolicy.Validate(read.Value).IsValid)
                {
                    read = new UserConfigReadResult<UserSettings>(
                        UserConfigReadStatus.Corrupt,
                        null,
                        "invalid-policy-shape");
                }

                var hasLastKnownGood = _cache.TryGetValue(userIdN, out cached);
                var lastKnownGood = Effective(cached, administratorDefault);
                var inheritsAdministratorDefault = read.Status == UserConfigReadStatus.Missing;
                var enabled = read.Status switch
                {
                    UserConfigReadStatus.Valid when read.Value != null
                        => read.Value.RemoveContinueWatchingEnabled,
                    UserConfigReadStatus.Missing => administratorDefault,
                    _ when hasLastKnownGood => lastKnownGood,
                    _ => true,
                };

                if (read.Status is UserConfigReadStatus.Corrupt or UserConfigReadStatus.Unavailable
                    && _warnedReadFailure.TryAdd(userId, 0))
                {
                    _logger.LogWarning(
                        "Remove-from-home policy read failed for user {UserId}; using {FallbackKind}.",
                        userIdN,
                        hasLastKnownGood ? "bounded last-known-good state" : "fail-closed enforcement");
                }
                else if (!read.IsFault)
                {
                    _warnedReadFailure.TryRemove(userId, out _);
                }

                var next = new PolicyCacheEntry(
                    enabled,
                    inheritsAdministratorDefault,
                    now);
                _cache[userIdN] = next;
                return Effective(next, administratorDefault);
            }
        }

        private static bool Effective(PolicyCacheEntry entry, bool administratorDefault)
            => entry.InheritsAdministratorDefault ? administratorDefault : entry.Enabled;

        internal void SeedCacheForTest(string userIdN, bool enabled)
        {
            if (!string.IsNullOrEmpty(userIdN))
            {
                _cache[userIdN] = new PolicyCacheEntry(
                    enabled,
                    InheritsAdministratorDefault: false,
                    LoadedAt: DateTime.UtcNow);
            }
        }

        internal bool IsCachedForTest(string userIdN)
            => !string.IsNullOrEmpty(userIdN) && _cache.ContainsKey(userIdN);

        internal int MaximumEntriesForTest => _cache.MaximumEntries;

        internal long MaximumWeightForTest => _cache.MaximumWeight;

        internal void ExpireCacheForTest(string userIdN)
        {
            if (!string.IsNullOrEmpty(userIdN)
                && _cache.TryGetValue(userIdN, out var entry))
            {
                _cache[userIdN] = entry with { LoadedAt = DateTime.MinValue };
            }
        }
    }
}
