// src/extras/colored-ratings.ts
// Applies color-coded backgrounds to media ratings on item details page

import { JE as JEBase } from '../globals';
import { assetUrl } from '../core/asset-urls';
import { onBodyMutation } from '../core/dom-observer';
import { onNavigate } from '../core/navigation';
import type { PluginConfig } from '../types/je';

/**
 * Local view of the shared namespace adding the public members this module
 * OWNS plus the legacy config members it reads.
 */
const JE = JEBase as typeof JEBase & {
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
let processedElements = new WeakSet<Element>();

function isFeatureEnabled(): boolean {
    return Boolean(window?.JellyfinEnhanced?.pluginConfig?.ColoredRatingsEnabled);
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
        console.error('🪼 Jellyfin Enhanced: Failed to inject ratings CSS', error);
    }
}


function processRatingElements(): void {
    try {
        const elements = document.querySelectorAll<HTMLElement>(CONFIG.targetSelector);

        elements.forEach((element) => {
            if (processedElements.has(element)) {
                const currentRating = element.textContent?.trim();
                const existingRating = element.getAttribute(CONFIG.attributeName);
                if (currentRating === existingRating) {
                    return;
                }
            }

            const ratingText = element.textContent?.trim();
            if (ratingText && ratingText.length > 0) {
                const normalizedRating = normalizeRating(ratingText);

                if (element.getAttribute(CONFIG.attributeName) !== normalizedRating) {
                    element.setAttribute(CONFIG.attributeName, normalizedRating);
                    processedElements.add(element);

                    if (!element.getAttribute('aria-label')) {
                        element.setAttribute('aria-label', `Content rated ${normalizedRating}`);
                    }
                    if (!element.getAttribute('title')) {
                        element.setAttribute('title', `Rating: ${normalizedRating}`);
                    }
                }
            }
        });

    } catch (error) {
        console.error('🪼 Jellyfin Enhanced: Error processing rating elements', error);
    }
}

function normalizeRating(rating: string): string {
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

    return ratingMappings[normalized] || rating.trim();
}

function debouncedProcess(): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(processRatingElements, CONFIG.debounceDelay);
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

function setupMutationObserver(): boolean {
    if (!window.MutationObserver) return false;

    try {
        // PERF(R3): rides the shared structural body observer instead of a
        // dedicated characterData:true body observer — that one fired on the
        // OSD clock's text updates every second during playback. Rating text
        // only ever (re)renders via childList mutations, and the
        // per-navigation pass below covers cached-page re-shows.
        observerHandle = onBodyMutation('colored-ratings', (mutations) => {
            if (mutationsTouchRatings(mutations)) {
                debouncedProcess();
            }
        });
        return true;
    } catch (error) {
        console.error('🪼 Jellyfin Enhanced: Failed to setup ratings observer', error);
        return false;
    }
}

function setupNavigationWatcher(): void {
    if (navUnsubscribe) return;
    // PERF(R5): replaces both the permanent 1Hz full-document polling interval and
    // the per-mutation location.href watcher — one debounced pass per
    // navigation plus a settle pass for late-arriving page content.
    navUnsubscribe = onNavigate(() => {
        if (!isFeatureEnabled()) return;
        debouncedProcess();
        if (navSettleTimer) clearTimeout(navSettleTimer);
        navSettleTimer = setTimeout(processRatingElements, CONFIG.navSettleDelay);
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
    if (isFeatureEnabled()) {
        debouncedProcess();
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
    processedElements = new WeakSet();
}

function initialize(): void {
    if (!isFeatureEnabled()) {
        cleanup();
        return;
    }
    cleanup();
    injectCSS();
    processRatingElements();
    setupMutationObserver();
    setupNavigationWatcher();
}

if (typeof document.visibilityState !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && isFeatureEnabled()) {
            setTimeout(processRatingElements, 100);
        }
    });
}

window.addEventListener('beforeunload', cleanup);
JE.initializeColoredRatings = initialize;
// Expose pause/resume functions for pausescreen.js to control
JE.pauseRatingsPolling = pausePolling;
JE.resumeRatingsPolling = resumePolling;
