using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Tracks the device ids of sessions that actually run the Jellyfin Enhanced
    /// client, so live pushes (<see cref="LiveNotifierService"/>) reach ONLY them.
    ///
    /// Why: the config-changed push rides a <c>GeneralCommand</c> carrier. The web
    /// client provably ignores it, but a native client (Android, Android TV, Kodi,
    /// …) receives the same session message and its handling is outside our
    /// control — broadcasting a playback-shaped command to every session of every
    /// user is exactly how a foreign client ends up acting on (or choking on)
    /// traffic it never asked for. JE can know precisely where it runs: every JE
    /// boot AND every hot-reload refetch calls <c>/JellyfinEnhanced/public-config</c>
    /// authenticated, carrying the session's device id claim. Recording those ids
    /// here makes the registry self-healing: a server restart empties it, and the
    /// next fetch from each live JE session repopulates it.
    /// </summary>
    public interface ILiveSessionRegistry
    {
        /// <summary>Record (or refresh) a device id as running the JE client.</summary>
        void Touch(string deviceId);

        /// <summary>Device ids seen within the TTL window, pruning expired entries.</summary>
        IReadOnlyList<string> GetActiveDeviceIds();
    }

    /// <inheritdoc />
    public sealed class LiveSessionRegistry : ILiveSessionRegistry
    {
        // A web session refetches public-config on every boot and on every
        // config-changed push, so a generous TTL only has to outlive an idle
        // (but still open) tab between pushes.
        internal static readonly TimeSpan EntryTtl = TimeSpan.FromHours(24);

        // Hard cap so a client cycling device ids can never grow this unbounded;
        // eviction drops the stalest entries first.
        internal const int MaxEntries = 500;

        private readonly ConcurrentDictionary<string, DateTimeOffset> _seen = new(StringComparer.Ordinal);
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
        public void Touch(string deviceId)
        {
            if (string.IsNullOrWhiteSpace(deviceId))
            {
                return;
            }

            _seen[deviceId] = _now();

            if (_seen.Count > MaxEntries)
            {
                // Rare (requires >500 distinct JE devices inside one TTL window);
                // drop the stalest entries to get back under the cap.
                foreach (var stale in _seen.OrderBy(p => p.Value).Take(_seen.Count - MaxEntries))
                {
                    _seen.TryRemove(stale.Key, out _);
                }
            }
        }

        /// <inheritdoc />
        public IReadOnlyList<string> GetActiveDeviceIds()
        {
            var cutoff = _now() - EntryTtl;
            var live = new List<string>(_seen.Count);
            foreach (var pair in _seen)
            {
                if (pair.Value < cutoff)
                {
                    _seen.TryRemove(pair.Key, out _);
                    continue;
                }

                live.Add(pair.Key);
            }

            return live;
        }
    }
}
