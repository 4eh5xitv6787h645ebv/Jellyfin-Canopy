// src/enhanced/hidden-content/buttons.ts
//
// Hidden Content — hide/unhide toggle buttons injected on native
// library cards, including the scoped (Next Up / Continue Watching) flow.
// (Converted from js/enhanced/hidden-content-buttons.js — bodies semantically identical.)

import { JE } from '../../globals';
import { getItemCached } from '../helpers';
import { hiddenIdSet, getSettings, hideItem, unhideItem } from './data';
import type { HideItemParams } from './data';
import { getCardSurface, getCardItemId } from './filter';
import { confirmAndHide } from './dialogs';

// ============================================================
// Library hide buttons
// ============================================================

/**
 * Creates and attaches a hide/unhide toggle button to a single library card.
 * Captures per-card references in a closure for state management.
 * @param cardBox The `.cardBox` element to attach the button to.
 * @param card The parent `.card` element.
 * @param itemId The Jellyfin item ID.
 */
function createLibraryHideButton(cardBox: HTMLElement, card: HTMLElement, itemId: string, isPerson: boolean): void {
    cardBox.style.position = 'relative';
    const btn = document.createElement('button');

    const hideLabel = JE.t!('hidden_content_hide_button') !== 'hidden_content_hide_button' ? JE.t!('hidden_content_hide_button') : 'Hide';
    const hiddenLabel = JE.t!('hidden_content_already_hidden') !== 'hidden_content_already_hidden' ? JE.t!('hidden_content_already_hidden') : 'Hidden';
    const unhideLabel = JE.t!('hidden_content_unhide') !== 'hidden_content_unhide' ? JE.t!('hidden_content_unhide') : 'Unhide';

    /**
     * Renders a material icon inside the button.
     * @param iconName Material icon name.
     */
    function renderIcon(iconName: string): void {
        btn.replaceChildren();
        const icon = document.createElement('span');
        icon.className = 'material-icons';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = iconName || 'visibility';
        btn.appendChild(icon);
    }

    /** Configures the button for "already hidden" state — click to unhide. */
    function setHiddenState(): void {
        btn.className = 'je-hide-btn je-already-hidden';
        btn.title = hiddenLabel;
        renderIcon('visibility_off');
        btn.onmouseenter = () => { btn.title = unhideLabel; };
        btn.onmouseleave = () => { btn.title = hiddenLabel; };
        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            unhideItem(itemId);
            setHideState();
        };
    }

    /** Configures the button for "visible" state — click to hide. */
    function setHideState(): void {
        btn.className = 'je-hide-btn';
        btn.title = hideLabel;
        renderIcon('visibility');
        btn.onmouseenter = null;
        btn.onmouseleave = null;
        btn.onclick = (e) => {
            void (async () => {
                e.preventDefault();
                e.stopPropagation();

                const cardName = card.querySelector('.cardText')?.textContent || '';
                const surface = getCardSurface(card);

                if (surface === 'nextup' || surface === 'continuewatching') {
                    await handleScopedCardHide(card, itemId, cardName, surface, setHiddenState);
                } else {
                    const itemData: HideItemParams = { itemId, name: cardName };
                    if (isPerson) itemData.type = 'Person';
                    confirmAndHide(itemData, () => {
                        card.classList.add('je-hidden');
                    });
                }
            })();
        };
    }

    if (hiddenIdSet.has(itemId)) {
        setHiddenState();
    } else {
        setHideState();
    }
    cardBox.appendChild(btn);
}

/**
 * Handles the hide flow for a card in a scoped surface (Next Up / Continue Watching).
 * Fetches item metadata to determine if episode-choice should be offered.
 * @param card The card element to hide.
 * @param itemId The Jellyfin item ID.
 * @param cardName Display name from the card text.
 * @param surface The detected surface ('nextup' or 'continuewatching').
 * @param setHiddenState Callback to switch the button to "hidden" state.
 */
async function handleScopedCardHide(card: HTMLElement, itemId: string, cardName: string, surface: string, setHiddenState: () => void): Promise<void> {
    const itemData: HideItemParams = { itemId, name: cardName };
    // Pass surface through so the hideScope stays bound to the row the user clicked.
    const dialogOpts: {
        surface: string;
        showEpisodeChoice?: boolean;
        onChooseScoped?: () => void;
        onChooseShow?: () => void;
    } = { surface };

    try {
        const userId = ApiClient.getCurrentUserId();
        const item: any = await getItemCached(itemId, { userId });
        const itemType = item?.Type || '';
        const seriesId = item?.SeriesId || '';
        const seriesName = item?.SeriesName || '';

        itemData.type = itemType;
        itemData.name = item?.Name || cardName;
        itemData.seriesId = seriesId;
        itemData.seriesName = seriesName;
        itemData.seasonNumber = item?.ParentIndexNumber != null ? item.ParentIndexNumber : null;
        itemData.episodeNumber = item?.IndexNumber != null ? item.IndexNumber : null;
        itemData.tmdbId = item?.ProviderIds?.Tmdb || '';

        if ((itemType === 'Episode' || itemType === 'Season') && seriesId) {
            dialogOpts.showEpisodeChoice = true;
            dialogOpts.onChooseScoped = () => {
                hideItem({ ...itemData, hideScope: surface });
                card.classList.add('je-hidden');
            };
            dialogOpts.onChooseShow = () => {
                void (async () => {
                    let seriesTmdbId = '';
                    try {
                        const series: any = await getItemCached(seriesId, { userId });
                        seriesTmdbId = series?.ProviderIds?.Tmdb || '';
                    } catch (err) {
                        console.warn('🪼 Jellyfin Enhanced: Failed to fetch series TMDB ID', err);
                    }
                    hideItem({
                        itemId: seriesId,
                        name: seriesName || cardName,
                        type: 'Series',
                        tmdbId: seriesTmdbId
                    });
                    card.classList.add('je-hidden');
                })();
            };
        } else {
            dialogOpts.onChooseScoped = () => {
                hideItem({ ...itemData, hideScope: surface });
                card.classList.add('je-hidden');
            };
        }
    } catch (err) {
        console.warn('🪼 Jellyfin Enhanced: Failed to fetch item data for scoped hide', err);
        dialogOpts.onChooseScoped = () => {
            hideItem({ itemId, name: cardName, hideScope: surface });
            card.classList.add('je-hidden');
        };
    }

    confirmAndHide(itemData, () => {
        card.classList.add('je-hidden');
    }, dialogOpts);
}

/**
 * Adds hide/unhide toggle buttons to native Jellyfin library cards.
 * Only runs when the `showButtonLibrary` setting is enabled.
 * Skips cards that already have a `.je-hide-btn` to avoid duplicates.
 */
export function addLibraryHideButtons(): void {
    const s = getSettings();
    if (!s.enabled || !s.showHideButtons) return;
    // At least one of library or cast buttons must be enabled
    if (!s.showButtonLibrary && !s.showButtonCast) return;

    const skipCollections = !s.experimentalHideCollections;

    const cards = document.querySelectorAll<HTMLElement>('.card[data-id] .cardBox, .card[data-itemid] .cardBox');
    for (let i = 0; i < cards.length; i++) {
        const cardBox = cards[i];
        if (cardBox.querySelector('.je-hide-btn')) continue;

        const card = cardBox.closest<HTMLElement>('.card');
        if (!card) continue;

        // Skip image editor cards and cards inside dialogs/admin pages
        if (card.hasAttribute('data-imagetype') || card.closest('.formDialog, .editPageInnerContent')) continue;

        // Skip chapter/scene cards on detail pages
        if (card.closest('#itemDetailPage') && card.querySelector('.chapterCardImageContainer')) continue;

        const itemId = getCardItemId(card);
        if (!itemId) continue;

        const cardType = (card.dataset.type || '').toLowerCase();
        const isPerson = cardType === 'person' || card.classList.contains('personCard');

        // Skip Person cards unless showButtonCast is enabled
        if (isPerson && !s.showButtonCast) continue;
        // Skip non-Person cards unless showButtonLibrary is enabled
        if (!isPerson && !s.showButtonLibrary) continue;

        if (skipCollections && !isPerson) {
            if (cardType === 'collectionfolder' || cardType === 'userview' || cardType === 'boxset' || cardType === 'playlist' || cardType === 'channel') continue;
            const section = card.closest('.section, .verticalSection, .homeSection');
            if (section) {
                const sTitle = (section.querySelector('.sectionTitle, h2, .headerText, .sectionTitle-sectionTitle')?.textContent || '').toLowerCase();
                if (sTitle.includes('my media') || sTitle.includes('collections')) continue;
            }
        }

        createLibraryHideButton(cardBox, card, itemId, isPerson);
    }
}

/**
 * Removes all hide buttons from native Jellyfin library cards.
 * Called when the `showButtonLibrary` setting is toggled off.
 */
export function removeLibraryHideButtons(): void {
    const btns = document.querySelectorAll('.card[data-id] .je-hide-btn, .card[data-itemid] .je-hide-btn');
    for (let i = 0; i < btns.length; i++) {
        btns[i].remove();
    }
}
