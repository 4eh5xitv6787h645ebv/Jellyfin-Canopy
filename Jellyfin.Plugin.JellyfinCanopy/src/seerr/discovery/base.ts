// src/seerr/discovery/base.ts
//
// Shared state machine for the Seerr discovery sections (genre, tag,
// network, person, collection). Owns the chassis every module used to
// re-declare — processed-page dedup, re-entry guard, AbortController swap,
// metrics, error handling, lifecycle/navigation wiring — plus the
// pagination machines:
//
//   mode 'dual-feed'    server-paginated TV + Movie feeds fetched page by
//                       page with interleaving, filter/sort controls and
//                       infinite scroll (genre / tag / network)
//   mode 'client-paged' one fetched result list chunk-rendered client-side
//                       with filter/sort and infinite scroll (person)
//   mode 'one-shot'     single render, no pagination (collection)
//
// This module is deliberately seerr-scoped (not js/core/): everything
// it orchestrates — JC.discoveryFilter, JC.seamlessScroll, JC.seerrAPI,
// JC.seerrUI cards, JC.requestManager metrics — is Seerr plumbing and
// nothing outside js/seerr consumes it.
//
// Public surface: JC.discoveryBase { createDiscovery, idFromDetailUrl, idFromListParam }.
import { JC } from '../../globals';
import type { IdentityContext } from '../../types/jc';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload + spec shapes; typed incrementally */

/** A discovery-section controller returned by createDiscovery. */
export interface DiscoveryController {
    initialize: () => void;
    cleanup: () => void;
    render: () => Promise<void>;
    handlePageNavigation: () => void;
    start: () => void;
    dispose: () => void;
}

interface DiscoveryResolveContext {
    id: string;
    signal: AbortSignal;
}

interface DiscoveryOneShotContext extends DiscoveryResolveContext {
    pageKey: string;
    waitForPageReady: (signal?: AbortSignal) => Promise<HTMLElement | null>;
}

export interface DiscoverySpec {
    key: string;
    mode: 'dual-feed' | 'client-paged' | 'one-shot';
    logLabel: string;
    configKey: string;
    defaultEnabled?: boolean;
    getIdFromUrl: () => string | null;
    pageKey?: (id: string) => string;
    resolveFeeds?: (context: DiscoveryResolveContext) => Promise<{
        tvId?: number | null;
        movieId?: number | null;
        title: string;
    } | null>;
    buildDiscoverPath?: (kind: 'tv' | 'movie', id: number) => string;
    resolveItems?: (context: DiscoveryResolveContext) => Promise<{
        items: any[];
        title: string;
    } | null>;
    renderOneShot?: (context: DiscoveryOneShotContext) => Promise<boolean | undefined>;
    pageSize?: number;
    onCleanup?: () => void;
}

/** Shared discovery chassis (JC.discoveryBase). */
export interface DiscoveryBaseApi {
    createDiscovery: (spec: DiscoverySpec) => DiscoveryController;
    idFromDetailUrl: () => string | null;
    idFromListParam: (param: string) => () => string | null;
}

declare module '../../types/jc' {
    interface JEGlobal {
        /** Shared discovery chassis (src/seerr/discovery/base.ts). */
        discoveryBase?: DiscoveryBaseApi;
    }
}


/**
 * Extracts the item id from a detail-page URL (#!/details?id=...).
 * @returns {string|null}
 */
function idFromDetailUrl() {
    const hash = window.location.hash;
    if (!hash.includes('/details') || !hash.includes('id=')) {
        return null;
    }
    try {
        const params = new URLSearchParams(hash.split('?')[1]);
        return params.get('id');
    } catch (error: any) {
        return null;
    }
}

/**
 * Builds a parser that extracts a query param from a list-page URL
 * (#!/list?<param>=...).
 * @param {string} param - e.g. 'genreId', 'studioId'
 * @returns {() => string|null}
 */
function idFromListParam(param: string): () => string | null {
    return function() {
        const hash = window.location.hash;
        if (!hash.includes('/list') || !hash.includes(param + '=')) {
            return null;
        }
        try {
            const params = new URLSearchParams(hash.split('?')[1]);
            return params.get(param);
        } catch (error: any) {
            return null;
        }
    };
}

/**
 * @typedef {object} DiscoverySpec
 * @property {string} key - Module key ('genre', 'tag', 'network', 'person',
 *   'collection'). Drives the section CSS class, request-cache prefix,
 *   metrics key, filter/sort state key and lifecycle feature name.
 * @property {'dual-feed'|'client-paged'|'one-shot'} mode
 * @property {string} logLabel - Human label for log prefixes, e.g. 'Genre Discovery'.
 * @property {string} configKey - JC.pluginConfig gate key.
 * @property {boolean} [defaultEnabled=true] - true: render unless the config
 *   key is explicitly false. false: render only when the key is truthy.
 * @property {() => string|null} getIdFromUrl - URL/hash contract: returns the
 *   page's id (or name) when the module applies to the current page.
 * @property {(id: string) => string} [pageKey] - Override the processed-page
 *   key. Default: `${key}-${id}-${location.hash}`.
 * @property {(ctx: {id: string, signal: AbortSignal}) => Promise<{tvId?: (number|null), movieId?: (number|null), title: string}|null>} [resolveFeeds]
 *   dual-feed only: check user status and resolve TMDB feed ids + section
 *   title. Return null (or no ids) to skip rendering.
 * @property {(kind: 'tv'|'movie', id: number) => string} [buildDiscoverPath]
 *   dual-feed only: API path for a feed page, before ?page/&sortBy.
 * @property {(ctx: {id: string, signal: AbortSignal}) => Promise<{items: Array<any>, title: string}|null>} [resolveItems]
 *   client-paged only: check user status and fetch the full (deduped)
 *   result list + section title. Return null to skip rendering.
 * @property {(ctx: {id: string, pageKey: string, signal: AbortSignal, waitForPageReady: (signal?: AbortSignal) => Promise<HTMLElement|null>}) => Promise<boolean|undefined>} [renderOneShot]
 *   one-shot only: perform the full render. Return true to mark the page
 *   as processed (and end metrics).
 * @property {number} [pageSize] - client-paged chunk size (default 40).
 * @property {() => void} [onCleanup] - Extra per-module cleanup (cache clears).
 */

/**
 * Creates a discovery section controller from a spec.
 * @param {DiscoverySpec} spec
 * @returns {{initialize: () => void, cleanup: () => void, render: () => Promise<void>, handlePageNavigation: () => void, start: () => void}}
 */
function createDiscovery(spec: DiscoverySpec): DiscoveryController {
    const key = spec.key;
    const logPrefix = `🪼 Jellyfin Canopy: ${spec.logLabel}:`;
    const sectionSelector = `.seerr-${key}-discovery-section`;
    const isDualFeed = spec.mode === 'dual-feed';
    const isClientPaged = spec.mode === 'client-paged';
    // All discovery sections render into wrapping grids (vertical-wrap), so every
    // mode uses the native percentage-width portraitCard — matching the native
    // library poster rows at every breakpoint. overflowPortraitCard (vw-based,
    // for horizontal scrollers) previously made the detail-page sections
    // (person "More from …") ~2× the native card size on phones.
    const cardClass = 'portraitCard';
    const PAGE_SIZE = spec.pageSize || 40;

    // ---- Chassis state (all modes) -------------------------------------
    const processedPages = new Set<string>();
    /** @type {AbortController|null} */
    let currentAbortController: AbortController | null = null;
    /** @type {string|null} */
    let currentRenderingPageKey: string | null = null;
    let renderGeneration = 0;
    let initialized = false;
    let started = false;
    const navigationSubscriptions: Array<() => void> = [];
    let unregisterIdentityReset: (() => void) | null = null;
    let unregisterIdentityActivate: (() => void) | null = null;
    const renderFrames = new Set<number>();

    // ---- Pagination state (dual-feed + client-paged) --------------------
    let isLoading = false;
    let hasMorePages = true;
    const scrollState: any = { activeScrollObserver: null };

    // dual-feed: separate page tracking for TV and Movies
    let tvCurrentPage = 1;
    let movieCurrentPage = 1;
    let tvHasMorePages = true;
    let movieHasMorePages = true;
    /** @type {{tvId: (number|null), movieId: (number|null)}|null} */
    let currentFeeds: { tvId: number | null; movieId: number | null } | null = null;
    /** @type {Array<any>} */
    let cachedTvResults: any[] = [];
    /** @type {Array<any>} */
    let cachedMovieResults: any[] = [];
    /** @type {{add: Function, filter: Function, clear: Function}|null} */
    let itemDeduplicator: any = null;

    // client-paged: one cached list, chunk-rendered
    let clientListActive = false;
    /** @type {Array<any>} */
    let cachedAllResults: any[] = [];
    /** @type {Array<any>} */
    let currentPagedResults: any[] = [];
    let renderedCount = 0;

    /**
     * Managed fetch through the shared request manager (cache prefix = key).
     * @param {string} path
     * @param {object} [options]
     */
    const fetchWithManagedRequest = (path: string, options?: any) =>
        JC.discoveryFilter!.fetchWithManagedRequest(path, key, options);

    /**
     * Whether the module is enabled by plugin config.
     * @returns {boolean}
     */
    function isEnabled() {
        if (spec.defaultEnabled === false) {
            return !!JC.pluginConfig?.[spec.configKey];
        }
        return JC.pluginConfig?.[spec.configKey] !== false;
    }

    /**
     * Fetches one discover feed page (dual-feed), appending page/sortBy
     * query params exactly as the modules always did.
     * @param {'tv'|'movie'} kind
     * @param {number} feedId
     * @param {number} page
     * @param {AbortSignal} [signal]
     * @returns {Promise<{results: Array<any>, totalPages: number}>}
     */
    async function fetchFeedPage(kind: 'tv' | 'movie', feedId: number, page = 1, signal?: AbortSignal): Promise<any> {
        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            const sortBy = kind === 'tv'
                ? (JC.discoveryFilter?.getTvSortMode(key) || '')
                : (JC.discoveryFilter?.getSortMode(key) || '');
            let path = `${spec.buildDiscoverPath!(kind, feedId)}?page=${page}`;
            if (sortBy) path += `&sortBy=${encodeURIComponent(sortBy)}`;
            const response = await fetchWithManagedRequest(path, { signal });
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            return response || { results: [], totalPages: 1 };
        } catch (error: any) {
            if (error.name === 'AbortError') throw error;
            return { results: [], totalPages: 1 };
        }
    }

    /**
     * Sorts results client-side based on current sort mode (client-paged).
     * @param {Array<any>} results
     * @returns {Array<any>} new sorted array
     */
    function applySortOrder(results: any[]): any[] {
        const sortBy = JC.discoveryFilter?.getSortMode(key) || '';
        if (!sortBy) return results; // default order from API (popularity)

        const sorted = [...results];
        if (sortBy === 'vote_average.desc') {
            sorted.sort((a: any, b: any) => (b.voteAverage || 0) - (a.voteAverage || 0));
        } else if (sortBy === 'release_date.desc') {
            sorted.sort((a: any, b: any) => {
                const dateA = a.releaseDate || a.firstAirDate || '';
                const dateB = b.releaseDate || b.firstAirDate || '';
                return dateB.localeCompare(dateA);
            });
        } else if (sortBy === 'release_date.asc') {
            sorted.sort((a: any, b: any) => {
                const dateA = a.releaseDate || a.firstAirDate || '';
                const dateB = b.releaseDate || b.firstAirDate || '';
                return dateA.localeCompare(dateB);
            });
        }
        return sorted;
    }

    /**
     * Gets filtered/interleaved results based on current filter mode.
     * @param {string} mode - 'mixed', 'movies', or 'tv'
     * @returns {Array<any>}
     */
    function getFilteredResults(mode: string): any[] {
        const filter = JC.discoveryFilter;

        if (isClientPaged) {
            const sorted = applySortOrder(cachedAllResults);
            if (!filter) {
                return sorted;
            }
            if (mode === filter.MODES.MOVIES || mode === filter.MODES.TV) {
                return filter.filterByMediaType(sorted, mode);
            }
            // Mixed mode - interleave TV and Movies for balanced display
            const tvResults = sorted.filter((item: any) => item.mediaType === 'tv');
            const movieResults = sorted.filter((item: any) => item.mediaType === 'movie');
            return filter.interleaveArrays(tvResults, movieResults);
        }

        if (!filter) {
            // Fallback if utility not loaded
            return [...cachedTvResults, ...cachedMovieResults];
        }
        if (mode === filter.MODES.MOVIES) {
            return cachedMovieResults;
        }
        if (mode === filter.MODES.TV) {
            return cachedTvResults;
        }
        // Mixed mode - interleave
        return filter.interleaveArrays(cachedTvResults, cachedMovieResults);
    }

    /**
     * Creates a document fragment of media cards from results.
     * @param {Array<any>} results
     * @returns {DocumentFragment}
     */
    function createCardsFragment(results: any[]): DocumentFragment {
        return JC.discoveryFilter!.createCardsFragment(results, { cardClass });
    }

    /**
     * Creates the section container with optional filter and sort controls.
     * @param {string} title - Section heading text
     * @param {boolean} showFilter - Whether to show the All/Movies/Series filter
     * @param {Function} onFilterChange - Callback when filter changes: (newMode) => void
     * @param {Function} [onSortChange] - Callback when sort changes: () => void
     * @returns {HTMLElement} The section element
     */
    function createSectionContainer(title: string, showFilter: boolean, onFilterChange: (mode: string) => void, onSortChange?: () => void | Promise<void>): HTMLElement {
        const section = document.createElement('div');
        section.className = isDualFeed
            ? `verticalSection seerr-${key}-discovery-section padded-left padded-right`
            : `verticalSection seerr-${key}-discovery-section`;
        section.setAttribute(`data-seerr-${key}-discovery`, 'true');
        section.style.cssText = 'margin-top:2em;padding-top:1em;border-top:1px solid rgba(255,255,255,0.1)';

        // Use shared header helper if available, otherwise create basic header
        if (JC.discoveryFilter?.createSectionHeader) {
            const header = JC.discoveryFilter.createSectionHeader(title, key, showFilter, onFilterChange, onSortChange);
            section.appendChild(header);
        } else {
            const titleElement = document.createElement('h2');
            titleElement.className = 'sectionTitle sectionTitle-cards';
            titleElement.textContent = title;
            titleElement.style.marginBottom = '1em';
            section.appendChild(titleElement);
        }

        const itemsContainer = document.createElement('div');
        itemsContainer.setAttribute('is', 'emby-itemscontainer');
        itemsContainer.className = isDualFeed
            ? 'vertical-wrap itemsContainer centered'
            // Native library grid uses padded-left AND padded-right so 33.33%
            // portraitCards fill the row without overflow on narrow phones.
            : 'itemsContainer padded-left padded-right vertical-wrap';
        section.appendChild(itemsContainer);

        return section;
    }

    /**
     * Updates hasMorePages based on current filter mode (dual-feed).
     * @param {string} mode
     */
    function updateHasMorePages(mode: string): void {
        const filter = JC.discoveryFilter;
        if (!filter) {
            hasMorePages = tvHasMorePages || movieHasMorePages;
            return;
        }

        if (mode === filter.MODES.TV) {
            hasMorePages = tvHasMorePages;
        } else if (mode === filter.MODES.MOVIES) {
            hasMorePages = movieHasMorePages;
        } else {
            hasMorePages = tvHasMorePages || movieHasMorePages;
        }
    }

    /**
     * Gets the full result set for a filter mode, falling back to all
     * results if the filtered set is empty (client-paged).
     * @param {string} mode
     * @returns {Array<any>}
     */
    function getPagedResultsForMode(mode: string): any[] {
        let results = getFilteredResults(mode);
        if (results.length === 0 && cachedAllResults.length > 0) {
            results = cachedAllResults;
        }
        return results;
    }

    /**
     * Renders the next PAGE_SIZE chunk of results into the container
     * (client-paged pagination of the full fetched list).
     * @param {HTMLElement|null} itemsContainer
     * @param {string} mode - Current filter mode
     * @param {boolean} [reset=false] - Clear existing cards and reset counter
     */
    function renderChunk(itemsContainer: HTMLElement | null, mode: string, reset = false): void {
        if (!itemsContainer) return;

        if (reset) {
            while (itemsContainer.firstChild) itemsContainer.removeChild(itemsContainer.firstChild);
            renderedCount = 0;
        }

        currentPagedResults = getPagedResultsForMode(mode);
        const nextChunk = currentPagedResults.slice(renderedCount, renderedCount + PAGE_SIZE);
        if (nextChunk.length === 0) {
            hasMorePages = false;
            return;
        }

        const fragment = createCardsFragment(nextChunk);
        if (fragment.childNodes.length > 0) {
            itemsContainer.appendChild(fragment);
        }

        renderedCount += nextChunk.length;
        hasMorePages = renderedCount < currentPagedResults.length;
    }

    /**
     * Loads more items for infinite scroll. dual-feed fetches the next
     * server page(s) for the active filter mode; client-paged renders the
     * next local chunk.
     */
    async function loadMoreItems() {
        if (isClientPaged) {
            if (isLoading || !hasMorePages || !clientListActive) return;

            isLoading = true;
            try {
                const filterMode = JC.discoveryFilter?.getFilterMode(key) || 'mixed';
                const itemsContainer = document.querySelector<HTMLElement>(`${sectionSelector} .itemsContainer`);
                renderChunk(itemsContainer, filterMode, false);
            } catch (error: any) {
                if (error.name === 'AbortError') return;
                console.error(`${logPrefix} Error loading more items:`, error);
                throw error; // Re-throw for seamlessScroll retry handling
            } finally {
                isLoading = false;
            }
            return;
        }

        if (isLoading || !hasMorePages || !currentFeeds || (!currentFeeds.tvId && !currentFeeds.movieId)) {
            return;
        }

        const filterMode = JC.discoveryFilter?.getFilterMode(key) || 'mixed';

        isLoading = true;

        // Track page state before increment so we can roll back on failure
        const prevTvPage = tvCurrentPage;
        const prevMoviePage = movieCurrentPage;

        try {
            const signal = currentAbortController?.signal;
            const promises: Promise<any>[] = [];

            // Determine which endpoints to fetch based on filter mode and available IDs
            const needTv = currentFeeds.tvId && (filterMode === 'mixed' || filterMode === 'tv') && tvHasMorePages;
            const needMovies = currentFeeds.movieId && (filterMode === 'mixed' || filterMode === 'movies') && movieHasMorePages;

            if (needTv) {
                tvCurrentPage++;
                promises.push(
                    fetchFeedPage('tv', currentFeeds.tvId!, tvCurrentPage, signal)
                        .then((r: any) => ({ type: 'tv', data: r }))
                );
            }
            if (needMovies) {
                movieCurrentPage++;
                promises.push(
                    fetchFeedPage('movie', currentFeeds.movieId!, movieCurrentPage, signal)
                        .then((r: any) => ({ type: 'movie', data: r }))
                );
            }

            if (promises.length === 0) {
                hasMorePages = false;
                return;
            }

            const results = await Promise.all(promises);

            if (signal?.aborted) return;

            let newTvResults: any[] = [];
            let newMovieResults: any[] = [];

            results.forEach((r: any) => {
                if (r.type === 'tv') {
                    newTvResults = r.data.results || [];
                    tvHasMorePages = tvCurrentPage < (r.data.totalPages || 1);
                    cachedTvResults = [...cachedTvResults, ...newTvResults];
                } else {
                    newMovieResults = r.data.results || [];
                    movieHasMorePages = movieCurrentPage < (r.data.totalPages || 1);
                    cachedMovieResults = [...cachedMovieResults, ...newMovieResults];
                }
            });

            updateHasMorePages(filterMode);

            // Get items to add based on filter mode
            let itemsToAdd: any[];
            if (filterMode === 'tv') {
                itemsToAdd = newTvResults;
            } else if (filterMode === 'movies') {
                itemsToAdd = newMovieResults;
            } else {
                itemsToAdd = JC.discoveryFilter?.interleaveArrays(newTvResults, newMovieResults) ||
                             [...newTvResults, ...newMovieResults];
            }

            if (itemsToAdd.length === 0) return;

            // Deduplicate items using deduplicator (if available)
            if (itemDeduplicator) {
                itemsToAdd = itemDeduplicator.filter(itemsToAdd);
                if (itemsToAdd.length === 0) return;
            }

            const itemsContainer = document.querySelector(`${sectionSelector} .itemsContainer`);
            if (itemsContainer) {
                const fragment = createCardsFragment(itemsToAdd);
                if (fragment.childNodes.length > 0) {
                    itemsContainer.appendChild(fragment);
                }
            }
        } catch (error: any) {
            // Roll back page counters on failure so retry fetches the same page
            tvCurrentPage = prevTvPage;
            movieCurrentPage = prevMoviePage;
            if (error.name === 'AbortError') return;
            console.error(`${logPrefix} Error loading more items:`, error);
            throw error; // Re-throw for seamlessScroll retry handling
        } finally {
            isLoading = false;
        }
    }

    /**
     * Handles sort change. dual-feed re-fetches page 1 with the new
     * sortBy param; client-paged re-sorts the cached list and re-renders.
     */
    async function handleSortChange(): Promise<void> {
        const itemsContainer = document.querySelector<HTMLElement>(`${sectionSelector} .itemsContainer`);

        if (isClientPaged) {
            const filterMode = JC.discoveryFilter?.getFilterMode(key) || 'mixed';
            if (!itemsContainer) return;

            renderChunk(itemsContainer, filterMode, true);
            cleanupScrollObserver();
            if (hasMorePages) {
                setupInfiniteScroll();
            }
            return;
        }

        if (!itemsContainer || !currentFeeds || (!currentFeeds.tvId && !currentFeeds.movieId)) return;

        // Clear existing cards and scroll observer
        while (itemsContainer.firstChild) itemsContainer.removeChild(itemsContainer.firstChild);
        cleanupScrollObserver();

        // Reset pagination state for fresh fetch
        tvCurrentPage = 1;
        movieCurrentPage = 1;
        tvHasMorePages = true;
        movieHasMorePages = true;
        isLoading = false;
        cachedTvResults = [];
        cachedMovieResults = [];
        if (itemDeduplicator) itemDeduplicator.clear();

        // Abort previous requests and create a fresh controller to prevent race conditions
        if (currentAbortController) currentAbortController.abort();
        currentAbortController = new AbortController();
        const signal = currentAbortController.signal;
        const filterMode = JC.discoveryFilter?.getFilterMode(key) || 'mixed';

        // Build fetch promises for available media types
        const fetchPromises: Promise<any>[] = [];
        if (currentFeeds.tvId) {
            fetchPromises.push(
                fetchFeedPage('tv', currentFeeds.tvId, 1, signal).then((r: any) => ({ type: 'tv', data: r }))
            );
        }
        if (currentFeeds.movieId) {
            fetchPromises.push(
                fetchFeedPage('movie', currentFeeds.movieId, 1, signal).then((r: any) => ({ type: 'movie', data: r }))
            );
        }

        try {
            const results = await Promise.all(fetchPromises);
            if (signal.aborted) return;

            results.forEach((r: any) => {
                if (r.type === 'tv') {
                    cachedTvResults = r.data.results || [];
                    tvHasMorePages = 1 < (r.data.totalPages || 1);
                } else {
                    cachedMovieResults = r.data.results || [];
                    movieHasMorePages = 1 < (r.data.totalPages || 1);
                }
            });

            updateHasMorePages(filterMode);

            let displayResults = getFilteredResults(filterMode);
            if (displayResults.length === 0 && (cachedTvResults.length > 0 || cachedMovieResults.length > 0)) {
                displayResults = [...cachedTvResults, ...cachedMovieResults];
            }

            if (displayResults.length > 0) {
                const fragment = createCardsFragment(displayResults);
                itemsContainer.appendChild(fragment);
                if (itemDeduplicator) {
                    displayResults.forEach((item: any) => itemDeduplicator.add(item));
                }
            }

            JC.discoveryFilter!.applyFilterVisibility(itemsContainer, filterMode);

            if (hasMorePages) {
                setupInfiniteScroll();
            }
        } catch (error: any) {
            if (error.name !== 'AbortError') {
                console.error(`${logPrefix} Sort change error:`, error);
            }
        }
    }

    /**
     * Re-renders/refilters the section for the new filter mode.
     * @param {string} newMode
     */
    function handleFilterChange(newMode: string): void {
        const itemsContainer = document.querySelector<HTMLElement>(`${sectionSelector} .itemsContainer`);
        if (!itemsContainer) return;

        if (isClientPaged) {
            // Non-paginated endpoint: rebuild the visible list for the
            // selected mode and reset client-side paging.
            renderChunk(itemsContainer, newMode, true);
            cleanupScrollObserver();
            if (hasMorePages) {
                setupInfiniteScroll();
            }
            return;
        }

        // Use fast CSS-based visibility (no DOM rebuild)
        JC.discoveryFilter!.applyFilterVisibility(itemsContainer, newMode);

        // Update hasMorePages based on filter mode
        updateHasMorePages(newMode);

        // Re-setup infinite scroll if needed
        if (hasMorePages) {
            setupInfiniteScroll();
        }
    }

    /** Sets up infinite scroll observer using the shared utility. */
    function setupInfiniteScroll() {
        JC.discoveryFilter!.setupInfiniteScroll(
            scrollState,
            sectionSelector,
            loadMoreItems,
            () => hasMorePages,
            () => isLoading
        );
    }

    /** Cleanup scroll observer using the shared utility. */
    function cleanupScrollObserver() {
        JC.discoveryFilter!.cleanupScrollObserver(scrollState);
    }

    /**
     * Wait for the page to be ready using the shared utility. dual-feed
     * targets list pages, the other modes detail pages.
     * @param {AbortSignal} [signal]
     * @returns {Promise<HTMLElement|null>}
     */
    function waitForPageReady(signal?: AbortSignal): Promise<any> {
        return JC.discoveryFilter!.waitForPageReady(signal, { type: isDualFeed ? 'list' : 'detail' });
    }

    /**
     * Renders the dual-feed section body (genre / tag / network).
     * @param {string} id
     * @param {AbortSignal} signal
     * @param {string} pageKey
     */
    async function renderDualFeed(
        id: string,
        signal: AbortSignal,
        pageKey: string,
        context: IdentityContext
    ): Promise<void> {
        const pageReadyPromise = waitForPageReady(signal);

        const resolved = await spec.resolveFeeds!({ id, signal });
        if (signal.aborted || !JC.identity.isCurrent(context)) return;
        if (!resolved || (!resolved.tvId && !resolved.movieId)) return;

        // Reset pagination state
        tvCurrentPage = 1;
        movieCurrentPage = 1;
        isLoading = false;
        hasMorePages = true;
        tvHasMorePages = true;
        movieHasMorePages = true;
        currentFeeds = { tvId: resolved.tvId || null, movieId: resolved.movieId || null };

        // Clear cached results
        cachedTvResults = [];
        cachedMovieResults = [];

        // Initialize deduplicator for infinite scroll
        itemDeduplicator = JC.seamlessScroll?.createDeduplicator() || null;

        // Fetch TV and Movies separately (only if IDs available)
        const fetchPromises: Promise<any>[] = [];
        if (currentFeeds.tvId) {
            fetchPromises.push(
                fetchFeedPage('tv', currentFeeds.tvId, 1, signal)
                    .then((r: any) => ({ type: 'tv', data: r }))
            );
        }
        if (currentFeeds.movieId) {
            fetchPromises.push(
                fetchFeedPage('movie', currentFeeds.movieId, 1, signal)
                    .then((r: any) => ({ type: 'movie', data: r }))
            );
        }

        const [fetchResults, listPage] = await Promise.all([
            Promise.all(fetchPromises),
            pageReadyPromise
        ]);

        if (signal.aborted || !JC.identity.isCurrent(context)) return;

        // Process results
        fetchResults.forEach((r: any) => {
            if (r.type === 'tv') {
                cachedTvResults = r.data.results || [];
                tvHasMorePages = 1 < (r.data.totalPages || 1);
            } else {
                cachedMovieResults = r.data.results || [];
                movieHasMorePages = 1 < (r.data.totalPages || 1);
            }
        });

        // Determine if we have both types (only show filter if BOTH have results)
        const hasBoth = JC.discoveryFilter?.hasBothTypes(cachedTvResults, cachedMovieResults) || false;

        // Always start each section on defaults instead of persisting previous choice.
        JC.discoveryFilter?.resetFilterMode?.(key);
        JC.discoveryFilter?.resetSortMode?.(key);
        // Get current filter mode
        const filterMode = JC.discoveryFilter?.getFilterMode(key) || 'mixed';

        // Update hasMorePages
        updateHasMorePages(filterMode);

        // Get results based on filter mode
        let displayResults = getFilteredResults(filterMode);

        // If filtered results are empty but we have some content, fall back to showing all
        if (displayResults.length === 0 && (cachedTvResults.length > 0 || cachedMovieResults.length > 0)) {
            displayResults = [...cachedTvResults, ...cachedMovieResults];
        }

        if (displayResults.length === 0) return;

        if (!listPage) return;

        const existing = document.querySelector(sectionSelector);
        if (existing) existing.remove();

        const section = createSectionContainer(
            resolved.title,
            hasBoth,
            (mode) => { if (JC.identity.isCurrent(context)) handleFilterChange(mode); },
            () => JC.identity.isCurrent(context) ? handleSortChange() : undefined
        );
        section.setAttribute('data-jc-identity-owned', 'true');
        JC.identity.own(section, context);
        const itemsContainer = section.querySelector('.itemsContainer')!;

        const fragment = createCardsFragment(displayResults);
        if (fragment.childNodes.length === 0) return;

        itemsContainer.appendChild(fragment);

        // Seed deduplicator with initial items to prevent duplicates on scroll
        if (itemDeduplicator) {
            displayResults.forEach((item: any) => itemDeduplicator.add(item));
        }

        const parentContainer = listPage.closest('.verticalSection') || listPage.parentElement;
        if (parentContainer?.parentElement) {
            parentContainer.parentElement.appendChild(section);

            if (hasMorePages) {
                setupInfiniteScroll();
            }

            // Mark as successfully processed AFTER successful render
            processedPages.add(pageKey);
        }

        // End metrics
        if (JC.requestManager?.metrics?.enabled) {
            JC.requestManager.endMeasurement(`${key}-discovery`);
        }
    }

    /**
     * Renders the client-paged section body (person).
     * @param {string} id
     * @param {AbortSignal} signal
     * @param {string} pageKey
     */
    async function renderClientPaged(
        id: string,
        signal: AbortSignal,
        pageKey: string,
        context: IdentityContext
    ): Promise<void> {
        const resolved = await spec.resolveItems!({ id, signal });
        if (signal.aborted || !JC.identity.isCurrent(context)) return;
        if (!resolved || !resolved.items || resolved.items.length === 0) return;

        // Store all results for filter switching
        cachedAllResults = resolved.items;
        clientListActive = true;

        // Check if we have both media types
        const hasBoth = JC.discoveryFilter?.resultHasBothTypes(cachedAllResults) || false;

        // Always start each section on defaults instead of persisting previous choice.
        JC.discoveryFilter?.resetFilterMode?.(key);
        JC.discoveryFilter?.resetSortMode?.(key);
        // Get current filter mode
        const filterMode = JC.discoveryFilter?.getFilterMode(key) || 'mixed';

        // Get filtered results
        let displayResults = getFilteredResults(filterMode);

        // If filtered results are empty but we have some content, fall back to showing all
        if (displayResults.length === 0 && cachedAllResults.length > 0) {
            displayResults = cachedAllResults;
        }

        // Wait for page content
        const detailSection = await waitForPageReady(signal);
        if (signal.aborted || !JC.identity.isCurrent(context)) return;

        if (!detailSection) {
            console.debug(`${logPrefix} Could not find detail section to insert into`);
            return;
        }

        // Remove existing section
        const existing = document.querySelector(sectionSelector);
        if (existing) existing.remove();

        // Create and insert section
        const section = createSectionContainer(
            resolved.title,
            hasBoth,
            (mode) => { if (JC.identity.isCurrent(context)) handleFilterChange(mode); },
            () => JC.identity.isCurrent(context) ? handleSortChange() : undefined
        );
        section.setAttribute('data-jc-identity-owned', 'true');
        JC.identity.own(section, context);
        const itemsContainer = section.querySelector('.itemsContainer')!;

        // Seed first page and let seamless scroll load the rest.
        const initialItems = displayResults.slice(0, PAGE_SIZE);
        const fragment = createCardsFragment(initialItems);
        if (fragment.childNodes.length === 0) {
            console.debug(`${logPrefix} No cards created from results`);
            return;
        }

        itemsContainer.appendChild(fragment);
        currentPagedResults = displayResults;
        renderedCount = initialItems.length;
        hasMorePages = renderedCount < currentPagedResults.length;

        detailSection.appendChild(section);
        console.debug(`${logPrefix} Section added with ${fragment.childNodes.length} cards`);

        if (hasMorePages) {
            setupInfiniteScroll();
        }

        // Mark as successfully processed AFTER successful render
        processedPages.add(pageKey);

        // End metrics
        if (JC.requestManager?.metrics?.enabled) {
            JC.requestManager.endMeasurement(`${key}-discovery`);
        }
    }

    /**
     * Main render entry — chassis shared by every mode: page-key dedup,
     * re-entry guard, config gate, abort-controller swap, metrics and
     * error handling.
     */
    async function render(): Promise<void> {
        const context = JC.identity.capture();
        if (!context) return;
        const id = spec.getIdFromUrl();
        if (!id) return;

        const pageKey = spec.pageKey
            ? spec.pageKey(id)
            : `${key}-${id}-${window.location.hash}`;
        if (processedPages.has(pageKey)) return;

        // Prevent re-entry if already rendering this same page
        if (currentRenderingPageKey === pageKey) return;

        if (!isEnabled()) return;

        // Set rendering key before potentially aborting
        currentRenderingPageKey = pageKey;
        const generation = ++renderGeneration;

        // Cancel any previous requests (for different pages)
        if (currentAbortController) {
            currentAbortController.abort();
        }
        currentAbortController = new AbortController();
        const signal = currentAbortController.signal;

        // Start metrics if enabled
        if (JC.requestManager?.metrics?.enabled) {
            JC.requestManager.startMeasurement(`${key}-discovery`);
        }

        try {
            if (isDualFeed) {
                await renderDualFeed(id, signal, pageKey, context);
            } else if (isClientPaged) {
                await renderClientPaged(id, signal, pageKey, context);
            } else {
                const rendered = await spec.renderOneShot!({
                    id,
                    pageKey,
                    signal,
                    waitForPageReady
                });
                if (signal.aborted || !JC.identity.isCurrent(context)) return;
                if (rendered) {
                    const section = document.querySelector<HTMLElement>(sectionSelector);
                    if (section) {
                        section.setAttribute('data-jc-identity-owned', 'true');
                        JC.identity.own(section, context);
                    }
                    // Mark as processed
                    processedPages.add(pageKey);

                    // End metrics
                    if (JC.requestManager?.metrics?.enabled) {
                        JC.requestManager.endMeasurement(`${key}-discovery`);
                    }
                }
            }
        } catch (error: any) {
            // Don't mark as processed on failure so retry is possible
            if (error.name === 'AbortError') {
                console.debug(`${logPrefix} Request aborted`);
                return;
            }
            console.error(`${logPrefix} Error rendering ${key} discovery:`, error);
        } finally {
            // Clear rendering key after completion (success, abort, or failure)
            if (renderGeneration === generation) currentRenderingPageKey = null;
        }
    }

    /** Cleanup function — aborts in-flight requests and resets state. */
    function cleanup() {
        renderGeneration++;
        if (currentAbortController) {
            currentAbortController.abort();
            currentAbortController = null;
        }
        if (spec.mode !== 'one-shot') {
            cleanupScrollObserver();
        }
        processedPages.clear();

        // Reset pagination state
        isLoading = false;
        hasMorePages = true;
        tvCurrentPage = 1;
        movieCurrentPage = 1;
        tvHasMorePages = true;
        movieHasMorePages = true;
        currentFeeds = null;
        clientListActive = false;
        currentPagedResults = [];
        renderedCount = 0;

        currentRenderingPageKey = null;
        for (const frame of renderFrames) cancelAnimationFrame(frame);
        renderFrames.clear();
        document.querySelectorAll(sectionSelector).forEach((section) => section.remove());

        // Clear cached results
        cachedTvResults = [];
        cachedMovieResults = [];
        cachedAllResults = [];

        // Clear deduplicator
        if (itemDeduplicator) {
            itemDeduplicator.clear();
        }
        itemDeduplicator = null;

        if (spec.mode !== 'one-shot') {
            JC.discoveryFilter?.resetFilterMode?.(key);
            JC.discoveryFilter?.resetSortMode?.(key);
        }

        if (spec.onCleanup) {
            spec.onCleanup();
        }
    }

    /** Handles page navigation — renders when the URL matches the module. */
    function handlePageNavigation() {
        const context = JC.identity.capture();
        if (!context) return;
        const id = spec.getIdFromUrl();
        if (id) {
            const frame = requestAnimationFrame(() => {
                renderFrames.delete(frame);
                if (JC.identity.isCurrent(context)) void render();
            });
            renderFrames.add(frame);
        }
    }

    /** Initialize navigation listeners + lifecycle teardown wiring. */
    function initialize() {
        if (initialized) return;
        initialized = true;
        navigationSubscriptions.push(JC.core.navigation!.onNavigate(() => {
            cleanup();
            handlePageNavigation();
        }));

        handlePageNavigation();
        navigationSubscriptions.push(JC.core.navigation!.onViewPage(handlePageNavigation));
    }

    /** Run initialize now, or on DOMContentLoaded if still loading. */
    function start() {
        if (started) return;
        started = true;
        unregisterIdentityReset ??= JC.identity.registerReset(`seerr-${key}-discovery`, cleanup);
        unregisterIdentityActivate ??= JC.identity.registerActivate(
            `seerr-${key}-discovery`,
            handlePageNavigation,
        );
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initialize);
        } else {
            initialize();
        }
    }

    function dispose(): void {
        document.removeEventListener('DOMContentLoaded', initialize);
        for (const unsubscribe of navigationSubscriptions.splice(0).reverse()) unsubscribe();
        unregisterIdentityReset?.();
        unregisterIdentityReset = null;
        unregisterIdentityActivate?.();
        unregisterIdentityActivate = null;
        cleanup();
        initialized = false;
        started = false;
    }

    return { initialize, cleanup, render, handlePageNavigation, start, dispose };
}

JC.discoveryBase = {
    createDiscovery,
    idFromDetailUrl,
    idFromListParam
};
