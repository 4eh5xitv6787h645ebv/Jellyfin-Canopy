// src/extras/colored-ratings.ts
// Applies color-coded backgrounds to media ratings on item details page

import { JE as JEBase } from '../globals';
import type { PluginConfig } from '../types/je';

/**
 * Local view of the shared namespace adding the public members this module
 * OWNS plus the legacy helper/config members it reads.
 */
const JE = JEBase as typeof JEBase & {
    initializeColoredRatings?: () => void;
    pauseRatingsPolling?: () => void;
    resumeRatingsPolling?: () => void;
    isVideoPage?: () => boolean;
    pluginConfig: PluginConfig & { ColoredRatingsEnabled?: boolean };
    helpers?: {
        onBodyMutation?: (id: string, cb: (mutations: MutationRecord[]) => void) => { unsubscribe(): void };
        createObserver?: (id: string, cb: MutationCallback, target: Node, config: MutationObserverInit) => MutationObserver;
    };
};

const CONFIG = {
    targetSelector: '.mediaInfoOfficialRating',
    attributeName: 'rating',
    fallbackInterval: 1000,
    debounceDelay: 100,
    maxRetries: 3,
    cssUrl: 'https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Enhanced@main/css/ratings.css',
    cssId: 'jellyfin-ratings-style'
};

let observer: MutationObserver | { unsubscribe(): void } | null = null;
let urlObserverHandle: { unsubscribe(): void } | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;
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
        linkElement.href = CONFIG.cssUrl;
        document.head.appendChild(linkElement);
    } catch (error) {
        console.error('🪼 Jellyfin Enhanced: Failed to inject ratings CSS', error);
    }
}


function processRatingElements(): void {
    try {
        const elements = document.querySelectorAll<HTMLElement>(CONFIG.targetSelector);
        let processedCount = 0;

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
                    processedCount++;

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

function setupMutationObserver(): boolean {
    if (!window.MutationObserver) return false;

    try {
        const callback = (mutations: MutationRecord[]): void => {
            let shouldProcess = false;

            mutations.forEach((mutation) => {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const el = node as Element;
                            if (el.matches && el.matches(CONFIG.targetSelector)) {
                                shouldProcess = true;
                            } else if (el.querySelector && el.querySelector(CONFIG.targetSelector)) {
                                shouldProcess = true;
                            }
                        }
                    });
                }

                if (mutation.type === 'characterData' || mutation.type === 'childList') {
                    const target = mutation.target as Element;
                    if (target.nodeType === Node.ELEMENT_NODE &&
                        (target.matches(CONFIG.targetSelector) || target.closest(CONFIG.targetSelector))) {
                        shouldProcess = true;
                    }
                }
            });

            if (shouldProcess) {
                debouncedProcess();
            }
        };

        // Uses characterData so needs a dedicated observer via createObserver
        if (JE?.helpers?.createObserver) {
            observer = JE.helpers.createObserver(
                'colored-ratings',
                callback,
                document.body,
                { childList: true, subtree: true, characterData: true, characterDataOldValue: false }
            );
        } else {
            const mo = new MutationObserver(callback);
            mo.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true,
                characterDataOldValue: false
            });
            observer = mo;
        }

        return true;

    } catch (error) {
        console.error('🪼 Jellyfin Enhanced: Failed to setup ratings observer', error);
        return false;
    }
}

function setupFallbackPolling(): void {
    // Don't start polling if we're actively playing video
    if (isVideoPlaying()) {
        return;
    }
    fallbackTimer = setInterval(processRatingElements, CONFIG.fallbackInterval);
}

function isOnVideoPage(): boolean {
    // Check if we're on the video player page
    if (typeof JE?.isVideoPage === 'function') {
        return JE.isVideoPage();
    }
    // Fallback check
    return window.location.hash.startsWith('#/video') || !!document.querySelector('.videoPlayerContainer');
}

function isVideoPlaying(): boolean {
    // Check if we're on the video player page AND the video is actively playing
    if (!isOnVideoPage()) {
        return false;
    }

    // Check if pause screen is visible (pause screen has osdInfo visible)
    const pauseScreen = document.querySelector('.videoOsdBottom');
    if (pauseScreen && getComputedStyle(pauseScreen).display !== 'none' && getComputedStyle(pauseScreen).opacity !== '0') {
        // Pause screen is visible - allow polling
        return false;
    }

    // Check if video element exists and is playing
    const video = document.querySelector('video');
    if (!video) {
        return false;
    }

    return !video.paused;
}

function pausePolling(): void {
    if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
    }
}

function resumePolling(): void {
    if (!fallbackTimer && isFeatureEnabled() && !isVideoPlaying()) {
        fallbackTimer = setInterval(processRatingElements, CONFIG.fallbackInterval);
    }
}

function cleanup(): void {
    if (observer) {
        if ('disconnect' in observer) observer.disconnect();
        else observer.unsubscribe();
        observer = null;
    }
    if (urlObserverHandle) {
        urlObserverHandle.unsubscribe();
        urlObserverHandle = null;
    }
    if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
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
    setupFallbackPolling();
}

if (typeof document.visibilityState !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && isFeatureEnabled()) {
            setTimeout(processRatingElements, 100);
        }
    });
}

let lastUrl = location.href;

if (JE?.helpers?.onBodyMutation) {
    urlObserverHandle = JE.helpers.onBodyMutation('colored-ratings-url-watcher', () => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            if (isFeatureEnabled()) {
                setTimeout(initialize, 500);
            }
        }
    });
} else {
    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            if (isFeatureEnabled()) {
                setTimeout(initialize, 500);
            }
        }
    }).observe(document, { subtree: true, childList: true });
}

window.addEventListener('beforeunload', cleanup);
JE.initializeColoredRatings = initialize;
// Expose pause/resume functions for pausescreen.js to control
JE.pauseRatingsPolling = pausePolling;
JE.resumeRatingsPolling = resumePolling;
