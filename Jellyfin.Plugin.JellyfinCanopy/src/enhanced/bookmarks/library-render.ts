// src/enhanced/bookmarks/library-render.ts
//
// Bookmarks Library View — mount detection + main library rendering,
// plus the small shared time/type helpers.
// Split from bookmarks-library.js (code motion; bodies verbatim).
// (Converted from js/enhanced/bookmarks-library-render.js — bodies semantically identical.)

import { JC } from '../../globals';
import { escapeHtml, toast } from '../../core/ui-kit';
import { renderBookmarkItems } from './library-items';
import { showDuplicatesSyncModal } from './library-modals';
import type { IdentityContext } from '../../types/jc';

const logPrefix = '🪼 Jellyfin Canopy: Bookmarks Library:';

interface StoredBookmark {
  itemId?: string;
  tmdbId?: string;
  tvdbId?: string;
  mediaType?: string;
  timestamp?: number;
  [key: string]: unknown;
}

interface BookmarkConfig {
  bookmarks: Record<string, StoredBookmark>;
}

interface BookmarkGroup {
  details: StoredBookmark;
  bookmarks: Array<StoredBookmark & { id: string }>;
  type: string;
}

function bookmarkConfigOrEmpty(value: unknown): BookmarkConfig {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)
      && 'bookmarks' in value && value.bookmarks !== null
      && typeof value.bookmarks === 'object' && !Array.isArray(value.bookmarks)) {
    return value as BookmarkConfig;
  }
  return { bookmarks: {} };
}

// The container the bookmarks library renders into, set by the pages-framework
// descriptor (bookmarks/page.ts) for the lifetime of one adoption and cleared
// on drain. DOM-as-truth: a disconnected container makes every render a no-op
// instead of painting into a detached tree. Replaces the old
// '.sections.bookmarks' class scan that picked the LAST visible match — a
// defect that mis-targeted stale/duplicate nodes.
let activeContainer: HTMLElement | null = null;
let activeContainerIdentity: IdentityContext | null = null;

/** Set (or clear) the render target for the current page adoption. */
export function setActiveContainer(container: HTMLElement | null): void {
  activeContainer = container;
  activeContainerIdentity = container ? JC.identity.capture() : null;
}

// Coalesce bursts of refresh requests (e.g. the module's own
// 'jc-bookmarks-updated' event plus an explicit post-write refresh in the same
// tick) into a single render.
let renderQueueGeneration = 0;
let queuedIdentity: IdentityContext | null = null;

JC.identity.registerReset('bookmarks-library-render', () => {
  renderQueueGeneration += 1;
  queuedIdentity = null;
  activeContainer = null;
  activeContainerIdentity = null;
});

/**
 * Re-render the bookmarks library into the active container. No-op when the
 * page is not adopted or its container has left the DOM. The single refresh
 * entry point used by the 'jc-bookmarks-updated' event and every post-write
 * refresh — no DOM scanning, no stale-container guard.
 */
export function renderActiveBookmarks(context: IdentityContext | null = JC.identity.capture()): void {
  if (!context || !JC.identity.isCurrent(context)) return;
  if (!activeContainer || !activeContainer.isConnected) return;
  if (!activeContainerIdentity || activeContainerIdentity.epoch !== context.epoch) return;
  if (queuedIdentity?.epoch === context.epoch) return;
  queuedIdentity = context;
  const generation = ++renderQueueGeneration;
  queueMicrotask(() => {
    if (generation !== renderQueueGeneration) return;
    queuedIdentity = null;
    if (!JC.identity.isCurrent(context)) return;
    const container = activeContainer;
    if (container && container.isConnected && activeContainerIdentity?.epoch === context.epoch) {
      void renderBookmarksLibrary(container, context);
    }
  });
}

/**
 * Render bookmarks library content
 */
export async function renderBookmarksLibrary(
  container: HTMLElement,
  context: IdentityContext | null = JC.identity.capture()
): Promise<void> {
  if (!context || !JC.identity.isCurrent(context)) return;
  console.log(`${logPrefix} Rendering bookmarks library...`);

  const bookmarkConfig = bookmarkConfigOrEmpty(JC.userConfig?.bookmark);
  const bookmarks = bookmarkConfig.bookmarks;
  const bookmarkEntries = Object.entries(bookmarks);

  // Group by item
  const groupedByItem: Record<string, BookmarkGroup> = {};
  const typeCounts: Record<string, { items: number; bookmarks: number }> = {
    tv: { items: 0, bookmarks: 0 },
    movie: { items: 0, bookmarks: 0 }
  };

  for (const [id, bm] of bookmarkEntries) {
    const key = bm.itemId || bm.tmdbId || bm.tvdbId || 'unknown';
    const normalizedType = normalizeMediaType(bm.mediaType);
    if (!groupedByItem[key]) {
      groupedByItem[key] = {
        details: bm,
        bookmarks: [],
        type: normalizedType
      };
      if (typeCounts[normalizedType]) {
        typeCounts[normalizedType].items += 1;
      }
    }
    groupedByItem[key].bookmarks.push({ id, ...bm });
    if (typeCounts[groupedByItem[key].type]) {
      typeCounts[groupedByItem[key].type].bookmarks += 1;
    }
  }

  // Sort bookmarks within each group by timestamp
  Object.values(groupedByItem).forEach(group => {
    group.bookmarks.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  });

  const totalBookmarks = bookmarkEntries.length;
  let currentTab = container.dataset.currentTab || 'movie';
  if (currentTab === 'tv' && typeCounts.tv.items === 0 && typeCounts.movie.items > 0) {
    currentTab = 'movie';
  } else if (currentTab === 'movie' && typeCounts.movie.items === 0 && typeCounts.tv.items > 0) {
    currentTab = 'tv';
  }
  container.dataset.currentTab = currentTab;

  // Create UI
  container.innerHTML = `
    <div class="jc-bookmarks-wrapper">
      <div class="jc-bookmark-tabs">
        <button class="jc-tab ${currentTab === 'movie' ? 'active' : ''}" data-tab="movie">
          ${JC.t!('bookmarks_library_tab_movies')}
        </button>
        <button class="jc-tab ${currentTab === 'tv' ? 'active' : ''}" data-tab="tv">
          ${JC.t!('bookmarks_library_tab_series')}
        </button>
      </div>

      <div class="bookmarks-container">
        ${totalBookmarks === 0 ? `
          <div class="jc-bookmarks-empty">
            <div class="jc-bookmarks-empty-icon material-icons" aria-hidden="true">bookmark_border</div>
            <div class="jc-bookmarks-empty-title">${JC.t!('bookmarks_library_empty_title')}</div>
            <div class="jc-bookmarks-empty-hint">${JC.t!('bookmarks_library_empty_hint')}</div>
          </div>
        ` : `
          <div class="jc-bookmarks-grid" id="bookmarks-items-container"></div>
          <div class="jc-bookmark-actions-footer">
            <button class="btnFindDuplicates jc-btn-footer">
              <span class="material-icons" aria-hidden="true">merge</span>
              <span>${JC.t!('bookmarks_library_button_find_duplicates')}</span>
            </button>
            <button class="btnCleanupBookmarks jc-btn-footer">
              <span class="material-icons" aria-hidden="true">cleaning_services</span>
              <span>${JC.t!('bookmarks_library_button_cleanup')}</span>
            </button>
            <button class="btnDeleteAllBookmarks jc-btn-footer jc-btn-footer-delete">
              <span class="material-icons" aria-hidden="true">delete</span>
              <span>${JC.t!('bookmarks_library_button_delete_all')}</span>
            </button>
          </div>
        `}
      </div>
    </div>
  `;

  // Attach button handlers
  const findDuplicatesBtn = container.querySelector<HTMLButtonElement>('.btnFindDuplicates');
  const cleanupBtn = container.querySelector<HTMLButtonElement>('.btnCleanupBookmarks');
  const deleteAllBtn = container.querySelector<HTMLButtonElement>('.btnDeleteAllBookmarks');

  findDuplicatesBtn?.addEventListener('click', () => {
    if (!JC.identity.isCurrent(context)) return;
    findDuplicatesBtn.disabled = true;
    const label = findDuplicatesBtn.querySelector('span:last-child')!;
    const origText = label.innerHTML;
    label.innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite;">refresh</span>';

    // Surface duplicate bookmark groups and offer merging
    showDuplicatesSyncModal(bookmarks, context);

    if (JC.identity.isCurrent(context)) {
      findDuplicatesBtn.disabled = false;
      label.innerHTML = origText;
    }
  });

  cleanupBtn?.addEventListener('click', () => { void (async () => {
    if (!JC.identity.isCurrent(context)) return;
    cleanupBtn.disabled = true;
    const label = cleanupBtn.querySelector('span:last-child');
    const origText = label?.innerHTML;
    if (label) label.innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite;">refresh</span>';

    try {
      const result = await JC.bookmarks!.cleanupOrphaned();
      if (!JC.identity.isCurrent(context)) return;
      const deletedCount = Number(result.deleted) || 0;
      const retainedCount = Number(result.retainedUncertain) || 0;
      const errorCount = Number(result.errors) || 0;
      const removed = JC.t!('bookmark_cleanup_complete').replace('{count}', String(deletedCount));
      const details = retainedCount > 0 || errorCount > 0
        ? JC.t!('bookmark_cleanup_uncertain_summary')
          .replace('{retained}', String(retainedCount))
          .replace('{errors}', String(errorCount))
        : '';
      toast([removed, details].filter(Boolean).map(escapeHtml).join(' · '), 5000);
      renderActiveBookmarks(context);
    } catch (error) {
      if (!JC.identity.isCurrent(context)) return;
      console.error('Cleanup failed:', error);
      toast(JC.t!('bookmark_cleanup_failed'), 3000);
    } finally {
      if (JC.identity.isCurrent(context)) {
        cleanupBtn.disabled = false;
        if (label && origText) label.innerHTML = origText;
      }
    }
  })(); });

  deleteAllBtn?.addEventListener('click', () => { void (async () => {
    if (!JC.identity.isCurrent(context)) return;
    if (!confirm(JC.t!('bookmark_delete_all_confirm'))) return;
    if (!JC.identity.isCurrent(context)) return;

    deleteAllBtn.disabled = true;
    const label = deleteAllBtn.querySelector('span:last-child');
    const origText = label?.innerHTML;
    if (label) label.innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite;">refresh</span>';

    try {
      // The server commits the entire delete set under one revision/lock. A
      // stale tab rebases on conflict; a failed transaction removes nothing.
      await JC.bookmarks!.deleteAll();
      if (!JC.identity.isCurrent(context)) return;
      toast(JC.t!('bookmark_deleted_all'), 3000);
      // deleteAll emits the shared update event after adopting committed state;
      // that event owns the coalesced library refresh.
    } catch (error) {
      if (!JC.identity.isCurrent(context)) return;
      console.error('Delete failed:', error);
      toast(JC.t!('bookmark_delete_failed'), 3000);
    } finally {
      if (JC.identity.isCurrent(context)) {
        deleteAllBtn.disabled = false;
        if (label && origText) label.innerHTML = origText;
      }
    }
  })(); });

  // Render items with posters
  if (totalBookmarks > 0) {
    const itemsContainer = container.querySelector<HTMLElement>('#bookmarks-items-container');
    if (itemsContainer) {
      await renderBookmarkItems(itemsContainer, groupedByItem, currentTab, context);
      if (!JC.identity.isCurrent(context)) return;

      // Tab click handlers
      container.querySelectorAll<HTMLElement>('.jc-tab').forEach(btn => {
        btn.addEventListener('click', () => { void (async () => {
          if (!JC.identity.isCurrent(context)) return;
          const tab = btn.dataset.tab!;
          container.dataset.currentTab = tab;
          container.querySelectorAll<HTMLElement>('.jc-tab').forEach(b => {
            b.classList.toggle('active', b.dataset.tab === tab);
          });
          await renderBookmarkItems(itemsContainer, groupedByItem, tab, context);
        })(); });
      });
    }
  }
}

/**
 * Format timestamp (seconds) to HH:MM:SS
 */
export function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function normalizeMediaType(mediaType: unknown): string {
  const type = typeof mediaType === 'string' ? mediaType.toLowerCase() : '';
  if (type === 'series' || type === 'episode' || type === 'tvshow' || type === 'tv') return 'tv';
  if (type === 'movie' || type === 'film' || type === 'musicvideo') return 'movie';
  return 'other';
}

// Parse HH:MM:SS or MM:SS or seconds into numeric seconds
export function parseTimestampInput(value: string | number): number | null {
  if (!value && value !== 0) return null;
  const str = String(value).trim();
  if (!str) return null;

  if (!str.includes(':')) {
    const num = parseFloat(str);
    return Number.isFinite(num) && num >= 0 ? num : null;
  }

  const parts = str.split(':').map(p => parseFloat(p));
  if (parts.some(p => Number.isNaN(p) || p < 0)) return null;

  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + part;
  }
  return seconds;
}
