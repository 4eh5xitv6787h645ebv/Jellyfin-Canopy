// src/enhanced/osd-rating.ts
//
// Injects rating into the Jellyfin video OSD near the "Ends at" text
// (Converted from js/enhanced/osd-rating.js — bodies semantically identical.)

import { JC } from '../globals';
import { onBodyMutation } from '../core/dom-observer';
import { onNavigate } from '../core/navigation';
import { createStableMethodFacade } from '../core/feature-loader';
import type { IdentityContext } from '../types/jc';

/** Ratings resolved for one item (display-ready values). */
interface OsdRating {
    tmdb: string | null;
    critic: number | null;
}

/** Minimal Jellyfin item projection requested by the OSD rating endpoint. */
interface RatingItem {
  Type?: string;
  SeriesId?: string;
  CommunityRating?: unknown;
  CriticRating?: unknown;
}

interface RatingItemsResponse {
  Items?: RatingItem[];
}

const logPrefix = '🪼 Jellyfin Canopy: OSD Rating:';
const CONTAINER_ID = 'jc-osd-rating-container';
// PERF(R6/ENH-7): the RT critic chip's tomato glyphs were `url(assets/img/*.svg)`,
// which resolve relative to /web/ and DO NOT exist anywhere in the tree — so the
// chip rendered no icon and fired a 404. Inline them as plugin-owned, zero-network
// data-URI SVGs (compile-time constants → trusted producers, no CDN/manifest).
const FRESH_TOMATO_DATA_URI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMyIgcj0iOCIgZmlsbD0iI2Y5MzIwOCIvPjxwYXRoIGQ9Ik0xMiA1YzEtMiAzLTMgNS0zLTEgMi0yIDMtNCA0eiIgZmlsbD0iIzVhYTAyYyIvPjwvc3ZnPg==';
const ROTTEN_TOMATO_DATA_URI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTEyIDNjMiAzIDYgMyA2IDcgMCAzIDIgNCAxIDctMiA0LTggNC0xMSAxLTMtMy0yLTYtMS04IDEtMiAzLTMgNS03eiIgZmlsbD0iIzZiOGUyMyIvPjwvc3ZnPg==';
// Hot cache (per session) so each item is fetched once
const ratingCache = new Map<string, OsdRating>();
const pendingRatings = new Map<string, Promise<OsdRating>>();
let scheduledUpdate: number | null = null;
let osdObserver: MutationObserver | null = null;
let navUnsubscribe: (() => void) | null = null;
let generation = 0;

interface AttachAttempt {
  readonly generation: number;
  cancel(): void;
}

let attachAttempt: AttachAttempt | null = null;

function isActive(context: IdentityContext, expectedGeneration: number): boolean {
  return generation === expectedGeneration && JC.identity.isCurrent(context);
}

function ratingKey(context: IdentityContext, itemId: string): string {
  return `${context.serverId}:${context.userId}:${context.epoch}:${itemId}`;
}

function isEnabled(): boolean {
  // Controlled by server config; default true unless explicitly disabled
  return JC.pluginConfig?.ShowRatingInPlayer !== false;
}

function normalizeCriticPercent(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  const percent = num <= 10 ? Math.round(num * 10) : Math.round(num);
  return Math.max(0, Math.min(100, percent));
}

function createTomatoIcon(isRotten: boolean): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `jc-tomato ${isRotten ? 'rotten' : 'fresh'}`;
  return span;
}

function getCurrentItemId(): string | null {
  // Pull from the favorite button in the OSD
  const favBtn = document.querySelector<HTMLElement>('.videoOsdBottom .btnUserRating[data-id]');
  return favBtn?.dataset?.id || null;
}

async function fetchItemRatings(
  context: IdentityContext,
  expectedGeneration: number,
  itemId: string
): Promise<OsdRating> {
  try {
    const params = new URLSearchParams({
      Ids: itemId,
      Fields: 'CommunityRating,CriticRating,Type'
    });
    const result = await JC.core.api!.jf(`/Users/${context.userId}/Items?${params}`) as RatingItemsResponse;
    if (!isActive(context, expectedGeneration)) return { tmdb: null, critic: null };
    const item = result?.Items?.[0];
    if (!item) return { tmdb: null, critic: null };

    let sourceItem = item;
    if ((item.Type === 'Season' || item.Type === 'Episode') && item.SeriesId && !item.CommunityRating && !item.CriticRating) {
      try {
        const seriesParams = new URLSearchParams({
          Ids: String(item.SeriesId),
          Fields: 'CommunityRating,CriticRating,Type'
        });
        const seriesResult = await JC.core.api!.jf(`/Users/${context.userId}/Items?${seriesParams}`) as RatingItemsResponse;
        if (!isActive(context, expectedGeneration)) return { tmdb: null, critic: null };
        sourceItem = seriesResult?.Items?.[0] || item;
      } catch (e) {
        if (!isActive(context, expectedGeneration)) return { tmdb: null, critic: null };
        console.warn(`${logPrefix} Failed to fetch series rating for ${item.Type}`, e);
      }
    }

    const tmdb = sourceItem.CommunityRating != null ? Number(sourceItem.CommunityRating).toFixed(1) : null;
    const critic = normalizeCriticPercent(sourceItem.CriticRating);

    return { tmdb, critic };
  } catch (e) {
    if (!isActive(context, expectedGeneration)) return { tmdb: null, critic: null };
    console.warn(`${logPrefix} Failed to fetch rating for ${itemId}`, e);
    return { tmdb: null, critic: null };
  }
}

export function ensureStyles(): void {
  if (document.getElementById('jc-osd-rating-style')) return;
  const style = document.createElement('style');
  style.id = 'jc-osd-rating-style';
  style.textContent = `
    #${CONTAINER_ID} { display: inline-flex; align-items: center; gap: 6px; margin-left: 10px; vertical-align: middle; }
    #${CONTAINER_ID} .jc-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 4px; font-weight: 600; line-height: 1; }
    #${CONTAINER_ID} .jc-chip.tmdb { color: #ffc107; }
    #${CONTAINER_ID} .jc-chip.critic { color: #ffffff; }
    #${CONTAINER_ID} .jc-star { font-family: 'Material Icons'; font-size: 16px; color: #ffc107; line-height: 1; }
    #${CONTAINER_ID} .jc-text { font-size: 14px; color: inherit; font-weight: 600; line-height: 1; }
    #${CONTAINER_ID} .jc-tomato { width: 16px; height: 16px; flex-shrink: 0; background-size: contain; background-repeat: no-repeat; background-position: center; display: inline-block; }
    #${CONTAINER_ID} .jc-tomato.fresh { background-image: url(${FRESH_TOMATO_DATA_URI}); }
    #${CONTAINER_ID} .jc-tomato.rotten { background-image: url(${ROTTEN_TOMATO_DATA_URI}); }
  `;
  document.head.appendChild(style);
}

function injectRating(osdRoot: HTMLElement, rating: OsdRating, itemId: string): void {
  if (!osdRoot || (!rating.tmdb && rating.critic === null)) return;
  if (!osdRoot.isConnected || getCurrentItemId() !== itemId) return;
  ensureStyles();

  const osdTimeContainer = osdRoot.querySelector('.osdTimeText');
  if (!osdTimeContainer) return;

  osdRoot.querySelectorAll(`#${CONTAINER_ID}`).forEach(el => el.remove());

  const container = document.createElement('span');
  container.id = CONTAINER_ID;
  container.dataset.itemId = itemId;

  if (rating.critic !== null) {
    const criticChip = document.createElement('span');
    criticChip.className = 'jc-chip critic';
    criticChip.appendChild(createTomatoIcon(rating.critic < 60));

    const criticText = document.createElement('span');
    criticText.className = 'jc-text';
    criticText.textContent = `${rating.critic}%`;

    criticChip.appendChild(criticText);
    container.appendChild(criticChip);
  }

  if (rating.tmdb) {
    const tmdbChip = document.createElement('span');
    tmdbChip.className = 'jc-chip tmdb';

    const star = document.createElement('span');
    star.className = 'jc-star';
    star.textContent = 'star';

    const text = document.createElement('span');
    text.className = 'jc-text';
    text.textContent = rating.tmdb;

    tmdbChip.appendChild(star);
    tmdbChip.appendChild(text);
    container.appendChild(tmdbChip);
  }

  if (container.children.length === 0) return;
  osdTimeContainer.insertAdjacentElement('beforebegin', container);
}

async function updateOsdRating(
  context = JC.identity.capture(),
  expectedGeneration = generation
): Promise<void> {
  if (!context || !isActive(context, expectedGeneration)) return;
  if (!isEnabled()) {
    console.debug(`${logPrefix} Skipped - feature disabled`);
    return;
  }
  if (!JC.isVideoPage?.()) {
    return;
  }
  const osdRoot = document.querySelector<HTMLElement>('.videoOsdBottom');
  if (!osdRoot) return;

  const itemId = getCurrentItemId();
  if (!itemId) return;
  const key = ratingKey(context, itemId);

  // Skip re-injection only if the container already shows the correct item
  const existing = osdRoot.querySelector<HTMLElement>(`#${CONTAINER_ID}`);
  if (existing && existing.dataset.itemId === itemId) return;

  // Remove stale container from previous episode before injecting new one
  if (existing) existing.remove();

  // Serve from cache if available (including null-rating to avoid refetch loops)
  if (ratingCache.has(key)) {
    const cached = ratingCache.get(key);
    if (cached && (cached.tmdb || cached.critic !== null)) injectRating(osdRoot, cached, itemId);
    return;
  }

  // Reuse in-flight fetch
  if (pendingRatings.has(key)) {
    const rating = await pendingRatings.get(key);
    if (isActive(context, expectedGeneration) && rating && (rating.tmdb || rating.critic !== null)) {
      injectRating(osdRoot, rating, itemId);
    }
    return;
  }

  const promise = (async () => {
    const rating = await fetchItemRatings(context, expectedGeneration, itemId);
    if (isActive(context, expectedGeneration)) ratingCache.set(key, rating);
    return rating;
  })();

  pendingRatings.set(key, promise);

  try {
    const rating = await promise;
    if (isActive(context, expectedGeneration) && rating && (rating.tmdb || rating.critic !== null)) {
      injectRating(osdRoot, rating, itemId);
    }
  } finally {
    pendingRatings.delete(key);
  }
}

function scheduleUpdate(context: IdentityContext, expectedGeneration: number): void {
  if (scheduledUpdate) return;
  scheduledUpdate = window.setTimeout(() => {
    scheduledUpdate = null;
    if (isActive(context, expectedGeneration) && JC.isVideoPage?.()) {
      void updateOsdRating(context, expectedGeneration);
    }
  }, 200);
}

function waitForPlayerContainer(attempt: AttachAttempt): Promise<Element | null> {
  const existing = document.querySelector('.videoPlayerContainer');
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let handle: { unsubscribe(): void } | null = null;
    const settle = (element: Element | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      handle?.unsubscribe();
      resolve(element);
    };
    attempt.cancel = () => settle(null);
    handle = onBodyMutation(`osd-rating-player-${attempt.generation}`, () => {
      const element = document.querySelector('.videoPlayerContainer');
      if (element) settle(element);
    });
    timeoutId = setTimeout(() => settle(null), 20_000);
  });
}

/**
 * Attaches the OSD observer, scoped to the player container.
 * PERF(R3): previously created at boot and — because .videoPlayerContainer does
 * not exist yet at that point — permanently fell back to observing
 * document.body, adding a 200ms-timeout schedule on every body mutation on
 * every page. It is now created lazily when a video page mounts and is torn
 * down on leave (see the onNavigate wiring in JC.initializeOsdRating).
 */
async function attachOsdObserver(context: IdentityContext, expectedGeneration: number): Promise<void> {
  if (!isActive(context, expectedGeneration)) return;
  if (osdObserver || attachAttempt) return;
  const attempt: AttachAttempt = { generation: expectedGeneration, cancel() { /* assigned by waiter */ } };
  attachAttempt = attempt;
  try {
    // The player container mounts shortly after navigation; wait for it via
    // the shared body observer instead of observing body ourselves.
    const target = await waitForPlayerContainer(attempt);
    if (!target) return;
    if (!isActive(context, expectedGeneration) || !JC.isVideoPage?.()) return; // navigated/switched while waiting
    if (osdObserver) return;
    osdObserver = new MutationObserver(() => {
      scheduleUpdate(context, expectedGeneration);
    });
    osdObserver.observe(target, { childList: true, subtree: true });
    scheduleUpdate(context, expectedGeneration);
  } finally {
    if (attachAttempt === attempt) attachAttempt = null;
  }
}

/** Disconnects the OSD observer and cancels any pending update. */
function detachOsdObserver(): void {
  if (osdObserver) {
    osdObserver.disconnect();
    osdObserver = null;
  }
  if (scheduledUpdate) {
    clearTimeout(scheduledUpdate);
    scheduledUpdate = null;
  }
}

function reset(): void {
  generation++;
  detachOsdObserver();
  navUnsubscribe?.();
  navUnsubscribe = null;
  attachAttempt?.cancel();
  attachAttempt = null;
  ratingCache.clear();
  pendingRatings.clear();
  document.querySelectorAll(`#${CONTAINER_ID}`).forEach((node) => node.remove());
  document.getElementById('jc-osd-rating-style')?.remove();
}

function initializeOsdRating(): void {
  reset();
  if (!isEnabled()) {
    console.log(`${logPrefix} Feature is disabled in settings.`);
    return;
  }
  try {
    const context = JC.identity.capture();
    if (!context) return;
    const expectedGeneration = generation;
    const syncWithPage = (): void => {
      if (!isActive(context, expectedGeneration)) return;
      if (JC.isVideoPage?.()) {
        void attachOsdObserver(context, expectedGeneration);
      } else {
        detachOsdObserver();
      }
    };
    navUnsubscribe = onNavigate(syncWithPage);
    syncWithPage(); // boot may happen while already on a video page
    console.log(`${logPrefix} Initialized successfully.`);
  } catch (e) { console.warn(`${logPrefix} Init failed`, e); }
}

const osdRatingApi = { initialize: initializeOsdRating };
const stableOsdRating = createStableMethodFacade<typeof osdRatingApi>({ initialize() {} });

/** Publish the OSD compatibility initializer for one loader-owned activation. */
export function installOsdRating(): () => void {
  const uninstall = stableOsdRating.install(osdRatingApi);
  JC.initializeOsdRating = stableOsdRating.facade.initialize;
  const unregisterReset = JC.identity.registerReset('osd-rating', reset);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    reset();
    unregisterReset();
    uninstall();
  };
}

/** Start OSD rating without resolving through its global compatibility method. */
export function initializeInstalledOsdRating(): void {
  initializeOsdRating();
}
