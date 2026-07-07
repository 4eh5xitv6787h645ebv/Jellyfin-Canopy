// src/enhanced/spoiler-guard/detail-button.ts
//
// The detail-page Spoiler Guard toggle button (Series / Movie / Collection) and
// its click → toggle → refresh flow. Injected through the EXISTING v12
// details-page dispatcher (src/enhanced/features/details-page.ts calls
// addSpoilerBlurButton) rather than a new observer — PERF(R3): no feature owns a
// body-wide observer; this rides the shared one behind the details-page gate.

import { JE } from '../../globals';
import { kindOf, type SpoilerKind } from './ids';
import {
    isEnabledFor, isMovieEnabledFor, isCollectionEnabledFor,
    enableForSeries, disableForSeries,
    enableForMovie, disableForMovie,
    enableForCollection, disableForCollection,
    getUserPrefs,
    isStateLoaded,
} from './state';
import { confirmDisableSpoiler } from './dialog';
import { refreshSpoilerableImages } from './image-refresh';

const logPrefix = '🪼 Jellyfin Elevate [SpoilerGuard]:';

function isEnabledForKind(kind: SpoilerKind, id: string): boolean {
    if (kind === 'movie') return isMovieEnabledFor(id);
    if (kind === 'collection') return isCollectionEnabledFor(id);
    return isEnabledFor(id);
}

/**
 * Render the icon-only button content + tooltip for the given enabled state.
 * The label rides on `title` (hover) and `aria-label` (screen readers) so the
 * action row stays compact. Built with DOM APIs — no HTML interpolation (X1).
 */
function renderButton(button: HTMLButtonElement, enabled: boolean): void {
    const label = enabled ? JE.t!('spoiler_blur_button_on') : JE.t!('spoiler_blur_button_off');
    button.classList.toggle('je-spoiler-blur-on', enabled);
    button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    button.title = label;
    button.setAttribute('aria-label', label);

    button.replaceChildren();
    const content = document.createElement('div');
    content.className = 'detailButton-content';
    const icon = document.createElement('span');
    icon.className = 'material-icons detailButton-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = enabled ? 'blur_on' : 'blur_off';
    content.appendChild(icon);
    button.appendChild(content);
}

/**
 * Keep the button positioned just before Jellyfin's More-commands (...) menu
 * button when present, else append. Idempotent: only mutates the DOM when the
 * button is actually out of position, so the shared body observer re-running
 * the details dispatcher doesn't churn the row.
 */
function placeButton(button: HTMLButtonElement, container: Element): void {
    const menuBtn = container.querySelector('.btnMoreCommands');
    if (menuBtn) {
        if (button.nextElementSibling !== menuBtn) container.insertBefore(button, menuBtn);
    } else if (button.parentNode !== container) {
        container.appendChild(button);
    }
}

/**
 * Insert (or refresh) the Spoiler Guard toggle on a Series / Movie / Collection
 * detail page's action row. Idempotent: re-running on the same page reuses the
 * existing button and only re-renders when state OR identity changed.
 * @param itemId - The detail item's Jellyfin id.
 * @param visiblePage - The visible #itemDetailPage element.
 * @param itemType - Jellyfin item Type (Series | Movie | BoxSet).
 */
export function addSpoilerBlurButton(itemId: string, visiblePage: Element, itemType: string): void {
    if (JE.pluginConfig?.SpoilerBlurEnabled !== true) return;
    if (!itemId || !visiblePage) return;
    if (!isStateLoaded()) return; // wait for the initial GET attempt to settle

    const kind = kindOf(itemType);

    const selectors = ['.detailButtons', '.itemActionsBottom', '.mainDetailButtons', '.detailButtonsContainer'];
    let container: Element | null = null;
    for (const sel of selectors) {
        const found = visiblePage.querySelector(sel);
        if (found) { container = found; break; }
    }
    if (!container) return;

    const enabled = isEnabledForKind(kind, itemId);
    const newState = enabled ? 'on' : 'off';

    let existing = visiblePage.querySelector<HTMLButtonElement>('.je-spoiler-blur-btn');

    if (!existing) {
        existing = document.createElement('button');
        existing.setAttribute('is', 'emby-button');
        existing.className = 'button-flat detailButton emby-button je-spoiler-blur-btn';
        existing.type = 'button';
        placeButton(existing, container);
        // Read itemId/kind LIVE from data-attrs at click time, not closure:
        // Jellyfin reuses #itemDetailPage across SPA navigations, so a button
        // reused for a different item must target the current one.
        existing.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const liveId = existing!.getAttribute('data-je-item-id') || '';
            const liveKind = (existing!.getAttribute('data-je-spoiler-kind') || 'series') as SpoilerKind;
            const livePage = existing!.closest('#itemDetailPage:not(.hide)') || visiblePage;
            onToggleClicked(existing!, liveId, liveKind, livePage);
        });
        existing.setAttribute('data-je-item-id', itemId);
        existing.setAttribute('data-je-spoiler-state', newState);
        existing.setAttribute('data-je-spoiler-kind', kind);
        renderButton(existing, enabled);
        return;
    }

    placeButton(existing, container);

    const prevId = existing.getAttribute('data-je-item-id');
    const prevKind = existing.getAttribute('data-je-spoiler-kind');
    if (prevId !== itemId) existing.setAttribute('data-je-item-id', itemId);
    if (prevKind !== kind) existing.setAttribute('data-je-spoiler-kind', kind);

    // Re-render only when state OR identity changed — the shared body observer
    // re-enters this on every mutation; an unconditional render would loop.
    const stateChanged = existing.getAttribute('data-je-spoiler-state') !== newState;
    const identityChanged = prevId !== itemId || prevKind !== kind;
    if (stateChanged || identityChanged) {
        existing.setAttribute('data-je-spoiler-state', newState);
        renderButton(existing, enabled);
    }
}

// Full-reload scheduler (Strict refresh mode only): title / overview / ratings
// come from a DTO the page rendered ONCE and don't reactively update when the
// server-side strip changes. Coalesced + debounced so a burst of watched-marks
// triggers one reload. One-shot setTimeout (not self-rescheduling).
let pendingReload: number | null = null;
function scheduleFullReload(): void {
    if (pendingReload) clearTimeout(pendingReload);
    pendingReload = window.setTimeout(() => {
        pendingReload = null;
        try { location.reload(); } catch (e) { console.warn(`${logPrefix} reload failed:`, e); }
    }, 600);
}

/**
 * Click handler: flips Spoiler Guard for this item, confirms on disable (unless
 * snoozed / SkipDisableConfirm), toasts, and refreshes images in place.
 */
function onToggleClicked(button: HTMLButtonElement, itemId: string, kind: SpoilerKind, visiblePage: Element): void {
    if (button.disabled) return; // ignore re-entrant clicks
    const willBeEnabled = !isEnabledForKind(kind, itemId);
    // Disable up-front so rapid double-clicks can't stack confirm dialogs.
    button.disabled = true;
    if (!willBeEnabled) {
        confirmDisableSpoiler().then((proceed) => {
            if (proceed) performToggle(button, itemId, kind, visiblePage, willBeEnabled);
            else button.disabled = false;
        }, (err) => {
            console.warn(`${logPrefix} confirmDisableSpoiler rejected:`, err);
            button.disabled = false;
        });
        return;
    }
    performToggle(button, itemId, kind, visiblePage, willBeEnabled);
}

function performToggle(
    button: HTMLButtonElement, itemId: string, kind: SpoilerKind,
    visiblePage: Element, willBeEnabled: boolean
): void {
    let displayName = '';
    if ((kind === 'movie' || kind === 'collection') && visiblePage) {
        try {
            const titleEl = visiblePage.querySelector('h1.itemName-name, h1.itemName, .itemName, h2.itemName-name');
            if (titleEl?.textContent) displayName = titleEl.textContent.trim();
        } catch (e) {
            console.warn(`${logPrefix} ${kind} title scrape failed; falling back to server lookup:`, e);
        }
    }

    let promise: Promise<void>;
    if (kind === 'movie') {
        promise = willBeEnabled ? enableForMovie(itemId, displayName) : disableForMovie(itemId);
    } else if (kind === 'collection') {
        promise = willBeEnabled ? enableForCollection(itemId, displayName) : disableForCollection(itemId);
    } else {
        promise = willBeEnabled ? enableForSeries(itemId) : disableForSeries(itemId);
    }

    promise.then(() => {
        renderButton(button, willBeEnabled);
        button.setAttribute('data-je-spoiler-state', willBeEnabled ? 'on' : 'off');

        // Per-kind toast wording: series mentions "unwatched episodes".
        let msg: string;
        if (willBeEnabled) {
            msg = kind === 'movie' ? JE.t!('spoiler_blur_enabled_movie_toast')
                : kind === 'collection' ? JE.t!('spoiler_blur_enabled_collection_toast')
                    : JE.t!('spoiler_blur_enabled_toast');
        } else {
            msg = kind === 'movie' ? JE.t!('spoiler_blur_disabled_movie_toast')
                : kind === 'collection' ? JE.t!('spoiler_blur_disabled_collection_toast')
                    : JE.t!('spoiler_blur_disabled_toast');
        }
        JE.toast?.(msg);

        // Bust the JE tag-pipeline server cache so freshly-eligible items lose
        // their pre-toggle (unstripped) tag overlays immediately.
        try { void JE.tagPipeline?.invalidateServerCache?.(); }
        catch (e) { console.warn(`${logPrefix} invalidateServerCache failed:`, e); }

        // Remove any reviews section rendered for THIS detail page when enabling,
        // mirroring reviews.ts shouldSuppressForSpoilerMode: admin strip on AND
        // the user hasn't opted to keep reviews (HideReviews === false wins).
        try {
            const reviewsOptOut = getUserPrefs().HideReviews === false;
            if (willBeEnabled && JE.pluginConfig?.SpoilerStripReviews !== false && !reviewsOptOut) {
                const existingReviews = document.querySelector('#itemDetailPage:not(.hide) .tmdb-reviews-section')
                    || document.querySelector('.tmdb-reviews-section');
                existingReviews?.parentNode?.removeChild(existingReviews);
            }
        } catch (e) {
            console.warn(`${logPrefix} reviews section cleanup failed:`, e);
        }

        // Snappy visual feedback: refresh all image URLs in place. DOM text
        // (overview/titles/ratings) only re-renders on next navigation unless
        // Strict refresh mode is on, in which case also schedule a reload.
        try { refreshSpoilerableImages(); }
        catch (e) { console.warn(`${logPrefix} refreshSpoilerableImages failed:`, e); }

        if (JE.pluginConfig?.SpoilerBlurStrictRefresh === true) scheduleFullReload();
    }).catch((err) => {
        console.error(`${logPrefix} Toggle failed:`, err);
        JE.toast?.(JE.t!('spoiler_blur_error_toast'));
    }).finally(() => {
        button.disabled = false;
    });
}
