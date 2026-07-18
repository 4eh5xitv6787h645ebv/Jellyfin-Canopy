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
import { normalizeBookmarkMediaType, replacementItemTypes } from './media-types';
import {
  BOOKMARK_IDENTITY_VERSION,
  compareBookmarkIdentity,
  type BookmarkIdentityRecord
} from './bookmark-identity';

const replacementModalTimers = new Set<number>();
export const SERIES_ENRICHMENT_CHUNK_SIZE = 50;
export const SERIES_ENRICHMENT_MAX_URL_LENGTH = 2048;
const REPLACEMENT_PAGE_SIZE = 500;
const REPLACEMENT_MAX_PAGES = 1000;
const REPLACEMENT_MAX_ITEMS = REPLACEMENT_PAGE_SIZE * REPLACEMENT_MAX_PAGES;

/**
 * How many source bookmarks a MOVE-style migration durably relocated: every
 * original id no longer present in the committed store. syncBookmarks returns
 * only the newly created target rows, so a source that deduplicated into an
 * existing target equivalent (creating no new row) is still migrated and must
 * be counted here; using the add count alone would under-report the migration.
 */
export function migratedSourceCount(oldIds: string[], store: Record<string, unknown>): number {
  return oldIds.filter((id) => !Object.prototype.hasOwnProperty.call(store, id)).length;
}

interface StoredBookmark {
  itemId: string;
  tmdbId: string;
  tvdbId: string;
  mediaType?: string;
  identityVersion?: number;
  itemType?: string;
  seriesTmdbId?: string;
  seriesTvdbId?: string;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  episodeEndNumber?: number | null;
  name: string;
  [key: string]: unknown;
}

interface BookmarkGroup {
  details: StoredBookmark;
  bookmarks: Array<StoredBookmark & { id: string }>;
}

export interface JellyfinReplacementItem {
  Id: string;
  Name: string;
  Type?: string;
  ProductionYear?: string | number;
  ProviderIds?: { Tmdb?: string; Tvdb?: string };
  SeriesId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  IndexNumberEnd?: number;
  SeriesProviderIds?: { Tmdb?: string; Tvdb?: string };
  ImageTags?: { Primary?: string };
  UserData?: { Key?: string };
}

export type ReplacementSearchOutcome =
  | { status: 'match'; items: JellyfinReplacementItem[] }
  | { status: 'no-match' }
  | { status: 'failed'; error: unknown }
  | { status: 'cancelled' };

interface ImageApiClient {
  getImageUrl(itemId: string, options: { type: string; maxWidth: number; tag?: string }): string;
}

interface ReplacementResult {
  group: BookmarkGroup;
  matches: JellyfinReplacementItem[];
}

function isJellyfinReplacementItem(value: unknown): value is JellyfinReplacementItem {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && 'Id' in value && typeof value.Id === 'string' && value.Id.length > 0
    && 'Name' in value && typeof value.Name === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function incompleteReplacementSearch(message: string): never {
  const error = new Error(message);
  error.name = 'IncompleteCollectionError';
  throw error;
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

function readReplacementPage(
  response: unknown,
  requestedStartIndex: number
): { items: JellyfinReplacementItem[]; totalRecordCount: number } {
  if (!isRecord(response)) incompleteReplacementSearch('replacement response was not an object');
  if (!Array.isArray(response.Items)) {
    incompleteReplacementSearch('replacement response did not contain an Items array');
  }
  if (!Number.isSafeInteger(response.TotalRecordCount) || (response.TotalRecordCount as number) < 0) {
    incompleteReplacementSearch('replacement response TotalRecordCount was not a non-negative safe integer');
  }
  if (Object.prototype.hasOwnProperty.call(response, 'StartIndex')) {
    if (!Number.isSafeInteger(response.StartIndex) || (response.StartIndex as number) < 0) {
      incompleteReplacementSearch('replacement response StartIndex was not a non-negative safe integer');
    }
    if (response.StartIndex !== requestedStartIndex) {
      incompleteReplacementSearch(
        `replacement response StartIndex ${String(response.StartIndex)} did not match requested ${requestedStartIndex}`
      );
    }
  }
  if (response.Items.length > REPLACEMENT_PAGE_SIZE) {
    incompleteReplacementSearch(`replacement page exceeded requested size ${REPLACEMENT_PAGE_SIZE}`);
  }

  const items: JellyfinReplacementItem[] = [];
  for (const value of response.Items) {
    if (!isJellyfinReplacementItem(value)) {
      incompleteReplacementSearch('replacement response contained an invalid item');
    }
    items.push(value);
  }
  return { items, totalRecordCount: response.TotalRecordCount as number };
}

function replacementIdentity(item: JellyfinReplacementItem): BookmarkIdentityRecord {
  const isEpisode = item.Type === 'Episode';
  const isSeason = item.Type === 'Season';
  const episodeNumber = isEpisode && Number.isSafeInteger(item.IndexNumber) ? item.IndexNumber : null;
  return {
    itemId: item.Id,
    identityVersion: BOOKMARK_IDENTITY_VERSION,
    itemType: String(item.Type || '').toLowerCase(),
    mediaType: normalizeBookmarkMediaType(item.Type),
    tmdbId: item.ProviderIds?.Tmdb || '',
    tvdbId: item.ProviderIds?.Tvdb || '',
    seriesTmdbId: item.SeriesProviderIds?.Tmdb || '',
    seriesTvdbId: item.SeriesProviderIds?.Tvdb || '',
    seasonNumber: isEpisode
      ? (Number.isSafeInteger(item.ParentIndexNumber) ? item.ParentIndexNumber : null)
      : (isSeason && Number.isSafeInteger(item.IndexNumber) ? item.IndexNumber : null),
    episodeNumber,
    episodeEndNumber: isEpisode
      ? (Number.isSafeInteger(item.IndexNumberEnd) ? item.IndexNumberEnd : episodeNumber)
      : null
  };
}

function seriesEnrichmentUrl(userId: string, seriesIds: string[]): string {
  const ids = seriesIds.map(id => encodeURIComponent(id)).join(',');
  return `/Users/${userId}/Items?Ids=${ids}&Fields=ProviderIds&Limit=${seriesIds.length}`;
}

function chunkSeriesIds(userId: string, seriesIds: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const seriesId of seriesIds) {
    const candidate = [...current, seriesId];
    if (current.length > 0 && (
      candidate.length > SERIES_ENRICHMENT_CHUNK_SIZE
      || seriesEnrichmentUrl(userId, candidate).length > SERIES_ENRICHMENT_MAX_URL_LENGTH
    )) {
      chunks.push(current);
      current = [];
    }
    if (seriesEnrichmentUrl(userId, [seriesId]).length <= SERIES_ENRICHMENT_MAX_URL_LENGTH) {
      current.push(seriesId);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
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

export function resetBookmarksLibraryReplacementModals(): void {
  for (const timer of replacementModalTimers) window.clearTimeout(timer);
  replacementModalTimers.clear();
  document.querySelectorAll('[data-jc-bookmark-library-modal="true"]').forEach((modal) => modal.remove());
}

function throwReplacementCancelled(): never {
  const error = new Error('replacement search identity changed mid-flight');
  error.name = 'AbortError';
  throw error;
}

/**
 * Fill each candidate's parent-series ProviderIds so episode identity can match
 * on the series' namespaced ids. Enrichment is best-effort: a failed chunk
 * degrades to item-level provider matching only (per-chunk catch), but an abort
 * or account switch propagates so the whole search resolves as cancelled.
 */
async function enrichSeriesProviders(
  userId: string,
  items: JellyfinReplacementItem[],
  context: IdentityContext
): Promise<JellyfinReplacementItem[]> {
  const seriesIds = [...new Set(items.map(item => item.SeriesId).filter((id): id is string => !!id))];
  if (seriesIds.length === 0) return items;

  const seriesProviders = new Map<string, { Tmdb?: string; Tvdb?: string }>();
  for (const chunk of chunkSeriesIds(userId, seriesIds)) {
    if (!JC.identity.isCurrent(context)) throwReplacementCancelled();
    try {
      const seriesResponse: unknown = await JC.core.api!.jf(
        seriesEnrichmentUrl(userId, chunk),
        { skipCache: true }
      );
      if (!JC.identity.isCurrent(context)) throwReplacementCancelled();
      const seriesItems = isRecord(seriesResponse) && Array.isArray(seriesResponse.Items)
        ? seriesResponse.Items.filter(isJellyfinReplacementItem)
        : [];
      for (const seriesItem of seriesItems) {
        seriesProviders.set(seriesItem.Id, seriesItem.ProviderIds || {});
      }
    } catch (error) {
      if (isAbortError(error) || !JC.identity.isCurrent(context)) throw error;
      console.warn(`🪼 Jellyfin Canopy: Bookmarks Library: Parent-series enrichment chunk failed; retaining item-provider matches`, error);
    }
  }

  return items.map(item => ({
    ...item,
    SeriesProviderIds: item.SeriesId ? seriesProviders.get(item.SeriesId) : undefined
  }));
}

/**
 * Search Jellyfin for a logical replacement, paging DateCreated-descending by
 * StartIndex and evaluating each page as it arrives.
 *
 * Matching is page-by-page with early-exit: the first page carrying a logical
 * match resolves `match` immediately, so a present replacement is never gated
 * behind a whole-library download or the item safety cap. Only a negative needs
 * a complete scan — `no-match` is published solely after every advertised item
 * has been examined (the running count reaches the reported TotalRecordCount).
 * Anything that prevents a complete negative scan — a malformed or shifting
 * envelope, an empty or non-advancing page before the end, more rows than
 * advertised, or a page/item safety cap reached before exhaustion — rejects and
 * surfaces as `failed`, never as a confident `no-match`, because this flow gates
 * a DESTRUCTIVE migration. An account switch or abort at any point resolves
 * `cancelled`.
 */
export async function searchForReplacementItem(
  bookmark: StoredBookmark,
  context: IdentityContext
): Promise<ReplacementSearchOutcome> {
  if (!JC.identity.isCurrent(context)) return { status: 'cancelled' };
  const userId = context.userId;

  try {
    const normalizedMediaType = normalizeBookmarkMediaType(bookmark.mediaType);
    const itemTypes = replacementItemTypes(normalizedMediaType);
    const typeFilter = itemTypes ? `&IncludeItemTypes=${itemTypes}` : '';
    // EnableUserData=false: replacement identity never reads mutable playback
    // state, so excluding it keeps the payload smaller and immune to progress
    // updates arriving mid-scan.
    const baseUrl = `/Users/${userId}/Items?Recursive=true${typeFilter}&Fields=ProviderIds,Type,SeriesId,ParentIndexNumber,IndexNumber,IndexNumberEnd&EnableUserData=false&SortBy=DateCreated&SortOrder=Descending`;

    let expectedTotal: number | null = null;
    let itemsExamined = 0;

    for (let pageIndex = 0; pageIndex < REPLACEMENT_MAX_PAGES; pageIndex += 1) {
      if (!JC.identity.isCurrent(context)) return { status: 'cancelled' };
      const skip = pageIndex * REPLACEMENT_PAGE_SIZE;
      const url = `${baseUrl}&Limit=${REPLACEMENT_PAGE_SIZE}&StartIndex=${skip}`;
      const response: unknown = await JC.core.api!.jf(url, { skipCache: true });
      if (!JC.identity.isCurrent(context)) return { status: 'cancelled' };

      const page = readReplacementPage(response, skip);
      if (expectedTotal === null) {
        expectedTotal = page.totalRecordCount;
      } else if (page.totalRecordCount !== expectedTotal) {
        // A shifting total means the collection churned mid-scan; a negative can
        // no longer be proven, so fail closed rather than risk a false no-match.
        incompleteReplacementSearch(
          `replacement total changed mid-scan from ${expectedTotal} to ${page.totalRecordCount}`
        );
      }

      // Evaluate this page before any completeness bookkeeping so a present
      // match short-circuits regardless of library size or the safety cap.
      // UserData.Key is deliberately never consulted: unlike ProviderIds it
      // carries no namespace and cannot safely identify an episode.
      const enriched = await enrichSeriesProviders(userId, page.items, context);
      if (!JC.identity.isCurrent(context)) return { status: 'cancelled' };
      const matches = enriched.filter(
        item => compareBookmarkIdentity(bookmark, replacementIdentity(item)) === 'logical'
      );
      if (matches.length > 0) return { status: 'match', items: matches };

      itemsExamined += page.items.length;
      if (itemsExamined > expectedTotal) {
        incompleteReplacementSearch(
          `replacement scan read ${itemsExamined} rows beyond the advertised ${expectedTotal}`
        );
      }
      if (itemsExamined >= expectedTotal) return { status: 'no-match' };

      // Not yet exhausted: the scan must be able to make progress and stay
      // within the safety bound, otherwise a negative cannot be trusted.
      if (page.items.length === 0) {
        incompleteReplacementSearch('replacement scan hit an empty page before exhausting the collection');
      }
      if (expectedTotal > REPLACEMENT_MAX_ITEMS) {
        incompleteReplacementSearch(
          `replacement collection of ${expectedTotal} exceeds the ${REPLACEMENT_MAX_ITEMS} item safety bound`
        );
      }
    }

    // Ran out of pages before reaching the advertised total: an incomplete
    // scan, never a confident no-match.
    return incompleteReplacementSearch(
      `replacement scan exceeded the ${REPLACEMENT_MAX_PAGES} page safety bound before exhausting the collection`
    );
  } catch (error) {
    if (isAbortError(error) || !JC.identity.isCurrent(context)) return { status: 'cancelled' };
    console.error('Failed to search for replacement:', error);
    return { status: 'failed', error };
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

  try {
    const result = await searchForReplacementItem(group.details, context);
    switch (result.status) {
      case 'match':
        showReplacementSelectionModal(group, result.items, context);
        return;
      case 'no-match':
        toast(JC.t!('bookmark_no_replacement'), 3000);
        return;
      case 'failed':
        toast(JC.t!('bookmark_search_failed'), 3000);
        return;
      case 'cancelled':
        return;
    }
  } finally {
    triggerBtn.disabled = false;
  }
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
        ...replacementIdentity(selectedItem),
        name: fullItem.Name
      };

      // DATA-SAFETY: write + verify the new copies FIRST, then delete the
      // originals. syncBookmarks removes the originals (by id) only after the
      // new copies are durably persisted, so a mid-flight failure keeps the
      // originals intact (the old pre-delete lost data if syncing failed).
      const oldIds = oldGroup.bookmarks.map((bookmark) => bookmark.id);
      await JC.bookmarks!.syncBookmarks(oldGroup.bookmarks, newDetails, 0, oldIds);
      if (!JC.identity.isCurrent(context)) return;

      // syncBookmarks returns only the newly created target rows, but a MOVE
      // migrates every source — including any that deduplicated into an existing
      // equivalent (no new row). Report the sources actually relocated, i.e. the
      // originals no longer present in the durable state, not the add count.
      const store = (JC.userConfig as { bookmark?: { bookmarks?: Record<string, unknown> } } | undefined)?.bookmark?.bookmarks || {};
      const migratedCount = migratedSourceCount(oldIds, store);
      toast(JC.t!('bookmark_migrated').replace('{count}', String(migratedCount)).replace('{name}', JC.escapeHtml(fullItem.Name)), 4000);

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

  // Group by canonical category and item ID.
  const byItem: Record<string, BookmarkGroup> = {};
  for (const [id, bm] of Object.entries(bookmarks)) {
    const key = `${normalizeBookmarkMediaType(bm.mediaType)}:${bm.itemId}`;
    if (!byItem[key]) {
      byItem[key] = {
        details: bm,
        bookmarks: []
      };
    }
    byItem[key].bookmarks.push({ id, ...bm });
  }

  // Check each item
  for (const group of Object.values(byItem)) {
    if (!JC.identity.isCurrent(context)) return;
    const itemId = group.details.itemId;
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
        if (group.details.tmdbId || group.details.tvdbId
          || group.details.seriesTmdbId || group.details.seriesTvdbId) {
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

  // Search for replacements for all orphaned items. A partial result set is
  // never safe enough to gate destructive migrations.
  const replacementResults: ReplacementResult[] = [];
  let failedSearchCount = 0;
  for (const group of orphanedGroups) {
    if (!JC.identity.isCurrent(context)) return;
    const result = await searchForReplacementItem(group.details, context);
    switch (result.status) {
      case 'match':
        replacementResults.push({ group, matches: result.items });
        break;
      case 'no-match':
        break;
      case 'failed':
        failedSearchCount += 1;
        break;
      case 'cancelled':
        return;
    }
  }

  if (failedSearchCount > 0) {
    toast(JC.t!('bookmark_orphaned_search_failed').replace('{count}', String(failedSearchCount)), 4000);
    return;
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
