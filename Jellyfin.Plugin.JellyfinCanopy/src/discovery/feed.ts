// src/discovery/feed.ts
//
// Renders a Discovery/Trending feed as a vertical stack of horizontal shelves (Trending, Popular,
// Upcoming, per-genre, …), scoped to one media type. Placement-agnostic: the library tab, the home
// tab, the standalone page and the search surface all call renderFeed() into whatever container
// they own. Each shelf reserves its height up front (R1) and lazy-loads its cards only when it
// scrolls into view (R5 — no eager fan-out of every row), fading the cards in on arrival (R7).
// Cards, posters, availability badges, request buttons and in-library rewriting are the existing
// Seerr renderer (createCardsFragment) unchanged, so a discovery card behaves like a search card.

import { JC } from '../globals';
import { injectCss } from '../core/ui-kit';
import type { DiscoveryMediaType, DiscoveryRowSpec } from './rows';
import type { IdentityContext } from '../types/jc';
import { resolveRows } from './rows';
import { fetchRow, fetchGenres } from './data';

const CSS_ID = 'jc-discovery-feed-css';
const FEED_CLASS = 'jc-discovery-feed';
const activeControllers = new Set<AbortController>();
const activeDestroyers = new Set<() => void>();

function ensureCss(): void {
    injectCss(CSS_ID, `
        .${FEED_CLASS} { padding-top: 0.5em; }
        .jc-discovery-row { margin-bottom: 1.2em; }
        .jc-discovery-row .emby-scroller { min-height: 22vh; }
        .jc-discovery-row .itemsContainer { min-height: 22vh; }
        .jc-discovery-row--empty { display: none; }
        .jc-discovery-row-cards { opacity: 0; transition: opacity 0.25s ease; }
        .jc-discovery-row-cards.jc-in { opacity: 1; }
        .jc-discovery-empty-msg { padding: 2em 1em; text-align: center; opacity: 0.7; }
    `);
}

/** Builds one shelf shell (title + empty horizontal scroller) with its height reserved. */
function buildShelf(spec: DiscoveryRowSpec): { row: HTMLElement; itemsContainer: HTMLElement } {
    const row = document.createElement('div');
    row.className = 'verticalSection emby-scroller-container jc-discovery-row';
    row.setAttribute('data-discovery-row', spec.id);

    const title = document.createElement('h2');
    title.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-left padded-right';
    title.textContent = spec.title || (spec.titleKey ? JC.t!(spec.titleKey) : spec.id);
    row.appendChild(title);

    const scroller = document.createElement('div');
    scroller.setAttribute('is', 'emby-scroller');
    scroller.className = 'padded-top-focusscale padded-bottom-focusscale emby-scroller';
    scroller.dataset.horizontal = 'true';
    scroller.dataset.centerfocus = 'card';

    const itemsContainer = document.createElement('div');
    itemsContainer.setAttribute('is', 'emby-itemscontainer');
    itemsContainer.className = 'focuscontainer-x itemsContainer scrollSlider jc-discovery-row-cards';

    scroller.appendChild(itemsContainer);
    row.appendChild(scroller);
    return { row, itemsContainer };
}

/** Fills a shelf's cards from its data; hides the shelf if it resolves empty. */
async function fillShelf(
    spec: DiscoveryRowSpec,
    mt: DiscoveryMediaType,
    row: HTMLElement,
    itemsContainer: HTMLElement,
    signal: AbortSignal,
    context: IdentityContext,
    scheduleFrame: (callback: FrameRequestCallback) => void
): Promise<void> {
    try {
        const results = await fetchRow(spec, mt, signal);
        if (signal.aborted || !JC.identity.isCurrent(context)) return;
        const fragment = JC.discoveryFilter?.createCardsFragment?.(results, { cardClass: 'overflowPortraitCard' });
        if (!fragment || fragment.childElementCount === 0) {
            row.classList.add('jc-discovery-row--empty');
            return;
        }
        itemsContainer.appendChild(fragment);
        // R7: content is in place before we reveal it; fade in (opacity only, no reflow).
        scheduleFrame(() => {
            if (!signal.aborted && JC.identity.isCurrent(context)) itemsContainer.classList.add('jc-in');
        });
    } catch (e) {
        if ((e as Error)?.name === 'AbortError' || signal.aborted || !JC.identity.isCurrent(context)) return;
        row.classList.add('jc-discovery-row--empty');
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
    const context = JC.identity.capture();
    const abort = new AbortController();
    activeControllers.add(abort);
    const feed = document.createElement('div');
    feed.className = FEED_CLASS;
    feed.setAttribute('data-media-type', mt);
    feed.setAttribute('data-jc-identity-owned', 'true');
    if (context) JC.identity.own(feed, context);

    let observer: IntersectionObserver | null = null;
    let destroyed = false;
    const frames = new Set<number>();
    const scheduleFrame = (callback: FrameRequestCallback): void => {
        const frame = requestAnimationFrame((time) => {
            frames.delete(frame);
            callback(time);
        });
        frames.add(frame);
    };
    const destroy = (): void => {
        if (destroyed) return;
        destroyed = true;
        abort.abort();
        activeControllers.delete(abort);
        observer?.disconnect();
        frames.forEach((frame) => cancelAnimationFrame(frame));
        frames.clear();
        activeDestroyers.delete(destroy);
    };
    activeDestroyers.add(destroy);

    if (!context) {
        destroy();
        return { element: feed, destroy };
    }

    const genres = await fetchGenres(mt, abort.signal);
    if (abort.signal.aborted || !JC.identity.isCurrent(context)) {
        destroy();
        return { element: feed, destroy };
    }
    const specs = resolveRows(userRowIds, genres);

    if (specs.length === 0) {
        const msg = document.createElement('div');
        msg.className = 'jc-discovery-empty-msg';
        msg.textContent = JC.t!('discovery_empty');
        feed.appendChild(msg);
        container.appendChild(feed);
        return { element: feed, destroy };
    }

    // Lazy-load: build every shelf shell (height reserved), fill each only when it nears the viewport.
    const feedObserver = new IntersectionObserver((entries) => {
        if (abort.signal.aborted || !JC.identity.isCurrent(context)) return;
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const el = entry.target as HTMLElement;
            feedObserver.unobserve(el);
            const spec = specs.find((s) => s.id === el.getAttribute('data-discovery-row'));
            const items = el.querySelector<HTMLElement>('.jc-discovery-row-cards');
            if (spec && items) void fillShelf(spec, mt, el, items, abort.signal, context, scheduleFrame);
        }
    }, { rootMargin: '400px 0px' });
    observer = feedObserver;

    for (const spec of specs) {
        const { row } = buildShelf(spec);
        feed.appendChild(row);
        feedObserver.observe(row);
    }

    container.appendChild(feed);
    return {
        element: feed,
        destroy,
    };
}

JC.identity.registerReset('discovery-feeds', () => {
    for (const destroy of [...activeDestroyers]) destroy();
    for (const controller of [...activeControllers]) controller.abort();
    activeControllers.clear();
    document.querySelectorAll('[data-jc-identity-owned="true"].jc-discovery-feed')
        .forEach((node) => node.remove());
});
