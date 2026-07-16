// src/enhanced/bookmarks/bookmarks.ts
//
// Enhanced bookmarks system with multi-bookmark support, TMDB/TVDB tracking, and visual markers
// (Converted from js/enhanced/bookmarks.js — bodies semantically identical.)

import { JC } from '../../globals';
import { escapeHtml, toast } from '../../core/ui-kit';
import { debounce } from '../helpers';
import { createObserver, disconnectObserver } from '../../core/dom-observer';
import type { BookmarkCleanupResult, BookmarksApi } from './surface';
import type { IdentityContext } from '../../types/jc';
import { normalizeBookmarkMediaType } from './media-types';
import {
  compareBookmarkIdentity,
  persistedBookmarkIdentity,
  type BookmarkIdentityRecord
} from './bookmark-identity';
import {
  createItemDetailsCache,
  type ItemDetailsCacheOutcome
} from './item-details-cache';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Define the surface for the document lifetime. The enabled gate is evaluated
// on every identity activation; an A-disabled/B-enabled SPA switch must still
// be able to start the feature without re-executing the bundle.
{

  const logPrefix = '🪼 Jellyfin Canopy: Bookmarks:';
  const ownedBookmarkMarkerSelector = '.jc-bookmark-marker[data-jc-identity-owned="true"]';
  let bookmarkGeneration = 0;
  let bookmarkMarkerGeneration = 0;
  const ownedBookmarkMarkers = new Set<HTMLElement>();
  const ownedBookmarkButtons = new Set<HTMLButtonElement>();
  const activeModalDisposers = new Map<HTMLElement, () => void>();
  const bookmarkTimers = new Set<number>();
  let forceCleanupBookmarks: (() => void) | null = null;

  interface BookmarkIdentityCapture {
    readonly context: Readonly<IdentityContext> | null;
    readonly generation: number;
  }

  interface BookmarkOperation {
    type: 'add' | 'update' | 'delete';
    bookmarkId: string;
    bookmark?: Record<string, unknown>;
  }

  interface BookmarkCommittedState {
    revision: number;
    bookmarks: Record<string, any>;
  }

  function captureIdentity(): BookmarkIdentityCapture {
    const context = JC.identity.capture();
    return Object.freeze({
      context: context ? Object.freeze({
        serverId: context.serverId,
        userId: context.userId,
        epoch: context.epoch
      }) : null,
      generation: bookmarkGeneration
    });
  }

  function isIdentityCurrent(captured: BookmarkIdentityCapture): boolean {
    return captured.generation === bookmarkGeneration && JC.identity.isCurrent(captured.context);
  }

  function scheduleIdentityTask(
    captured: BookmarkIdentityCapture,
    callback: () => void,
    delay: number
  ): number {
    const timer = window.setTimeout(() => {
      bookmarkTimers.delete(timer);
      if (isIdentityCurrent(captured)) callback();
    }, delay);
    bookmarkTimers.add(timer);
    return timer;
  }

  function disposeActiveModals(): void {
    for (const dispose of [...activeModalDisposers.values()]) dispose();
    activeModalDisposers.clear();
  }

  function bookmarkRootFor(captured: BookmarkIdentityCapture): any {
    if (!captured.context || !isIdentityCurrent(captured)) return null;
    const userConfig = (JC as any).userConfig;
    if (!userConfig || typeof userConfig !== 'object') return null;

    const configOwner = JC.identity.ownerOf(userConfig);
    if (configOwner && !JC.identity.isOwned(userConfig, captured.context)) return null;

    const root = userConfig.bookmark;
    if (!root || typeof root !== 'object') return null;

    const rootOwner = JC.identity.ownerOf(root);
    if (rootOwner && !JC.identity.isOwned(root, captured.context)) return null;
    // A revision exists only after the server bookmark GET completed
    // successfully. The identity transition's deliberately empty placeholder
    // has no revision, so no mutation can turn a failed/unfinished boot read
    // into a destructive empty replacement.
    if (!Number.isSafeInteger(root.revision) || root.revision < 0) return null;
    return root.bookmarks && typeof root.bookmarks === 'object' && !Array.isArray(root.bookmarks) ? root : null;
  }

  function isBookmarkRootCurrent(captured: BookmarkIdentityCapture, root: any): boolean {
    if (!isIdentityCurrent(captured) || (JC.userConfig as any)?.bookmark !== root) return false;
    const owner = JC.identity.ownerOf(root);
    return !owner || (!!captured.context && JC.identity.isOwned(root, captured.context));
  }

  function committedState(value: unknown): BookmarkCommittedState | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    // Core API responses are raw ASP.NET JSON, unlike the boot loader's GET.
    // Use the same schema owner for every response path; it preserves all
    // bookmark IDs while converting BookmarkItem DTO properties.
    const schemaTransform = JC.transformUserFileCase;
    const localValue = typeof schemaTransform === 'function'
      ? schemaTransform('bookmark.json', value, 'load')
      : value;
    if (!localValue || typeof localValue !== 'object' || Array.isArray(localValue)) return null;
    const record = localValue as Record<string, unknown>;
    const revision = Number(record.revision ?? record.Revision);
    const bookmarks = record.bookmarks ?? record.Bookmarks;
    if (!Number.isSafeInteger(revision) || revision < 0
      || !bookmarks || typeof bookmarks !== 'object' || Array.isArray(bookmarks)) return null;

    if (typeof schemaTransform === 'function') {
      return { revision, bookmarks: bookmarks as Record<string, any> };
    }

    // Compatibility for a partially upgraded client where this bundle is
    // newer than plugin.js: transform values individually so IDs stay exact.
    const converter = JC.toCamelCase;
    const normalized = Object.setPrototypeOf({}, null) as Record<string, any>;
    for (const [bookmarkId, bookmark] of Object.entries(bookmarks as Record<string, unknown>)) {
      normalized[bookmarkId] = typeof converter === 'function' ? converter(bookmark) : bookmark;
    }
    return { revision, bookmarks: normalized };
  }

  function conflictState(error: unknown): BookmarkCommittedState | null {
    if (!error || typeof error !== 'object') return null;
    const shaped = error as { responseJSON?: unknown; responseText?: string };
    const direct = committedState(shaped.responseJSON);
    if (direct) return direct;
    if (!shaped.responseText) return null;
    try { return committedState(JSON.parse(shaped.responseText)); } catch { return null; }
  }

  function cleanupResponse(value: unknown): { state: BookmarkCommittedState; result: BookmarkCleanupResult } | null {
    const state = committedState(value);
    if (!state || !value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const deleted = Number(record.deleted ?? record.Deleted);
    const retainedUncertain = Number(record.retainedUncertain ?? record.RetainedUncertain);
    const errors = Number(record.errors ?? record.Errors);
    if (![deleted, retainedUncertain, errors].every(count => Number.isSafeInteger(count) && count >= 0)) return null;
    return { state, result: { deleted, retainedUncertain, errors } };
  }

  function httpStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const shaped = error as { status?: number; statusCode?: number; response?: { status?: number } };
    return Number(shaped.status ?? shaped.statusCode ?? shaped.response?.status) || undefined;
  }

  function adoptCommittedState(
    captured: BookmarkIdentityCapture,
    root: any,
    state: BookmarkCommittedState
  ): boolean {
    if (!isBookmarkRootCurrent(captured, root)) return false;
    root.revision = state.revision;
    root.bookmarks = state.bookmarks;
    return isBookmarkRootCurrent(captured, root);
  }

  function sameBookmark(left: Record<string, any>, right: Record<string, any>): boolean {
    const fields = [
      'itemId', 'identityVersion', 'itemType', 'tmdbId', 'tvdbId',
      'seriesTmdbId', 'seriesTvdbId', 'mediaType', 'seasonNumber',
      'episodeNumber', 'episodeEndNumber', 'name', 'timestamp',
      'label', 'createdAt', 'updatedAt', 'syncedFrom'
    ];
    return fields.every(field => (left[field] ?? '') === (right[field] ?? ''));
  }

  function hasOwnBookmark(bookmarks: Record<string, any>, bookmarkId: string): boolean {
    return Object.prototype.hasOwnProperty.call(bookmarks, bookmarkId);
  }

  function bookmarkOperationsApplied(
    state: BookmarkCommittedState,
    operations: BookmarkOperation[]
  ): boolean {
    return operations.every(operation => {
      const exists = hasOwnBookmark(state.bookmarks, operation.bookmarkId);
      const existing = state.bookmarks[operation.bookmarkId];
      if (operation.type === 'delete') return !exists;
      return exists && !!operation.bookmark && sameBookmark(existing, operation.bookmark);
    });
  }

  function isAmbiguousBookmarkTransportError(error: unknown): boolean {
    if (httpStatus(error) !== undefined || !error || typeof error !== 'object') return false;
    const shaped = error as { name?: string; message?: string };
    return shaped.name === 'AbortError'
      || error instanceof TypeError
      || /network|failed to fetch/i.test(shaped.message || '');
  }

  /**
   * Commit one atomic server-side transaction. A stale revision is not a
   * failure by itself: adopt the authoritative state returned with 409, rebuild
   * the operation list against it, and retry. Operations use stable client ids,
   * so a lost acknowledgement followed by a retry cannot duplicate an add.
   */
  async function commitBookmarkBatch(
    captured: BookmarkIdentityCapture,
    root: any,
    buildOperations: (state: BookmarkCommittedState) => BookmarkOperation[]
  ): Promise<BookmarkCommittedState | null> {
    if (!captured.context || !isBookmarkRootCurrent(captured, root)) return null;
    const plugin = JC.core.api?.plugin?.bind(JC.core.api);
    if (typeof plugin !== 'function') throw new Error('Bookmark mutation transport is unavailable');

    for (let attempt = 0; attempt < 5; attempt++) {
      if (!isBookmarkRootCurrent(captured, root)) return null;
      const base = committedState(root);
      if (!base) throw new Error('Bookmark state is unavailable; reload before changing bookmarks');
      const operations = buildOperations(base);
      if (operations.length === 0) return base;

      try {
        const response = await plugin(`/user-settings/${encodeURIComponent(captured.context.userId)}/bookmark.json/batch`, {
          method: 'POST',
          body: { revision: base.revision, operations },
          skipRetry: true
        });
        const committed = committedState(response);
        if (!committed) throw new Error('Bookmark server returned an invalid committed state');
        return adoptCommittedState(captured, root, committed) ? committed : null;
      } catch (error) {
        if (isAmbiguousBookmarkTransportError(error)) {
          if (!isBookmarkRootCurrent(captured, root)) return null;
          try {
            const response = await plugin(
              `/user-settings/${encodeURIComponent(captured.context.userId)}/bookmark.json`,
              { method: 'GET', skipRetry: true }
            );
            const evidence = committedState(response);
            if (!evidence) throw new Error('Bookmark evidence response was invalid');
            if (bookmarkOperationsApplied(evidence, operations)) {
              return adoptCommittedState(captured, root, evidence) ? evidence : null;
            }
            if (evidence.revision === base.revision) {
              // A caller-initiated abort must never be turned into a new write.
              // A network loss may retry the same stable operation IDs safely.
              if ((error as { name?: string }).name === 'AbortError') throw error;
              continue;
            }
            if (!adoptCommittedState(captured, root, evidence)) return null;
            continue;
          } catch {
            throw error;
          }
        }
        if (httpStatus(error) !== 409) throw error;
        const latest = conflictState(error);
        if (!latest) throw new Error('Bookmark conflict response omitted authoritative state');
        if (!adoptCommittedState(captured, root, latest)) return null;
      }
    }

    throw new Error('Bookmark state kept changing; retry the operation');
  }

  // Notify other views (e.g., CustomTabs library) when bookmarks change
  function emitBookmarksUpdated(captured: BookmarkIdentityCapture, reason = 'updated'): boolean {
    if (!isIdentityCurrent(captured)) return false;
    try {
      document.dispatchEvent(new CustomEvent('jc-bookmarks-updated', { detail: { reason } }));
      return isIdentityCurrent(captured);
    } catch (e) {
      if (isIdentityCurrent(captured)) console.warn(`${logPrefix} Failed to emit update event`, e);
      return false;
    }
  }

  /**
   * New bookmark data structure:
   * {
   *   "unique-bookmark-id": {
   *     itemId: "jellyfin-item-id",
   *     tmdbId: "12345",
   *     tvdbId: "67890",
   *     mediaType: "movie" | "tv" | "other",
   *     name: "Item Name",
   *     timestamp: 123.45,
   *     label: "Epic scene" (optional),
   *     createdAt: ISO date string,
   *     updatedAt: ISO date string
   *   }
   * }
   */

  /**
   * Get current video item data (similar to osd-rating.js)
   */
  function getCurrentItemData(): { itemId: string } | null {
    try {
      // Get item ID from favorite/rating button
      const btnUserRating = document.querySelector<HTMLElement>('.videoOsdBottom .btnUserRating[data-id]');
      const itemId = btnUserRating?.dataset?.id || null;

      if (!itemId) {
        console.debug(`${logPrefix} No item ID found`);
        return null;
      }

      return { itemId };
    } catch (e) {
      console.warn(`${logPrefix} Error getting item data:`, e);
      return null;
    }
  }

  /**
   * Async player work is owned by both the account generation and the exact
   * media item that initiated it. A same-account SPA navigation does not
   * advance the identity epoch, so the item ID must also still match before
   * publishing markers or a modal.
   */
  function isMediaItemCurrent(captured: BookmarkIdentityCapture, itemId: string): boolean {
    return isIdentityCurrent(captured) && getCurrentItemData()?.itemId === itemId;
  }

  function currentVideoElement(): HTMLVideoElement | null {
    return document.querySelector<HTMLVideoElement>('.videoPlayerContainer video');
  }

  function removeOwnedBookmarkMarkers(root: ParentNode = document): number {
    let removed = 0;
    // The host may temporarily detach and later reuse the OSD. Keep explicit
    // ownership so cleanup also reaches markers outside the connected document.
    for (const marker of [...ownedBookmarkMarkers]) {
      marker.remove();
      ownedBookmarkMarkers.delete(marker);
      removed += 1;
    }
    // Also clean up owned output created by an older bundle instance.
    for (const marker of root.querySelectorAll<HTMLElement>(ownedBookmarkMarkerSelector)) {
      marker.remove();
      removed += 1;
    }
    return removed;
  }

  function removeOwnedBookmarkButtons(root: ParentNode = document): number {
    let removed = 0;
    for (const button of [...ownedBookmarkButtons]) {
      button.remove();
      ownedBookmarkButtons.delete(button);
      removed += 1;
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>(
      '#jcBookmarkBtn[data-jc-identity-owned="true"]'
    )) {
      button.remove();
      removed += 1;
    }
    return removed;
  }

  function invalidateBookmarkMarkerOutput(): number {
    bookmarkMarkerGeneration += 1;
    removeOwnedBookmarkMarkers();
    return bookmarkMarkerGeneration;
  }

  function isBookmarkMarkerReconciliationCurrent(
    captured: BookmarkIdentityCapture,
    mediaItemId: string,
    video: HTMLVideoElement,
    generation: number
  ): boolean {
    return generation === bookmarkMarkerGeneration
      && currentVideoElement() === video
      && isMediaItemCurrent(captured, mediaItemId);
  }

  interface BookmarkItemDetails extends BookmarkIdentityRecord {
    readonly itemId: string;
    readonly identityVersion: 1;
    readonly itemType: string;
    readonly tmdbId: string | null;
    readonly tvdbId: string | null;
    readonly seriesTmdbId: string | null;
    readonly seriesTvdbId: string | null;
    readonly mediaType: string;
    readonly seasonNumber: number | null;
    readonly episodeNumber: number | null;
    readonly episodeEndNumber: number | null;
    readonly name: string;
    readonly type: string;
  }

  const itemDetailsCache = createItemDetailsCache<BookmarkItemDetails>({
    maxEntries: 32,
    successTtlMs: 15_000,
    negativeTtlMs: 1_000,
    failureTtlMs: 500
  });

  /**
   * Fetch full item details including TMDB/TVDB IDs (cached per item for a few seconds)
   */
  async function fetchItemDetails(itemId: string): Promise<BookmarkItemDetails | null> {
    const captured = captureIdentity();
    const context = captured.context;
    if (!context) return null;

    const outcome = await itemDetailsCache.getOrLoad({
      serverId: context.serverId,
      userId: context.userId,
      itemId
    }, context.epoch, async (signal): Promise<ItemDetailsCacheOutcome<BookmarkItemDetails>> => {
      try {
        const userId = context.userId;
        if (signal.aborted || !isIdentityCurrent(captured)) return { kind: 'aborted' };

        const result: any = await ApiClient.ajax({
          type: 'GET',
          url: (ApiClient as { getUrl(path: string, params?: unknown): string }).getUrl(`/Users/${userId}/Items`, {
            Ids: itemId,
            Fields: 'ProviderIds,Type,Name,SeriesId,ParentIndexNumber,IndexNumber,IndexNumberEnd'
          }),
          dataType: 'json',
          signal
        });

        const item = result?.Items?.[0];
        if (signal.aborted || !isIdentityCurrent(captured)) return { kind: 'aborted' };
        if (!item) return { kind: 'negative', reason: 'not-found' };
        if (typeof item.Id !== 'string' || item.Id !== itemId) {
          return { kind: 'negative', reason: 'invalid-response' };
        }

        // Episode/season provider IDs identify that concrete item. Keep them in
        // their namespace and fetch the parent series IDs into separate fields.
        let seriesItem: any = null;
        if ((item.Type === 'Season' || item.Type === 'Episode') && item.SeriesId) {
          if (signal.aborted || !isIdentityCurrent(captured)) return { kind: 'aborted' };
          try {
            const seriesResult: any = await ApiClient.ajax({
              type: 'GET',
              url: (ApiClient as { getUrl(path: string, params?: unknown): string }).getUrl(`/Users/${userId}/Items`, {
                Ids: item.SeriesId,
                Fields: 'ProviderIds,Type,Name'
              }),
              dataType: 'json',
              signal
            });
            seriesItem = seriesResult?.Items?.[0] || null;
          } catch (e) {
            if (signal.aborted || !isIdentityCurrent(captured)) return { kind: 'aborted' };
            console.warn(`${logPrefix} Failed to fetch series info:`, e);
          }
        }

        const tmdbId = item.ProviderIds?.Tmdb || null;
        const tvdbId = item.ProviderIds?.Tvdb || null;
        const mediaType = normalizeBookmarkMediaType(item.Type);
        const isEpisode = item.Type === 'Episode';
        const isSeason = item.Type === 'Season';
        const episodeNumber = isEpisode && Number.isSafeInteger(item.IndexNumber) ? item.IndexNumber : null;

        const details: BookmarkItemDetails = {
          itemId: item.Id,
          identityVersion: 1,
          itemType: String(item.Type || 'other').toLowerCase(),
          tmdbId,
          tvdbId,
          seriesTmdbId: seriesItem?.ProviderIds?.Tmdb || null,
          seriesTvdbId: seriesItem?.ProviderIds?.Tvdb || null,
          mediaType,
          seasonNumber: isEpisode
            ? (Number.isSafeInteger(item.ParentIndexNumber) ? item.ParentIndexNumber : null)
            : (isSeason && Number.isSafeInteger(item.IndexNumber) ? item.IndexNumber : null),
          episodeNumber,
          episodeEndNumber: isEpisode
            ? (Number.isSafeInteger(item.IndexNumberEnd) ? item.IndexNumberEnd : episodeNumber)
            : null,
          name: item.Name || 'Unknown',
          type: item.Type
        };

        if (signal.aborted || !isIdentityCurrent(captured)) return { kind: 'aborted' };
        return { kind: 'success', value: details };
      } catch (e) {
        if (signal.aborted || !isIdentityCurrent(captured)) return { kind: 'aborted' };
        console.warn(`${logPrefix} Error fetching item details:`, e);
        return { kind: 'failure', reason: 'transport' };
      }
    });
    return outcome.kind === 'success' ? outcome.value : null;
  }

  /**
   * Generate unique bookmark ID
   */
  function generateBookmarkId(): string {
    return `bm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Find bookmarks for current item (by itemId or TMDB/TVDB fallback)
   * Returns both exact matches and provider ID matches separately
   */
  function findBookmarksForItem(
    itemId: string,
    tmdbId?: string | null,
    tvdbId?: string | null,
    mediaType?: unknown,
    identity?: BookmarkIdentityRecord
  ): { bookmarks: any[]; hasIdMismatch: boolean; exactMatches: any[]; providerMatches: any[] } {
    const allBookmarks = (JC.userConfig as any)?.bookmark?.bookmarks || {};
    const exactMatches: any[] = [];
    const providerMatches: any[] = [];

    for (const [bookmarkId, bookmark] of Object.entries<any>(allBookmarks)) {
      // Skip invalid bookmarks
      if (typeof bookmark !== 'object' || bookmark === null) continue;

      const match = compareBookmarkIdentity(bookmark, {
        ...(identity || {}),
        itemId,
        tmdbId,
        tvdbId,
        mediaType
      });
      if (match === 'exact') {
        exactMatches.push({ id: bookmarkId, ...bookmark, exactMatch: true });
        continue;
      }
      if (match === 'logical') {
        providerMatches.push({ id: bookmarkId, ...bookmark, exactMatch: false });
      }
    }

    // Use exact matches if available, otherwise use provider matches
    const bookmarks = exactMatches.length > 0 ? exactMatches : providerMatches;
    const hasIdMismatch = exactMatches.length === 0 && providerMatches.length > 0;

    return { bookmarks, hasIdMismatch, exactMatches, providerMatches };
  }

  /**
   * Add a new bookmark
   */
  async function addBookmark(timestamp: number, label = ''): Promise<Record<string, unknown> | null> {
    const captured = captureIdentity();
    if (!captured.context) return null;
    const root = bookmarkRootFor(captured);
    if (!root) {
      console.error(`${logPrefix} Bookmark state has not loaded; refusing to add`);
      return null;
    }
    const itemData = getCurrentItemData();
    if (!itemData) {
      toast(JC.t!('toast_bookmark_no_item'), 3000);
      return null;
    }
    const requestedItemId = itemData.itemId;

    // Fetch full details
    const details = await fetchItemDetails(requestedItemId);
    if (!isMediaItemCurrent(captured, requestedItemId)) return null;
    if (!details || details.itemId !== requestedItemId) {
      toast(JC.t!('toast_bookmark_fetch_failed'), 3000);
      return null;
    }

    const bookmarkId = generateBookmarkId();
    const now = new Date().toISOString();

    const bookmark = {
      itemId: details.itemId || '',
      ...persistedBookmarkIdentity(details),
      mediaType: normalizeBookmarkMediaType(details.mediaType),
      name: details.name || '',
      timestamp: timestamp,
      label: label || '',
      createdAt: now,
      updatedAt: now,
      syncedFrom: ''
    };

    if (!isBookmarkRootCurrent(captured, root) || !isMediaItemCurrent(captured, requestedItemId)) return null;

    try {
      const committed = await commitBookmarkBatch(captured, root, state => {
        if (hasOwnBookmark(state.bookmarks, bookmarkId)) {
          const existing = state.bookmarks[bookmarkId];
          if (sameBookmark(existing, bookmark)) return [];
          throw new Error(`Bookmark id collision for ${bookmarkId}`);
        }
        return [{ type: 'add', bookmarkId, bookmark }];
      });
      if (!committed) return null;
      if (!isBookmarkRootCurrent(captured, root)
        || !isMediaItemCurrent(captured, requestedItemId)) return null;
      console.log(`${logPrefix} Bookmark added:`, bookmarkId, bookmark);
      if (!emitBookmarksUpdated(captured, 'add')) return null;
      return {
        id: bookmarkId,
        ...(hasOwnBookmark(committed.bookmarks, bookmarkId) ? committed.bookmarks[bookmarkId] : bookmark)
      };
    } catch (e) {
      if (!isBookmarkRootCurrent(captured, root)) return null;
      console.error(`${logPrefix} Failed to save bookmark:`, e);
      throw e;
    }
  }

  /**
   * Update an existing bookmark
   */
  async function updateBookmark(bookmarkId: string, updates: Record<string, unknown>): Promise<boolean> {
    const captured = captureIdentity();
    if (!captured.context) return false;
    const root = bookmarkRootFor(captured);
    if (!root || !hasOwnBookmark(root.bookmarks, bookmarkId)) {
      console.warn(`${logPrefix} Bookmark not found:`, bookmarkId);
      return false;
    }

    const updatedAt = new Date().toISOString();
    const startingBookmark = root.bookmarks[bookmarkId];
    let identityUpgrade: Record<string, unknown> = {};
    let identityUpgradeMediaType: unknown;
    if (startingBookmark.identityVersion !== 1 && typeof startingBookmark.itemId === 'string') {
      const details = await fetchItemDetails(startingBookmark.itemId);
      if (!isBookmarkRootCurrent(captured, root)) return false;
      if (details && details.itemId === startingBookmark.itemId) {
        identityUpgrade = persistedBookmarkIdentity(details);
        identityUpgradeMediaType = details.mediaType;
      }
    }
    const safeUpdates = { ...updates };
    for (const field of [
      'itemId', 'identityVersion', 'itemType', 'tmdbId', 'tvdbId',
      'seriesTmdbId', 'seriesTvdbId', 'mediaType', 'seasonNumber',
      'episodeNumber', 'episodeEndNumber'
    ]) delete safeUpdates[field];

    try {
      const committed = await commitBookmarkBatch(captured, root, state => {
        if (!hasOwnBookmark(state.bookmarks, bookmarkId)) return [];
        const current = state.bookmarks[bookmarkId];
        return [{
          type: 'update',
          bookmarkId,
          bookmark: {
            ...current,
            ...safeUpdates,
            ...identityUpgrade,
            mediaType: normalizeBookmarkMediaType(identityUpgradeMediaType ?? current.mediaType),
            updatedAt
          }
        }];
      });
      if (!committed || !hasOwnBookmark(committed.bookmarks, bookmarkId)) return false;
      if (!isBookmarkRootCurrent(captured, root)) return false;
      console.log(`${logPrefix} Bookmark updated:`, bookmarkId);
      return emitBookmarksUpdated(captured, 'update');
    } catch (e) {
      if (!isBookmarkRootCurrent(captured, root)) return false;
      console.error(`${logPrefix} Failed to update bookmark:`, e);
      return false;
    }
  }

  /**
   * Delete a bookmark
   */
  async function deleteBookmark(bookmarkId: string): Promise<boolean> {
    const captured = captureIdentity();
    if (!captured.context) return false;
    const root = bookmarkRootFor(captured);
    if (!root || !hasOwnBookmark(root.bookmarks, bookmarkId)) {
      console.warn(`${logPrefix} Bookmark not found:`, bookmarkId);
      return false;
    }

    const startingRevision = root.revision;
    try {
      const committed = await commitBookmarkBatch(captured, root, state =>
        hasOwnBookmark(state.bookmarks, bookmarkId) ? [{ type: 'delete', bookmarkId }] : []);
      if (!committed) return false;
      if (!isBookmarkRootCurrent(captured, root)) return false;
      console.log(`${logPrefix} Bookmark deleted:`, bookmarkId);
      return emitBookmarksUpdated(captured, 'delete');
    } catch (e) {
      if (!isBookmarkRootCurrent(captured, root)) return false;
      // A 409 can advance the local root to an authoritative server snapshot
      // before the rebased retry fails. Reconcile every view to that retained
      // snapshot instead of leaving the pre-conflict marker on screen.
      if (root.revision !== startingRevision) {
        emitBookmarksUpdated(captured, 'authoritative-reconcile');
      }
      console.error(`${logPrefix} Failed to delete bookmark:`, e);
      return false;
    }
  }

  /**
   * Sync bookmarks from old item ID to new item ID.
   *
   * Creates duplicate copies under the new item ID. When `removeOldIds` is
   * supplied, the copies and removals are committed in one server-side atomic
   * batch: either the complete migration lands or the prior state remains.
   */
  async function syncBookmarks(oldBookmarks: any[], newItemDetails: any, timeOffset = 0, removeOldIds?: string[]): Promise<any[]> {
    const captured = captureIdentity();
    if (!captured.context) return [];
    const synced: any[] = [];
    const now = new Date().toISOString();
    const root = bookmarkRootFor(captured);
    if (!root) return [];
    // Stable ids make a conflict retry (or a replay after a lost response)
    // idempotent rather than creating a second copy.
    for (const oldBookmark of oldBookmarks) {
      if (compareBookmarkIdentity(oldBookmark, newItemDetails) === 'none') {
        throw new Error('Refusing to sync bookmarks across different or ambiguous logical media');
      }
      const newBookmarkId = generateBookmarkId();
      const newTimestamp = Math.max(0, oldBookmark.timestamp + timeOffset);

      const newBookmark = {
        itemId: newItemDetails.itemId,
        ...(newItemDetails.itemType
          ? persistedBookmarkIdentity(newItemDetails)
          : { tmdbId: newItemDetails.tmdbId || '', tvdbId: newItemDetails.tvdbId || '' }),
        mediaType: normalizeBookmarkMediaType(newItemDetails.mediaType),
        name: newItemDetails.name,
        timestamp: newTimestamp,
        label: oldBookmark.label || '',
        createdAt: oldBookmark.createdAt || now,
        updatedAt: now,
        syncedFrom: oldBookmark.itemId // Track where it came from
      };

      synced.push({ id: newBookmarkId, ...newBookmark });
    }

    try {
      const committed = await commitBookmarkBatch(captured, root, state => {
        const operations: BookmarkOperation[] = [];
        for (const next of synced) {
          const { id, ...bookmark } = next;
          if (hasOwnBookmark(state.bookmarks, id)) {
            if (!sameBookmark(state.bookmarks[id], bookmark)) {
              throw new Error(`Bookmark id collision for ${id}`);
            }
          } else {
            operations.push({ type: 'add', bookmarkId: id, bookmark });
          }
        }
        for (const id of removeOldIds || []) {
          if (hasOwnBookmark(state.bookmarks, id)) operations.push({ type: 'delete', bookmarkId: id });
        }
        return operations;
      });
      if (!committed) return [];
      console.log(`${logPrefix} Atomically synced ${synced.length} bookmarks to new item ID`);
    } catch (e) {
      if (!isBookmarkRootCurrent(captured, root)) return [];
      console.error(`${logPrefix} Failed to sync bookmarks:`, e);
      throw e;
    }

    if (!isBookmarkRootCurrent(captured, root)) return [];
    if (!emitBookmarksUpdated(captured, 'sync')) return [];
    return synced;
  }

  /**
   * Ask the server to classify every bookmarked item in the current user's
   * library scope and atomically delete only authoritative global absences.
   */
  async function cleanupOrphanedBookmarks(): Promise<BookmarkCleanupResult> {
    const empty = (): BookmarkCleanupResult => ({ deleted: 0, retainedUncertain: 0, errors: 0 });
    const captured = captureIdentity();
    if (!captured.context) return empty();
    const root = bookmarkRootFor(captured);
    if (!root) return empty();
    const plugin = JC.core.api?.plugin?.bind(JC.core.api);
    if (typeof plugin !== 'function') throw new Error('Bookmark cleanup transport is unavailable');
    const evidenceDeleted = new Set<string>();

    for (let attempt = 0; attempt < 5; attempt++) {
      if (!isBookmarkRootCurrent(captured, root)) return empty();
      const base = committedState(root);
      if (!base) throw new Error('Bookmark state is unavailable; reload before cleanup');
      try {
        const response = await plugin(
          `/user-settings/${encodeURIComponent(captured.context.userId)}/bookmark.json/cleanup`,
          { method: 'POST', body: { revision: base.revision }, skipRetry: true }
        );
        const cleaned = cleanupResponse(response);
        if (!cleaned) throw new Error('Bookmark cleanup returned an invalid committed state');
        if (!adoptCommittedState(captured, root, cleaned.state)) return empty();
        const result = {
          ...cleaned.result,
          deleted: cleaned.result.deleted + evidenceDeleted.size
        };
        if (result.deleted > 0) emitBookmarksUpdated(captured, 'cleanup');
        console.log(
          `${logPrefix} Cleanup: ${result.deleted} removed, `
          + `${result.retainedUncertain} retained uncertain, ${result.errors} errors`
        );
        return result;
      } catch (error) {
        if (isAmbiguousBookmarkTransportError(error)) {
          if (!isBookmarkRootCurrent(captured, root)) return empty();
          try {
            const response = await plugin(
              `/user-settings/${encodeURIComponent(captured.context.userId)}/bookmark.json`,
              { method: 'GET', skipRetry: true }
            );
            const evidence = committedState(response);
            if (!evidence) throw new Error('Bookmark evidence response was invalid');
            // Evidence cannot distinguish our response-lost commit from a
            // concurrent session deleting the same bookmark in this narrow
            // window. Counting every newly absent id avoids false zero-success;
            // this affects only the informational toast, never deletion policy.
            for (const bookmarkId of Object.keys(base.bookmarks)) {
              if (!hasOwnBookmark(evidence.bookmarks, bookmarkId)) evidenceDeleted.add(bookmarkId);
            }
            if (!adoptCommittedState(captured, root, evidence)) return empty();
            if ((error as { name?: string }).name === 'AbortError') throw error;
            continue;
          } catch {
            throw error;
          }
        }
        if (httpStatus(error) !== 409) throw error;
        const latest = conflictState(error);
        if (!latest) throw new Error('Bookmark conflict response omitted authoritative state');
        if (!adoptCommittedState(captured, root, latest)) return empty();
      }
    }

    throw new Error('Bookmark state kept changing; retry cleanup');
  }

  /** Delete the currently loaded bookmark set in one atomic transaction. */
  async function deleteAllBookmarks(): Promise<number> {
    const captured = captureIdentity();
    if (!captured.context) return 0;
    const root = bookmarkRootFor(captured);
    if (!root) return 0;
    const ids = Object.keys(root.bookmarks);
    if (ids.length === 0) return 0;
    const committed = await commitBookmarkBatch(captured, root, state =>
      ids
        .filter(bookmarkId => hasOwnBookmark(state.bookmarks, bookmarkId))
        .map(bookmarkId => ({ type: 'delete' as const, bookmarkId })));
    if (!committed || !isBookmarkRootCurrent(captured, root)) return 0;
    const deleted = ids.filter(bookmarkId => !hasOwnBookmark(committed.bookmarks, bookmarkId)).length;
    if (deleted > 0) emitBookmarksUpdated(captured, 'delete-all');
    return deleted;
  }

  /**
   * Format timestamp as HH:MM:SS or MM:SS
   */
  function formatTimestamp(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${m}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Create visual bookmark markers in video OSD
   */
  function createBookmarkMarkers(
    video: HTMLVideoElement,
    bookmarksList: any[],
    captured: BookmarkIdentityCapture,
    mediaItemId: string,
    generation: number
  ): void {
    console.log(`${logPrefix} createBookmarkMarkers called - video:`, !!video, 'bookmarks:', bookmarksList.length);

    if (!captured.context
      || !video
      || !isBookmarkMarkerReconciliationCurrent(captured, mediaItemId, video, generation)) {
      console.log(`${logPrefix} Early return - stale marker owner or no video`);
      return;
    }

    // Resolve the current OSD owner before reconciling. Jellyfin reuses this
    // DOM across item transitions, so an empty result must replace prior output.
    const osdBottom = document.querySelector('.videoOsdBottom');
    if (!osdBottom) {
      console.log(`${logPrefix} No .videoOsdBottom found`);
      return;
    }

    // Find the position slider with expanded selectors
    const positionSlider = osdBottom.querySelector('.osdPositionSlider, .sliderBubble, .mdl-slider, input[type="range"]');
    if (!positionSlider) {
      console.log(`${logPrefix} No position slider found`);
      return;
    }

    const sliderContainer = positionSlider.closest<HTMLElement>('.osdPositionSliderContainer, .sliderContainer') || positionSlider.parentElement;
    if (!sliderContainer) {
      console.log(`${logPrefix} No slider container found`);
      return;
    }

    if (!isBookmarkMarkerReconciliationCurrent(captured, mediaItemId, video, generation)) return;

    const removed = removeOwnedBookmarkMarkers(sliderContainer);
    console.log(`${logPrefix} Removing ${removed} existing owned markers`);
    if (!bookmarksList.length) {
      console.log(`${logPrefix} Reconciled empty bookmark marker set`);
      return;
    }

    // Ensure markers position relative to the slider container
    const sliderPos = window.getComputedStyle(sliderContainer).position;
    if (sliderPos === 'static') {
      sliderContainer.style.position = 'relative';
    }

    const duration = video.duration;
    if (!duration || !isFinite(duration)) {
      console.log(`${logPrefix} Invalid duration:`, duration);
      return;
    }

    // Create markers for each bookmark
    bookmarksList.forEach(bookmark => {
      const percent = (bookmark.timestamp / duration) * 100;
      const markerColor = bookmark.exactMatch ? '#00d4ff' : '#ffa500';

      const marker = document.createElement('div');
      marker.className = 'jc-bookmark-marker';
      marker.dataset.jcIdentityOwned = 'true';
      marker.dataset.jcIdentityEpoch = String(captured.context!.epoch);
      marker.dataset.jcBookmarkMarkerOwner = 'canopy';
      marker.dataset.jcBookmarkMediaItemId = mediaItemId;
      marker.dataset.jcBookmarkGeneration = String(generation);
      marker.style.cssText = `
        position: absolute;
        left: ${percent}%;
        bottom: 0%;
        transform: translate(-50%, -50%);
        z-index: 1000;
        pointer-events: all;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      `;

      const icon = document.createElement('span');
      icon.className = 'material-icons';
      icon.textContent = 'location_pin';
      icon.style.cssText = `
        font-size: 24px;
        color: ${markerColor};
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8));
        pointer-events: none;
      `;

      marker.appendChild(icon);

      const labelText = bookmark.label || JC.t!('bookmark_no_label');
      const versionNote = !bookmark.exactMatch ? ` ${JC.t!('bookmark_file_changed')}` : '';
      marker.title = `${labelText} - ${formatTimestamp(bookmark.timestamp)}${versionNote}`;

      // Click to jump to bookmark
      marker.addEventListener('click', (e) => {
        if (!isBookmarkMarkerReconciliationCurrent(captured, mediaItemId, video, generation)) return;
        e.stopPropagation();
        video.currentTime = bookmark.timestamp;
        toast(`${JC.t!('toast_jumped_to_bookmark')}: ${formatTimestamp(bookmark.timestamp)}`, 2000);
      });

      if (isBookmarkMarkerReconciliationCurrent(captured, mediaItemId, video, generation)
        && sliderContainer.isConnected) {
        sliderContainer.appendChild(marker);
        ownedBookmarkMarkers.add(marker);
      }
    });

    console.log(`${logPrefix} ✓ Created ${bookmarksList.length} bookmark markers`);
  }


  /**
   * Update bookmark markers for current video
   */
  async function updateBookmarkMarkersForCurrentVideo(): Promise<void> {
    // Claim a new playback-render generation and synchronously withdraw every
    // prior owned marker before item-details I/O can suspend. A reused OSD
    // therefore never displays item A's output while item B is loading.
    const reconciliationGeneration = invalidateBookmarkMarkerOutput();
    const captured = captureIdentity();
    if (!captured.context) return;
    console.log(`${logPrefix} updateBookmarkMarkersForCurrentVideo called`);

    const video = currentVideoElement();
    if (!video) {
      console.log(`${logPrefix} No video element found`);
      return;
    }

    const itemData = getCurrentItemData();
    if (!itemData) {
      console.log(`${logPrefix} No item data (no btnUserRating?)`);
      return;
    }

    const requestedItemId = itemData.itemId;
    console.log(`${logPrefix} Fetching details for item:`, requestedItemId);
    const details = await fetchItemDetails(requestedItemId);
    if (!details
      || details.itemId !== requestedItemId
      || !isBookmarkMarkerReconciliationCurrent(
        captured,
        requestedItemId,
        video,
        reconciliationGeneration
      )) {
      console.log(`${logPrefix} Failed to fetch item details`);
      return;
    }

    console.log(`${logPrefix} Item details:`, details);
    const { bookmarks: bookmarksList } = findBookmarksForItem(
      details.itemId,
      details.tmdbId,
      details.tvdbId,
      details.mediaType,
      details
    );

    console.log(`${logPrefix} Found ${bookmarksList.length} bookmarks for this item`);
    createBookmarkMarkers(
      video,
      bookmarksList,
      captured,
      requestedItemId,
      reconciliationGeneration
    );
  }

  /**
   * Show bookmark management modal
   */
  async function showBookmarkModal(mode = 'add', existingBookmark: any = null): Promise<void> {
    const captured = captureIdentity();
    if (!captured.context) return;
    const video = document.querySelector<HTMLVideoElement>('.videoPlayerContainer video');
    const currentTime = video?.currentTime || 0;

    const itemData = getCurrentItemData();
    if (!itemData) {
      toast(JC.t!('toast_bookmark_no_item'), 3000);
      return;
    }

    const requestedItemId = itemData.itemId;
    const details = await fetchItemDetails(requestedItemId);
    if (!isMediaItemCurrent(captured, requestedItemId)) return;
    if (!details) {
      toast(JC.t!('toast_bookmark_fetch_failed'), 3000);
      return;
    }
    if (details.itemId !== requestedItemId) return;

    const { bookmarks: existingBookmarks } = findBookmarksForItem(
      details.itemId,
      details.tmdbId,
      details.tvdbId,
      details.mediaType,
      details
    );

    console.log('🪼 Bookmarks modal: Found', existingBookmarks.length, 'existing bookmarks for item', details.itemId);
    console.log('🪼 Bookmarks modal: Mode =', mode, 'Existing bookmarks:', existingBookmarks);

    const isEdit = mode === 'edit' && existingBookmark;
    const title = isEdit ? JC.t!('bookmark_edit_title') : (mode === 'view' ? 'Your Bookmarks' : JC.t!('bookmark_add_title'));
    const timestamp = isEdit ? existingBookmark.timestamp : currentTime;
    const label = isEdit ? existingBookmark.label : '';

    const formHtml = `
      <style>
        .jc-bm-player-modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0,0,0,0.85);
          z-index: 9999;
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0;
          transition: opacity 0.2s;
        }
        .jc-bm-player-modal-container {
          background: #181818;
          border-radius: 12px;
          max-width: 700px;
          width: 90%;
          max-height: 85vh;
          padding: 24px;
          position: relative;
          box-shadow: 0 8px 32px rgba(0,0,0,0.8);
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        @media (max-width: 600px) {
          .jc-bm-player-modal-container {
            padding: 16px;
            max-height: 90vh;
            width: 95%;
          }
        }
        .jc-bookmark-modal-close {
          position: absolute;
          top: 16px;
          right: 16px;
          background: transparent;
          border: none;
          color: #fff;
          font-size: 32px;
          cursor: pointer;
          width: 40px;
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          transition: background 0.2s;
        }
        .jc-bookmark-modal-close:hover {
          background: rgba(255,255,255,0.1);
        }
        .jc-bookmark-modal-actions {
          display: flex;
          gap: 12px;
          margin-top: 16px;
          justify-content: flex-end;
          flex-shrink: 0;
        }
        .jc-bookmark-btn-submit,
        .jc-bookmark-btn-cancel {
          padding: 12px 24px;
          border: none;
          border-radius: 6px;
          font-size: 15px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }
        .jc-bookmark-btn-submit {
          background: #00a86b;
          color: #fff;
        }
        .jc-bookmark-btn-submit:hover {
          background: #00c47a;
        }
        .jc-bookmark-btn-cancel {
          display: flex;
          align-items: center;
          gap: 6px;
          background: rgba(255,255,255,0.1);
          color: #fff;
        }
        .jc-bookmark-btn-cancel:hover {
          background: rgba(255,255,255,0.15);
        }
        .jc-bookmark-modal {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
          flex: 1;
          overflow-y: auto;
          min-height: 0;
        }
        .jc-bookmark-hero { padding: 0 0 20px 0; border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 20px; }
        .jc-bookmark-hero-title { font-size: 20px; font-weight: 600; color: #fff; margin: 0 0 6px 0; }
        .jc-bookmark-hero-icon { display: none; }
        .jc-bookmark-hero-subtitle { font-size: 14px; color: #888; margin: 0; }

        .jc-bookmark-form-grid { display: grid; gap: 20px; }
        .jc-bookmark-input-group { position: relative; }
        .jc-bookmark-input-group label {
          display: block;
          margin-bottom: 8px;
          font-weight: 600;
          color: #e0e0e0;
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .jc-bookmark-input, .jc-bookmark-textarea {
          width: 100%;
          padding: 12px 16px;
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 6px;
          background: rgba(255,255,255,0.05);
          color: #fff;
          font-family: inherit;
          font-size: 15px;
          transition: all 0.2s;
          box-sizing: border-box;
        }
        .jc-bookmark-input:focus, .jc-bookmark-textarea:focus {
          outline: none;
          border-color: rgba(255,255,255,0.3);
          background: rgba(255,255,255,0.08);
        }
        .jc-bookmark-input[readonly] {
          background: rgba(0,0,0,0.2);
          cursor: not-allowed;
          border-color: rgba(255,255,255,0.1);
        }
        .jc-bookmark-textarea {
          resize: vertical;
          min-height: 80px;
          font-family: inherit;
        }

        .jc-bookmark-list {
          margin-top: 28px;
          max-height: 300px;
          overflow-y: auto;
          padding-right: 8px;
        }
        @media (max-width: 600px) {
          .jc-bookmark-list {
            max-height: 150px;
            margin-top: 16px;
          }
        }
        .jc-bookmark-list::-webkit-scrollbar {
          width: 8px;
        }
        .jc-bookmark-list::-webkit-scrollbar-track {
          background: rgba(255,255,255,0.05);
          border-radius: 4px;
        }
        .jc-bookmark-list::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.2);
          border-radius: 4px;
        }
        .jc-bookmark-list::-webkit-scrollbar-thumb:hover {
          background: rgba(255,255,255,0.3);
        }
        .jc-bookmark-list-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 12px;
          padding-bottom: 8px;
          border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .jc-bookmark-list-title {
          font-size: 13px;
          font-weight: 600;
          color: #aaa;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .jc-bookmark-list-count {
          background: rgba(255,255,255,0.1);
          color: #fff;
          padding: 4px 12px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
        }

        .jc-bookmark-item {
            display: flex;
            gap: 12px;
            padding: 14px 16px;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 8px;
            margin-bottom: 10px;
            transition: all 0.2s;
            flex-wrap: wrap;
            flex-direction: row;
            align-items: center;
        }

        .jc-bookmark-item:hover {
          background: rgba(255,255,255,0.08);
          border-color: rgba(255,255,255,0.2);
        }
        .jc-bookmark-item-marker {
          width: 3px;
          background: rgba(255,255,255,0.3);
          border-radius: 2px;
          flex-shrink: 0;
        }
        .jc-bookmark-item-content { flex: 1; min-width: 0; }
        .jc-bookmark-item-time {
          font-weight: 600;
          color: #fff;
          font-size: 15px;
          margin-bottom: 4px;
        }
        .jc-bookmark-item-label {
          font-size: 14px;
          color: #ccc;
          margin-top: 4px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .jc-bookmark-item-warning {
          color: #ffa500;
          font-size: 12px;
          margin-top: 6px;
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .jc-bookmark-item-actions {
          display: flex;
          gap: 8px;
          flex-shrink: 0;
        }
        .jc-bookmark-btn {
          padding: 8px;
          font-size: 20px;
          border-radius: 50%;
          cursor: pointer;
          border: none;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
        }
        .jc-bookmark-btn:hover {
          opacity: 0.9;
          color: #fff;
        }
        .jc-bookmark-btn-jump:hover {
          background: #00a86b;
        }
        .jc-bookmark-btn-delete:hover {
          background: #b60505;
        }

        .jc-bookmark-empty {
          text-align: center;
          padding: 40px 20px;
          color: #888;
          font-size: 14px;
        }
        .jc-bookmark-empty-icon {
          font-size: 48px;
          margin-bottom: 12px;
          opacity: 0.5;
        }
      </style>
      <div class="jc-bookmark-modal">
        <div class="jc-bookmark-hero">
          <div class="jc-bookmark-hero-title">
            <span>${title}</span>
          </div>
          <div class="jc-bookmark-hero-subtitle">${escapeHtml(details.name)}</div>
        </div>
        <div class="jc-bookmark-form-grid">
          <div class="jc-bookmark-input-group">
            <label for="bookmark-time">${JC.t!('bookmark_time_label')}</label>
            <input
              type="text"
              id="bookmark-time"
              class="jc-bookmark-input"
              value="${formatTimestamp(timestamp)}"
              readonly>
          </div>
          <div class="jc-bookmark-input-group">
            <label for="bookmark-label">${JC.t!('bookmark_label_label')}</label>
            <input
              type="text"
              id="bookmark-label"
              class="jc-bookmark-input"
              placeholder="${JC.t!('bookmark_label_placeholder')}"
              value="${escapeHtml(label)}"
              maxlength="100">
          </div>
        </div>
        ${existingBookmarks.length > 0 ? `
          <div class="jc-bookmark-list">
            <div class="jc-bookmark-list-header">
              <div class="jc-bookmark-list-title">${JC.t!('bookmark_existing_title')}</div>
              <div class="jc-bookmark-list-count">${existingBookmarks.length}</div>
            </div>
            ${existingBookmarks.map(bm => `
              <div class="jc-bookmark-item">
                <div class="jc-bookmark-item-marker"></div>
                <div class="jc-bookmark-item-content">
                  <div class="jc-bookmark-item-time">${formatTimestamp(bm.timestamp)}</div>
                  ${bm.label ? `<div class="jc-bookmark-item-label">${escapeHtml(bm.label)}</div>` : ''}
                  ${!bm.exactMatch ? `<div class="jc-bookmark-item-warning">${JC.t!('bookmark_file_changed')}</div>` : ''}
                </div>
                <div class="jc-bookmark-item-actions">
                  <button class="jc-bookmark-btn jc-bookmark-btn-jump" data-bookmark-id="${escapeHtml(bm.id)}" title="${JC.t!('bookmark_jump')}">
                    <span class="material-icons">forward</span>
                  </button>
                  <button class="jc-bookmark-btn jc-bookmark-btn-delete" data-bookmark-id="${escapeHtml(bm.id)}" title="${JC.t!('bookmark_delete_confirm')}">
                    <span class="material-icons">delete</span>
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
        ` : `
          <div class="jc-bookmark-empty">
            <div>${JC.t!('bookmark_none')}</div>
          </div>
        `}
      </div>
    `;

    // Create custom modal
    const modal = document.createElement('div');
    modal.className = 'jc-bm-player-modal-overlay';
    modal.dataset.jcIdentityOwned = 'true';
    modal.dataset.jcIdentityEpoch = String(captured.context.epoch);
    modal.innerHTML = `
      <div class="jc-bm-player-modal-container">
        <button class="jc-bookmark-modal-close">×</button>
        ${formHtml}
        <div class="jc-bookmark-modal-actions">
          <button class="jc-bookmark-btn-submit">${isEdit ? JC.t!('bookmark_save') : JC.t!('bookmark_add')}</button>
          <button class="jc-bookmark-btn-cancel">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
            <span>Cancel</span>
          </button>
        </div>
      </div>
    `;

    if (!isIdentityCurrent(captured)) return;
    document.body.appendChild(modal);

    const modalTimers = new Set<number>();
    let removalTimer: number | null = null;
    let removed = false;
    let closing = false;

    const scheduleModalTask = (callback: () => void, delay: number): void => {
      const timer = window.setTimeout(() => {
        modalTimers.delete(timer);
        if (isIdentityCurrent(captured) && !removed) callback();
      }, delay);
      modalTimers.add(timer);
    };

    const removeModalNow = (): void => {
      if (removed) return;
      removed = true;
      for (const timer of modalTimers) clearTimeout(timer);
      modalTimers.clear();
      if (removalTimer !== null) clearTimeout(removalTimer);
      removalTimer = null;
      document.removeEventListener('viewshow', requestClose);
      activeModalDisposers.delete(modal);
      modal.remove();
    };

    const disposeModal = (immediate: boolean): void => {
      if (removed) return;
      if (immediate) {
        removeModalNow();
        return;
      }
      if (closing) return;
      closing = true;
      modal.style.opacity = '0';
      removalTimer = window.setTimeout(removeModalNow, 200);
    };

    function requestClose(): void {
      if (!isIdentityCurrent(captured)) return;
      disposeModal(false);
    }

    const isModalOwnerCurrent = (): boolean =>
      isMediaItemCurrent(captured, requestedItemId);

    activeModalDisposers.set(modal, () => disposeModal(true));

    // Prevent keyboard shortcuts and wheel events from affecting video player
    modal.addEventListener('keydown', (e) => { if (isIdentityCurrent(captured)) e.stopPropagation(); });
    modal.addEventListener('keyup', (e) => { if (isIdentityCurrent(captured)) e.stopPropagation(); });
    modal.addEventListener('keypress', (e) => { if (isIdentityCurrent(captured)) e.stopPropagation(); });
    modal.addEventListener('wheel', (e) => { if (isIdentityCurrent(captured)) e.stopPropagation(); });

    // Close modal when navigating away
    document.addEventListener('viewshow', requestClose);

    // Close button
    modal.querySelector('.jc-bookmark-modal-close')?.addEventListener('click', requestClose);
    modal.querySelector('.jc-bookmark-btn-cancel')?.addEventListener('click', requestClose);
    modal.addEventListener('click', (e) => {
      if (isIdentityCurrent(captured) && e.target === modal) requestClose();
    });

    // Focus label input after modal opens
    scheduleModalTask(() => {
      if (!isModalOwnerCurrent()) {
        disposeModal(true);
        return;
      }
      const labelInput = modal.querySelector<HTMLInputElement>('#bookmark-label');
      if (labelInput) labelInput.focus();
      modal.style.opacity = '1';
    }, 10);

    // Submit
    modal.querySelector('.jc-bookmark-btn-submit')?.addEventListener('click', () => { void (async () => {
      if (!isModalOwnerCurrent()) return;
      const labelInput = modal.querySelector<HTMLInputElement>('#bookmark-label')!.value.trim();

      try {
        let saved: boolean | Record<string, unknown> | null;
        if (isEdit) {
          saved = await updateBookmark(existingBookmark.id, { label: labelInput });
        } else {
          saved = await addBookmark(timestamp, labelInput);
        }
        if (!isModalOwnerCurrent()) return;
        if (!saved) {
          toast(JC.t!('toast_bookmark_save_failed'), 3000);
          return;
        }
        toast(JC.t!('toast_bookmark_updated'), 2000);

        // Refresh markers
        void updateBookmarkMarkersForCurrentVideo();
        requestClose();
      } catch (e) {
        if (!isModalOwnerCurrent()) return;
        toast(JC.t!('toast_bookmark_save_failed'), 3000);
      }
    })(); });

    // Jump to bookmark buttons
    modal.querySelectorAll<HTMLElement>('.jc-bookmark-btn-jump').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!isModalOwnerCurrent()) return;
        const bookmarkId = btn.dataset.bookmarkId;
        const bookmark = existingBookmarks.find(bm => bm.id === bookmarkId);
        if (bookmark && video) {
          video.currentTime = bookmark.timestamp;
          toast(`${JC.t!('toast_jumped_to_bookmark')}: ${formatTimestamp(bookmark.timestamp)}`, 2000);
          requestClose();
        }
      });
    });

    // Delete bookmark buttons
    modal.querySelectorAll<HTMLElement>('.jc-bookmark-btn-delete').forEach(btn => {
      btn.addEventListener('click', () => { void (async () => {
        if (!isModalOwnerCurrent()) return;
        const bookmarkId = btn.dataset.bookmarkId!;
        const deleted = await deleteBookmark(bookmarkId);
        if (!isModalOwnerCurrent()) return;
        if (!deleted) {
          toast(JC.t!('toast_bookmark_save_failed'), 3000);
          return;
        }
        toast(JC.t!('toast_bookmark_deleted'), 2000);
        void updateBookmarkMarkersForCurrentVideo();
        requestClose();
        // Reopen modal to show updated list
        scheduleIdentityTask(captured, () => {
          if (isModalOwnerCurrent()) void showBookmarkModal(mode, existingBookmark);
        }, 300);
      })(); });
    });
  }

  // Public API
  JC.bookmarks = {
    add: addBookmark,
    update: updateBookmark,
    delete: deleteBookmark,
    findForItem: findBookmarksForItem,
    showModal: showBookmarkModal,
    updateMarkers: updateBookmarkMarkersForCurrentVideo,
    formatTimestamp,
    syncBookmarks,
    cleanupOrphaned: cleanupOrphanedBookmarks,
    deleteAll: deleteAllBookmarks
  } satisfies BookmarksApi;

  /**
   * Add bookmark button to the video player OSD
   */
  function addOsdBookmarkButton(captured: BookmarkIdentityCapture = captureIdentity()): void {
    if (!captured.context || !isIdentityCurrent(captured)) return;
    // A replaced OSD may leave its button detached for later host reuse. Retire
    // it before creating output for the current controls and keep the registry
    // bounded to connected ownership.
    for (const button of [...ownedBookmarkButtons]) {
      if (button.isConnected) continue;
      button.remove();
      ownedBookmarkButtons.delete(button);
    }
    // Don't add if already exists
    if (document.getElementById('jcBookmarkBtn')) return;

    const controlsContainer = document.querySelector('.videoOsdBottom .buttons.focuscontainer-x');
    if (!controlsContainer) return;

    // Find the native settings button to insert before
    const nativeSettingsButton = controlsContainer.querySelector('.btnVideoOsdSettings');
    if (!nativeSettingsButton) return;

    const bookmarkBtn = document.createElement('button');
    bookmarkBtn.id = 'jcBookmarkBtn';
    bookmarkBtn.setAttribute('is', 'paper-icon-button-light');
    bookmarkBtn.className = 'autoSize paper-icon-button-light';
    bookmarkBtn.dataset.jcIdentityOwned = 'true';
    bookmarkBtn.dataset.jcIdentityEpoch = String(captured.context.epoch);
    bookmarkBtn.title = JC.t!('shortcut_BookmarkCurrentTime');
    bookmarkBtn.innerHTML = '<span class="largePaperIconButton material-icons" aria-hidden="true">bookmark_add</span>';

    bookmarkBtn.onclick = (e) => {
      if (!isIdentityCurrent(captured)) return;
      e.stopPropagation();
      void showBookmarkModal('add');
    };

    // Insert before the settings button
    if (!isIdentityCurrent(captured)) return;
    nativeSettingsButton.parentElement!.insertBefore(bookmarkBtn, nativeSettingsButton);
    ownedBookmarkButtons.add(bookmarkBtn);
    console.log(`${logPrefix} ✓ Added OSD bookmark button`);
  }

  /**
   * Initialize bookmarks system
   */
  JC.initializeBookmarks = (function() {
    let initialized = false;
    let cleanupFunctions: (() => void)[] = [];

    return function() {
      if (!JC.pluginConfig?.BookmarksEnabled) {
        JC.cleanupBookmarks?.();
        return;
      }
      // Prevent multiple initializations
      if (initialized) {
        console.log(`${logPrefix} Already initialized, skipping...`);
        return;
      }
      const activation = captureIdentity();
      if (!activation.context || !isIdentityCurrent(activation)) return;
      initialized = true;

      console.log(`${logPrefix} Initializing enhanced bookmarks...`);

      let lastVideoUrl: string | null = null;
      let lastInjectedOsdKey: string | null = null;
      let disposed = false;
      const osdObserverId = 'jc-bookmarks-osd';
      const videoObserverId = 'jc-bookmarks-video-changes';

      const isActivationCurrent = (): boolean => !disposed && isIdentityCurrent(activation);

      function getOsdKey(): string {
        const video = document.querySelector<HTMLVideoElement>('.videoPlayerContainer video');
        return video?.currentSrc || video?.src || window.location.href;
      }

      // Debounced OSD injection - prevents rapid re-injection
      const debouncedOsdInjection = debounce(() => {
        if (!isActivationCurrent()) return;
        if (!(JC as any).isVideoPage()) return;

        const osdBottom = document.querySelector('.videoOsdBottom');
        const video = document.querySelector('.videoPlayerContainer video');
        const currentOsdKey = getOsdKey();

        // Only inject if OSD exists and we haven't already injected for this video
        if (osdBottom && video && currentOsdKey !== lastInjectedOsdKey) {
          void updateBookmarkMarkersForCurrentVideo();
          addOsdBookmarkButton(activation);
          if (!isActivationCurrent()) return;
          lastInjectedOsdKey = currentOsdKey;
          console.log(`${logPrefix} Injected markers/button for ${currentOsdKey}`);
        }
      }, 200);

      // Managed observer: only watches when on video page
      function ensureOsdObserver(): void {
        if (!isActivationCurrent()) return;
        if (!(JC as any).isVideoPage()) {
          disconnectObserver(osdObserverId);
          return;
        }

        // Create observer that watches for OSD appearance
        createObserver(
          osdObserverId,
          debouncedOsdInjection,
          document.body,
          { childList: true, subtree: true }
        );
      }

      // Debounced handlers for video events
      const handlePlayingEvent = debounce((e: Event) => {
        if (!isActivationCurrent()) return;
        if ((e.target as HTMLElement).tagName === 'VIDEO' && (JC as any).isVideoPage()) {
          debouncedOsdInjection();
        }
      }, 300);

      const handleMetadataEvent = debounce((e: Event) => {
        if (!isActivationCurrent()) return;
        if ((e.target as HTMLElement).tagName === 'VIDEO' && (JC as any).isVideoPage()) {
          debouncedOsdInjection();
        }
      }, 300);

      const handleViewShow = () => {
        if (!isActivationCurrent()) return;
        // A host navigation retires unresolved detail work immediately. The
        // settled keyed entries remain reusable within this identity epoch,
        // while every continuation still carries the exact current item fence.
        itemDetailsCache.cancelPending();
        if ((JC as any).isVideoPage()) {
          lastInjectedOsdKey = null; // Reset for new page
          ensureOsdObserver();
          debouncedOsdInjection();
        } else {
          // Clean up when leaving video page
          invalidateBookmarkMarkerOutput();
          lastVideoUrl = null;
          lastInjectedOsdKey = null;
          disconnectObserver(osdObserverId);
          disconnectObserver(videoObserverId);
        }
      };

      // Register event listeners with cleanup tracking
      document.addEventListener('playing', handlePlayingEvent, true);
      cleanupFunctions.push(() => document.removeEventListener('playing', handlePlayingEvent, true));

      document.addEventListener('loadedmetadata', handleMetadataEvent, true);
      cleanupFunctions.push(() => document.removeEventListener('loadedmetadata', handleMetadataEvent, true));

      document.addEventListener('viewshow', handleViewShow);
      cleanupFunctions.push(() => document.removeEventListener('viewshow', handleViewShow));

      // Mutations emit this event only after the server acknowledgement has
      // been adopted. This keeps every persistence entry point on the same
      // marker reconciliation path without publishing optimistic output.
      const handleBookmarksUpdated = () => {
        if (isActivationCurrent()
          && (JC as unknown as { isVideoPage(): boolean }).isVideoPage()) {
          void updateBookmarkMarkersForCurrentVideo();
        }
      };
      document.addEventListener('jc-bookmarks-updated', handleBookmarksUpdated);
      cleanupFunctions.push(() => document.removeEventListener('jc-bookmarks-updated', handleBookmarksUpdated));

      // Initial setup if already on video page
      if ((JC as any).isVideoPage()) {
        ensureOsdObserver();
        debouncedOsdInjection();
      }

      const cleanupActivation = (force = false): void => {
        if (disposed) return;
        if (!force && !isIdentityCurrent(activation)) return;
        // Mark disposal before draining listeners/observers. Already-queued
        // debounce callbacks then fail closed even when the identity is unchanged.
        disposed = true;
        cleanupFunctions.forEach(fn => fn());
        cleanupFunctions = [];
        disconnectObserver(osdObserverId);
        disconnectObserver(videoObserverId);
        for (const timer of bookmarkTimers) clearTimeout(timer);
        bookmarkTimers.clear();
        disposeActiveModals();
        invalidateBookmarkMarkerOutput();
        removeOwnedBookmarkButtons();
        document.querySelectorAll('.jc-bm-player-modal-overlay').forEach((node) => node.remove());
        initialized = false;
        console.log(`${logPrefix} Cleaned up`);
      };
      const forceCleanup = (): void => cleanupActivation(true);
      forceCleanupBookmarks = forceCleanup;

      // The public cleanup is identity-owned, so a retained A function cannot
      // tear down B. The reset hook retains the private force variant.
      JC.cleanupBookmarks = (): void => cleanupActivation(false);

      console.log(`${logPrefix} ✓ Initialized`);
    };
  })();

  JC.identity.registerReset('bookmarks', () => {
    bookmarkGeneration += 1;
    invalidateBookmarkMarkerOutput();
    for (const timer of bookmarkTimers) clearTimeout(timer);
    bookmarkTimers.clear();
    disposeActiveModals();
    itemDetailsCache.clear();
    forceCleanupBookmarks?.();
    forceCleanupBookmarks = null;
    removeOwnedBookmarkButtons();
    document.querySelectorAll('.jc-bm-player-modal-overlay').forEach((node) => node.remove());
  });

}
