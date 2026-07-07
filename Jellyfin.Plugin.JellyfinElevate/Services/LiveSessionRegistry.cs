using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinElevate.Services
{
    /// <summary>
    /// A device registered as running the JE client, with the user who
    /// registered it (used to validate pushes against live sessions).
    /// </summary>
    public readonly record struct LiveSessionEntry(string DeviceId, Guid UserId);

    /// <summary>
    /// Tracks the devices (and registering users) of sessions that actually run
    /// the Jellyfin Elevate client, so live pushes (<see cref="LiveNotifierService"/>)
    /// reach ONLY them.
    ///
    /// Why: the config-changed push rides a <c>GeneralCommand</c> carrier. The web
    /// client provably ignores it, but a native client (Android, Android TV, Kodi,
    /// …) receives the same session message and its handling is outside our
    /// control — broadcasting a playback-shaped command to every session of every
    /// user is exactly how a foreign client ends up acting on (or choking on)
    /// traffic it never asked for. JE can know precisely where it runs: every JE
    /// boot, every hot-reload refetch AND the 15-minute self-update recheck call
    /// JE endpoints authenticated, carrying the session's device id claim.
    /// Recording those ids here makes the registry self-healing: a server restart
    /// empties it, and each live JE session re-registers within one recheck.
    ///
    /// The registering user is stored because the device id claim is ultimately
    /// caller-supplied (Jellyfin trusts the auth header's DeviceId): the notifier
    /// only pushes to a device when the REGISTERING user has a live session on
    /// it, so a user can never direct pushes at devices that aren't theirs.
    /// </summary>
    public interface ILiveSessionRegistry
    {
        /// <summary>Record (or refresh) a device id as running the JE client.</summary>
        void Touch(string deviceId, Guid userId);

        /// <summary>Entries seen within the TTL window, pruning expired ones.</summary>
        IReadOnlyList<LiveSessionEntry> GetActiveEntries();
    }

    /// <inheritdoc />
    public sealed class LiveSessionRegistry : ILiveSessionRegistry
    {
        // A web session refetches public-config on every boot and on every
        // config-changed push, and pings /version every 15 minutes, so a
        // generous TTL only has to outlive an idle (but still open) tab
        // between touches.
        internal static readonly TimeSpan EntryTtl = TimeSpan.FromHours(24);

        // Hard cap so a client cycling device ids can never grow this unbounded;
        // eviction drops the stalest entries first.
        internal const int MaxEntries = 500;

        private readonly ConcurrentDictionary<string, (Guid UserId, DateTimeOffset Seen)> _seen = new(StringComparer.Ordinal);
        private readonly Func<DateTimeOffset> _now;

        public LiveSessionRegistry()
            : this(() => DateTimeOffset.UtcNow)
        {
        }

        /// <summary>Test seam: inject a fake clock.</summary>
        internal LiveSessionRegistry(Func<DateTimeOffset> now)
        {
            _now = now;
        }

        /// <inheritdoc />
        public void Touch(string deviceId, Guid userId)
        {
            if (string.IsNullOrWhiteSpace(deviceId) || userId == Guid.Empty)
            {
                return;
            }

            _seen[deviceId] = (userId, _now());

            if (_seen.Count > MaxEntries)
            {
                // Rare (requires >500 distinct JE devices inside one TTL window);
                // drop the stalest entries to get back under the cap. Pair-
                // conditional removal so an entry refreshed AFTER this snapshot
                // was taken survives (plain TryRemove(key) would delete it).
                foreach (var stale in _seen.OrderBy(p => p.Value.Seen).Take(_seen.Count - MaxEntries))
                {
                    ((ICollection<KeyValuePair<string, (Guid, DateTimeOffset)>>)_seen).Remove(stale);
                }
            }
        }

        /// <inheritdoc />
        public IReadOnlyList<LiveSessionEntry> GetActiveEntries()
        {
            var cutoff = _now() - EntryTtl;
            var live = new List<LiveSessionEntry>(_seen.Count);
            foreach (var pair in _seen)
            {
                if (pair.Value.Seen < cutoff)
                {
                    // Pair-conditional: a concurrent Touch since this enumeration
                    // observed the entry keeps it alive.
                    ((ICollection<KeyValuePair<string, (Guid, DateTimeOffset)>>)_seen).Remove(pair);
                    continue;
                }

                live.Add(new LiveSessionEntry(pair.Key, pair.Value.UserId));
            }

            return live;
        }
    }
}
