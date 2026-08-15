// src/extras/colored-ratings.ts
// Applies color-coded backgrounds to media ratings on item details page

import { JC as JEBase } from '../globals';
import { assetUrl } from '../core/asset-urls';
import { onBodyMutation } from '../core/dom-observer';
import { createStableMethodFacade } from '../core/feature-loader';
import { onNavigate } from '../core/navigation';
import type { IdentityContext, PluginConfig } from '../types/jc';

/**
 * Local view of the shared namespace adding the public members this module
 * OWNS plus the legacy config members it reads.
 */
const JC = JEBase as typeof JEBase & {
    initializeColoredRatings?: () => void;
    pauseRatingsPolling?: () => void;
    resumeRatingsPolling?: () => void;
    isVideoPage?: () => boolean;
    pluginConfig: PluginConfig & { ColoredRatingsEnabled?: boolean };
};

const CONFIG = {
    targetSelector: '.mediaInfoOfficialRating',
    attributeName: 'rating',
    debounceDelay: 100,
    navSettleDelay: 500,
    cssId: 'jellyfin-ratings-style'
};

let observerHandle: { unsubscribe(): void } | null = null;
let navUnsubscribe: (() => void) | null = null;
let navSettleTimer: ReturnType<typeof setTimeout> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
interface RatingElementState {
    sourceText: string | null;
    sourceRating: string | null;
    sourceAriaLabel: string | null;
    sourceTitle: string | null;
    renderedText: string | null;
    renderedRating: string;
    renderedAriaLabel: string | null;
    renderedTitle: string | null;
}
let elementStates = new WeakMap<HTMLElement, RatingElementState>();
let generation = 0;

function isActive(context: IdentityContext, expectedGeneration: number): boolean {
    return generation === expectedGeneration && JC.identity.isCurrent(context);
}

function isFeatureEnabled(): boolean {
    return Boolean(window?.JellyfinCanopy?.pluginConfig?.ColoredRatingsEnabled);
}

function injectCSS(): void {
    if (document.getElementById(CONFIG.cssId)) return;

    try {
        const linkElement = document.createElement('link');
        linkElement.id = CONFIG.cssId;
        linkElement.rel = 'stylesheet';
        linkElement.type = 'text/css';
        // PERF(R6): no remote assets — ratings.css served from the local asset cache.
        linkElement.href = assetUrl('ratings/ratings.css');
        document.head.appendChild(linkElement);
    } catch (error) {
        console.error('🪼 Jellyfin Canopy: Failed to inject ratings CSS', error);
    }
}


function processRatingElements(context: IdentityContext, expectedGeneration: number): void {
    if (!isActive(context, expectedGeneration) || !isFeatureEnabled()) return;
    try {
        const elements = document.querySelectorAll<HTMLElement>(CONFIG.targetSelector);

        elements.forEach((element) => {
            if (!isActive(context, expectedGeneration)) return;
            let state = elementStates.get(element);
            if (state) {
                const currentText = element.textContent;
                const currentRating = element.getAttribute(CONFIG.attributeName);
                const currentAriaLabel = element.getAttribute('aria-label');
                const currentTitle = element.getAttribute('title');
                if (currentText === state.renderedText && currentRating === state.renderedRating
                    && currentAriaLabel === state.renderedAriaLabel && currentTitle === state.renderedTitle) {
                    return;
                }
                // A retained host node can be populated with a different item on
                // navigation. Treat values that no longer match our last render
                // as the new host-owned state so teardown restores the right item.
                if (currentText !== state.renderedText) state.sourceText = currentText;
                if (currentRating !== state.renderedRating) state.sourceRating = currentRating;
                if (currentAriaLabel !== state.renderedAriaLabel) state.sourceAriaLabel = currentAriaLabel;
                if (currentTitle !== state.renderedTitle) state.sourceTitle = currentTitle;
            } else {
                state = {
                    sourceText: element.textContent,
                    sourceRating: element.getAttribute(CONFIG.attributeName),
                    sourceAriaLabel: element.getAttribute('aria-label'),
                    sourceTitle: element.getAttribute('title'),
                    renderedText: element.textContent,
                    renderedRating: '',
                    renderedAriaLabel: element.getAttribute('aria-label'),
                    renderedTitle: element.getAttribute('title'),
                };
                elementStates.set(element, state);
            }

            const ratingText = element.textContent?.trim();
            if (ratingText && ratingText.length > 0) {
                const normalizedRating = normalizeRating(ratingText);
                const isFsk = normalizedRating.startsWith('FSK-');
                const visibleText = isFsk ? normalizedRating : element.textContent;
                let ariaLabel = element.getAttribute('aria-label');
                let title = element.getAttribute('title');
                if (visibleText !== element.textContent) element.textContent = visibleText;
                element.setAttribute(CONFIG.attributeName, normalizedRating);
                if (isFsk || ariaLabel === null) {
                    ariaLabel = `Content rated ${normalizedRating}`;
                    element.setAttribute('aria-label', ariaLabel);
                }
                if (isFsk || title === null) {
                    title = `Rating: ${normalizedRating}`;
                    element.setAttribute('title', title);
                }
                element.dataset.jcColoredRating = 'true';
                state.renderedText = visibleText;
                state.renderedRating = normalizedRating;
                state.renderedAriaLabel = ariaLabel;
                state.renderedTitle = title;
            }
        });

    } catch (error) {
        console.error('🪼 Jellyfin Canopy: Error processing rating elements', error);
    }
}

export function normalizeRating(rating: string): string {
    if (!rating) return '';

    const normalized = rating.replace(/\s+/g, ' ').trim().toUpperCase();

    const ratingMappings: Record<string, string> = {
        'NOT RATED': 'NR',
        'NOT-RATED': 'NR',
        'UNRATED': 'NR',
        'NO RATING': 'NR',
        'APPROVED': 'APPROVED',
        'PASSED': 'PASSED'
    };

    const fsk = normalized.match(/^(?:DE-|FSK(?:-| )?)(0|6|12|16|18)$/);
    if (fsk) return `FSK-${fsk[1]}`;

    return ratingMappings[normalized] || rating.trim();
}

function debouncedProcess(context: IdentityContext, expectedGeneration: number): void {
    if (!isActive(context, expectedGeneration)) return;
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        processRatingElements(context, expectedGeneration);
    }, CONFIG.debounceDelay);
}

/**
 * Decides whether a structural mutation batch can contain (or affect) rating
 * elements. Only inspects the mutation records themselves — the full-document
 * query runs solely inside the debounced processing pass.
 * @param mutations - The structural mutation batch from the shared body observer.
 * @returns True when a rating element was added or its subtree changed.
 */
export function mutationsTouchRatings(mutations: MutationRecord[]): boolean {
    for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;

        for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const el = node as Element;
            if (el.matches?.(CONFIG.targetSelector) || el.querySelector?.(CONFIG.targetSelector)) {
                return true;
            }
        }

        const target = mutation.target as Element;
        if (target.nodeType === Node.ELEMENT_NODE &&
            (target.matches(CONFIG.targetSelector) || target.closest(CONFIG.targetSelector))) {
            return true;
        }
    }
    return false;
}

function setupMutationObserver(context: IdentityContext, expectedGeneration: number): boolean {
    if (!window.MutationObserver) return false;

    try {
        // PERF(R3): rides the shared structural body observer instead of a
        // dedicated characterData:true body observer — that one fired on the
        // OSD clock's text updates every second during playback. Rating text
        // only ever (re)renders via childList mutations, and the
        // per-navigation pass below covers cached-page re-shows.
        observerHandle = onBodyMutation('colored-ratings', (mutations) => {
            if (isActive(context, expectedGeneration) && mutationsTouchRatings(mutations)) {
                debouncedProcess(context, expectedGeneration);
            }
        });
        return true;
    } catch (error) {
        console.error('🪼 Jellyfin Canopy: Failed to setup ratings observer', error);
        return false;
    }
}

function setupNavigationWatcher(context: IdentityContext, expectedGeneration: number): void {
    if (navUnsubscribe) return;
    // PERF(R5): replaces both the permanent 1Hz full-document polling interval and
    // the per-mutation location.href watcher — one debounced pass per
    // navigation plus a settle pass for late-arriving page content.
    navUnsubscribe = onNavigate(() => {
        if (!isActive(context, expectedGeneration) || !isFeatureEnabled()) return;
        debouncedProcess(context, expectedGeneration);
        if (navSettleTimer) clearTimeout(navSettleTimer);
        navSettleTimer = setTimeout(() => {
            navSettleTimer = null;
            processRatingElements(context, expectedGeneration);
        }, CONFIG.navSettleDelay);
    });
}

/**
 * Legacy hook kept for pausescreen.ts: there is no polling interval anymore,
 * so pausing is a no-op.
 */
function pausePolling(): void {
    // Intentionally empty — detection is mutation/navigation driven now.
}

/**
 * Legacy hook kept for pausescreen.ts: schedules one processing pass so the
 * pause screen's rating element is colored as soon as it is shown.
 */
function resumePolling(): void {
    const context = JC.identity.capture();
    if (context && isFeatureEnabled()) {
        debouncedProcess(context, generation);
    }
}

function cleanup(): void {
    if (observerHandle) {
        observerHandle.unsubscribe();
        observerHandle = null;
    }
    if (navUnsubscribe) {
        navUnsubscribe();
        navUnsubscribe = null;
    }
    if (navSettleTimer) {
        clearTimeout(navSettleTimer);
        navSettleTimer = null;
    }
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
}

export function resetColoredRatings(): void {
    generation += 1;
    cleanup();
    document.querySelectorAll<HTMLElement>('[data-jc-colored-rating="true"]').forEach((element) => {
        const state = elementStates.get(element);
        if (state) {
            element.textContent = state.sourceText;
            const restore = (name: string, value: string | null) => {
                if (value === null) element.removeAttribute(name);
                else element.setAttribute(name, value);
            };
            restore(CONFIG.attributeName, state.sourceRating);
            restore('aria-label', state.sourceAriaLabel);
            restore('title', state.sourceTitle);
        } else {
            element.removeAttribute(CONFIG.attributeName);
            element.removeAttribute('aria-label');
            element.removeAttribute('title');
        }
        delete element.dataset.jcColoredRating;
    });
    elementStates = new WeakMap();
    document.getElementById(CONFIG.cssId)?.remove();
}

function initialize(): void {
    resetColoredRatings();
    if (!isFeatureEnabled()) {
        return;
    }
    const context = JC.identity.capture();
    if (!context) return;
    const expectedGeneration = generation;
    injectCSS();
    processRatingElements(context, expectedGeneration);
    setupMutationObserver(context, expectedGeneration);
    setupNavigationWatcher(context, expectedGeneration);
}

function handleVisibilityChange(): void {
    if (typeof document.visibilityState !== 'undefined') {
        const context = JC.identity.capture();
        if (context && document.visibilityState === 'visible' && isFeatureEnabled()) {
            const expectedGeneration = generation;
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                if (isActive(context, expectedGeneration) && isFeatureEnabled()) {
                    processRatingElements(context, expectedGeneration);
                }
            }, 100);
        }
    }
}

const coloredRatingsApi = { initialize, pausePolling, resumePolling };
const stableColoredRatings = createStableMethodFacade<typeof coloredRatingsApi>({
    initialize() {},
    pausePolling() {},
    resumePolling() {},
});

/** Publish compatibility methods and listeners for one lazy-feature activation. */
export function installColoredRatings(): () => void {
    const uninstall = stableColoredRatings.install(coloredRatingsApi);
    JC.initializeColoredRatings = stableColoredRatings.facade.initialize;
    JC.pauseRatingsPolling = stableColoredRatings.facade.pausePolling;
    JC.resumeRatingsPolling = stableColoredRatings.facade.resumePolling;
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', cleanup);
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('beforeunload', cleanup);
        resetColoredRatings();
        uninstall();
    };
}

/** Start the installed implementation without resolving through globals. */
export function initializeColoredRatings(): void {
    coloredRatingsApi.initialize();
}
