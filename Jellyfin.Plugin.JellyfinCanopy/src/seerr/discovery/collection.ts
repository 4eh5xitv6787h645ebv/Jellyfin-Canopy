// src/seerr/discovery/collection.ts
// Shows missing collection movies on BoxSet detail pages with request buttons.
// One-shot spec over JC.discoveryBase — the base owns page dedup, abort,
// metrics and lifecycle wiring; this module keeps only the BoxSet lookup
// and the missing-movies render.
import { JC } from '../../globals';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload shapes; typed incrementally */


const logPrefix = '🪼 Jellyfin Canopy: Collection Discovery:';

const boxsetInfoCache = new Map<string, any>();

// Alias for shared utilities
const fetchWithManagedRequest = (path: string, options?: any) =>
    JC.discoveryFilter!.fetchWithManagedRequest(path, 'collection', options);

/**
 * Gets BoxSet information from Jellyfin (with caching)
 * @param {string} boxsetId - Jellyfin item ID
 * @param {AbortSignal} [signal]
 * @returns {Promise<{id: string, name: string, tmdbId: string|null, type: string}|null>}
 */
async function getBoxSetInfo(boxsetId: string, signal?: AbortSignal): Promise<any> {
    if (boxsetInfoCache.has(boxsetId)) {
        return boxsetInfoCache.get(boxsetId);
    }
    try {
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        const response = await fetchWithManagedRequest(`/JellyfinCanopy/boxset/${boxsetId}`, { signal });

        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        if (response) {
            boxsetInfoCache.set(boxsetId, response);
        }
        return response;
    } catch (error: any) {
        if (error.name === 'AbortError') throw error;
        return null;
    }
}

/**
 * Checks if the current detail page is a BoxSet
 * @param {string} itemId - Jellyfin item ID
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
async function isBoxSetPage(itemId: string, signal?: AbortSignal): Promise<any> {
    try {
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        const item: any = JC.helpers?.getItemCached
            ? await JC.helpers.getItemCached(itemId)
            : await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);

        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        return item && item.Type === 'BoxSet';
    } catch (error: any) {
        if (error.name === 'AbortError') throw error;
        return false;
    }
}

/**
 * Creates a document fragment of media cards from results using shared utility
 * @param {Array} results - Array of media result objects
 * @returns {DocumentFragment} Fragment containing rendered card elements
 */
function createCardsFragment(results: any[]): DocumentFragment {
    // Native library-grid sizing: portraitCard is percentage-width and matches
    // the native poster rows on the same page at every breakpoint (33% on a
    // phone → 3 across). overflowPortraitCard is vw-based (40vw on a phone → 2
    // giant cards) — it is only meant for horizontal scrollers, but this
    // section is a wrapping grid (vertical-wrap), so it produced cards ~2× the
    // size of the native cards in the row above.
    return JC.discoveryFilter!.createCardsFragment(results, { cardClass: 'portraitCard' });
}

/**
 * Creates the section container for missing collection movies
 * @param {string} title - Section heading text
 * @returns {HTMLElement} The section element
 */
function createSectionContainer(title: string): HTMLElement {
    const section = document.createElement('div');
    section.className = 'verticalSection seerr-collection-discovery-section';
    section.setAttribute('data-seerr-collection-discovery', 'true');
    section.style.cssText = 'margin-top:2em;padding-top:1em;border-top:1px solid rgba(255,255,255,0.1)';

    const titleElement = document.createElement('h2');
    titleElement.className = 'sectionTitle sectionTitle-cards padded-left';
    titleElement.textContent = title;
    titleElement.style.marginBottom = '0.5em';
    section.appendChild(titleElement);

    const itemsContainer = document.createElement('div');
    itemsContainer.setAttribute('is', 'emby-itemscontainer');
    // Match the native library grid exactly: padded-left AND padded-right (3.3%
    // each) so three 33.33% portraitCards fill the row without horizontal
    // overflow. padded-right alone left the row 3.3% too wide on narrow phones.
    itemsContainer.className = 'itemsContainer padded-left padded-right vertical-wrap';
    section.appendChild(itemsContainer);

    return section;
}

/**
 * Renders the collection discovery section (one-shot body).
 * @param {{id: string, signal: AbortSignal, waitForPageReady: (signal?: AbortSignal) => Promise<HTMLElement|null>}} ctx
 * @returns {Promise<boolean|undefined>} true when the section was rendered
 */
async function renderCollectionDiscovery({ id: itemId, signal, waitForPageReady }: { id: string; signal: AbortSignal; waitForPageReady: (signal?: AbortSignal) => Promise<any> }): Promise<boolean | undefined> {
    // Check if this is a BoxSet page
    const isBoxSet = await isBoxSetPage(itemId, signal);
    if (signal.aborted) return;
    if (!isBoxSet) return;

    // Fetch boxset info, user status, and page readiness in parallel
    // pageReadyPromise is started here but awaited later to overlap DOM wait with API calls
    const boxsetInfoPromise = getBoxSetInfo(itemId, signal);
    const statusPromise = JC.seerrAPI?.checkUserStatus();
    const pageReadyPromise = waitForPageReady(signal);

    const [boxsetInfo, status] = await Promise.all([boxsetInfoPromise, statusPromise]);

    if (signal.aborted) return;

    if (!status?.active || !boxsetInfo?.tmdbId) {
        if (!boxsetInfo?.tmdbId) {
            console.debug(`${logPrefix} No TMDB collection ID for BoxSet ${itemId}`);
        }
        return;
    }

    const tmdbCollectionId = parseInt(boxsetInfo.tmdbId, 10);
    if (!tmdbCollectionId) return;

    // Fetch collection details from Seerr
    const collectionDetails = await JC.seerrAPI!.fetchCollectionDetails(tmdbCollectionId);
    if (signal.aborted) return;

    if (!collectionDetails?.parts || collectionDetails.parts.length === 0) {
        console.debug(`${logPrefix} No parts found in collection ${tmdbCollectionId}`);
        return;
    }

    // Filter to only missing movies (not fully available in library)
    // Status: 1=not available, 2=requested, 3=pending, 4=partial, 5=available
    // No user filter/sort controls needed — collections are small fixed sets
    // Ensure each part has mediaType set to 'movie' for the shared card renderer
    const missingMovies = collectionDetails.parts
        .map((movie: any) => ({ ...movie, mediaType: movie.mediaType || 'movie' }))
        .filter((movie: any) => {
            const movieStatus = movie.mediaInfo?.status || 1;
            return movieStatus !== 5;
        });

    // Sort by release date
    missingMovies.sort((a: any, b: any) => {
        const dateA = a.releaseDate || '';
        const dateB = b.releaseDate || '';
        return dateA.localeCompare(dateB);
    });

    if (missingMovies.length === 0) {
        console.debug(`${logPrefix} All movies in collection ${boxsetInfo.name} are available`);
        return;
    }

    // Wait for page DOM
    const detailSection = await pageReadyPromise;
    if (signal.aborted) return;

    if (!detailSection) {
        console.debug(`${logPrefix} Could not find detail section to insert into`);
        return;
    }

    // Remove existing section
    const existing = document.querySelector('.seerr-collection-discovery-section');
    if (existing) existing.remove();

    // Build section title
    const totalInCollection = collectionDetails.parts.length;
    const availableCount = totalInCollection - missingMovies.length;
    const sectionTitle = `Missing from ${boxsetInfo.name} (${availableCount}/${totalInCollection})`;

    const section = createSectionContainer(sectionTitle);
    const itemsContainer = section.querySelector('.itemsContainer')!;

    // Create cards using the same shared card renderer as all other discovery modules
    const fragment = createCardsFragment(missingMovies);
    if (fragment.childNodes.length === 0) {
        console.debug(`${logPrefix} No cards created from missing movies`);
        return;
    }

    itemsContainer.appendChild(fragment);

    detailSection.appendChild(section);
    console.debug(`${logPrefix} Section added with ${missingMovies.length} missing movies from ${boxsetInfo.name}`);

    return true;
}

const discovery = JC.discoveryBase!.createDiscovery({
    key: 'collection',
    mode: 'one-shot',
    logLabel: 'Collection Discovery',
    configKey: 'SeerrShowCollectionDiscovery',
    getIdFromUrl: JC.discoveryBase!.idFromDetailUrl,
    renderOneShot: renderCollectionDiscovery,
    onCleanup: () => boxsetInfoCache.clear()
});

discovery.start();
