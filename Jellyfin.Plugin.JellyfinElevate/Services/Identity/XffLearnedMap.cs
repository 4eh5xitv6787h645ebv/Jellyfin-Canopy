using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

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
    /// It is a fail-closed CANDIDATE SET, identical in posture to session-by-IP:
    /// a stale entry (a user who logged in earlier and left, or a CGNAT IP later
    /// reassigned to someone else) only ADDS a candidate, which can over-protect
    /// (blur for a user who is gone) but can never leak a guarding user's art —
    /// so the TTL is deliberately generous, mirroring tier 4's "don't age out a
    /// quietly-scrolling user" rule.
    /// </summary>
    public sealed class XffLearnedMap
    {
        // Generous so a user who authenticated once then browses for a long
        // while is never dropped from protection. Refreshed on every authed
        // observation. Over-retention only over-blurs (safe); under-retention
        // would leak (forbidden), so we err long.
        private static readonly TimeSpan EntryTtl = TimeSpan.FromMinutes(30);

        private const int MaxIps = 2048;
        private const int MaxUsersPerIp = 16;

        private sealed class Entry
        {
            public required DateTime LastSeen { get; set; }
        }

        // realIpKey → (userId → last-seen). Nested dict so multiple users behind
        // one real IP (a genuine shared client machine) all stay candidates.
        private readonly ConcurrentDictionary<string, ConcurrentDictionary<Guid, Entry>> _map
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

            var users = _map.GetOrAdd(realIpKey, static _ => new ConcurrentDictionary<Guid, Entry>());
            var now = _now();
            users.AddOrUpdate(
                userId,
                _ => new Entry { LastSeen = now },
                (_, existing) => { existing.LastSeen = now; return existing; });

            // Bound users-per-IP: evict the oldest if a shared machine churns
            // through many accounts. Rare; a simple prune suffices.
            if (users.Count > MaxUsersPerIp)
            {
                PruneOldestUser(users, now);
            }

            // Bound the number of tracked IPs across long uptime.
            if (_map.Count > MaxIps)
            {
                PruneExpiredIps(now);
            }
        }

        /// <summary>
        /// The set of users observed at <paramref name="realIpKey"/> within the
        /// TTL. Empty when nothing (usable) is known.
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
                if ((now - kvp.Value.LastSeen) < EntryTtl)
                {
                    live.Add(kvp.Key);
                }
                else
                {
                    users.TryRemove(kvp.Key, out _);
                }
            }
            if (users.IsEmpty) _map.TryRemove(realIpKey, out _);
            return live;
        }

        private static void PruneOldestUser(ConcurrentDictionary<Guid, Entry> users, DateTime now)
        {
            // Drop expired first; if none, drop the single oldest.
            Guid oldestKey = Guid.Empty;
            var oldest = DateTime.MaxValue;
            foreach (var kvp in users)
            {
                if ((now - kvp.Value.LastSeen) >= EntryTtl)
                {
                    users.TryRemove(kvp.Key, out _);
                    continue;
                }
                if (kvp.Value.LastSeen < oldest)
                {
                    oldest = kvp.Value.LastSeen;
                    oldestKey = kvp.Key;
                }
            }
            if (users.Count > MaxUsersPerIp && oldestKey != Guid.Empty)
            {
                users.TryRemove(oldestKey, out _);
            }
        }

        private void PruneExpiredIps(DateTime now)
        {
            foreach (var kvp in _map)
            {
                var users = kvp.Value;
                var anyLive = users.Any(u => (now - u.Value.LastSeen) < EntryTtl);
                if (!anyLive)
                {
                    _map.TryRemove(kvp.Key, out _);
                }
            }
        }
    }
}
