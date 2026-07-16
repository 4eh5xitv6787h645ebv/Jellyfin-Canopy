// src/enhanced/features/details-page.ts
//
// Details-page dispatcher: the debounced item-details observer, the Hide
// button on detail pages, and the per-item-type feature gating.
// (Converted from js/enhanced/features-details-page.js — bodies semantically
// identical; the eager JC.internals.features destructure is now real imports.)

import { JC } from '../../globals';
import { getVisibleDetailsPage, isDetailsPageVisible } from '../../core/details-view';
import { onBodyMutation } from '../../core/dom-observer';
import { onNavigate, onViewPage } from '../../core/navigation';
import { getItemCached } from '../helpers';
import {
    displayWatchProgress,
    displayItemSize,
    displayAudioLanguages,
    resetDetailsMediaInfo,
} from './details-media-info';
import { displayReleaseDate, resetReleaseDates } from './release-dates';
import type { IdentityContext } from '../../types/jc';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Handle item details page display with debounced observer
 */
// Cache the last item id and type to avoid repeated ApiClient calls
let lastDetailsItemId: string | null = null;
let lastDetailsItemType: string | null = null;
let itemTypeFetchInProgress: Promise<unknown> | null = null;
// PERF(R9): fail open — a transient failure of the item-type fetch used to
// leave the page bare for the whole view (nothing re-runs the dispatcher on a
// quiet page except navigation). Retry with backoff while the user is still on
// the same item. The cap bounds the TIMER-driven retries; mutation-driven
// dispatcher runs may still probe while the page keeps mutating (debounced,
// pre-existing behavior) — both stop once the type resolves or the item changes.
let itemTypeFetchAttempts = 0;
const itemTypeRetryTimers = new Set<number>();
const ITEM_TYPE_FETCH_MAX_ATTEMPTS = 4;
let detailsDispatchTimer: number | null = null;
let detailsDispatchGeneration = 0;

// Types that support file size and watch progress
const FEATURES_SUPPORTED_TYPES = ['Episode', 'Season', 'Series', 'Movie', 'BoxSet', 'Playlist'];
// Types that support audio languages (excludes BoxSet and Playlist)
const AUDIO_LANGUAGES_SUPPORTED_TYPES = ['Episode', 'Season', 'Series', 'Movie'];

// Types that support hiding
const HIDE_SUPPORTED_TYPES = ['Movie', 'Series', 'Episode', 'Season'];

/**
 * Adds a "Hide" button to the item detail page action buttons area.
 * Supports Movies, Series, Episodes, and Seasons.
 * For Episodes: shows a choice dialog between hiding the episode or the entire show.
 * @param itemId The item's Jellyfin ID.
 * @param visiblePage The visible detail page element.
 */
function addHideContentButton(context: IdentityContext, itemId: string, visiblePage: Element): void {
    if (!JC.identity.isCurrent(context)) return;
    // JC.hiddenContent is another family's frozen surface (hidden-content-init),
    // read late-bound at every call site exactly like the legacy file did.
    if (!(JC as any).hiddenContent) return;
    const settings = (JC as any).hiddenContent.getSettings();
    if (!settings.enabled || !settings.showHideButtons) return;
    const itemType = lastDetailsItemType;
    const isPerson = itemType === 'Person';
    if (isPerson) {
        if (!settings.showButtonCast) return;
    } else {
        if (settings.showButtonDetails === false) return;
        if (!HIDE_SUPPORTED_TYPES.includes(itemType as string)) return;
    }

    // Don't add duplicate
    if (visiblePage.querySelector('.jc-detail-hide-btn')) return;

    const selectors = [
        '.detailButtons',
        '.itemActionsBottom',
        '.mainDetailButtons',
        '.detailButtonsContainer'
    ];
    let buttonContainer: Element | null = null;
    for (const sel of selectors) {
        const found = visiblePage.querySelector(sel);
        if (found) {
            buttonContainer = found;
            break;
        }
    }
    if (!buttonContainer) return;

    const button = document.createElement('button');
    button.setAttribute('is', 'emby-button');
    button.className = 'button-flat detailButton emby-button jc-detail-hide-btn';
    button.type = 'button';
    let mounted = false;

    const isTargetCurrent = (): boolean => {
        if (!JC.identity.isCurrent(context)) return false;
        const current = getVisibleDetailsPage();
        if (!current || current.page !== visiblePage || current.itemId !== itemId) return false;
        return !mounted || button.isConnected;
    };

    const hideLabel = JC.t!('hidden_content_hide_button') !== 'hidden_content_hide_button'
        ? JC.t!('hidden_content_hide_button')
        : 'Hide';
    const hiddenLabel = JC.t!('hidden_content_already_hidden') !== 'hidden_content_already_hidden'
        ? JC.t!('hidden_content_already_hidden')
        : 'Hidden';
    const unhideLabel = JC.t!('hidden_content_unhide') !== 'hidden_content_unhide'
        ? JC.t!('hidden_content_unhide')
        : 'Unhide';

    const content = document.createElement('div');
    content.className = 'detailButton-content';
    button.appendChild(content);

    function renderContent(text: string, iconName?: string): void {
        content.replaceChildren();
        const icon = document.createElement('span');
        icon.className = 'material-icons detailButton-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = iconName || 'visibility';
        content.appendChild(icon);
        if (text) {
            const textSpan = document.createElement('span');
            textSpan.className = 'detailButton-icon-text';
            textSpan.textContent = text;
            content.appendChild(textSpan);
        }
    }

    function setHiddenState(): void {
        if (!isTargetCurrent()) return;
        button.classList.add('jc-already-hidden');
        button.setAttribute('aria-label', hiddenLabel);
        button.title = hiddenLabel;
        renderContent('', 'visibility_off');

        button.onmouseenter = () => {
            if (!isTargetCurrent()) return;
            button.title = unhideLabel;
        };
        button.onmouseleave = () => {
            if (!isTargetCurrent()) return;
            button.title = hiddenLabel;
        };
        button.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isTargetCurrent()) return;
            (JC as any).hiddenContent.unhideItem(itemId);
            setHideState();
        };
    }

    function setHideState(): void {
        if (!isTargetCurrent()) return;
        button.classList.remove('jc-already-hidden');
        button.setAttribute('aria-label', hideLabel);
        button.title = hideLabel;
        renderContent('', 'visibility');
        button.onmouseenter = null;
        button.onmouseleave = null;
        button.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isTargetCurrent()) return;

            void (async () => {
                // Get item name from the page title
                const nameEl = visiblePage.querySelector('.itemName, h1, h2, [class*="itemName"]');
                const itemName = nameEl?.textContent?.trim() || 'Unknown';

                // Fetch full item data for TMDb ID and episode/series metadata
                let tmdbId = '';
                let seriesId = '';
                let seriesName = '';
                let seasonNumber: number | null = null;
                let episodeNumber: number | null = null;
                try {
                    const item: any = await getItemCached(itemId, { userId: context.userId });
                    if (!isTargetCurrent()) return;
                    tmdbId = item?.ProviderIds?.Tmdb || '';
                    seriesId = item?.SeriesId || '';
                    seriesName = item?.SeriesName || '';
                    seasonNumber = item?.ParentIndexNumber != null ? item.ParentIndexNumber : null;
                    episodeNumber = item?.IndexNumber != null ? item.IndexNumber : null;
                } catch (err) {
                    if (!isTargetCurrent()) return;
                    console.warn('🪼 Jellyfin Canopy: Could not fetch item metadata for hide button', err);
                }

                if (!isTargetCurrent()) return;

                const isEpisode = itemType === 'Episode';
                const isSeason = itemType === 'Season';

                // Build base item data
                const baseItemData = {
                    itemId,
                    name: itemName,
                    type: itemType,
                    tmdbId,
                    seriesId,
                    seriesName,
                    seasonNumber,
                    episodeNumber
                };

                if (isEpisode && seriesId) {
                    // Episode on a detail page: show choice dialog
                    (JC as any).hiddenContent.confirmAndHide(baseItemData, () => {
                        if (isTargetCurrent()) setHiddenState();
                    }, {
                        showEpisodeChoice: true,
                        onChooseShow: async () => {
                            if (!isTargetCurrent()) return;
                            // User chose to hide the entire show
                            let seriesTmdbId = '';
                            try {
                                const series: any = await ApiClient.getItem(context.userId, seriesId);
                                if (!isTargetCurrent()) return;
                                seriesTmdbId = series?.ProviderIds?.Tmdb || '';
                            } catch (err) {
                                if (!isTargetCurrent()) return;
                                console.warn('🪼 Jellyfin Canopy: Could not fetch series metadata for hide-show action', err);
                            }
                            if (!isTargetCurrent()) return;
                            (JC as any).hiddenContent.hideItem({
                                itemId: seriesId,
                                name: seriesName || itemName,
                                type: 'Series',
                                tmdbId: seriesTmdbId,
                                posterPath: ''
                            });
                            setHiddenState();
                        }
                    });
                } else if (isSeason && seriesId) {
                    // Season: hide with series metadata
                    (JC as any).hiddenContent.confirmAndHide(baseItemData, () => {
                        if (isTargetCurrent()) setHiddenState();
                    });
                } else {
                    // Movie or Series: standard hide
                    (JC as any).hiddenContent.confirmAndHide(baseItemData, () => {
                        if (isTargetCurrent()) setHiddenState();
                    });
                }
            })();
        };
    }

    if ((JC as any).hiddenContent.isHidden(itemId)) {
        setHiddenState();
    } else {
        setHideState();
    }

    // Keep Jellyfin's overflow menu (three-dots) as the last action button.
    const moreButton = buttonContainer.querySelector('.btnMoreCommands');
    if (moreButton) {
        buttonContainer.insertBefore(button, moreButton);
    } else {
        buttonContainer.appendChild(button);
    }
    mounted = true;
}

function runHandleItemDetails(context: IdentityContext): void {
    if (!JC.identity.isCurrent(context)) return;
    // Resolve the visible details view ONLY when it belongs to the current
    // URL's item. During a details→details push the outgoing page is still
    // the visible one when navigation callbacks fire — injecting there put
    // the NEW item's chips into a view about to be hidden (and left the new
    // page bare). getVisibleDetailsPage returns null for that window; the
    // viewshow probe / body-mutation probes re-run this once the right page
    // is up.
    const resolved = getVisibleDetailsPage();
    if (!resolved) return;
    const { page: visiblePage, itemId } = resolved;

    const container = visiblePage.querySelector<HTMLElement>('.itemMiscInfo.itemMiscInfo-primary');
    if (!container) return;

    try {

        // Reset cache when navigating to a new item
        if (lastDetailsItemId !== itemId) {
            lastDetailsItemId = itemId;
            lastDetailsItemType = null;
            itemTypeFetchInProgress = null;
            itemTypeFetchAttempts = 0;
            for (const timer of itemTypeRetryTimers) clearTimeout(timer);
            itemTypeRetryTimers.clear();
        }

        // Fetch item type once per item to decide applicability
        if (!lastDetailsItemType) {
            if (!itemTypeFetchInProgress) {
                const fetchItemId = itemId;
                const fetchPage = visiblePage;
                const request = getItemCached(itemId, { userId: context.userId })
                    .then((item: any) => {
                        if (itemTypeFetchInProgress !== request || !JC.identity.isCurrent(context)) return;
                        itemTypeFetchInProgress = null;
                        const current = getVisibleDetailsPage();
                        if (!current || current.page !== fetchPage || current.itemId !== fetchItemId) {
                            scheduleHandleItemDetails(context);
                            return;
                        }
                        // The user navigated to a DIFFERENT item while this was in
                        // flight — discard the stale type (it belongs to the old
                        // item) and re-dispatch so the current item starts its own
                        // fetch instead of rendering with the wrong feature gates.
                        if (lastDetailsItemId !== fetchItemId) {
                            scheduleHandleItemDetails(context);
                            return;
                        }
                        lastDetailsItemType = item?.Type || null;
                        itemTypeFetchAttempts = 0;
                        // Re-run once type is known to render features
                        scheduleHandleItemDetails(context);
                    })
                    .catch(() => {
                        if (itemTypeFetchInProgress !== request || !JC.identity.isCurrent(context)) return;
                        itemTypeFetchInProgress = null;
                        const current = getVisibleDetailsPage();
                        if (!current || current.page !== fetchPage || current.itemId !== fetchItemId) {
                            scheduleHandleItemDetails(context);
                            return;
                        }
                        if (lastDetailsItemId !== fetchItemId) {
                            // Different item now — let it start its own fetch.
                            scheduleHandleItemDetails(context);
                            return;
                        }
                        // PERF(R9): fail open — getItemCached drops failed entries,
                        // so a bounded backoff retry refetches for real. Guarded to
                        // the same item; abandoned on navigation. Runs even in a
                        // hidden tab (one cheap bounded fetch) so backgrounding
                        // during the retry window doesn't turn late into never.
                        itemTypeFetchAttempts++;
                        if (itemTypeFetchAttempts < ITEM_TYPE_FETCH_MAX_ATTEMPTS) {
                            const delay = 1000 * Math.pow(2, itemTypeFetchAttempts - 1);
                            const timer = window.setTimeout(() => {
                                itemTypeRetryTimers.delete(timer);
                                if (JC.identity.isCurrent(context) && lastDetailsItemId === fetchItemId) {
                                    scheduleHandleItemDetails(context);
                                }
                            }, delay);
                            itemTypeRetryTimers.add(timer);
                        }
                    });
                itemTypeFetchInProgress = request;
            }
            return;
        }

        // Add hide content button on detail pages (including Person pages)
        if ((JC as any).hiddenContent) {
            addHideContentButton(context, itemId, visiblePage);
        }

        // Spoiler Guard toggle on Series (blurs all unwatched episode images via
        // the server filter), Movie (blurs its own poster/backdrop until Played),
        // and Collection/BoxSet (protects every movie inside) detail pages.
        // Rides this existing dispatcher — no new observer (R3).
        if ((lastDetailsItemType === 'Series' || lastDetailsItemType === 'Movie' || lastDetailsItemType === 'BoxSet')
            && JC.spoilerGuard?.addSpoilerBlurButton) {
            JC.spoilerGuard.addSpoilerBlurButton(itemId, visiblePage, lastDetailsItemType);
        }

        // Skip unsupported item types for media features
        if (!FEATURES_SUPPORTED_TYPES.includes(lastDetailsItemType)) {
            return;
        }

        if (JC?.currentSettings?.showWatchProgress) {
            void displayWatchProgress(itemId, container);
        }
        if (JC?.currentSettings?.showFileSizes) {
            void displayItemSize(itemId, container);
        }
        if (JC?.currentSettings?.showAudioLanguages && AUDIO_LANGUAGES_SUPPORTED_TYPES.includes(lastDetailsItemType)) {
            void displayAudioLanguages(itemId, container);
        }
        if (JC.pluginConfig?.ShowReleaseDates && JC.pluginConfig?.TmdbEnabled && AUDIO_LANGUAGES_SUPPORTED_TYPES.includes(lastDetailsItemType)) {
            void displayReleaseDate(itemId, container);
        }
    } catch (e) {
    console.warn('🪼 Jellyfin Canopy: Error in item details handler', e);
}
}

function scheduleHandleItemDetails(context = JC.identity.capture()): void {
    if (!context || !JC.identity.isCurrent(context)) return;
    const generation = ++detailsDispatchGeneration;
    if (detailsDispatchTimer !== null) clearTimeout(detailsDispatchTimer);
    detailsDispatchTimer = window.setTimeout(() => {
        detailsDispatchTimer = null;
        if (generation !== detailsDispatchGeneration || !JC.identity.isCurrent(context)) return;
        runHandleItemDetails(context);
    }, 100);
}

// PERF(R3): this used to be a dedicated body-wide MutationObserver with
// attributes:['class','style'], firing on every hover/focus/style write on
// EVERY page. Structural changes now arrive via the shared multiplexed body
// observer behind a cheap details-page gate, and the cached-page re-show
// (a class flip with no structural mutation — the only thing the attribute
// filter actually caught) is covered by the navigation/viewshow probes below.
// handleItemDetails is debounced and re-validates page visibility itself.
// The gate MUST scope to the visible view: up to three cached
// `#itemDetailPage` elements coexist (v12-platform.md §3), and
// getElementById returned whichever sat in the lowest slot — usually an old
// HIDDEN one — so this gate went permanently dead after two details visits
// and the wipe-recovery re-inject pass (host renderMiscInfo innerHTML-wipes
// the chips when item data arrives) never ran.
export function resetDetailsPage(): void {
    detailsDispatchGeneration++;
    if (detailsDispatchTimer !== null) {
        clearTimeout(detailsDispatchTimer);
        detailsDispatchTimer = null;
    }
    lastDetailsItemId = null;
    lastDetailsItemType = null;
    itemTypeFetchInProgress = null;
    itemTypeFetchAttempts = 0;
    for (const timer of itemTypeRetryTimers) clearTimeout(timer);
    itemTypeRetryTimers.clear();
    document.querySelectorAll('.jc-detail-hide-btn').forEach((node) => node.remove());
    resetDetailsMediaInfo();
    resetReleaseDates();
}

/** Install detail-page observation for one lazy-feature activation. */
export function installDetailsPage(): () => void {
    const body = onBodyMutation('item-details-info', () => {
        if (!isDetailsPageVisible()) return;
        scheduleHandleItemDetails();
    });
    const offNavigate = onNavigate(() => { scheduleHandleItemDetails(); });
    const offView = onViewPage(() => { scheduleHandleItemDetails(); });
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        body.unsubscribe();
        offNavigate();
        offView();
        resetDetailsPage();
    };
}

export function initializeDetailsPage(context = JC.identity.capture()): void {
    if (context) scheduleHandleItemDetails(context);
}
