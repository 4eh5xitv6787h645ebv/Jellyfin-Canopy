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
    ///   • a LIVE (within-TTL) user is NEVER removed — dropping one would remove
    ///     a candidate and could leak that user's guarded art. Only EXPIRED user
    ///     entries are pruned, and the empty IP buckets they leave behind are
    ///     deliberately NOT evicted (removing a bucket a concurrent Observe just
    ///     repopulated would drop a live user). A bucket is tiny and is reused by
    ///     the next Observe for that IP, so memory is bounded by the real client
    ///     population — appropriate for this opt-in, proxy-fronted feature.
    ///   • the per-user value is an immutable timestamp, and expiry-removal is
    ///     value-matched (remove only if the timestamp still equals the stale
    ///     one we read), so a concurrent Observe that just refreshed the entry
    ///     is never clobbered by a Resolve/sweep that read the pre-refresh value.
    /// </summary>
    public sealed class XffLearnedMap
    {
        // Generous so a user who authenticated once then browses for a long
        // while is never dropped from protection. Refreshed on every authed
        // observation. Over-retention only over-blurs (safe); under-retention
        // would leak (forbidden), so we err long.
        private static readonly TimeSpan EntryTtl = TimeSpan.FromMinutes(30);

        // Above this many users on one real IP, an authed observation also
        // sweeps that bucket's EXPIRED users (never live ones) to keep it tidy.
        private const int UsersPerIpSweepTrigger = 64;

        // Hard ceiling on tracked real-client IPs. At capacity we stop learning
        // NEW IPs (existing buckets keep refreshing) rather than evicting any —
        // eviction would risk dropping a live user (a leak), whereas refusing to
        // learn a new IP is fail-safe: that IP simply falls back to the existing
        // session-by-IP / marker ladder, exactly as if this feature were off.
        // Generous for a proxy-fronted deployment; each empty bucket is tiny.
        private const int MaxIps = 8192;

        // realIpKey → (userId → lastSeenUtc). DateTime value (not a mutable
        // box) so value-matched removal is race-free.
        private readonly ConcurrentDictionary<string, ConcurrentDictionary<Guid, DateTime>> _map
            = new(StringComparer.Ordinal);

        private readonly Func<DateTime> _now;

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

            // At capacity, keep refreshing IPs we already track but stop taking
            // on NEW ones (fail-safe: an unlearned IP degrades to the lower
            // ladder, never a leak). The benign check-then-add race can nudge a
            // few past the cap under concurrency — harmless, still bounded.
            if (!_map.TryGetValue(realIpKey, out var users))
            {
                if (_map.Count >= MaxIps) return;
                users = _map.GetOrAdd(realIpKey, static _ => new ConcurrentDictionary<Guid, DateTime>());
            }
            users.AddOrUpdate(userId, now, (_, prev) => now > prev ? now : prev);

            // Expired-only tidy of an unusually large bucket. Never drops a live
            // user (value-matched), never removes the bucket itself.
            if (users.Count > UsersPerIpSweepTrigger) SweepExpiredUsers(users, now);
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
                    // newer value, so this no-ops and keeps the live entry. The
                    // now-possibly-empty bucket is intentionally left in place.
                    ((ICollection<KeyValuePair<Guid, DateTime>>)users).Remove(kvp);
                }
            }
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
    }
}
