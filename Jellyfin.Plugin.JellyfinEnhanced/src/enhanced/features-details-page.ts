// src/enhanced/features-details-page.ts
//
// Details-page dispatcher: the debounced item-details observer, the Hide
// button on detail pages, and the per-item-type feature gating.
// (Converted from js/enhanced/features-details-page.js — bodies semantically
// identical; the eager JE.internals.features destructure is now real imports.)

import { JE } from '../globals';
import { onBodyMutation } from '../core/dom-observer';
import { onNavigate, onViewPage } from '../core/navigation';
import { debounce, getItemCached } from './helpers';
import { displayWatchProgress, displayItemSize, displayAudioLanguages } from './features-details-media-info';
import { displayReleaseDate } from './features-release-dates';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Handle item details page display with debounced observer
 */
// Cache the last item id and type to avoid repeated ApiClient calls
let lastDetailsItemId: string | null = null;
let lastDetailsItemType: string | null = null;
let itemTypeFetchInProgress: Promise<unknown> | null = null;

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
function addHideContentButton(itemId: string, visiblePage: Element): void {
    // JE.hiddenContent is another family's frozen surface (hidden-content-init),
    // read late-bound at every call site exactly like the legacy file did.
    if (!(JE as any).hiddenContent) return;
    const settings = (JE as any).hiddenContent.getSettings();
    if (!settings.enabled || !settings.showHideButtons) return;
    const isPerson = lastDetailsItemType === 'Person';
    if (isPerson) {
        if (!settings.showButtonCast) return;
    } else {
        if (settings.showButtonDetails === false) return;
        if (!HIDE_SUPPORTED_TYPES.includes(lastDetailsItemType as string)) return;
    }

    // Don't add duplicate
    if (visiblePage.querySelector('.je-detail-hide-btn')) return;

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
    button.className = 'button-flat detailButton emby-button je-detail-hide-btn';
    button.type = 'button';

    const hideLabel = JE.t!('hidden_content_hide_button') !== 'hidden_content_hide_button'
        ? JE.t!('hidden_content_hide_button')
        : 'Hide';
    const hiddenLabel = JE.t!('hidden_content_already_hidden') !== 'hidden_content_already_hidden'
        ? JE.t!('hidden_content_already_hidden')
        : 'Hidden';
    const unhideLabel = JE.t!('hidden_content_unhide') !== 'hidden_content_unhide'
        ? JE.t!('hidden_content_unhide')
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
        button.classList.add('je-already-hidden');
        button.setAttribute('aria-label', hiddenLabel);
        button.title = hiddenLabel;
        renderContent('', 'visibility_off');

        button.onmouseenter = () => {
            button.title = unhideLabel;
        };
        button.onmouseleave = () => {
            button.title = hiddenLabel;
        };
        button.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            (JE as any).hiddenContent.unhideItem(itemId);
            setHideState();
        };
    }

    function setHideState(): void {
        button.classList.remove('je-already-hidden');
        button.setAttribute('aria-label', hideLabel);
        button.title = hideLabel;
        renderContent('', 'visibility');
        button.onmouseenter = null;
        button.onmouseleave = null;
        button.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();

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
                    const userId = ApiClient.getCurrentUserId();
                    const item: any = await getItemCached(itemId, { userId });
                    tmdbId = item?.ProviderIds?.Tmdb || '';
                    seriesId = item?.SeriesId || '';
                    seriesName = item?.SeriesName || '';
                    seasonNumber = item?.ParentIndexNumber != null ? item.ParentIndexNumber : null;
                    episodeNumber = item?.IndexNumber != null ? item.IndexNumber : null;
                } catch (err) {
                    console.warn('🪼 Jellyfin Enhanced: Could not fetch item metadata for hide button', err);
                }

                const isEpisode = lastDetailsItemType === 'Episode';
                const isSeason = lastDetailsItemType === 'Season';

                // Build base item data
                const baseItemData = {
                    itemId,
                    name: itemName,
                    type: lastDetailsItemType,
                    tmdbId,
                    seriesId,
                    seriesName,
                    seasonNumber,
                    episodeNumber
                };

                if (isEpisode && seriesId) {
                    // Episode on a detail page: show choice dialog
                    (JE as any).hiddenContent.confirmAndHide(baseItemData, () => {
                        setHiddenState();
                    }, {
                        showEpisodeChoice: true,
                        onChooseShow: async () => {
                            // User chose to hide the entire show
                            let seriesTmdbId = '';
                            try {
                                const userId = ApiClient.getCurrentUserId();
                                const series: any = await ApiClient.getItem(userId, seriesId);
                                seriesTmdbId = series?.ProviderIds?.Tmdb || '';
                            } catch (err) {
                                console.warn('🪼 Jellyfin Enhanced: Could not fetch series metadata for hide-show action', err);
                            }
                            (JE as any).hiddenContent.hideItem({
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
                    (JE as any).hiddenContent.confirmAndHide(baseItemData, () => {
                        setHiddenState();
                    });
                } else {
                    // Movie or Series: standard hide
                    (JE as any).hiddenContent.confirmAndHide(baseItemData, () => {
                        setHiddenState();
                    });
                }
            })();
        };
    }

    if ((JE as any).hiddenContent.isHidden(itemId)) {
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
}

const handleItemDetails = debounce(() => {
    const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
    if (!visiblePage) return;

    const container = visiblePage.querySelector<HTMLElement>('.itemMiscInfo.itemMiscInfo-primary');
    if (!container) return;

    try {
        const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
        if (!itemId) return;

        // Reset cache when navigating to a new item
        if (lastDetailsItemId !== itemId) {
            lastDetailsItemId = itemId;
            lastDetailsItemType = null;
        }

        // Fetch item type once per item to decide applicability
        if (!lastDetailsItemType) {
            if (!itemTypeFetchInProgress) {
                const userId = ApiClient.getCurrentUserId();
                itemTypeFetchInProgress = getItemCached(itemId, { userId })
                    .then((item: any) => {
                        lastDetailsItemType = item?.Type || null;
                        itemTypeFetchInProgress = null;
                        // Re-run once type is known to render features
                        handleItemDetails();
                    })
                    .catch(() => { itemTypeFetchInProgress = null; });
            }
            return;
        }

        // Add hide content button on detail pages (including Person pages)
        if ((JE as any).hiddenContent) {
            addHideContentButton(itemId, visiblePage);
        }

        // Skip unsupported item types for media features
        if (!FEATURES_SUPPORTED_TYPES.includes(lastDetailsItemType)) {
            return;
        }

        if (JE?.currentSettings?.showWatchProgress) {
            void displayWatchProgress(itemId, container);
        }
        if (JE?.currentSettings?.showFileSizes) {
            void displayItemSize(itemId, container);
        }
        if (JE?.currentSettings?.showAudioLanguages && AUDIO_LANGUAGES_SUPPORTED_TYPES.includes(lastDetailsItemType)) {
            void displayAudioLanguages(itemId, container);
        }
        if (JE.pluginConfig?.ShowReleaseDates && JE.pluginConfig?.TmdbEnabled && AUDIO_LANGUAGES_SUPPORTED_TYPES.includes(lastDetailsItemType)) {
            void displayReleaseDate(itemId, container);
        }
    } catch (e) {
    console.warn('🪼 Jellyfin Enhanced: Error in item details handler', e);
}
}, 100);

// PERF: this used to be a dedicated body-wide MutationObserver with
// attributes:['class','style'], firing on every hover/focus/style write on
// EVERY page. Structural changes now arrive via the shared multiplexed body
// observer behind a cheap O(1) details-page gate, and the cached-page re-show
// (a class flip with no structural mutation — the only thing the attribute
// filter actually caught) is covered by the navigation/viewshow probes below.
// handleItemDetails is debounced and re-validates page visibility itself.
onBodyMutation('item-details-info', () => {
    const page = document.getElementById('itemDetailPage');
    if (!page || page.classList.contains('hide')) return;
    handleItemDetails();
});
onNavigate(() => { handleItemDetails(); });
onViewPage(() => { handleItemDetails(); });
