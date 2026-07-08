// src/discovery/feed.ts
//
// Renders a Discovery/Trending feed as a vertical stack of horizontal shelves (Trending, Popular,
// Upcoming, per-genre, …), scoped to one media type. Placement-agnostic: the library tab, the home
// tab, the standalone page and the search surface all call renderFeed() into whatever container
// they own. Each shelf reserves its height up front (R1) and lazy-loads its cards only when it
// scrolls into view (R5 — no eager fan-out of every row), fading the cards in on arrival (R7).
// Cards, posters, availability badges, request buttons and in-library rewriting are the existing
// Seerr renderer (createCardsFragment) unchanged, so a discovery card behaves like a search card.

import { JE } from '../globals';
import { injectCss } from '../core/ui-kit';
import type { DiscoveryMediaType, DiscoveryRowSpec } from './rows';
import { resolveRows } from './rows';
import { fetchRow, fetchGenres } from './data';

const CSS_ID = 'je-discovery-feed-css';
const FEED_CLASS = 'je-discovery-feed';

function ensureCss(): void {
    injectCss(CSS_ID, `
        .${FEED_CLASS} { padding-top: 0.5em; }
        .je-discovery-row { margin-bottom: 1.2em; }
        .je-discovery-row .emby-scroller { min-height: 22vh; }
        .je-discovery-row .itemsContainer { min-height: 22vh; }
        .je-discovery-row--empty { display: none; }
        .je-discovery-row-cards { opacity: 0; transition: opacity 0.25s ease; }
        .je-discovery-row-cards.je-in { opacity: 1; }
        .je-discovery-empty-msg { padding: 2em 1em; text-align: center; opacity: 0.7; }
    `);
}

/** Builds one shelf shell (title + empty horizontal scroller) with its height reserved. */
function buildShelf(spec: DiscoveryRowSpec): { row: HTMLElement; itemsContainer: HTMLElement } {
    const row = document.createElement('div');
    row.className = 'verticalSection emby-scroller-container je-discovery-row';
    row.setAttribute('data-discovery-row', spec.id);

    const title = document.createElement('h2');
    title.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-left padded-right';
    title.textContent = spec.title || (spec.titleKey ? JE.t!(spec.titleKey) : spec.id);
    row.appendChild(title);

    const scroller = document.createElement('div');
    scroller.setAttribute('is', 'emby-scroller');
    scroller.className = 'padded-top-focusscale padded-bottom-focusscale emby-scroller';
    scroller.dataset.horizontal = 'true';
    scroller.dataset.centerfocus = 'card';

    const itemsContainer = document.createElement('div');
    itemsContainer.setAttribute('is', 'emby-itemscontainer');
    itemsContainer.className = 'focuscontainer-x itemsContainer scrollSlider je-discovery-row-cards';

    scroller.appendChild(itemsContainer);
    row.appendChild(scroller);
    return { row, itemsContainer };
}

/** Fills a shelf's cards from its data; hides the shelf if it resolves empty. */
async function fillShelf(spec: DiscoveryRowSpec, mt: DiscoveryMediaType, row: HTMLElement, itemsContainer: HTMLElement, signal: AbortSignal): Promise<void> {
    try {
        const { results } = await fetchRow(spec, mt, signal);
        if (signal.aborted) return;
        const fragment = JE.discoveryFilter?.createCardsFragment?.(results, { cardClass: 'overflowPortraitCard' });
        if (!fragment || fragment.childElementCount === 0) {
            row.classList.add('je-discovery-row--empty');
            return;
        }
        itemsContainer.appendChild(fragment);
        // R7: content is in place before we reveal it; fade in (opacity only, no reflow).
        requestAnimationFrame(() => itemsContainer.classList.add('je-in'));
    } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        row.classList.add('je-discovery-row--empty');
    }
}

export interface DiscoveryFeedHandle {
    element: HTMLElement;
    destroy: () => void;
}

/**
 * Renders a discovery feed for a media type into `container`. `userRowIds` overrides the row set
 * (per-user customization); null uses the admin/default rows plus a few genre rows. Returns a
 * handle whose destroy() aborts in-flight fetches and disconnects the lazy-load observer.
 */
export async function renderFeed(container: HTMLElement, mt: DiscoveryMediaType, userRowIds: string[] | null = null): Promise<DiscoveryFeedHandle> {
    ensureCss();
    const abort = new AbortController();
    const feed = document.createElement('div');
    feed.className = FEED_CLASS;
    feed.setAttribute('data-media-type', mt);

    const genres = await fetchGenres(mt, abort.signal);
    let specs = resolveRows(userRowIds, genres);
    if (!userRowIds) {
        // Enrich the default feed with a few real genre rows so it's rich out of the box.
        const genreRowIds = [...genres.keys()].slice(0, 4).map((id) => `genre:${id}`);
        const genreSpecs = resolveRows(genreRowIds, genres).filter((s) => !specs.some((e) => e.id === s.id));
        specs = specs.concat(genreSpecs);
    }

    if (specs.length === 0) {
        const msg = document.createElement('div');
        msg.className = 'je-discovery-empty-msg';
        msg.textContent = JE.t!('discovery_empty');
        feed.appendChild(msg);
        container.appendChild(feed);
        return { element: feed, destroy: () => abort.abort() };
    }

    // Lazy-load: build every shelf shell (height reserved), fill each only when it nears the viewport.
    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const el = entry.target as HTMLElement;
            observer.unobserve(el);
            const spec = specs.find((s) => s.id === el.getAttribute('data-discovery-row'));
            const items = el.querySelector<HTMLElement>('.je-discovery-row-cards');
            if (spec && items) void fillShelf(spec, mt, el, items, abort.signal);
        }
    }, { rootMargin: '400px 0px' });

    for (const spec of specs) {
        const { row } = buildShelf(spec);
        feed.appendChild(row);
        observer.observe(row);
    }

    container.appendChild(feed);
    return {
        element: feed,
        destroy: () => { abort.abort(); observer.disconnect(); },
    };
}
