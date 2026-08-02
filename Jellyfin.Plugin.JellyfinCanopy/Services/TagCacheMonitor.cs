using System;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// Monitors library item changes and updates the tag cache incrementally.
    /// Hooks ILibraryManager.ItemAdded, ItemUpdated, and ItemRemoved events.
    /// </summary>
    public class TagCacheMonitor : IDisposable
    {
        private readonly ILibraryManager _libraryManager;
        private readonly TagCacheService _tagCacheService;
        private readonly ILogger<TagCacheMonitor> _logger;

        public TagCacheMonitor(ILibraryManager libraryManager, TagCacheService tagCacheService, ILogger<TagCacheMonitor> logger)
        {
            _libraryManager = libraryManager;
            _tagCacheService = tagCacheService;
            _logger = logger;
        }

        /// <summary>
        /// Subscribe to library events. Always subscribes regardless of cache state
        /// so no events are missed between startup and first cache build. Delegates to
        /// <see cref="EnsureSubscribed"/> so a second startup-task run (a dashboard "Run"
        /// button always exists) re-subscribes idempotently instead of double-subscribing.
        /// </summary>
        public void Initialize()
        {
            EnsureSubscribed();
        }

        /// <summary>
        /// Re-subscribe after a full cache rebuild (ensures no double-subscription).
        /// </summary>
        public void EnsureSubscribed()
        {
            _libraryManager.ItemAdded -= OnItemChanged;
            _libraryManager.ItemUpdated -= OnItemChanged;
            _libraryManager.ItemRemoved -= OnItemRemoved;

            _libraryManager.ItemAdded += OnItemChanged;
            _libraryManager.ItemUpdated += OnItemChanged;
            _libraryManager.ItemRemoved += OnItemRemoved;
            _logger.LogInformation("[TagCacheMonitor] Event subscriptions active");
        }

        private void OnItemChanged(object? sender, ItemChangeEventArgs e)
        {
            var item = e.Item;
            if (item == null) return;

            var kind = item.GetBaseItemKind();
            if (!TagCacheService.TaggableTypes.Contains(kind)) return;

            // PERF(S1): only record the already-materialized item identity here — no DB query,
            // descendant discovery, or media probe. Jellyfin raises
            // these events synchronously on the library-scan thread (once per item, many times
            // during a scan), so the heavy BuildEntryForItem work is coalesced and run
            // off-thread by the service. See TagCacheService.EnqueueItemChange and
            // docs/developers.md#performance-rules (S1).
            _tagCacheService.EnqueueItemChange(item, removed: false);
        }

        private void OnItemRemoved(object? sender, ItemChangeEventArgs e)
        {
            var item = e.Item;
            if (item == null || !TagCacheService.TaggableTypes.Contains(item.GetBaseItemKind())) return;
            _tagCacheService.EnqueueItemChange(item, removed: true);
        }

        public void Dispose()
        {
            _libraryManager.ItemAdded -= OnItemChanged;
            _libraryManager.ItemUpdated -= OnItemChanged;
            _libraryManager.ItemRemoved -= OnItemRemoved;
        }
    }
}
