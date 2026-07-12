// src/enhanced/features/random-button.ts
//
// Random-item header button: fetches a random movie/series and navigates to it.
// (Converted from js/enhanced/features-random-button.js — bodies semantically identical.)

import { JC } from '../../globals';
import { toast } from '../../core/ui-kit';
import { getHeaderRightContainer } from '../helpers';
import { insertHeaderTrayButton, HeaderTrayOrder } from '../header-tray';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Fetches a random item (Movie or Series) from the user's library.
 * @returns A promise that resolves to a random item or null.
 */
async function getRandomItem(): Promise<any> {
    const userId = ApiClient.getCurrentUserId();
    if (!userId) {
        console.error("🪼 Jellyfin Canopy: User not logged in.");
        return null;
    }

    const itemTypes: string[] = [];
    if (JC.currentSettings!.randomIncludeMovies) itemTypes.push('Movie');
    if (JC.currentSettings!.randomIncludeShows) itemTypes.push('Series');
    const includeItemTypes = itemTypes.join(',');

    const apiUrl = ApiClient.getUrl(`/Users/${userId}/Items?IncludeItemTypes=${includeItemTypes}&Recursive=true&SortBy=Random&Limit=100&Fields=ExternalUrls`);

    try {
        const response: any = await ApiClient.ajax({ type: 'GET', url: apiUrl, dataType: 'json' });
        if (response && response.Items && response.Items.length > 0) {
            let items: any[] = response.Items;

            if (JC.currentSettings!.randomUnwatchedOnly) {
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
        console.error('🪼 Jellyfin Canopy: Error fetching random item:', error);
        toast(`${JC.icon!(JC.IconName!.ERROR)} ${JC.escapeHtml((error as any)?.message || 'Unknown error')}`, 2000);
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
        toast(JC.t!('toast_random_item_loaded'), 2000);
    } else {
        console.error('🪼 Jellyfin Canopy: Invalid item object or ID:', item);
        toast(JC.t!('toast_generic_error'), 2000);
    }
}

/** Set the button's Material Icons glyph (works for both `<i>` and MUI `<span>`). */
function setGlyph(btn: HTMLElement, ligature: string): void {
    const glyph = btn.querySelector('.material-icons');
    if (glyph) glyph.textContent = ligature;
}

/** Shared click handler: fetch a random item and navigate, with a spinner glyph. */
function onRandomClick(randomButton: HTMLButtonElement): void {
    void (async () => {
        randomButton.disabled = true;
        randomButton.classList.add('loading');
        setGlyph(randomButton, 'hourglass_empty');

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
                    setGlyph(randomButton, 'casino');
                }
            }, 500);
        }
    })();
}

/**
 * Builds the random-item button. On the modern layout (MUI toolbar tray) it is
 * built with JC.core.ui.muiIconButton so it wears the native AppBar action
 * button markup/theme tokens; on the legacy header it keeps the classic
 * paper-icon-button-light markup so it matches that layout's own buttons.
 * @param anchor - The resolved header container (see getHeaderRightContainer).
 */
function buildRandomButton(anchor: HTMLElement): HTMLDivElement {
    const buttonContainer = document.createElement('div');
    buttonContainer.id = 'randomItemButtonContainer';

    const onModern = anchor.closest('.MuiToolbar-root') !== null;
    let randomButton: HTMLButtonElement;

    if (onModern) {
        // Native MUI AppBar action button; legacy classes kept so the shared
        // header-button sizing fix and group styling still apply.
        randomButton = JC.core.ui!.muiIconButton({
            id: 'randomItemButton',
            icon: 'casino',
            title: JC.t!('random_button_tooltip'),
            className: 'headerButton headerButtonRight paper-icon-button-light'
        });
    } else {
        randomButton = document.createElement('button');
        randomButton.id = 'randomItemButton';
        randomButton.setAttribute('is', 'paper-icon-button-light');
        randomButton.className = 'headerButton headerButtonRight paper-icon-button-light';
        randomButton.title = JC.t!('random_button_tooltip');
        const glyph = document.createElement('i');
        glyph.className = 'material-icons';
        glyph.textContent = 'casino';
        randomButton.appendChild(glyph);
    }

    randomButton.addEventListener('click', () => onRandomClick(randomButton));
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
 * JC.core.dom.ensureInjected; disabling removes it.
 */
JC.addRandomButton = (): void => {
    if (!JC.currentSettings!.randomButtonEnabled) {
        randomButtonHandle?.remove();
        randomButtonHandle = null;
        document.getElementById('randomItemButtonContainer')?.remove();
        return;
    }

    if (randomButtonHandle) {
        randomButtonHandle.run();
        return;
    }

    // PERF(R1, doctrine: reserved-space entrance + pre-paint re-mounts): the
    // button keeps its designed slot (prepend = leading position in the tray),
    // but the injection can no longer shift the native buttons:
    //  - Boot / feature-toggle-on is necessarily POST-paint (JC loads after the
    //    native header paints), so the first injection expands from width 0
    //    over 150ms (ui-kit expandIn) instead of snap-shifting the tray.
    //  - Re-mounts (the /video round trip, React re-renders) run through the
    //    prePaint path: the button attaches synchronously in the mutation batch
    //    that rebuilt the toolbar, before its first paint — inserted instantly,
    //    no animation, indistinguishable from a native tray button.
    let firstBuild = true;
    randomButtonHandle = JC.core.dom!.ensureInjected(
        'jc-random-button',
        () => getHeaderRightContainer(),
        (headerRight, ctx) => {
            const container = buildRandomButton(headerRight);
            insertHeaderTrayButton(headerRight, container, HeaderTrayOrder.randomButton);
            JC.core.ui!.expandIn(container, { instant: ctx?.prePaint === true || !firstBuild });
            firstBuild = false;
            return container;
        },
        { headerTray: true, prePaint: true }
    );
};
