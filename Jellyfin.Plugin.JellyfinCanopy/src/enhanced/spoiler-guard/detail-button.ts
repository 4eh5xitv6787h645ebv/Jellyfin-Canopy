// src/enhanced/spoiler-guard/detail-button.ts
//
// The detail-page Spoiler Guard toggle button (Series / Movie / Collection) and
// its click → toggle → refresh flow. Injected through the EXISTING v12
// details-page dispatcher (src/enhanced/features/details-page.ts calls
// addSpoilerBlurButton) rather than a new observer — PERF(R3): no feature owns a
// body-wide observer; this rides the shared one behind the details-page gate.

import { JC } from '../../globals';
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
import type { IdentityContext } from '../../types/jc';

const logPrefix = '🪼 Jellyfin Canopy [SpoilerGuard]:';

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
    const label = enabled ? JC.t!('spoiler_blur_button_on') : JC.t!('spoiler_blur_button_off');
    button.classList.toggle('jc-spoiler-blur-on', enabled);
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

function isLiveButton(button: HTMLButtonElement, context: IdentityContext, visiblePage?: Element): boolean {
    return JC.identity.isCurrent(context)
        && JC.identity.isOwned(button, context)
        && button.isConnected
        && (!visiblePage || visiblePage.contains(button));
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
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    if (JC.pluginConfig?.SpoilerBlurEnabled !== true) return;
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

    let existing = visiblePage.querySelector<HTMLButtonElement>('.jc-spoiler-blur-btn');

    // A cached details-page element can survive an account switch. Never
    // reuse a control whose listener closure belongs to the previous epoch.
    if (existing && !JC.identity.isOwned(existing, context)) {
        existing.remove();
        existing = null;
    }

    if (!existing) {
        existing = document.createElement('button');
        existing.setAttribute('is', 'emby-button');
        existing.className = 'button-flat detailButton emby-button jc-spoiler-blur-btn';
        existing.dataset.jcThemeSurface = 'details';
        existing.dataset.jcThemeComponent = 'protection-toggle';
        existing.type = 'button';
        existing.dataset.jcIdentityOwned = 'true';
        JC.identity.own(existing, context);
        placeButton(existing, container);
        // Read itemId/kind LIVE from data-attrs at click time, not closure:
        // Jellyfin reuses #itemDetailPage across SPA navigations, so a button
        // reused for a different item must target the current one.
        existing.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isLiveButton(existing!, context)) return;
            const liveId = existing!.getAttribute('data-jc-item-id') || '';
            const liveKind = (existing!.getAttribute('data-jc-spoiler-kind') || 'series') as SpoilerKind;
            const livePage = existing!.closest('#itemDetailPage:not(.hide)') || visiblePage;
            if (!isLiveButton(existing!, context, livePage)) return;
            onToggleClicked(existing!, liveId, liveKind, livePage, context);
        });
        existing.setAttribute('data-jc-item-id', itemId);
        existing.setAttribute('data-jc-spoiler-state', newState);
        existing.setAttribute('data-jc-spoiler-kind', kind);
        renderButton(existing, enabled);
        return;
    }

    placeButton(existing, container);

    const prevId = existing.getAttribute('data-jc-item-id');
    const prevKind = existing.getAttribute('data-jc-spoiler-kind');
    if (prevId !== itemId) existing.setAttribute('data-jc-item-id', itemId);
    if (prevKind !== kind) existing.setAttribute('data-jc-spoiler-kind', kind);

    // Re-render only when state OR identity changed — the shared body observer
    // re-enters this on every mutation; an unconditional render would loop.
    const stateChanged = existing.getAttribute('data-jc-spoiler-state') !== newState;
    const identityChanged = prevId !== itemId || prevKind !== kind;
    if (stateChanged || identityChanged) {
        existing.setAttribute('data-jc-spoiler-state', newState);
        renderButton(existing, enabled);
    }
}

// Full-reload scheduler (Strict refresh mode only): title / overview / ratings
// come from a DTO the page rendered ONCE and don't reactively update when the
// server-side strip changes. Coalesced + debounced so a burst of watched-marks
// triggers one reload. One-shot setTimeout (not self-rescheduling).
let pendingReload: number | null = null;
let pendingReloadContext: IdentityContext | null = null;
function cancelFullReload(): void {
    if (pendingReload !== null) clearTimeout(pendingReload);
    pendingReload = null;
    pendingReloadContext = null;
}

function scheduleFullReload(context: IdentityContext): void {
    cancelFullReload();
    pendingReloadContext = context;
    pendingReload = window.setTimeout(() => {
        const owner = pendingReloadContext;
        pendingReload = null;
        pendingReloadContext = null;
        if (!owner || !JC.identity.isCurrent(owner)) return;
        try { location.reload(); } catch (e) { console.warn(`${logPrefix} reload failed:`, e); }
    }, 600);
}

/**
 * Click handler: flips Spoiler Guard for this item, confirms on disable (unless
 * snoozed / SkipDisableConfirm), toasts, and refreshes images in place.
 */
function onToggleClicked(
    button: HTMLButtonElement,
    itemId: string,
    kind: SpoilerKind,
    visiblePage: Element,
    context: IdentityContext,
): void {
    if (!isLiveButton(button, context, visiblePage)) return;
    if (button.disabled) return; // ignore re-entrant clicks
    const willBeEnabled = !isEnabledForKind(kind, itemId);
    // Disable up-front so rapid double-clicks can't stack confirm dialogs.
    button.disabled = true;
    if (!willBeEnabled) {
        confirmDisableSpoiler(context).then((proceed) => {
            if (!isLiveButton(button, context, visiblePage)) return;
            if (proceed) performToggle(button, itemId, kind, visiblePage, willBeEnabled, context);
            else button.disabled = false;
        }, (err) => {
            if (!isLiveButton(button, context, visiblePage)) return;
            console.warn(`${logPrefix} confirmDisableSpoiler rejected:`, err);
            button.disabled = false;
        });
        return;
    }
    performToggle(button, itemId, kind, visiblePage, willBeEnabled, context);
}

function performToggle(
    button: HTMLButtonElement, itemId: string, kind: SpoilerKind,
    visiblePage: Element, willBeEnabled: boolean, context: IdentityContext,
): void {
    if (!isLiveButton(button, context, visiblePage)) return;
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
        if (!isLiveButton(button, context, visiblePage)) return;
        renderButton(button, willBeEnabled);
        button.setAttribute('data-jc-spoiler-state', willBeEnabled ? 'on' : 'off');

        // Per-kind toast wording: series mentions "unwatched episodes".
        let msg: string;
        if (willBeEnabled) {
            msg = kind === 'movie' ? JC.t!('spoiler_blur_enabled_movie_toast')
                : kind === 'collection' ? JC.t!('spoiler_blur_enabled_collection_toast')
                    : JC.t!('spoiler_blur_enabled_toast');
        } else {
            msg = kind === 'movie' ? JC.t!('spoiler_blur_disabled_movie_toast')
                : kind === 'collection' ? JC.t!('spoiler_blur_disabled_collection_toast')
                    : JC.t!('spoiler_blur_disabled_toast');
        }
        JC.toast?.(msg);

        // Bust the JC tag-pipeline server cache so freshly-eligible items lose
        // their pre-toggle (unstripped) tag overlays immediately.
        try { void JC.tagPipeline?.invalidateServerCache?.(); }
        catch (e) { console.warn(`${logPrefix} invalidateServerCache failed:`, e); }

        // Remove any reviews section rendered for THIS detail page when enabling,
        // mirroring reviews.ts shouldSuppressForSpoilerMode: admin strip on AND
        // the user hasn't opted to keep reviews (HideReviews === false wins).
        try {
            const reviewsOptOut = getUserPrefs().HideReviews === false;
            if (willBeEnabled && JC.pluginConfig?.SpoilerStripReviews !== false && !reviewsOptOut) {
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

        if (JC.pluginConfig?.SpoilerBlurStrictRefresh === true) scheduleFullReload(context);
    }).catch((err) => {
        if (!isLiveButton(button, context, visiblePage)) return;
        console.error(`${logPrefix} Toggle failed:`, err);
        JC.toast?.(JC.t!('spoiler_blur_error_toast'));
    }).finally(() => {
        if (isLiveButton(button, context, visiblePage)) button.disabled = false;
    });
}

export function resetSpoilerDetailControls(): void {
    cancelFullReload();
    document.querySelectorAll('.jc-spoiler-blur-btn').forEach((node) => node.remove());
}
