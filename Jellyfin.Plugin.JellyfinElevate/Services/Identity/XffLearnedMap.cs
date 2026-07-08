using System;
using System.Collections.Concurrent;
using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinElevate.Services
{
    /// <summary>
    /// Learned real-IP → user map (issue 7). When Jellyfin's KnownProxies is
    /// unset, core records the PROXY IP in SessionInfo.RemoteEndPoint, so the
    /// session-by-IP tier can't match an anonymous image request's real client
    /// IP. This map rebuilds that tier on the TRUE client IP: on every
    /// authenticated request behind a trusted proxy we observe
    /// <c>realClientIp → userId</c>; an anonymous request from the same real IP
    /// then resolves to the observed candidate set.
    ///
    /// It is a strictly fail-closed CANDIDATE SET, identical in posture to
    /// session-by-IP. Two invariants make that true:
    ///   • a LIVE (within-TTL) entry is NEVER evicted — dropping a live user
    ///     would remove a candidate and could leak that user's guarded art, so
    ///     eviction only ever removes EXPIRED entries. Memory is bounded by the
    ///     real live-client population (each IP capped at a generous user count),
    ///     which self-limits; the IP cap only triggers an expired-sweep, never a
    ///     live eviction.
    ///   • the per-user value is an immutable timestamp, and expiry-removal is
    ///     value-matched (remove only if the timestamp still equals the stale
    ///     one we read), so a concurrent Observe that just refreshed the entry
    ///     is never clobbered by a Resolve that read the pre-refresh value.
    /// </summary>
    public sealed class XffLearnedMap
    {
        // Generous so a user who authenticated once then browses for a long
        // while is never dropped from protection. Refreshed on every authed
        // observation. Over-retention only over-blurs (safe); under-retention
        // would leak (forbidden), so we err long.
        private static readonly TimeSpan EntryTtl = TimeSpan.FromMinutes(30);

        // Soft advisory caps: exceeding them triggers an expired-only sweep, not
        // a live eviction. Generous so a genuine shared/CGNAT real IP keeps all
        // its live users as candidates.
        private const int SoftIpCap = 4096;
        private const int SoftUsersPerIpCap = 64;

        // Throttle the O(map) expired sweep so a busy instance doesn't scan the
        // whole map on every observation once it is above the soft cap.
        private static readonly TimeSpan MinSweepInterval = TimeSpan.FromSeconds(30);

        // realIpKey → (userId → lastSeenUtc). DateTime value (not a mutable
        // box) so value-matched removal is race-free.
        private readonly ConcurrentDictionary<string, ConcurrentDictionary<Guid, DateTime>> _map
            = new(StringComparer.Ordinal);

        private readonly Func<DateTime> _now;
        private DateTime _lastSweep = DateTime.MinValue;

        public XffLearnedMap() : this(() => DateTime.UtcNow) { }

        // Test seam for deterministic TTL testing.
        internal XffLearnedMap(Func<DateTime> now)
        {
            _now = now;
        }

        /// <summary>Records that <paramref name="userId"/> was seen at <paramref name="realIpKey"/> (an authenticated request).</summary>
        public void Observe(string realIpKey, Guid userId)
        {
            if (string.IsNullOrEmpty(realIpKey) || userId == Guid.Empty) return;

            var now = _now();
            var users = _map.GetOrAdd(realIpKey, static _ => new ConcurrentDictionary<Guid, DateTime>());
            users.AddOrUpdate(userId, now, (_, prev) => now > prev ? now : prev);

            // Expired-only maintenance, throttled. Never drops a live user.
            if (users.Count > SoftUsersPerIpCap) SweepExpiredUsers(users, now);
            if (_map.Count > SoftIpCap && (now - _lastSweep) >= MinSweepInterval)
            {
                _lastSweep = now;
                SweepExpiredIps(now);
            }
        }

        /// <summary>
        /// The set of users observed at <paramref name="realIpKey"/> within the
        /// TTL. Empty when nothing (usable) is known. Expired entries are pruned
        /// with value-matched removal so a concurrent refresh is never lost.
        /// </summary>
        public IReadOnlyCollection<Guid> Resolve(string realIpKey)
        {
            if (string.IsNullOrEmpty(realIpKey) || !_map.TryGetValue(realIpKey, out var users))
            {
                return Array.Empty<Guid>();
            }

            var now = _now();
            var live = new List<Guid>();
            foreach (var kvp in users)
            {
                if ((now - kvp.Value) < EntryTtl)
                {
                    live.Add(kvp.Key);
                }
                else
                {
                    // Remove only if the timestamp is still the stale one we
                    // read — a concurrent Observe that refreshed it writes a
                    // newer value, so this no-ops and keeps the live entry.
                    ((ICollection<KeyValuePair<Guid, DateTime>>)users).Remove(kvp);
                }
            }
            if (users.IsEmpty) TryRemoveEmptyBucket(realIpKey, users);
            return live;
        }

        private static void SweepExpiredUsers(ConcurrentDictionary<Guid, DateTime> users, DateTime now)
        {
            foreach (var kvp in users)
            {
                if ((now - kvp.Value) >= EntryTtl)
                {
                    ((ICollection<KeyValuePair<Guid, DateTime>>)users).Remove(kvp);
                }
            }
        }

        private void SweepExpiredIps(DateTime now)
        {
            foreach (var kvp in _map)
            {
                var users = kvp.Value;
                SweepExpiredUsers(users, now);
                if (users.IsEmpty) TryRemoveEmptyBucket(kvp.Key, users);
            }
        }

        // Remove an emptied bucket only if it is still the same (now-empty)
        // instance — a concurrent Observe may have GetOrAdd'd this bucket and
        // added a user, in which case we must not drop it.
        private void TryRemoveEmptyBucket(string key, ConcurrentDictionary<Guid, DateTime> emptied)
        {
            if (emptied.IsEmpty)
            {
                ((ICollection<KeyValuePair<string, ConcurrentDictionary<Guid, DateTime>>>)_map)
                    .Remove(new KeyValuePair<string, ConcurrentDictionary<Guid, DateTime>>(key, emptied));
            }
        }
    }
}
