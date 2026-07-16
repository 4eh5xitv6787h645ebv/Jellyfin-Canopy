// src/seerr/ui/results.ts
// Search-page result rendering: Seerr section, header icon, season
// status analysis and in-place result updates.
import { JC } from '../../globals';
// PERF(R6): no remote assets — Seerr icon served from the local asset cache.
import { assetUrl } from '../../core/asset-urls';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload + DOM shapes; typed incrementally */


import { ui, internal } from './internal';
const state = internal.state;
const logPrefix = '🪼 Jellyfin Canopy: Seerr UI:';
const MediaStatus = JC.seerrStatus!.MEDIA;
const icons = internal.icons; // requires ui-icons.js to be loaded first

// Keep card buttons in sync when a request is made from other surfaces (e.g., more info modal)
function markCardRequested(tmdbId: any, mediaType: any, is4k: any = false) {
    const button = document.querySelector(`.seerr-request-button[data-tmdb-id="${tmdbId}"]`);
    if (!button) return;

    const requestedLabel = JC?.t ? JC.t('seerr_btn_requested') : 'Requested';
    const setPending = (target: any) => {
        target.innerHTML = `${icons.requested}<span>${requestedLabel}</span>`;
        target.classList.remove('seerr-button-request');
        if (!target.classList.contains('seerr-button-pending')) {
            target.classList.add('seerr-button-pending');
        }
        target.disabled = true;
    };

    if (button.classList.contains('seerr-split-main')) {
        setPending(button);
        const arrow = button.parentElement?.querySelector<HTMLButtonElement>('.seerr-split-arrow');
        if (arrow && is4k) {
            arrow.classList.add('seerr-4k-pending');
            arrow.disabled = true;
        }
    } else {
        setPending(button);
    }

    const card = button.closest('.seerr-card');
    const badge = card?.querySelector<HTMLElement>('.seerr-status-badge');
    if (badge) {
        badge.innerHTML = icons.requested;
        badge.className = 'seerr-status-badge status-requested';
        badge.style.display = 'flex';
    }
}

function handleMediaRequested(e: Event): void {
    const requestEvent = e as CustomEvent<any>;
    const { tmdbId, mediaType, is4k } = requestEvent.detail || {};
    if (!tmdbId || !mediaType) return;
    markCardRequested(String(tmdbId), mediaType, is4k);
}

// ================================
// UI MANAGEMENT FUNCTIONS
// ================================

/**
 * Updates the Seerr icon in the search field based on current state.
 * @param {boolean} isSeerrActive - If the server is reachable.
 * @param {boolean} seerrUserFound - If the current user is linked.
 * @param {boolean} isSeerrOnlyMode - If the results are filtered.
 * @param {function} onToggleFilter - The function to call to toggle the filter.
 */
ui.updateSeerrIcon = function (isSeerrActive: any, seerrUserFound: any, isSeerrOnlyMode: any, onToggleFilter: any) {
    const anchor = document.querySelector('.searchFields .inputContainer') ||
                   document.querySelector('#searchPage .searchFields') ||
                   document.querySelector('#searchPage');
    if (!anchor) return;

    let icon: any = document.getElementById('seerr-search-icon');
    if (!icon) {
        icon = document.createElement('img');
        icon.id = 'seerr-search-icon';
        icon.className = 'seerr-icon';
        icon.src = assetUrl('icons/seerr.svg');
        icon.alt = 'Seerr';

        let tapCount = 0;
        let tapTimer: any = null;
        const handleIconInteraction = () => {
            if (!isSeerrActive || !seerrUserFound || !onToggleFilter) return;
            tapCount++;
            if (tapCount === 1) {
                tapTimer = setTimeout(() => { tapCount = 0; }, 300);
            } else if (tapCount === 2) {
                clearTimeout(tapTimer);
                tapCount = 0;
                onToggleFilter();
            }
        };

        icon.addEventListener('click', handleIconInteraction);
        icon.addEventListener('touchend', (e: any) => { e.preventDefault(); handleIconInteraction(); }, { passive: false });
        icon.setAttribute('tabindex', '0');
        icon.addEventListener('keydown', (e: any) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (!isSeerrActive || !seerrUserFound || !onToggleFilter) return;
                onToggleFilter();
            }
        });
        anchor.appendChild(icon);
    }

    icon.classList.remove('is-active', 'is-disabled', 'is-no-user', 'is-filter-active');
    if (isSeerrActive && seerrUserFound) {
        icon.title = JC.t!(isSeerrOnlyMode ? 'seerr_icon_active_filter_tooltip' : 'seerr_icon_active_tooltip');
        icon.classList.add('is-active');
        if (isSeerrOnlyMode) icon.classList.add('is-filter-active');
    } else if (isSeerrActive && !seerrUserFound) {
        icon.title = JC.t!('seerr_icon_no_user_tooltip');
        icon.classList.add('is-no-user');
    } else {
        icon.title = JC.t!('seerr_icon_disabled_tooltip');
        icon.classList.add('is-disabled');
    }
};

/**
 * Analyzes season statuses to determine overall show status.
 * @param {Array} seasons - Array of season objects with status information.
 * @returns {object} - Analysis result with overall status and summary.
 */
function analyzeSeasonStatuses(seasons: any) {
    if (!seasons || seasons.length === 0) return { overallStatus: 1, statusSummary: null, total: 0 };
    const regularSeasons = seasons.filter((s: any) => s.seasonNumber > 0);
    const total = regularSeasons.length;
    if (total === 0) return { overallStatus: 1, statusSummary: null, total: 0 };

    const statusCounts = {
        available: regularSeasons.filter((s: any) => s.status === MediaStatus.AVAILABLE).length,
        pending: regularSeasons.filter((s: any) => s.status === MediaStatus.PENDING).length,
        processing: regularSeasons.filter((s: any) => s.status === MediaStatus.PROCESSING).length,
        partiallyAvailable: regularSeasons.filter((s: any) => s.status === MediaStatus.PARTIALLY_AVAILABLE).length,
        notRequested: regularSeasons.filter((s: any) => s.status === MediaStatus.UNKNOWN).length
    };
    const requestedCount = statusCounts.pending + statusCounts.processing;
    const availableCount = statusCounts.available + statusCounts.partiallyAvailable;
    const accountedForCount = requestedCount + availableCount;
    let overallStatus, statusSummary = null;

    if (statusCounts.notRequested === 0) {
        overallStatus = (availableCount === total) ? MediaStatus.AVAILABLE : MediaStatus.DELETED;
        if (overallStatus === MediaStatus.DELETED) statusSummary = JC.t!('seerr_seasons_accounted_for', { count: accountedForCount, total });
    } else if (accountedForCount > 0) {
        overallStatus = (availableCount > 0) ? MediaStatus.PARTIALLY_AVAILABLE : MediaStatus.PROCESSING;
        statusSummary = (availableCount > 0) ? JC.t!('seerr_seasons_available_count', { count: availableCount, total }) : JC.t!('seerr_seasons_requested_count', { count: requestedCount, total });
    } else {
        overallStatus = MediaStatus.UNKNOWN;
    }

    // If every regular season is accounted for but the specials season (0) was never
    // requested, still surface a "Request More" affordance instead of marking the
    // show fully Available, so specials-only seasons remain requestable.
    if (overallStatus === MediaStatus.AVAILABLE) {
        const specialsSeason = seasons.find((s: any) => s.seasonNumber === 0);
        if (specialsSeason && specialsSeason.status === MediaStatus.UNKNOWN) {
            overallStatus = MediaStatus.DELETED;
            statusSummary = JC.t!('seerr_seasons_accounted_for', { count: accountedForCount, total });
        }
    }

    return { overallStatus, statusSummary, total, availableCount };
}

// PERF(R7): pending detached-placement watcher for the Seerr section. A newer
// render supersedes (cancels) it so a stale keystroke never inserts late.
let pendingSectionPlacement: { cancel: () => void } | null = null;
const sectionTimers = new Set<number>();
// How long to hold the built section detached waiting for the native
// Movies/Shows sections before falling back to the results container.
const SECTION_PLACEMENT_TIMEOUT_MS = 1000;

/** Cancel detached placement/timers owned by the previous search identity. */
export function resetSeerrResultsIdentity(): void {
    pendingSectionPlacement?.cancel();
    pendingSectionPlacement = null;
    for (const timer of sectionTimers) clearTimeout(timer);
    sectionTimers.clear();
}

ui.resetResultsIdentity = resetSeerrResultsIdentity;

/**
 * Renders Seerr search results into the search page with improved placement logic.
 * @param {Array} results - Array of search result items.
 * @param {string} query - The search query that generated these results.
 * @param {boolean} isSeerrOnlyMode - Whether the filter is active.
 * @param {boolean} isSeerrActive - If the server is reachable.
 * @param {boolean} seerrUserFound - If the current user is linked.
 */
ui.renderSeerrResults = function (results: any, query: any, isSeerrOnlyMode: any, isSeerrActive: any, seerrUserFound: any) {
    const context = JC.identity.capture();
    if (!context) return;
    console.log(`${logPrefix} Rendering results for query: "${query}"`);
    const searchPage = document.querySelector('#searchPage')!;
    if (!searchPage) {
        console.warn(`${logPrefix} #searchPage not found. Cannot render results.`);
        return;
    }

    // A newer render supersedes any still-detached section from the previous
    // keystroke — cancel its placement watcher so it never inserts late.
    resetSeerrResultsIdentity();

    const sectionToInject = createSeerrSection(results, isSeerrOnlyMode, isSeerrActive, seerrUserFound, context);

    // PERF(R7): per-keystroke re-render PATCHES the existing section in place —
    // one replaceChildren() swap inside the same container node — instead of
    // tearing the section down and re-inserting/repositioning it, which
    // visibly jumped the page on every keystroke. Card build is identical;
    // only the mount strategy changed.
    const oldSection = searchPage.querySelector('.seerr-section');
    if (oldSection) {
        const owner = JC.identity.ownerOf(oldSection);
        if (owner && !JC.identity.isCurrent(owner)) {
            oldSection.remove();
        } else {
            oldSection.replaceChildren(...Array.from(sectionToInject.childNodes));
            // Keep the localized no-results message in sync (the full-render path
            // does this at placement time).
            const noResultsMessage = searchPage.querySelector('.noItemsMessage');
            if (noResultsMessage) {
                noResultsMessage.textContent = JC.t!('seerr_no_results_jellyfin', { query });
            }
            return;
        }
    }

    const primarySectionKeywords = ['movies', 'shows', 'film', 'serier', 'filme', 'serien', 'películas', 'series', 'films', 'séries', 'serie tv'];

    /**
     * Finds the last Movies/Shows section in the search results.
     * @returns {HTMLElement|null}
     */
    function findLastPrimarySection() {
        const allSections = Array.from(searchPage.querySelectorAll('.verticalSection:not(.seerr-section)'));
        for (let i = allSections.length - 1; i >= 0; i--) {
            const title = allSections[i].querySelector('.sectionTitle')?.textContent.trim().toLowerCase();
            if (title && primarySectionKeywords.some((keyword: any) => title.includes(keyword))) {
                return allSections[i];
            }
        }
        return null;
    }

    /**
     * Inserts the section at its proper anchor when one exists NOW: after the
     * no-results message, or after the last native Movies/Shows section.
     * @returns {boolean} True if the section was inserted.
     */
    function tryPlaceAtAnchor() {
        if (!JC.identity.isCurrent(context) || !searchPage.isConnected) return false;
        const noResultsMessage = searchPage.querySelector('.noItemsMessage');
        if (noResultsMessage) {
            noResultsMessage.textContent = JC.t!('seerr_no_results_jellyfin', { query });
            noResultsMessage.parentElement!.insertBefore(sectionToInject, noResultsMessage.nextSibling);
            return true;
        }

        const lastPrimary = findLastPrimarySection();
        if (lastPrimary) {
            lastPrimary.after(sectionToInject);
            return true;
        }
        return false;
    }

    // PERF(R1): determine the insertion point BEFORE injecting. If the anchor
    // exists, this is a single insert at the final position. Otherwise the
    // built section stays DETACHED (off-DOM) until the native sections render,
    // then inserts once — inside the same mutation batch that added them, so
    // it is part of their first painted frame. The section is never moved
    // after insertion (the old inject-at-fallback-then-reposition flow was the
    // visible jump this replaces).
    if (tryPlaceAtAnchor()) return;

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
        if (!JC.identity.isCurrent(context)) {
            resetSeerrResultsIdentity();
            return;
        }
        if (searchPage.querySelector('.noItemsMessage') || findLastPrimarySection()) {
            cancel();
            pendingSectionPlacement = null;
            tryPlaceAtAnchor();
        }
    });
    const cancel = () => {
        observer.disconnect();
        if (timeoutId) {
            clearTimeout(timeoutId);
            sectionTimers.delete(Number(timeoutId));
            timeoutId = null;
        }
    };
    pendingSectionPlacement = { cancel };
    observer.observe(searchPage, { childList: true, subtree: true });

    // Timeout: anchor never appeared — insert at the fallback position once,
    // WITHOUT any later repositioning.
    timeoutId = setTimeout(() => {
        cancel();
        pendingSectionPlacement = null;
        if (!JC.identity.isCurrent(context) || !searchPage.isConnected) return;
        const resultsContainer = searchPage.querySelector('.searchResults, [class*="searchResults"], .padded-top.padded-bottom-page');
        if (resultsContainer) {
            resultsContainer.appendChild(sectionToInject);
        } else {
            searchPage.appendChild(sectionToInject);
        }
    }, SECTION_PLACEMENT_TIMEOUT_MS);
    sectionTimers.add(Number(timeoutId));
};

/**
 * Creates the main Seerr results section.
 * @param {Array} results - Array of search result items.
 * @param {boolean} isSeerrOnlyMode - Whether the filter is active.
 * @param {boolean} isSeerrActive - If the server is reachable.
 * @param {boolean} seerrUserFound - If the current user is linked.
 * @returns {HTMLElement} - Section element.
 */
function createSeerrSection(
    results: any = [],
    isSeerrOnlyMode: any,
    isSeerrActive: any,
    seerrUserFound: any,
    context = JC.identity.capture()
) {
    const section = document.createElement('div');
    section.className = 'verticalSection emby-scroller-container seerr-section';
    section.setAttribute('data-seerr-section', 'true');
    section.setAttribute('data-jc-identity-owned', 'true');
    if (context) JC.identity.own(section, context);

    const title = document.createElement('h2');
    title.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-left padded-right';
    title.textContent = isSeerrOnlyMode ? JC.t!('seerr_results_title') : JC.t!('seerr_discover_title');

    // Add a refresh button beside the results heading
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'seerr-refresh-btn';
    refreshBtn.style.marginLeft = '0.5em';
    refreshBtn.style.verticalAlign = 'middle';
    refreshBtn.style.background = 'none';
    refreshBtn.style.border = 'none';
    refreshBtn.style.cursor = 'pointer';
    refreshBtn.style.display = 'inline-flex';
    refreshBtn.style.alignItems = 'center';
    refreshBtn.style.justifyContent = 'center';
    refreshBtn.style.padding = '0';
    const icon = document.createElement('span');
    icon.className = 'material-icons seerr-refresh-icon';
    icon.textContent = 'refresh';
    icon.style.transition = 'transform 0.5s cubic-bezier(.4,2,.6,1)';
    refreshBtn.appendChild(icon);
    refreshBtn.addEventListener('click', function (e: any) {
        e.preventDefault();
        e.stopPropagation();
        if (!context || !JC.identity.isCurrent(context)) return;
        icon.style.transform = 'rotate(360deg)';
        const timer = window.setTimeout(() => {
            sectionTimers.delete(timer);
            if (JC.identity.isCurrent(context)) icon.style.transform = '';
        }, 500);
        sectionTimers.add(timer);
        document.dispatchEvent(new CustomEvent('seerr-manual-refresh'));
    });
    title.appendChild(refreshBtn);
if (!document.getElementById('seerr-refresh-style')) {
    const style = document.createElement('style');
    style.id = 'seerr-refresh-style';
    style.textContent = `
        .seerr-refresh-btn:focus { outline: none; }
        .seerr-refresh-icon { color: #fff; filter: opacity(0.6); }
        .seerr-refresh-btn:hover .seerr-refresh-icon { color: #fff; filter: opacity(0.9); }
    `;
    document.head.appendChild(style);
}
    section.appendChild(title);

    const scrollerContainer = document.createElement('div');
    scrollerContainer.setAttribute('is', 'emby-scroller');
    scrollerContainer.className = 'padded-top-focusscale padded-bottom-focusscale emby-scroller';
    scrollerContainer.dataset.horizontal = "true";
    scrollerContainer.dataset.centerfocus = "card";

    const itemsContainer = document.createElement('div');
    itemsContainer.setAttribute('is', 'emby-itemscontainer');
    itemsContainer.className = 'focuscontainer-x itemsContainer scrollSlider';

    const isTvMode = document.querySelector('.alphaPicker-tv') !== null;
    if (isTvMode) {
        itemsContainer.classList.add('itemsContainer-tv');
        itemsContainer.classList.add('animatedScrollX');
    }

    results.forEach((item: any) => {
        const card = internal.createSeerrCard(item, isSeerrActive, seerrUserFound);
        itemsContainer.appendChild(card);
    });

    scrollerContainer.appendChild(itemsContainer);
    section.appendChild(scrollerContainer);
    return section;
}

/**
 * Updates existing Seerr results in the DOM with fresh data.
 * @param {Array} newResults - The new array of result items from the API.
 * @param {boolean} isSeerrActive - If the server is reachable.
 * @param {boolean} seerrUserFound - If the current user is linked.
 */
ui.updateSeerrResults = function (newResults: any, isSeerrActive: any, seerrUserFound: any) {
    const existingButtons = document.querySelectorAll('.seerr-request-button[data-tmdb-id]');
    if (existingButtons.length === 0) return;

    existingButtons.forEach((button: any) => {
        const tmdbId = button.dataset.tmdbId;
        const newItem = newResults.find((item: any) => item.id.toString() === tmdbId);
        if (!newItem) return;

        const oldItemJSON = button.dataset.searchResultItem;
        if (!oldItemJSON) return;

        // Simple check: compare JSON strings of mediaInfo
        const oldMediaInfo = JSON.parse(oldItemJSON).mediaInfo;
        const newMediaInfo = newItem.mediaInfo;
        if (JSON.stringify(oldMediaInfo) !== JSON.stringify(newMediaInfo)) {
            console.log(`${logPrefix} Status change detected for TMDB ID ${tmdbId}. Updating button.`);
            internal.configureRequestButton(button, newItem, isSeerrActive, seerrUserFound);

            // If the popover for this item is currently visible, update it
            if (state.seerrHoverPopover &&
                state.seerrHoverPopover.classList.contains('show') &&
                state.seerrHoverPopover.dataset.tmdbId === tmdbId) {

                console.log(`${logPrefix} Active popover found for TMDB ID ${tmdbId}. Refreshing content.`);
                const popoverContent = internal.fillHoverPopover(newItem);
                if (popoverContent) {
                    const { clientX, clientY } = state.seerrHoverPopover.dataset;
                    internal.positionHoverPopover(popoverContent, parseFloat(clientX), parseFloat(clientY));
                } else {
                    ui.hideHoverPopover(); // Hide if there's no longer valid download data
                }
            }
        }
    });
};
internal.markCardRequested = markCardRequested;
internal.analyzeSeasonStatuses = analyzeSeasonStatuses;
internal.createSeerrSection = createSeerrSection;

let uninstallIdentityReset: (() => void) | null = null;
let requestListenerInstalled = false;

export function installSeerrResults(): () => void {
    uninstallIdentityReset ??= JC.identity.registerReset(
        'seerr-results-placement',
        resetSeerrResultsIdentity,
    );
    if (!requestListenerInstalled) {
        document.addEventListener('seerr-media-requested', handleMediaRequested);
        requestListenerInstalled = true;
    }
    let installed = true;
    return () => {
        if (!installed) return;
        installed = false;
        uninstallIdentityReset?.();
        uninstallIdentityReset = null;
        if (requestListenerInstalled) {
            document.removeEventListener('seerr-media-requested', handleMediaRequested);
            requestListenerInstalled = false;
        }
        resetSeerrResultsIdentity();
    };
}


installSeerrResults();
