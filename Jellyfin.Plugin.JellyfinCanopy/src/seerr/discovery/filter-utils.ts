// src/seerr/discovery/filter-utils.ts
// Shared utilities for discovery section content type filtering
import { JC } from '../../globals';
import { getVisibleDetailsPage } from '../../core/details-view';
import { waitForSharedResult } from '../../core/shared-result';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload shapes; typed incrementally */

/** Shared discovery filter/sort helpers (JC.discoveryFilter). */
export interface DiscoveryFilterApi {
    MODES: { MIXED: string; MOVIES: string; TV: string };
    SORT_OPTIONS: { value: string; label: string }[];
    getFilterMode: (moduleName: string) => string;
    setFilterMode: (moduleName: string, mode: string) => void;
    resetFilterMode: (moduleName: string) => void;
    getSortMode: (moduleName: string) => string;
    getTvSortMode: (moduleName: string) => string;
    setSortMode: (moduleName: string, sort: string) => void;
    resetSortMode: (moduleName: string) => void;
    interleaveArrays: (arr1: any[], arr2: any[]) => any[];
    filterByMediaType: (results: any[], mode: string) => any[];
    hasBothTypes: (tvResults: any[], movieResults: any[]) => boolean;
    resultHasBothTypes: (results: any[]) => boolean;
    createFilterControl: (moduleName: string, onFilterChange: (mode: string) => void) => HTMLElement;
    createSortControl: (moduleName: string, onSortChange: (sort: string) => void | Promise<void>) => HTMLElement;
    createSectionHeader: (title: string, moduleName: string, showFilter: boolean, onFilterChange: (mode: string) => void, onSortChange?: (sort: string) => void | Promise<void>) => HTMLElement;
    fetchWithManagedRequest: (path: string, cachePrefix: string, options?: ManagedRequestOptions) => Promise<any>;
    createCardsFragment: (results: any[], options?: any) => DocumentFragment;
    waitForPageReady: (signal?: AbortSignal, options?: any) => Promise<any>;
    setupInfiniteScroll: (state: any, sectionSelector: string, loadMoreFn: () => Promise<void>, hasMoreCheck: () => boolean, isLoadingCheck: () => boolean) => void;
    cleanupScrollObserver: (state: any) => void;
    applyFilterVisibility: (container: HTMLElement | null, mode: string) => void;
}

interface ManagedRequestOptions {
    signal?: AbortSignal;
    cacheDisposition?: (data: unknown) => 'positive' | 'negative' | 'skip';
    cacheNotFound?: boolean;
}

declare module '../../types/jc' {
    interface JEGlobal {
        /** Shared discovery filter/sort utilities (src/seerr/discovery/filter-utils.ts). */
        discoveryFilter?: DiscoveryFilterApi;
    }
}


const FILTER_MODES = {
    MIXED: 'mixed',
    MOVIES: 'movies',
    TV: 'tv'
};
const runtimeFilterModes = new Map<string, string>();
const runtimeSortModes = new Map<string, string>();

JC.identity.registerReset('seerr-discovery-filter', () => {
    runtimeFilterModes.clear();
    runtimeSortModes.clear();
});

const SORT_OPTIONS = [
    { value: '', label: 'Popular' },
    { value: 'vote_average.desc', label: 'Top Rated' },
    { value: 'release_date.desc', label: 'Newest' },
    { value: 'release_date.asc', label: 'Oldest' }
];

/**
 * Gets the current filter mode for a module from runtime state.
 * @param {string} moduleName - e.g., 'genre', 'tag', 'person', 'network'
 * @returns {string} - 'mixed', 'movies', or 'tv'
 */
function getFilterMode(moduleName: string): string {
    const stored = runtimeFilterModes.get(moduleName);
    if (stored && Object.values(FILTER_MODES).includes(stored)) {
        return stored;
    }
    return FILTER_MODES.MIXED;
}

/**
 * Sets the filter mode for a module in runtime state.
 * @param {string} moduleName
 * @param {string} mode - 'mixed', 'movies', or 'tv'
 */
function setFilterMode(moduleName: string, mode: string): void {
    if (Object.values(FILTER_MODES).includes(mode)) {
        runtimeFilterModes.set(moduleName, mode);
    }
}

/**
 * Resets module filter mode back to default.
 * @param {string} moduleName
 */
function resetFilterMode(moduleName: string): void {
    runtimeFilterModes.delete(moduleName);
}

/**
 * Gets the current sort mode for a module.
 * @param {string} moduleName - e.g., 'genre', 'tag', 'person', 'network'
 * @returns {string} Sort value (empty string = default/popular)
 */
function getSortMode(moduleName: string): string {
    return runtimeSortModes.get(moduleName) || '';
}

/**
 * Gets the sort value adapted for TV endpoints.
 * TMDB uses first_air_date for TV instead of release_date for movies.
 * @param {string} moduleName
 * @returns {string} TV-compatible sort value
 */
function getTvSortMode(moduleName: string): string {
    const sort = runtimeSortModes.get(moduleName) || '';
    return sort.replace('release_date', 'first_air_date');
}

/**
 * Sets the sort mode for a module.
 * @param {string} moduleName
 * @param {string} sort - Sort value from SORT_OPTIONS
 */
function setSortMode(moduleName: string, sort: string): void {
    runtimeSortModes.set(moduleName, sort);
}

/**
 * Resets module sort mode back to default (popular).
 * @param {string} moduleName
 */
function resetSortMode(moduleName: string): void {
    runtimeSortModes.delete(moduleName);
}

/**
 * Interleaves two arrays in 1:1 alternating fashion
 * Preserves internal order of each array
 * @param {Array} arr1 - First array (e.g., TV results)
 * @param {Array} arr2 - Second array (e.g., Movie results)
 * @returns {Array} - Interleaved array
 */
function interleaveArrays(arr1: any[], arr2: any[]): any[] {
    const result: any[] = [];
    const len1 = arr1.length;
    const len2 = arr2.length;
    const maxLen = Math.max(len1, len2);

    let i1 = 0;
    let i2 = 0;

    for (let i = 0; i < maxLen * 2 && (i1 < len1 || i2 < len2); i++) {
        if (i % 2 === 0 && i1 < len1) {
            result.push(arr1[i1++]);
        } else if (i % 2 === 1 && i2 < len2) {
            result.push(arr2[i2++]);
        } else if (i1 < len1) {
            result.push(arr1[i1++]);
        } else if (i2 < len2) {
            result.push(arr2[i2++]);
        }
    }

    return result;
}

/**
 * Filters results by media type
 * @param {Array} results - Array of items with mediaType property
 * @param {string} mode - 'mixed', 'movies', or 'tv'
 * @returns {Array} - Filtered array
 */
function filterByMediaType(results: any[], mode: string): any[] {
    if (mode === FILTER_MODES.MIXED) {
        return results;
    }
    if (mode === FILTER_MODES.MOVIES) {
        return results.filter((item: any) => item.mediaType === 'movie');
    }
    if (mode === FILTER_MODES.TV) {
        return results.filter((item: any) => item.mediaType === 'tv');
    }
    return results;
}

/**
 * Determines if both movies and TV exist in results
 * @param {Array} tvResults - TV results array
 * @param {Array} movieResults - Movie results array
 * @returns {boolean}
 */
function hasBothTypes(tvResults: any[], movieResults: any[]): boolean {
    return (tvResults && tvResults.length > 0) && (movieResults && movieResults.length > 0);
}

/**
 * Determines if results contain both media types (for combined endpoint results)
 * @param {Array} results - Combined results array
 * @returns {boolean}
 */
function resultHasBothTypes(results: any[]): boolean {
    if (!results || results.length === 0) return false;
    let hasMovie = false;
    let hasTv = false;
    for (let i = 0; i < results.length && !(hasMovie && hasTv); i++) {
        if (results[i].mediaType === 'movie') hasMovie = true;
        if (results[i].mediaType === 'tv') hasTv = true;
    }
    return hasMovie && hasTv;
}

/**
 * Creates the filter control UI element
 * @param {string} moduleName - Module name for persistence
 * @param {Function} onFilterChange - Callback when filter changes: (newMode) => void
 * @returns {HTMLElement} - The filter control container
 */
function createFilterControl(moduleName: string, onFilterChange: (mode: string) => void): HTMLElement {
    const currentMode = getFilterMode(moduleName);

    const container = document.createElement('div');
    container.className = 'seerr-discovery-filter';
    container.style.cssText = 'display:inline-flex;gap:0;font-size:0.85em;vertical-align:middle;';

    const allLabel = (typeof JC?.t === 'function') ? JC.t('seerr_discover_all') || 'All' : 'All';
    const moviesLabel = (typeof JC?.t === 'function') ? JC.t('seerr_card_badge_movie') || 'Movies' : 'Movies';
    const seriesLabel = (typeof JC?.t === 'function') ? JC.t('seerr_card_badge_series') || 'Series' : 'Series';

    const buttons = [
        { mode: FILTER_MODES.MIXED, label: allLabel },
        { mode: FILTER_MODES.MOVIES, label: moviesLabel },
        { mode: FILTER_MODES.TV, label: seriesLabel }
    ];

    buttons.forEach((btn, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'seerr-filter-btn';
        button.setAttribute('data-mode', btn.mode);
        button.textContent = btn.label;

        // Segmented button styling
        let borderRadius = '0';
        if (index === 0) borderRadius = '4px 0 0 4px';
        if (index === buttons.length - 1) borderRadius = '0 4px 4px 0';

        const isActive = currentMode === btn.mode;
        button.style.cssText = `
            padding: 4px 10px;
            border: 1px solid rgba(255,255,255,0.3);
            border-radius: ${borderRadius};
            background: ${isActive ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)'};
            color: rgba(255,255,255,0.8);
            cursor: pointer;
            font-size: inherit;
            font-family: inherit;
            margin-left: ${index > 0 ? '-1px' : '0'};
            transition: background 0.15s, border-color 0.15s;
            font-weight: ${isActive ? '600' : '400'};
        `;

        button.addEventListener('click', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();

            const newMode = btn.mode;
            if (newMode === getFilterMode(moduleName)) return;

            setFilterMode(moduleName, newMode);

            // Update button states
            container.querySelectorAll<HTMLElement>('.seerr-filter-btn').forEach((b) => {
                const isNowActive = b.getAttribute('data-mode') === newMode;
                b.style.background = isNowActive ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)';
                b.style.fontWeight = isNowActive ? '600' : '400';
            });

            if (onFilterChange) {
                onFilterChange(newMode);
            }
        });

        // Hover effects
        button.addEventListener('mouseenter', () => {
            if (getFilterMode(moduleName) !== btn.mode) {
                button.style.background = 'rgba(255,255,255,0.1)';
            }
        });
        button.addEventListener('mouseleave', () => {
            const isActive = getFilterMode(moduleName) === btn.mode;
            button.style.background = isActive ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)';
        });

        container.appendChild(button);
    });

    return container;
}

/**
 * Creates the sort control dropdown
 * @param {string} moduleName
 * @param {Function} onSortChange - Callback: (newSort) => void
 * @returns {HTMLElement}
 */
function createSortControl(moduleName: string, onSortChange: (sort: string) => void | Promise<void>): HTMLElement {
    const currentSort = getSortMode(moduleName);

    const container = document.createElement('div');
    container.className = 'seerr-discovery-sort';
    container.style.cssText = 'display:inline-flex;align-items:center;gap:0.4em;font-size:0.85em;margin-left:auto;';

    const label = document.createElement('span');
    label.textContent = 'Sort:';
    label.style.cssText = 'color:rgba(255,255,255,0.5);';
    container.appendChild(label);

    const select = document.createElement('select');
    select.className = 'seerr-sort-select';
    select.style.cssText = `
        background: rgba(255,255,255,0.08);
        color: rgba(255,255,255,0.85);
        border: 1px solid rgba(255,255,255,0.2);
        border-radius: 4px;
        padding: 3px 8px;
        font-size: inherit;
        font-family: inherit;
        cursor: pointer;
        outline: none;
    `;

    SORT_OPTIONS.forEach((opt) => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        option.style.cssText = 'background:#1a1a2e;color:#fff;';
        if (currentSort === opt.value) option.selected = true;
        select.appendChild(option);
    });

    select.addEventListener('change', () => {
        const newSort = select.value;
        setSortMode(moduleName, newSort);
        if (onSortChange) void onSortChange(newSort);
    });

    container.appendChild(select);
    return container;
}

/**
 * Creates a section header with title, optional filter control, and sort dropdown
 * @param {string} title - Section title text
 * @param {string} moduleName - Module name for filter persistence
 * @param {boolean} showFilter - Whether to show the filter control
 * @param {Function} onFilterChange - Callback when filter changes
 * @param {Function} [onSortChange] - Callback when sort changes
 * @returns {HTMLElement} - The header element
 */
function createSectionHeader(title: string, moduleName: string, showFilter: boolean, onFilterChange: (mode: string) => void, onSortChange?: (sort: string) => void | Promise<void>): HTMLElement {
    const header = document.createElement('div');
    header.className = 'seerr-discovery-header';
    header.style.cssText = 'display:flex;align-items:baseline;gap:1em;margin-bottom:1em;flex-wrap:wrap;width:100%;';

    const titleElement = document.createElement('h2');
    titleElement.className = 'sectionTitle sectionTitle-cards';
    titleElement.textContent = title;
    titleElement.style.margin = '0';
    header.appendChild(titleElement);

    if (showFilter) {
        const filterControl = createFilterControl(moduleName, onFilterChange);
        header.appendChild(filterControl);
    }

    if (onSortChange) {
        const sortControl = createSortControl(moduleName, onSortChange);
        header.appendChild(sortControl);
    }

    return header;
}

/**
 * Managed fetch helper using request manager when available
 * @param {string} path - API path
 * @param {string} cachePrefix - Cache key prefix (e.g., 'genre', 'network')
 * @param {object} [options] - Fetch options including signal
 * @returns {Promise<any>}
 */
async function fetchWithManagedRequest(
    path: string,
    cachePrefix: string,
    options: ManagedRequestOptions = {}
): Promise<any> {
    const { signal, cacheDisposition, cacheNotFound } = options;
    // The core paved road owns auth, per-identity cache keys, parsing fences,
    // abort-on-transition, dedup and concurrency. Calling manager primitives
    // directly here previously allowed an unsignalled A response to parse and
    // setCache after B had become current.
    const sharedRequest = JC.core.api!.jf(path, {
        cacheKey: `${cachePrefix}:${path}`,
        cacheDisposition,
        cacheNotFound,
    });
    return waitForSharedResult(sharedRequest, signal);
}

/**
 * Creates cards and returns a DocumentFragment for batch DOM insertion
 * @param {Array} results - Array of items to create cards for
 * @param {object} [options] - Options
 * @param {string} [options.cardClass] - Card class to use ('portraitCard' or 'overflowPortraitCard')
 * @returns {DocumentFragment}
 */
function createCardsFragment(results: any[], options: any = {}): DocumentFragment {
    const { cardClass = 'portraitCard' } = options;
    const fragment = document.createDocumentFragment();
    const excludeLibraryItems = JC.pluginConfig?.SeerrExcludeLibraryItems === true;
    const excludeBlocklistedItems = JC.pluginConfig?.SeerrExcludeBlocklistedItems === true;
    const seen = new Set<string>();

    // Filter hidden content before rendering
    const filteredResults = JC.hiddenContent
        ? JC.hiddenContent.filterSeerrResults(results, 'discovery')
        : results;

    for (let i = 0; i < filteredResults.length; i++) {
        const item = filteredResults[i];

        // Deduplicate by TMDB ID
        const key = `${item.mediaType}-${item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        if (excludeLibraryItems && item.mediaInfo?.jellyfinMediaId) {
            continue;
        }

        if (excludeBlocklistedItems && item.mediaInfo?.status === JC.seerrStatus!.MEDIA.BLOCKED) {
            continue;
        }
        const card = JC.seerrUI?.createSeerrCard?.(item, true, true);
        if (!card) continue;

        const classList = card.classList;
        // Remove both possible classes and add the desired one
        classList.remove('portraitCard', 'overflowPortraitCard');
        classList.add(cardClass);

        // Add media type for fast CSS-based filtering
        card.setAttribute('data-media-type', item.mediaType);

        const jellyfinMediaId = item.mediaInfo?.jellyfinMediaId;
        if (jellyfinMediaId) {
            card.setAttribute('data-library-item', 'true');
            card.setAttribute('data-jellyfin-media-id', jellyfinMediaId);
            classList.add('seerr-card-in-library');

            const titleLink: HTMLAnchorElement | null = card.querySelector('.cardText-first a');
            if (titleLink) {
                const itemName = item.title || item.name;
                titleLink.textContent = itemName;
                titleLink.title = itemName;
                titleLink.href = `#!/details?id=${jellyfinMediaId}`;
                titleLink.removeAttribute('target');
                titleLink.removeAttribute('rel');
            }
        }

        fragment.appendChild(card);
    }

    return fragment;
}

// Process-lifetime monotonic counter for waitForPageReady subscriber ids.
// Several discovery modules (genre/tag/network on list pages; person/
// collection/hss on detail pages) wait concurrently: a shared fixed id meant
// onBodyMutation REPLACED the earlier waiter (it could then only resolve via
// its give-up timeout), and the evicted waiter's cleanup deleted the shared
// key out from under the survivor. A counter makes every wait collision-free —
// the same fix waitForElement in core/dom-observer.ts already carries.
let pageReadySeq = 0;

/**
 * Wait for the page to be ready (active page only, not hidden).
 *
 * PERF(R9): fail open — no give-up timeout. On a slow server or connection the
 * host page can take arbitrarily long to mount its containers; the old 3s
 * timeout resolved null and the section was silently skipped for the whole
 * page view (nothing re-triggers a render except navigation). The wait now
 * stays subscribed to the multiplexed body observer (R3: no new observer, no
 * polling) until the container mounts or the caller's AbortSignal fires — the
 * discovery chassis aborts on every navigation, so the subscription's
 * lifetime is exactly the page view. Late sections insert once, fully built,
 * per R7.
 * @param {AbortSignal} [signal] - Abort signal (every caller passes the
 *   discovery chassis's per-page-view controller; aborted on navigation).
 * @param {object} [options] - Options
 * @param {string} [options.type] - Type of page: 'list' or 'detail'
 * @returns {Promise<HTMLElement|null>}
 */
function waitForPageReady(signal?: AbortSignal, options: any = {}): Promise<any> {
    const { type = 'list' } = options;

    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(null);
            return;
        }

        const checkContainer = () => {
            if (type === 'detail') {
                // Resolve through core/details-view: the page must be the view
                // SHOWN for the item the URL names — during a details→details
                // push the outgoing page is still visible, and a bare
                // :not(.hide) query resolved it, inserting this page's rows
                // into a view about to be hidden.
                const detailPage = getVisibleDetailsPage()?.page ?? null;
                // Jellyfin 12 dropped the .detailPageContent wrapper; fall back to
                // .detailPageSecondaryContainer, then the page itself.
                const detailContent: Element | null = detailPage && (
                    detailPage.querySelector('.detailPageContent') ||
                    detailPage.querySelector('.detailPageSecondaryContainer') ||
                    detailPage);
                return detailContent;
            }
            // List page
            const listContainer = document.querySelector('.page:not(.hide) .itemsContainer') ||
                                  document.querySelector('.libraryPage:not(.hide) .itemsContainer');
            return (listContainer?.children.length ?? 0) > 0 ? listContainer : null;
        };

        const immediate = checkContainer();
        if (immediate) {
            resolve(immediate);
            return;
        }

        let observerHandle: any = null;
        let backstopTimer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
            if (observerHandle) {
                observerHandle.unsubscribe();
                observerHandle = null;
            }
            if (backstopTimer) {
                clearTimeout(backstopTimer);
                backstopTimer = null;
            }
        };

        if (signal) {
            signal.addEventListener('abort', () => {
                cleanup();
                resolve(null);
            }, { once: true });
        } else {
            // Leak backstop for a (future) signal-less caller ONLY: without an
            // abort to end the wait, retire the subscription after a generous
            // absolute deadline. A real timer, not a lazy mutation-time check —
            // a page that stops mutating would otherwise never trigger it.
            // Never a UX budget (R9): every current caller passes a signal and
            // never takes this path.
            backstopTimer = setTimeout(() => {
                cleanup();
                resolve(checkContainer());
            }, 120_000);
        }

        observerHandle = JC.helpers!.onBodyMutation!(`seerr-discovery-container-detect-${++pageReadySeq}`, () => {
            const container = checkContainer();
            if (container) {
                cleanup();
                resolve(container);
            }
        });
    });
}

/**
 * Sets up infinite scroll using seamlessScroll module
 * Features:
 * - Larger prefetch window (~2 viewport heights)
 * - Retry UI on failure
 * - Scroll event fallback
 * @param {object} state - State object with activeScrollObserver property
 * @param {string} sectionSelector - CSS selector for the section
 * @param {Function} loadMoreFn - Function to call when more items needed
 * @param {Function} hasMoreCheck - Function that returns whether more pages exist
 * @param {Function} isLoadingCheck - Function that returns whether currently loading
 */
function setupInfiniteScroll(state: any, sectionSelector: string, loadMoreFn: () => Promise<void>, hasMoreCheck: () => boolean, isLoadingCheck: () => boolean): void {
    JC.seamlessScroll!.setupInfiniteScroll(
        state, sectionSelector, loadMoreFn, hasMoreCheck, isLoadingCheck
    );
}

/**
 * Cleanup scroll observer
 * @param {object} state - State object with activeScrollObserver property
 */
function cleanupScrollObserver(state: any): void {
    JC.seamlessScroll!.cleanupInfiniteScroll(state);
}

/**
 * Applies filter visibility using CSS classes (fast, no DOM rebuild)
 * @param {HTMLElement} container - The items container
 * @param {string} mode - 'mixed', 'movies', or 'tv'
 */
function applyFilterVisibility(container: HTMLElement | null, mode: string): void {
    if (!container) return;

    // Remove existing filter class from container
    container.classList.remove('filter-movies', 'filter-tv');

    if (mode === FILTER_MODES.MOVIES) {
        container.classList.add('filter-movies');
    } else if (mode === FILTER_MODES.TV) {
        container.classList.add('filter-tv');
    }
    // 'mixed' mode: no class = all visible
}

/**
 * Injects CSS rules for fast filter visibility (once per page)
 */
function injectFilterStyles() {
    if (document.getElementById('seerr-filter-styles')) return;

    const style = document.createElement('style');
    style.id = 'seerr-filter-styles';
    style.textContent = `
        .filter-movies [data-media-type="tv"] { display: none !important; }
        .filter-tv [data-media-type="movie"] { display: none !important; }
    `;
    document.head.appendChild(style);
}

// Inject styles on load
injectFilterStyles();

// Export utilities
JC.discoveryFilter = {
    MODES: FILTER_MODES,
    SORT_OPTIONS,
    getFilterMode,
    setFilterMode,
    resetFilterMode,
    getSortMode,
    getTvSortMode,
    setSortMode,
    resetSortMode,
    interleaveArrays,
    filterByMediaType,
    hasBothTypes,
    resultHasBothTypes,
    createFilterControl,
    createSortControl,
    createSectionHeader,
    // Shared utilities
    fetchWithManagedRequest,
    createCardsFragment,
    waitForPageReady,
    setupInfiniteScroll,
    cleanupScrollObserver,
    applyFilterVisibility
};
