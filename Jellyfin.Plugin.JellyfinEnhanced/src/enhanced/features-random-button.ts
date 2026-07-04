// src/enhanced/features-random-button.ts
//
// Random-item header button: fetches a random movie/series and navigates to it.
// (Converted from js/enhanced/features-random-button.js — bodies semantically identical.)

import { JE } from '../globals';
import { toast } from '../core/ui-kit';
import { getHeaderRightContainer } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Fetches a random item (Movie or Series) from the user's library.
 * @returns A promise that resolves to a random item or null.
 */
async function getRandomItem(): Promise<any> {
    const userId = ApiClient.getCurrentUserId();
    if (!userId) {
        console.error("🪼 Jellyfin Enhanced: User not logged in.");
        return null;
    }

    const itemTypes: string[] = [];
    if (JE.currentSettings!.randomIncludeMovies) itemTypes.push('Movie');
    if (JE.currentSettings!.randomIncludeShows) itemTypes.push('Series');
    const includeItemTypes = itemTypes.join(',');

    const apiUrl = ApiClient.getUrl(`/Users/${userId}/Items?IncludeItemTypes=${includeItemTypes}&Recursive=true&SortBy=Random&Limit=100&Fields=ExternalUrls`);

    try {
        const response: any = await ApiClient.ajax({ type: 'GET', url: apiUrl, dataType: 'json' });
        if (response && response.Items && response.Items.length > 0) {
            let items: any[] = response.Items;

            if (JE.currentSettings!.randomUnwatchedOnly) {
                items = items.filter(item => {
                    // For movies: check if not played
                    if (item.Type === 'Movie') {
                        return !item.UserData?.Played;
                    }
                    // For series: check if there are unplayed episodes
                    if (item.Type === 'Series') {
                        return item.UserData?.UnplayedItemCount > 0;
                    }
                    return false;
                });
                // If no unwatched items found, show error
                if (items.length === 0) {
                    throw new Error('No unwatched items found in selected libraries.');
                }
            }

            const randomIndex = Math.floor(Math.random() * items.length);
            return items[randomIndex];
        }
        throw new Error('No items found in selected libraries.');
    } catch (error) {
        console.error('🪼 Jellyfin Enhanced: Error fetching random item:', error);
        toast(`${JE.icon!(JE.IconName!.ERROR)} ${(error as any)?.message || 'Unknown error'}`, 2000);
        return null;
    }
}

/**
 * Navigates the browser to the details page of the given item.
 * @param item The item to navigate to.
 */
function navigateToItem(item: any): void {
    if (item && item.Id) {
        const embyPage = window.Emby?.Page as { show?: (path: string) => void } | undefined;
        if (window.Emby && embyPage && typeof embyPage.show === 'function') {
            const serverId = (ApiClient as any).serverId();
            embyPage.show(`/details?id=${item.Id}${serverId ? `&serverId=${serverId}` : ''}`);
        } else if (window.Dashboard && typeof window.Dashboard.navigate === 'function') {
            window.Dashboard.navigate(`details.html?id=${item.Id}`);
        } else {
            // Fallback to hash navigation for older versions
            const serverId = (ApiClient as any).serverId();
            const itemUrl = `#!/details?id=${item.Id}${serverId ? `&serverId=${serverId}` : ''}`;
            window.location.hash = itemUrl;
        }
        toast(JE.t!('toast_random_item_loaded'), 2000);
    } else {
        console.error('🪼 Jellyfin Enhanced: Invalid item object or ID:', item);
        toast(JE.t!('toast_generic_error'), 2000);
    }
}

/** Builds the random-item button element (markup unchanged; extracted for reuse). */
function buildRandomButton(): HTMLDivElement {
    const buttonContainer = document.createElement('div');
    buttonContainer.id = 'randomItemButtonContainer';

    const randomButton = document.createElement('button');
    randomButton.id = 'randomItemButton';
    randomButton.setAttribute('is', 'paper-icon-button-light');
    randomButton.className = 'headerButton headerButtonRight paper-icon-button-light';
    randomButton.title = JE.t!('random_button_tooltip');
    randomButton.innerHTML = `<i class="material-icons">casino</i>`;

    randomButton.addEventListener('click', () => {
        void (async () => {
            randomButton.disabled = true;
            randomButton.classList.add('loading');
            randomButton.innerHTML = '<i class="material-icons">hourglass_empty</i>';

            try {
                const item = await getRandomItem();
                if (item) {
                    navigateToItem(item);
                }
            } finally {
                setTimeout(() => {
                    if (document.getElementById(randomButton.id)) {
                        randomButton.disabled = false;
                        randomButton.classList.remove('loading');
                        randomButton.innerHTML = `<i class="material-icons">casino</i>`;
                    }
                }, 500);
            }
        })();
    });

    buttonContainer.appendChild(randomButton);
    return buttonContainer;
}

// Durable header-tray injector. `headerTray: true` (v12-platform.md §6.5) means
// the button re-attaches after the modern layout destroys the AppBar action
// tray on the `/video` round trip, and re-runs on every navigation.
let randomButtonHandle: { run(): void; remove(): void } | null = null;

/**
 * Creates and injects the "Random" button into the page header if enabled.
 * Re-injection across React re-renders and the player round trip is handled by
 * JE.core.dom.ensureInjected; disabling removes it.
 */
JE.addRandomButton = (): void => {
    if (!JE.currentSettings!.randomButtonEnabled) {
        randomButtonHandle?.remove();
        randomButtonHandle = null;
        document.getElementById('randomItemButtonContainer')?.remove();
        return;
    }

    if (randomButtonHandle) {
        randomButtonHandle.run();
        return;
    }

    randomButtonHandle = JE.core.dom!.ensureInjected(
        'je-random-button',
        () => getHeaderRightContainer(),
        (headerRight) => {
            const container = buildRandomButton();
            headerRight.prepend(container);
            return container;
        },
        { headerTray: true }
    );
};
