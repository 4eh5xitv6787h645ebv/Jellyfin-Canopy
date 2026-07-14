// src/enhanced/bookmarks/library-replacements.ts
//
// Bookmarks Library View — orphaned-bookmark replacement search + migration modals.
// Split from bookmarks-library.js (code motion; bodies verbatim).
// (Converted from js/enhanced/bookmarks-library-replacements.js — bodies semantically identical.)

import { JC } from '../../globals';
import { currentPageHandle } from '../pages/fallback-host';
import { escapeHtml, toast } from '../../core/ui-kit';
import { getItemCached } from '../helpers';
import { renderActiveBookmarks } from './library-render';
import type { IdentityContext } from '../../types/jc';

const replacementModalTimers = new Set<number>();

interface StoredBookmark {
  itemId: string;
  tmdbId: string;
  tvdbId: string;
  mediaType: string;
  name: string;
  [key: string]: unknown;
}

interface BookmarkGroup {
  details: StoredBookmark;
  bookmarks: Array<StoredBookmark & { id: string }>;
}

interface JellyfinReplacementItem {
  Id: string;
  Name: string;
  ProductionYear?: string | number;
  ProviderIds?: { Tmdb?: string; Tvdb?: string };
  ImageTags?: { Primary?: string };
  UserData?: { Key?: string };
}

interface ImageApiClient {
  getImageUrl(itemId: string, options: { type: string; maxWidth: number; tag?: string }): string;
}

interface ReplacementResult {
  group: BookmarkGroup;
  matches: JellyfinReplacementItem[];
}

function isJellyfinReplacementItem(value: unknown): value is JellyfinReplacementItem {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && 'Id' in value && typeof value.Id === 'string'
    && 'Name' in value && typeof value.Name === 'string';
}

function currentImageApiClient(): ImageApiClient | null {
  const direct = window.ApiClient as unknown as Partial<ImageApiClient> | undefined;
  if (typeof direct?.getImageUrl === 'function') return direct as ImageApiClient;
  const manager = (window as Window & {
    ConnectionManager?: { currentApiClient?(): ImageApiClient | null };
  }).ConnectionManager;
  return manager?.currentApiClient?.() ?? null;
}

function scheduleReplacementTask(context: IdentityContext, callback: () => void, delay: number): void {
  const timer = window.setTimeout(() => {
    replacementModalTimers.delete(timer);
    if (JC.identity.isCurrent(context)) callback();
  }, delay);
  replacementModalTimers.add(timer);
}

function ownReplacementModal(modal: HTMLElement): void {
  modal.dataset.jcIdentityOwned = 'true';
  modal.dataset.jcBookmarkLibraryModal = 'true';
}

function closeReplacementModal(modal: HTMLElement): void {
  if (!modal.isConnected) return;
  modal.style.opacity = '0';
  const timer = window.setTimeout(() => {
    replacementModalTimers.delete(timer);
    modal.remove();
  }, 200);
  replacementModalTimers.add(timer);
}

JC.identity.registerReset('bookmarks-library-replacement-modals', () => {
  for (const timer of replacementModalTimers) window.clearTimeout(timer);
  replacementModalTimers.clear();
  document.querySelectorAll('[data-jc-bookmark-library-modal="true"]').forEach((modal) => modal.remove());
});

/**
 * Search Jellyfin for items matching a TMDB/TVDB ID
 */
async function searchForReplacementItem(
  tmdbId: string,
  tvdbId: string,
  mediaType: string,
  context: IdentityContext
): Promise<JellyfinReplacementItem[] | null> {
  if (!JC.identity.isCurrent(context)) return null;
  const userId = context.userId;

  try {
    // Search using Jellyfin's provider ID filtering
    const itemTypes = mediaType === 'tv' ? 'Series,Episode' : 'Movie';

    // Fetch all items of this type and filter by provider ID client-side
    // This is more reliable than relying on AnyProviderIdEquals
    const url = `/Users/${userId}/Items?Recursive=true&IncludeItemTypes=${itemTypes}&SortBy=DateCreated&SortOrder=Descending&Limit=500`;

    // Routed through the core fetch layer (auth + JSON parse identical to the
    // former ApiClient.ajax call; failures still land in the catch below).
    let response: unknown = await JC.core.api!.jf(url, { skipCache: true });
    if (!JC.identity.isCurrent(context)) return null;

    // Handle if response is a string (shouldn't happen but be safe)
    if (typeof response === 'string') {
      response = JSON.parse(response) as unknown;
      if (!JC.identity.isCurrent(context)) return null;
    }

    console.log(`🪼 Jellyfin Canopy: Bookmarks Library: API Response:`, response);

    const items = response !== null && typeof response === 'object' && !Array.isArray(response)
      && 'Items' in response && Array.isArray(response.Items)
      ? response.Items.filter(isJellyfinReplacementItem)
      : [];
    console.log(`🪼 Jellyfin Canopy: Bookmarks Library: Fetched ${items.length} total items of type ${itemTypes}`);

    if (!Array.isArray(items) || items.length === 0) {
      console.warn(`🪼 Jellyfin Canopy: Bookmarks Library: No items found or items is not an array`);
      return null;
    }

    // Filter items by matching provider IDs
    // Check both ProviderIds and UserData.Key (TMDB ID is often stored there)
    const matches = items.filter((item) => {
      const providerIds = item.ProviderIds || {};
      const userData = item.UserData || {};

      if (tmdbId) {
        // Check ProviderIds.Tmdb
        if (providerIds.Tmdb === String(tmdbId)) return true;
        // Check UserData.Key for TMDB ID
        if (userData.Key === String(tmdbId)) return true;
      }

      if (tvdbId) {
        // Check ProviderIds.Tvdb
        if (providerIds.Tvdb === String(tvdbId)) return true;
      }

      return false;
    });

    console.log(`🪼 Jellyfin Canopy: Bookmarks Library: Found ${matches.length} matches for ${tmdbId ? 'TMDB:'+tmdbId : 'TVDB:'+tvdbId}`, matches);
    return matches.length > 0 ? matches : null;
  } catch (e) {
    if (!JC.identity.isCurrent(context)) return null;
    console.error('Failed to search for replacement:', e);
    return null;
  }
}

/**
 * Find replacement for orphaned item and offer migration
 */
export async function findAndOfferReplacement(
  group: BookmarkGroup,
  triggerBtn: HTMLButtonElement,
  context: IdentityContext | null = JC.identity.capture()
): Promise<void> {
  if (!context || !JC.identity.isCurrent(context)) return;
  triggerBtn.disabled = true;

  const matches = await searchForReplacementItem(
    group.details.tmdbId,
    group.details.tvdbId,
    group.details.mediaType,
    context
  );
  if (!JC.identity.isCurrent(context)) return;

  if (!matches || matches.length === 0) {
    toast(JC.t!('bookmark_no_replacement'), 3000);
    triggerBtn.disabled = false;
    return;
  }

  showReplacementSelectionModal(group, matches, context);
  triggerBtn.disabled = false;
}

/**
 * Show modal to select replacement item and migrate bookmarks
 */
function showReplacementSelectionModal(
  oldGroup: BookmarkGroup,
  replacementItems: JellyfinReplacementItem[],
  context: IdentityContext
): void {
  // These modals are reached from awaited flows (library search, orphan
  // scan): the page can drain mid-await. A modal with no live adoption to
  // own its teardown must not appear over the destination view.
  if (!JC.identity.isCurrent(context) || !currentPageHandle()) return;
  const apiClient = currentImageApiClient();
  if (!apiClient) return;

  const modal = document.createElement('div');
  modal.className = 'jc-bm-library-modal-overlay';
  ownReplacementModal(modal);
  modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.9); z-index: 10000; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s;';
  modal.innerHTML = `
    <div class="jc-bm-library-modal-container jc-replacement-modal-container">
      <button class="jc-bm-library-modal-close">×</button>
      <div class="jc-bm-library-modal-content" style="padding: 28px;">
        <div class="jc-bookmarks-modal-header">
          <span class="material-icons" aria-hidden="true" style="font-size: 48px; color: #4caf50; flex-shrink: 0;">find_replace</span>
          <div style="flex: 1;">
            <h2 class="jc-modal-title">Replacement Found</h2>
            <p class="jc-modal-subtitle">Migrate ${oldGroup.bookmarks.length} bookmark(s) from the old item to a new version</p>
          </div>
        </div>

        <div class="jc-modal-warning-box">
          <div class="jc-modal-warning-label">Old Item (Missing)</div>
          <div class="jc-modal-item-name">${escapeHtml(oldGroup.details.name)}</div>
          <div class="jc-modal-item-meta">TMDB: ${escapeHtml(oldGroup.details.tmdbId || 'N/A')} • Item ID: ${escapeHtml(oldGroup.details.itemId.substring(0,16))}...</div>
        </div>

        <div class="jc-replacement-section-title">Select Replacement:</div>
        <div class="jc-replacement-options">
          ${replacementItems.map((item, idx) => {
            const posterUrl = apiClient.getImageUrl(item.Id, {
              type: 'Primary',
              maxWidth: 120,
              tag: item.ImageTags?.Primary
            });
            return `
              <div class="replacement-option" data-item-index="${idx}" style="display: flex; gap: 12px; background: rgba(76,175,80,0.05); border: 2px solid rgba(76,175,80,0.2); border-radius: 8px; padding: 12px; cursor: pointer; transition: all 0.2s; align-items: center;">
                ${posterUrl ? `<img src="${escapeHtml(posterUrl)}" style="width: 60px; height: 90px; object-fit: cover; border-radius: 6px; flex-shrink: 0;">` : '<div style="width: 60px; height: 90px; background: rgba(255,255,255,0.05); border-radius: 6px; flex-shrink: 0;"></div>'}
                <div style="flex: 1;">
                  <div style="font-weight: 600; margin-bottom: 4px; color: #fff; font-size: 15px;">${escapeHtml(item.Name)}</div>
                  <div style="font-size: 12px; color: #aaa; margin-bottom: 4px;">${escapeHtml(item.ProductionYear || '')}</div>
                  <div style="font-size: 11px; color: #888;">Item ID: ${escapeHtml(item.Id.substring(0,16))}...</div>
                </div>
                <span class="material-icons" aria-hidden="true" style="color: #4caf50; font-size: 28px; display: none; flex-shrink: 0;">check_circle</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
      <div class="jc-modal-actions-padded">
        <button class="jc-modal-btn-cancel-alt jc-bookmark-btn-cancel">
          <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
          <span>Cancel</span>
        </button>
        <button class="jc-modal-btn-submit jc-bookmark-btn-submit" disabled>
          <span class="material-icons" aria-hidden="true" style="font-size: 18px;">swap_horiz</span>
          <span>Migrate Bookmarks</span>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  let selectedItem: JellyfinReplacementItem | null = null;

  const closeDialog = () => closeReplacementModal(modal);
  // Body-level modal: the page's dispose bag closes it on drain.
  currentPageHandle()?.track(closeDialog);

  modal.querySelector('.jc-bm-library-modal-close')?.addEventListener('click', closeDialog);
  modal.querySelector('.jc-bookmark-btn-cancel')?.addEventListener('click', closeDialog);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeDialog();
  });

  // Selection handlers
  modal.querySelectorAll<HTMLElement>('.replacement-option').forEach(option => {
    option.addEventListener('click', () => {
      if (!JC.identity.isCurrent(context)) return;
      const idx = parseInt(option.dataset.itemIndex!);
      selectedItem = replacementItems[idx];

      modal.querySelectorAll<HTMLElement>('.replacement-option').forEach(opt => {
        opt.style.borderColor = 'rgba(76,175,80,0.2)';
        opt.style.background = 'rgba(76,175,80,0.05)';
        opt.querySelector<HTMLElement>('.material-icons')!.style.display = 'none';
      });

      option.style.borderColor = '#4caf50';
      option.style.background = 'rgba(76,175,80,0.15)';
      option.querySelector<HTMLElement>('.material-icons')!.style.display = 'block';

      const submitBtn = modal.querySelector<HTMLButtonElement>('.jc-bookmark-btn-submit')!;
      submitBtn.disabled = false;
      submitBtn.style.opacity = '1';
    });
  });

  // Migrate handler
  modal.querySelector('.jc-bookmark-btn-submit')?.addEventListener('click', () => { void (async () => {
    if (!JC.identity.isCurrent(context)) return;
    if (!selectedItem) return;

    const btn = modal.querySelector<HTMLButtonElement>('.jc-bookmark-btn-submit')!;
    btn.disabled = true;
    btn.querySelector('span:last-child')!.textContent = 'Migrating...';

    try {
      // Fetch full details for new item
      const fullItem = await getItemCached(selectedItem.Id, { userId: context.userId });
      if (!JC.identity.isCurrent(context) || !isJellyfinReplacementItem(fullItem)) return;

      const newDetails = {
        itemId: fullItem.Id,
        tmdbId: fullItem.ProviderIds?.Tmdb || oldGroup.details.tmdbId,
        tvdbId: fullItem.ProviderIds?.Tvdb || oldGroup.details.tvdbId,
        mediaType: oldGroup.details.mediaType,
        name: fullItem.Name
      };

      // DATA-SAFETY: write + verify the new copies FIRST, then delete the
      // originals. syncBookmarks removes the originals (by id) only after the
      // new copies are durably persisted, so a mid-flight failure keeps the
      // originals intact (the old pre-delete lost data if syncing failed).
      const oldIds = oldGroup.bookmarks.map((bookmark) => bookmark.id);
      const synced = await JC.bookmarks!.syncBookmarks(oldGroup.bookmarks, newDetails, 0, oldIds);
      if (!JC.identity.isCurrent(context)) return;

      toast(JC.t!('bookmark_migrated').replace('{count}', String(synced.length)).replace('{name}', JC.escapeHtml(fullItem.Name)), 4000);

      closeDialog();

      // Refresh the adopted host (syncBookmarks already resolved — no blind
      // setTimeout needed).
      renderActiveBookmarks(context);
    } catch (e) {
      if (!JC.identity.isCurrent(context)) return;
      console.error('Migration failed:', e);
      toast(JC.t!('bookmark_migration_failed'), 3000);
      btn.disabled = false;
      btn.querySelector('span:last-child')!.textContent = JC.t!('bookmark_migrate');
    }
  })(); });

  scheduleReplacementTask(context, () => { if (modal.isConnected) modal.style.opacity = '1'; }, 10);
}

/**
 * Find all orphaned bookmarks and offer migration
 */
export async function findAllOrphanedAndOfferMigration(
  bookmarks: Record<string, StoredBookmark>,
  context: IdentityContext | null = JC.identity.capture()
): Promise<void> {
  if (!context || !JC.identity.isCurrent(context)) return;
  const apiClient = currentImageApiClient();
  if (!apiClient) {
    toast(JC.t!('toast_api_client_unavailable'), 3000);
    return;
  }

  const userId = context.userId;
  const orphanedGroups: BookmarkGroup[] = [];

  // Group by item ID
  const byItem: Record<string, BookmarkGroup> = {};
  for (const [id, bm] of Object.entries(bookmarks)) {
    if (!byItem[bm.itemId]) {
      byItem[bm.itemId] = {
        details: bm,
        bookmarks: []
      };
    }
    byItem[bm.itemId].bookmarks.push({ id, ...bm });
  }

  // Check each item
  for (const [itemId, group] of Object.entries(byItem)) {
    if (!JC.identity.isCurrent(context)) return;
    try {
      await getItemCached(itemId, { userId });
      if (!JC.identity.isCurrent(context)) return;
      // Item exists, not orphaned
    } catch (e) {
      if (!JC.identity.isCurrent(context)) return;
      // DATA-SAFETY: only an explicit 404 means the item is truly gone. A
      // transient failure must not be treated as orphaned (which would offer a
      // destructive migration); keep it and warn.
      const status = (e as { status?: number } | null)?.status;
      if (status === 404) {
        if (group.details.tmdbId || group.details.tvdbId) {
          orphanedGroups.push(group);
        }
      } else {
        console.warn(`🪼 Jellyfin Canopy: Bookmarks Library: Item ${itemId} check failed (status=${status ?? 'n/a'}), not a 404 — not treating as orphaned:`, e);
      }
    }
  }

  if (orphanedGroups.length === 0) {
    toast(JC.t!('bookmark_no_orphaned'), 3000);
    return;
  }

  // Search for replacements for all orphaned items
  const replacementResults: ReplacementResult[] = [];
  for (const group of orphanedGroups) {
    if (!JC.identity.isCurrent(context)) return;
    const matches = await searchForReplacementItem(
      group.details.tmdbId,
      group.details.tvdbId,
      group.details.mediaType,
      context
    );
    if (!JC.identity.isCurrent(context)) return;
    if (matches && matches.length > 0) {
      replacementResults.push({ group, matches });
    }
  }

  if (replacementResults.length === 0) {
    toast(JC.t!('bookmark_orphaned_no_replacement').replace('{count}', String(orphanedGroups.length)), 4000);
    return;
  }

  // Show summary modal
  showOrphanedSummaryModal(replacementResults, context);
}

/**
 * Show summary of all orphaned items with replacements
 */
function showOrphanedSummaryModal(replacementResults: ReplacementResult[], context: IdentityContext): void {
  // Same delayed-flow guard as showReplacementSelectionModal.
  if (!JC.identity.isCurrent(context) || !currentPageHandle()) return;
  const modal = document.createElement('div');
  modal.className = 'jc-bm-library-modal-overlay';
  ownReplacementModal(modal);
  modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85); z-index: 10000; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s;';
  modal.innerHTML = `
    <div class="jc-bm-library-modal-container" style="max-width: 700px; background: #181818; border-radius: 12px; padding: 24px; position: relative; box-shadow: 0 8px 32px rgba(0,0,0,0.8);">
      <button class="jc-bm-library-modal-close" style="position: absolute; top: 16px; right: 16px; background: transparent; border: none; color: #fff; font-size: 32px; cursor: pointer; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; border-radius: 50%; transition: background 0.2s;">×</button>
      <div class="jc-bm-library-modal-content">
        <div class="jc-bookmarks-modal-header">
          <span class="material-icons" aria-hidden="true" style="font-size: 32px; color: #4caf50;">search</span>
          <div>
            <h2 style="margin: 0 0 4px 0; font-size: 20px;">Orphaned Bookmarks</h2>
            <p style="margin: 0; font-size: 13px; color: #999;">Found ${replacementResults.length} item(s) with replacements available</p>
          </div>
        </div>
        <div style="margin-top: 20px; max-height: 400px; overflow-y: auto;">
          ${replacementResults.map((result, idx) => `
            <div class="jc-orphaned-result-item">
              <div class="jc-orphaned-result-header">
                <div>
                  <div class="jc-orphaned-result-name">${escapeHtml(result.group.details.name)}</div>
                  <div class="jc-orphaned-result-count">${result.group.bookmarks.length} bookmark(s) • ${result.matches.length} replacement(s) found</div>
                </div>
                <button class="btnMigrateOrphaned jc-btn" data-result-index="${idx}">
                  <span class="material-icons" aria-hidden="true" style="font-size: 16px;">find_replace</span>
                  <span>Migrate</span>
                </button>
              </div>
              <div class="jc-orphaned-result-meta">
                TMDB: ${escapeHtml(result.group.details.tmdbId || 'N/A')} • Item ID: ${escapeHtml(result.group.details.itemId.substring(0,12))}...
              </div>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="jc-bookmark-modal-actions">
        <button class="jc-bookmark-btn-cancel">
          <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
          <span>Close</span>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const closeDialog = () => closeReplacementModal(modal);
  // Body-level modal: the page's dispose bag closes it on drain.
  currentPageHandle()?.track(closeDialog);

  modal.querySelector('.jc-bm-library-modal-close')?.addEventListener('click', closeDialog);
  modal.querySelector('.jc-bookmark-btn-cancel')?.addEventListener('click', closeDialog);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeDialog();
  });

  // Migrate button handlers
  modal.querySelectorAll<HTMLElement>('.btnMigrateOrphaned').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!JC.identity.isCurrent(context)) return;
      const idx = parseInt(btn.dataset.resultIndex!);
      const result = replacementResults[idx];
      closeDialog();
      scheduleReplacementTask(context, () => {
        showReplacementSelectionModal(result.group, result.matches, context);
      }, 300);
    });
  });

  scheduleReplacementTask(context, () => { if (modal.isConnected) modal.style.opacity = '1'; }, 10);
}
