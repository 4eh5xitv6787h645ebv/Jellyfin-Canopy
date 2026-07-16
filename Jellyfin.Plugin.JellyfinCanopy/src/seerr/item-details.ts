// src/seerr/item-details.ts
// Adds Similar and Recommended sections to item details pages using Seerr API.
// Also adds a "Request More" button next to the Seasons section heading on
// Series detail pages when the show has unrequested seasons in Seerr.
import { JC } from '../globals';
import { getItemIdFromUrl, getVisibleDetailsPage } from '../core/details-view';
import type { IdentityContext } from '../types/jc';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload shapes; typed incrementally */


const logPrefix = '🪼 Jellyfin Canopy: Seerr Recommendations:';
const requestMoreLogPrefix = '🪼 Jellyfin Canopy: Series Request More:';

// Track processed items to avoid duplicate renders
const processedItems = new Set();
const processedRequestMoreItems = new Set();

// CSS class used to mark and dedupe the injected Request More button
const REQUEST_MORE_BTN_CLASS = 'jc-series-request-more-btn';

// Current abort controllers for cancellation. Separate controllers prevent
// the slower similar/recommended fetch from cancelling the Request More
// check (and vice versa) when the user navigates between detail pages.
let currentAbortController: AbortController | null = null;
let requestMoreAbortController: AbortController | null = null;
const pendingFrames = new Set<number>();
let initialized = false;
const navigationSubscriptions: Array<() => void> = [];
let unregisterIdentityReset: (() => void) | null = null;
let unregisterIdentityActivate: (() => void) | null = null;

function isCurrent(context: IdentityContext | null, signal?: AbortSignal): context is IdentityContext {
    return !!context && !signal?.aborted && JC.identity.isCurrent(context);
}

/**
 * Gets the TMDB ID from a Jellyfin item
 * @param {string} itemId - Jellyfin item ID
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<{tmdbId: number|null, type: string|null}>}
 */
async function getTmdbIdFromItem(itemId: string, context: IdentityContext, signal?: AbortSignal): Promise<{ tmdbId: number | null; type: string | null }> {
    try {
        // Check for abort before making request
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        const userId = context.userId;
        const item: any = JC.helpers?.getItemCached
            ? await JC.helpers.getItemCached(itemId, { userId })
            : await ApiClient.getItem(userId, itemId);

        // Check for abort after request
        if (!isCurrent(context, signal)) {
            throw new DOMException('Aborted', 'AbortError');
        }

        if (!item) {
            console.warn(`${logPrefix} Item not found:`, itemId);
            return { tmdbId: null, type: null };
        }

        // Check if item is Movie or Series
        const itemType = item.Type;
        if (itemType !== 'Movie' && itemType !== 'Series') {
            return { tmdbId: null, type: null };
        }

        // Get TMDB ID from provider IDs
        const tmdbId = item.ProviderIds?.Tmdb;
        if (!tmdbId) {
            console.warn(`${logPrefix} No TMDB ID found for item:`, item.Name);
            return { tmdbId: null, type: null };
        }

        const type = itemType === 'Movie' ? 'movie' : 'tv';
        return { tmdbId: parseInt(tmdbId), type };
    } catch (error: any) {
        if (error.name === 'AbortError') throw error;
        console.error(`${logPrefix} Error getting TMDB ID:`, error);
        return { tmdbId: null, type: null };
    }
}

// Process-lifetime monotonic counter so concurrent waiters (similar/
// recommended + request-more run in parallel per page) never share an
// onBodyMutation subscriber id — a fixed id meant the later waiter silently
// evicted the earlier one, and either waiter's cleanup stranded the survivor.
let detailReadySeq = 0;

/**
 * Wait for the detail page content to be ready.
 *
 * PERF(R9): fail open — no give-up timeout. On a slow server the host page
 * can take arbitrarily long to mount #similarCollapsible; the old 3s timeout
 * skipped the sections for the whole page view (nothing re-triggers except
 * navigation). The wait now stays subscribed to the multiplexed body observer
 * (R3) until the anchor mounts or the caller's AbortSignal fires — cleanup()
 * aborts both controllers on every navigation, so the subscription's lifetime
 * is exactly the page view.
 * @param {string} itemId - The item the caller is rendering sections for; the
 * wait only resolves a page that was SHOWN for this item. During a
 * details→details push the outgoing page is still visible (with its own
 * #similarCollapsible) when this is first called — resolving it inserted the
 * new item's sections into a view about to be hidden.
 * @param {AbortSignal} [signal] - Abort signal (aborted on navigation).
 * @returns {Promise<HTMLElement|null>}
 */
function waitForDetailPageReady(itemId: string, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve) => {
        // Check for abort
        if (signal?.aborted) {
            resolve(null);
            return;
        }

        const checkPage = () => {
            const resolved = getVisibleDetailsPage();
            if (!resolved || resolved.itemId !== itemId) return null;
            const activePage = resolved.page;

            // Jellyfin 12 dropped the .detailPageContent wrapper; fall back to
            // .detailPageSecondaryContainer, then the page itself. #similarCollapsible
            // (our insertion anchor) still exists inside it on both lines.
            const detailPageContent = activePage.querySelector('.detailPageContent') ||
                                      activePage.querySelector('.detailPageSecondaryContainer') ||
                                      activePage;
            const moreLikeThisSection = detailPageContent?.querySelector('#similarCollapsible');

            if (detailPageContent && moreLikeThisSection) {
                return { detailPageContent, moreLikeThisSection };
            }
            return null;
        };

        // Try immediately
        const immediate = checkPage();
        if (immediate) {
            resolve(immediate);
            return;
        }

        // Set up observer
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

        // Handle abort
        if (signal) {
            signal.addEventListener('abort', () => {
                cleanup();
                resolve(null);
            }, { once: true });
        } else {
            // Leak backstop for a (future) signal-less caller ONLY: a real
            // timer (a lazy mutation-time check never fires once a stuck page
            // stops mutating). Never a UX budget (R9); every current caller
            // passes a signal and never takes this path.
            backstopTimer = setTimeout(() => {
                cleanup();
                resolve(checkPage());
            }, 120_000);
        }

        observerHandle = JC.helpers!.onBodyMutation!(`seerr-item-details-page-detect-${++detailReadySeq}`, () => {
            const result = checkPage();
            if (result) {
                cleanup();
                resolve(result);
            }
        });
    });
}

/**
 * Creates a Seerr section similar to search results
 * @param {Array} results - Array of Seerr items
 * @param {string} title - Section title (already translated)
 * @returns {HTMLElement} - Section element
 */
function createSeerrSection(results: any[], title: string, context: IdentityContext): HTMLElement | null {
    if (!isCurrent(context)) return null;
    if (!results || results.length === 0) {
        return null;
    }

    // Filter out library items if configured
    const excludeLibraryItems = JC.pluginConfig?.SeerrExcludeLibraryItems === true;
    let filteredResults = results;

    if (excludeLibraryItems) {
        filteredResults = results.filter((item: any) => !item.mediaInfo?.jellyfinMediaId);
    }
    if (JC.hiddenContent) {
        filteredResults = JC.hiddenContent.filterSeerrResults(filteredResults, 'recommendations');
    }

    if (filteredResults.length === 0) {
        return null;
    }

    const section = document.createElement('div');
    section.className = 'verticalSection emby-scroller-container seerr-details-section';
    section.dataset.jcIdentityOwned = 'true';
    JC.identity.own(section, context);
    section.setAttribute('data-seerr-section', 'true');

    const titleElement = document.createElement('h2');
    titleElement.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-right';
    titleElement.textContent = title || 'Recommended';
    section.appendChild(titleElement);

    const scrollerContainer = document.createElement('div');
    scrollerContainer.setAttribute('is', 'emby-scroller');
    scrollerContainer.className = 'padded-top-focusscale padded-bottom-focusscale no-padding emby-scroller';
    scrollerContainer.dataset.horizontal = "true";
    scrollerContainer.dataset.centerfocus = "card";
    scrollerContainer.dataset.scrollModeX = "custom";

    // Enable smooth native horizontal touch scrolling (from KefinTweaks)
    scrollerContainer.style.scrollSnapType = 'none';
    scrollerContainer.style.touchAction = 'auto';
    scrollerContainer.style.overscrollBehaviorX = 'contain';
    scrollerContainer.style.overscrollBehaviorY = 'auto';
    (scrollerContainer.style as any).webkitOverflowScrolling = 'touch';

    const itemsContainer = document.createElement('div');
    itemsContainer.setAttribute('is', 'emby-itemscontainer');
    itemsContainer.className = 'focuscontainer-x itemsContainer scrollSlider animatedScrollX';
    itemsContainer.style.whiteSpace = 'nowrap';

    // Use DocumentFragment for batch DOM insertion
    const fragment = document.createDocumentFragment();

    // Add items to container
    for (const item of filteredResults) {
        const card = JC.seerrUI && JC.seerrUI.createSeerrCard
            ? JC.seerrUI.createSeerrCard(item, true, true)
            : null;
        if (card) {
            const titleLink: HTMLAnchorElement | null = card.querySelector('.cardText-first a');

            // If item exists in library, link to library item
            const jellyfinMediaId = item.mediaInfo?.jellyfinMediaId;
            if (jellyfinMediaId) {
                card.setAttribute('data-library-item', 'true');
                card.setAttribute('data-jellyfin-media-id', jellyfinMediaId);
                card.classList.add('seerr-card-in-library');
                // Update title link to point to library item
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
    }

    itemsContainer.appendChild(fragment);
    scrollerContainer.appendChild(itemsContainer);
    section.appendChild(scrollerContainer);
    return section;
}

/**
 * Renders Similar and Recommended sections for an item
 * @param {string} itemId - Jellyfin item ID
 */
async function renderSimilarAndRecommended(itemId: string) {
    const context = JC.identity.capture();
    if (!context) return;
    // Prevent duplicate renders (check only - add after success)
    if (processedItems.has(itemId)) {
        return;
    }

    // Cancel any previous in-flight requests
    if (currentAbortController) {
        currentAbortController.abort();
    }
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    // Start metrics if enabled
    if (JC.requestManager?.metrics?.enabled) {
        JC.requestManager.startMeasurement('similar-recommended');
    }

    try {
        // Check configuration settings early
        const showSimilar = JC.pluginConfig?.SeerrShowSimilar === true;
        const showRecommended = JC.pluginConfig?.SeerrShowRecommended === true;

        if (!showSimilar && !showRecommended) {
            console.debug(`${logPrefix} Both similar and recommended sections are disabled in settings`);
            return;
        }

        // Check if Seerr is active
        const status = await JC.seerrAPI!.checkUserStatus();
        if (!isCurrent(context, signal)) return;

        if (!status || !status.active) {
            console.debug(`${logPrefix} Seerr is not active, skipping`);
            return;
        }

        // Get TMDB ID and type
        const { tmdbId, type } = await getTmdbIdFromItem(itemId, context, signal);
        if (!isCurrent(context, signal)) return;

        if (!tmdbId || !type) {
            console.debug(`${logPrefix} No valid TMDB ID found for item, skipping`);
            return;
        }

        console.debug(`${logPrefix} Fetching similar and recommended content for TMDB ID ${tmdbId} (${type})`);

        // Fetch only the data that's enabled, passing signal for cancellation
        const fetchOptions = { signal };
        const promises: any[] = [];

        if (showSimilar) {
            promises.push(
                type === 'movie'
                    ? JC.seerrAPI!.fetchSimilarMovies(tmdbId, fetchOptions)
                    : JC.seerrAPI!.fetchSimilarTvShows(tmdbId, fetchOptions)
            );
        } else {
            promises.push(Promise.resolve({ results: [] }));
        }

        if (showRecommended) {
            promises.push(
                type === 'movie'
                    ? JC.seerrAPI!.fetchRecommendedMovies(tmdbId, fetchOptions)
                    : JC.seerrAPI!.fetchRecommendedTvShows(tmdbId, fetchOptions)
            );
        } else {
            promises.push(Promise.resolve({ results: [] }));
        }

        // Wait for page to be ready in parallel with data fetch
        const [similarData, recommendedData, pageReady] = await Promise.all([
            ...promises,
            waitForDetailPageReady(itemId, signal)
        ]);

        if (!isCurrent(context, signal)) return;

        const similarResults = similarData?.results || [];
        const recommendedResults = recommendedData?.results || [];

        if (similarResults.length === 0 && recommendedResults.length === 0) {
            console.debug(`${logPrefix} No similar or recommended content to display`);
            return;
        }

        // Check page readiness
        if (!pageReady) {
            console.warn(`${logPrefix} Page not ready for insertion`);
            return;
        }

        const { detailPageContent, moreLikeThisSection } = pageReady;

        // Filter items if configured to exclude library items or blocklisted items (status 6)
        const excludeLibraryItems = JC.pluginConfig?.SeerrExcludeLibraryItems === true;
        const excludeBlocklistedItems = JC.pluginConfig?.SeerrExcludeBlocklistedItems === true;

        const filteredSimilarResults = similarResults.filter((item: any) => {
            if (excludeLibraryItems && item.mediaInfo?.jellyfinMediaId) return false;
            if (excludeBlocklistedItems && item.mediaInfo?.status === JC.seerrStatus!.MEDIA.BLOCKED) return false;
            return true;
        });

        const filteredRecommendedResults = recommendedResults.filter((item: any) => {
            if (excludeLibraryItems && item.mediaInfo?.jellyfinMediaId) return false;
            if (excludeBlocklistedItems && item.mediaInfo?.status === JC.seerrStatus!.MEDIA.BLOCKED) return false;
            return true;
        });

        if (filteredSimilarResults.length === 0 && filteredRecommendedResults.length === 0) {
            console.debug(`${logPrefix} No content to display after filtering library items`);
            return;
        }

        // Final abort check before DOM manipulation
        if (!isCurrent(context, signal)) return;

        // Remove any existing Seerr sections to avoid duplicates
        detailPageContent.querySelectorAll('.seerr-details-section').forEach((el: Element) => el.remove());

        // PERF(R7): sections are built fully off-DOM (cards included) and inserted
        // once, below the fold — no empty-shell insert, no incremental fill.

        // Create and insert sections
        if (filteredRecommendedResults.length > 0) {
            const recommendedTitle = JC.t ? (JC.t('seerr_recommended_title') || 'Recommended') : 'Recommended';
            const recommendedSection = createSeerrSection(
                filteredRecommendedResults.slice(0, 20),
                recommendedTitle,
                context
            );
            if (recommendedSection) {
                moreLikeThisSection.after(recommendedSection);
                console.debug(`${logPrefix} Added Recommended section with ${filteredRecommendedResults.length} items`);
            }
        }

        if (filteredSimilarResults.length > 0) {
            const similarTitle = JC.t ? (JC.t('seerr_similar_title') || 'Similar') : 'Similar';
            const similarSection = createSeerrSection(
                filteredSimilarResults.slice(0, 20),
                similarTitle,
                context
            );
            if (similarSection) {
                const lastSeerrSection = detailPageContent.querySelector('.seerr-details-section:last-of-type');
                if (lastSeerrSection) {
                    lastSeerrSection.after(similarSection);
                } else {
                    moreLikeThisSection.after(similarSection);
                }
                console.debug(`${logPrefix} Added Similar section with ${filteredSimilarResults.length} items`);
            }
        }

        // Mark as successfully processed AFTER successful render
        processedItems.add(itemId);

        // End metrics
        if (JC.requestManager?.metrics?.enabled) {
            JC.requestManager.endMeasurement('similar-recommended');
        }

    } catch (error: any) {
        // Silently ignore abort errors (don't mark as processed so retry is possible)
        if (error.name === 'AbortError') {
            console.debug(`${logPrefix} Request aborted for item ${itemId}`);
            return;
        }
        console.error(`${logPrefix} Error rendering similar and recommended sections:`, error);
    }
}

/**
 * Polls a predicate until it returns a truthy value, the abort signal
 * fires, or the timeout is reached. Returns the truthy value, or null
 * on abort/timeout. Used instead of MutationObserver subscriptions for
 * conditions that depend on attribute/characterData changes — the
 * project's shared body observer only dispatches on childList mutations
 * (helpers.js fast-paths attribute/text mutations at line 38), so an
 * observer-based wait would miss a `classList.remove('hide')` or a
 * `span.textContent = 'Series'` mutation entirely unless some unrelated
 * childList mutation happened to fire around the same time.
 * @param {() => any} predicate - Called repeatedly; truthy return resolves.
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=100]
 * @param {number} [opts.timeoutMs=5000]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<any|null>}
 */
function pollUntil(predicate: () => any, opts: any = {}): Promise<any> {
    // PERF(R9): fail open — the deadline exists as a leak backstop, not a UX
    // budget; callers pass generous timeouts and the poll interval decays
    // (doubling up to maxIntervalMs) so holding the wait open on a slow host
    // costs almost nothing. Every caller passes the per-page-view AbortSignal,
    // so navigation ends the poll immediately (R5: page-scoped, no standing
    // timer beyond the view).
    const { intervalMs = 100, timeoutMs = 5000, maxIntervalMs = intervalMs, signal } = opts;
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(null);
            return;
        }
        const immediate = predicate();
        if (immediate) {
            resolve(immediate);
            return;
        }
        // The soft budget counts VISIBLE time only — a tab hidden past the
        // whole window would otherwise get a single probe on return and give
        // up. Decremented by the nominal interval on each visible tick.
        let remainingVisibleMs = timeoutMs;
        let currentInterval = intervalMs;
        let timerId: any = null;
        const finish = (value: any) => {
            if (timerId) clearTimeout(timerId);
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const onAbort = () => finish(null);
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        const tick = () => {
            if (signal?.aborted) return finish(null);
            // PERF(R5/R9): visibility-gated — a hidden tab skips the DOM probe
            // and does not burn the budget; the wait resumes with its full
            // remaining window when the tab returns. Nav abort ends it either way.
            if (document.visibilityState === 'hidden') {
                timerId = setTimeout(tick, maxIntervalMs);
                return;
            }
            const result = predicate();
            if (result) return finish(result);
            remainingVisibleMs -= currentInterval;
            if (remainingVisibleMs <= 0) return finish(null);
            currentInterval = Math.min(maxIntervalMs, currentInterval * 2);
            timerId = setTimeout(tick, currentInterval);
        };
        timerId = setTimeout(tick, currentInterval);
    });
}

/**
 * Waits for the Seasons section heading on a Series detail page to become
 * visible. On a Series page Jellyfin renders the seasons list inside
 * #listChildrenCollapsible (NOT #childrenCollapsible — that variant is
 * used for non-Series item types and stays hidden). The heading inside
 * is an h2.sectionTitle.sectionTitle-cards with a child <span> whose
 * text reads "Series" once Jellyfin has populated it.
 *
 * Uses polling instead of a MutationObserver because the readiness
 * conditions are attribute (`hide` class removal) and characterData
 * (span text set) mutations, which the project's shared body observer
 * does not dispatch on.
 *
 * @param {string} itemId - The series the button is for; only the page shown
 * for this item can match (see waitForDetailPageReady).
 * @param {AbortSignal} [signal]
 * @returns {Promise<HTMLElement|null>}
 */
function waitForSeasonsHeading(itemId: string, signal?: AbortSignal): Promise<any> {
    return pollUntil(() => {
        // Only the page shown for THIS item — on a series→series push the
        // outgoing page's seasons heading is still visible and matching it
        // would hang the button on a view about to be hidden.
        const resolved = getVisibleDetailsPage();
        if (!resolved || resolved.itemId !== itemId) return null;
        const activePage = resolved.page;
        const collapsible = activePage.querySelector('#listChildrenCollapsible');
        if (!collapsible || collapsible.classList.contains('hide')) return null;
        const heading = collapsible.querySelector('h2.sectionTitle.sectionTitle-cards');
        if (!heading || heading.classList.contains('hide')) return null;
        // Wait until Jellyfin has populated the title span (initially empty)
        const span = heading.querySelector('span');
        if (!span || !span.textContent.trim()) return null;
        return heading;
        // PERF(R9): 5s was a give-up that lost the button on slow hosts; the
        // decayed poll makes a long window nearly free and nav aborts it.
    }, { intervalMs: 100, maxIntervalMs: 1000, timeoutMs: 60_000, signal });
}

/**
 * Waits for `JC.seerrMoreInfo.checkForUnrequestedSeasons` to become
 * available. The Seerr modules are loaded in parallel by plugin.js
 * via dynamically-inserted <script> tags, so on a cold page load
 * item-details.js may execute before more-info-modal.js has finished
 * parsing and attached its API. The checker is required for deciding
 * whether to render the Request More button.
 * @param {AbortSignal} [signal]
 * @returns {Promise<Function|null>}
 */
function waitForChecker(signal?: AbortSignal): Promise<any> {
    return pollUntil(
        () => {
            const fn = JC.seerrMoreInfo && JC.seerrMoreInfo.checkForUnrequestedSeasons;
            return typeof fn === 'function' ? fn : null;
        },
        // PERF(R9): on a slow connection the module scripts themselves load
        // slowly — 3s lost the button for the page view. Decayed poll + nav abort.
        { intervalMs: 50, maxIntervalMs: 500, timeoutMs: 30_000, signal }
    );
}

/**
 * Builds the Request More button DOM. Reuses the .seerr-request-button
 * styling already injected by ui.js so visuals match the rest of Seerr UI.
 * Uses textContent / DOM construction (no innerHTML) for safety.
 * @param {object} tvDetails - TV show details from Seerr
 * @returns {HTMLButtonElement}
 */
function buildSeriesRequestMoreButton(tvDetails: any, context: IdentityContext): HTMLButtonElement {
    // Defensive: i18n table may not be initialized yet on first navigation;
    // match the fallback pattern used elsewhere in this file.
    const labelText = (JC.t && JC.t('seerr_btn_request_more')) || 'Request More';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `seerr-request-button seerr-button-request ${REQUEST_MORE_BTN_CLASS}`;
    button.dataset.jcIdentityOwned = 'true';
    JC.identity.own(button, context);
    button.title = labelText;
    // Inline overrides so the button sits comfortably next to the h2 text
    // without inheriting the heading's font size or block layout.
    button.style.display = 'inline-flex';
    button.style.alignItems = 'center';
    button.style.verticalAlign = 'middle';
    button.style.fontSize = '0.85rem';
    button.style.padding = '0.4em 0.9em';
    button.style.marginLeft = '1em';

    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'download';
    icon.style.marginRight = '0.4em';
    icon.style.fontSize = '1.1em';

    const labelSpan = document.createElement('span');
    labelSpan.textContent = labelText;

    button.appendChild(icon);
    button.appendChild(labelSpan);

    button.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isCurrent(context)) return;
        if (JC.seerrUI?.showSeasonSelectionModal) {
            JC.seerrUI.showSeasonSelectionModal(
                tvDetails.id,
                'tv',
                tvDetails.name || tvDetails.title,
                tvDetails
            );
        }
    });

    return button;
}

/**
 * Renders a "Request More" button next to the Seasons section heading on
 * a Series detail page when the show has unrequested seasons in Seerr.
 * Reuses checkForUnrequestedSeasons from more-info-modal.js so the
 * detection logic stays in one place.
 * @param {string} itemId - Jellyfin item ID
 */
async function renderSeriesRequestMoreButton(itemId: string) {
    const context = JC.identity.capture();
    if (!context) return;
    if (processedRequestMoreItems.has(itemId)) return;

    // Cancel any in-flight Request More check from a previous navigation.
    if (requestMoreAbortController) {
        requestMoreAbortController.abort();
    }
    requestMoreAbortController = new AbortController();
    const signal = requestMoreAbortController.signal;

    try {
        if (!JC.pluginConfig?.SeerrEnabled) return;
        if (JC.pluginConfig?.SeerrShowRequestMoreOnSeries === false) return;

        const status = await JC.seerrAPI!.checkUserStatus();
        if (!isCurrent(context, signal)) return;
        if (!status?.active) return;

        const { tmdbId, type } = await getTmdbIdFromItem(itemId, context, signal);
        if (!isCurrent(context, signal)) return;
        if (!tmdbId || type !== 'tv') return;

        const tvDetails = await JC.seerrAPI!.fetchTvShowDetails(tmdbId, { signal }) as unknown as {
            name?: string;
            title?: string;
            [key: string]: any;
        };
        if (!isCurrent(context, signal)) return;
        if (!tvDetails) return;

        // PERF(R7): resolve the Seasons heading in parallel with the checker and
        // PRE-APPLY the flex layout class as soon as the heading renders — not
        // when the button lands. Flipping the h2 from block to flex at button
        // time nudged the heading's baseline right as the user read it; doing
        // it at section-render time makes the (visually identical) layout the
        // heading's first painted state, and the later button append displaces
        // nothing but trailing free space.
        const headingPromise = waitForSeasonsHeading(itemId, signal);
        void headingPromise.then((heading: unknown) => {
            if (heading instanceof HTMLElement && isCurrent(context, signal)) {
                heading.classList.add('jc-series-request-more-heading');
            }
        });

        // Wait for the checker to become available — the Seerr
        // modules load in parallel via dynamically-inserted <script>
        // tags, so more-info-modal.js may still be parsing when we get
        // here on a cold load. Polling up to 3s avoids a one-shot race
        // where the button would otherwise never appear until the user
        // navigates away and back.
        const checker = await waitForChecker(signal);
        if (!isCurrent(context, signal)) return;
        if (!checker) {
            console.warn(`${requestMoreLogPrefix} checkForUnrequestedSeasons unavailable after 3s, skipping`);
            return;
        }
        const hasUnrequested = await checker(tvDetails);
        if (!isCurrent(context, signal)) return;
        if (!hasUnrequested) {
            // Dedupe negative results too. Each call to checker() runs an
            // HTTP request to /JellyfinCanopy/seerr/request, so we
            // don't want to repeat it on every viewshow for the same item.
            // cleanup() clears this set on real navigation.
            processedRequestMoreItems.add(itemId);
            console.debug(`${requestMoreLogPrefix} No unrequested seasons for "${tvDetails.name || tvDetails.title}"`);
            return;
        }

        const heading = await headingPromise;
        if (!isCurrent(context, signal)) return;
        if (!heading) {
            console.debug(`${requestMoreLogPrefix} Seasons heading not found, skipping`);
            return;
        }

        // Dedup: bail if we already injected a button into this heading.
        if (heading.querySelector(`.${REQUEST_MORE_BTN_CLASS}`)) {
            processedRequestMoreItems.add(itemId);
            return;
        }

        // The flex layout class was pre-applied when the heading rendered (see
        // headingPromise above). PERF(R7): appending at the heading's flow end
        // displaces nothing but trailing free space — single insert, content
        // fully built (no empty-shell insert).
        const button = buildSeriesRequestMoreButton(tvDetails, context);
        heading.appendChild(button);

        processedRequestMoreItems.add(itemId);
        console.debug(`${requestMoreLogPrefix} Added Request More button for "${tvDetails.name || tvDetails.title}"`);
    } catch (error: any) {
        if (error.name === 'AbortError') {
            console.debug(`${requestMoreLogPrefix} Aborted for item ${itemId}`);
            return;
        }
        console.error(`${requestMoreLogPrefix} Error rendering button:`, error);
    }
}

/**
 * Handles item details page navigation
 */
function handleItemDetailsPage() {
    const context = JC.identity.capture();
    if (!context) return;
    // Details route on either layout: the legacy layout keeps it in the hash
    // (#/details?id=X), the modern layout in the path + search
    // (/web/details?id=X with an empty hash). The old hash-only check meant
    // these sections could never inject on the modern layout at all.
    const onDetailsRoute = window.location.hash.includes('/details?')
        || window.location.pathname.endsWith('/details');
    if (!onDetailsRoute) {
        return;
    }

    const itemId = getItemIdFromUrl();
    if (itemId) {
        for (const pending of pendingFrames) cancelAnimationFrame(pending);
        pendingFrames.clear();
        // Use requestAnimationFrame instead of fixed timeout
        // This ensures we're in sync with the rendering cycle
        const frame = requestAnimationFrame(() => {
            pendingFrames.delete(frame);
            if (!isCurrent(context)) return;
            void renderSimilarAndRecommended(itemId);
            void renderSeriesRequestMoreButton(itemId);
        });
        pendingFrames.add(frame);
    }
}

/**
 * Cleanup function for navigation
 */
function cleanup() {
    for (const frame of pendingFrames) cancelAnimationFrame(frame);
    pendingFrames.clear();
    // Abort any in-flight requests
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
    }
    if (requestMoreAbortController) {
        requestMoreAbortController.abort();
        requestMoreAbortController = null;
    }
    // Clear processed items caches
    processedItems.clear();
    processedRequestMoreItems.clear();
    document.querySelectorAll('.seerr-details-section, .' + REQUEST_MORE_BTN_CLASS).forEach((node) => node.remove());
    document.querySelectorAll('.jc-series-request-more-heading').forEach((node) => {
        node.classList.remove('jc-series-request-more-heading');
    });
}

/**
 * Injects the CSS used by the Series "Request More" button. Kept tiny so
 * it can live alongside the JS module instead of needing a separate file.
 */
function injectRequestMoreStyles() {
    if (document.getElementById('jc-series-request-more-styles')) return;
    const style = document.createElement('style');
    style.id = 'jc-series-request-more-styles';
    style.textContent = `
        h2.sectionTitle.sectionTitle-cards.jc-series-request-more-heading {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
        }
    `;
    document.head.appendChild(style);
}

/**
 * Initializes the item details handler
 */
function initialize() {
    if (initialized) return;
    initialized = true;
    console.debug(`${logPrefix} Initializing Recommendations and Similar sections`);
    injectRequestMoreStyles();

    // Lifecycle: run cleanup() on EVERY navigation — hashchange, popstate
    // AND the pushState transitions the old raw hashchange listener
    // missed. Teardown wiring is registered first so cleanup always runs
    // before handleItemDetailsPage on a navigation.
    navigationSubscriptions.push(JC.core.navigation!.onNavigate(() => {
        cleanup();
        handleItemDetailsPage();
    }));

    // Check current page on load
    handleItemDetailsPage();

    // Also react to view shows (Jellyfin's custom viewshow event)
    navigationSubscriptions.push(JC.core.navigation!.onViewPage(() => handleItemDetailsPage()));
}

export function installSeerrItemDetails(): () => void {
    unregisterIdentityReset ??= JC.identity.registerReset('seerr-item-details-identity', cleanup);
    unregisterIdentityActivate ??= JC.identity.registerActivate(
        'seerr-item-details-identity',
        handleItemDetailsPage,
    );
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
    else initialize();
    let installed = true;
    return () => {
        if (!installed) return;
        installed = false;
        document.removeEventListener('DOMContentLoaded', initialize);
        for (const unsubscribe of navigationSubscriptions.splice(0).reverse()) unsubscribe();
        unregisterIdentityReset?.();
        unregisterIdentityReset = null;
        unregisterIdentityActivate?.();
        unregisterIdentityActivate = null;
        cleanup();
        document.getElementById('jc-series-request-more-styles')?.remove();
        initialized = false;
    };
}
