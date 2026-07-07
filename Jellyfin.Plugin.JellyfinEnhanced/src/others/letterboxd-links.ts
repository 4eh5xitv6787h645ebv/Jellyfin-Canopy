// src/others/letterboxd-links.ts

import { JE as JEBase } from '../globals';
import { assetUrl } from '../core/asset-urls';
import { onBodyMutation } from '../core/dom-observer';
import { onNavigate, onViewPage } from '../core/navigation';
import type { JELegacyHelpers, PluginConfig } from '../types/je';

/** Options accepted by helpers.createExternalLink (and its local fallback). */
interface ExternalLinkOptions {
    text?: string;
    title?: string;
    className?: string;
}

/**
 * Local view of the shared namespace adding the public member this module
 * OWNS plus the legacy helper/config members it reads that are not yet typed
 * on JEGlobal (owned by unconverted js/ modules).
 */
const JE = JEBase as typeof JEBase & {
    initializeLetterboxdLinksScript?: () => Promise<void>;
    pluginConfig: PluginConfig & { LetterboxdEnabled?: boolean; ShowLetterboxdLinkAsText?: boolean };
    helpers: JELegacyHelpers & {
        createExternalLink?: (url: string, options?: ExternalLinkOptions) => HTMLAnchorElement;
        getItemCached?: (itemId: string) => Promise<unknown>;
    };
};

// eslint-disable-next-line @typescript-eslint/require-await -- public initializer kept async to preserve its Promise-returning contract
JE.initializeLetterboxdLinksScript = async function () {
    const logPrefix = '🪼 Jellyfin Enhanced: Letterboxd Links:';

    if (!JE?.pluginConfig?.LetterboxdEnabled) {
        console.log(`${logPrefix} Integration disabled in plugin settings.`);
        return;
    }

    console.log(`${logPrefix} Initializing...`);

    let isAddingLinks = false; // Lock to prevent concurrent runs
    const processedItemIds = new Set<string>(); // Cache of items we've already processed
    let lastVisibleItemId: string | null = null; // Track the currently visible item
    // PERF(R9): transient-failure counter per item — the processed set is only
    // poisoned after repeated failures, so one blip doesn't hide the link for
    // the whole page view. Cleared alongside processedItemIds.
    const errorAttempts = new Map<string, number>();
    const ERROR_MAX_ATTEMPTS = 3;

    // PERF(R6): no remote assets — icon served from the local asset cache.
    const LETTERBOXD_ICON_URL = assetUrl('icons/letterboxd.svg');

    // Safe fallback for helpers.js Stage-3 load-order races.
    const extLink = JE.helpers?.createExternalLink || ((u: string, o?: ExternalLinkOptions) => {
        const a = document.createElement('a');
        a.setAttribute('is', 'emby-linkbutton');
        a.href = u;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        if (o?.text) a.textContent = o.text;
        if (o?.title) a.title = o.title;
        if (o?.className) a.className = o.className;
        return a;
    });

    const styleId = 'letterboxd-links-styles';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .letterboxd-link-icon::before {
                content: "";
                display: inline-block;
                width: 25px;
                height: 25px;
                background-image: url(${LETTERBOXD_ICON_URL});
                background-size: contain;
                background-repeat: no-repeat;
                vertical-align: middle;
                margin-right: 5px;
            }
        `;
        document.head.appendChild(style);
    }

    function getImdbId(context: Element): string | null {
        const links = context.querySelectorAll<HTMLAnchorElement>('.itemExternalLinks a, .externalIdLinks a');
        for (const link of links) {
            const href = link.href;
            if (href.includes('imdb.com/title/')) {
                const match = href.match(/\/title\/(tt\d+)/);
                if (match) {
                    return match[1];
                }
            }
        }
        return null;
    }

    // Letterboxd has no IMDb/TMDB lookup for people, only a name-based slug
    // (e.g. https://letterboxd.com/actor/tommy-lee-jones/), so we derive it
    // from the person's name the same way Letterboxd does.
    function getPersonSlug(name: string): string | null {
        if (!name) return null;
        const slug = name
            .toLowerCase()
            .normalize("NFD").replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, '');
        return slug || null;
    }

    async function addLetterboxdLinks(): Promise<void> {
        if (isAddingLinks) {
            return;
        }

        const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
        if (!visiblePage) return;

        const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
        if (!itemId) return;

        // If we've already processed this item, skip it
        if (processedItemIds.has(itemId)) {
            return;
        }

        // If item changed, clear the processed set to allow reprocessing on new item
        if (lastVisibleItemId && lastVisibleItemId !== itemId) {
            processedItemIds.clear();
            errorAttempts.clear();
        }
        lastVisibleItemId = itemId;

        const anchorElement = visiblePage.querySelector('.itemExternalLinks');

        // Cleanup stale links from any non-visible pages to prevent future conflicts
        document.querySelectorAll('#itemDetailPage.hide .letterboxd-link').forEach(staleLink => {
            if (staleLink.previousSibling && staleLink.previousSibling.nodeType === Node.TEXT_NODE) {
               staleLink.previousSibling.remove();
            }
            staleLink.remove();
        });

        if (!anchorElement || anchorElement.querySelector('.letterboxd-link')) {
            return;
        }

        isAddingLinks = true;
        try {
            const item = (JE.helpers?.getItemCached
                ? await JE.helpers.getItemCached(itemId)
                : await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId)) as any;
            if (!item?.Type) {
                processedItemIds.add(itemId);
                return;
            }

            // Note: Letterboxd does not support TV shows, Add 'Series' if letterboxd ever adds support for them in the future.
            if (!['Movie', 'Person'].includes(item.Type)) {
                console.log(`${logPrefix} Skipping ${item.Type} - Letterboxd links not supported.`);
                processedItemIds.add(itemId);
                return;
            }

            let letterboxdUrl;
            if (item.Type === 'Person') {
                const personSlug = getPersonSlug(item.Name);
                if (!personSlug) {
                    console.log(`${logPrefix} Could not derive a Letterboxd slug for ${item.Name}.`);
                    processedItemIds.add(itemId);
                    return;
                }
                letterboxdUrl = `https://letterboxd.com/actor/${personSlug}`;
            } else {
                // PERF(R9): prefer the item's authoritative provider id — the DOM
                // link scan raced the host rendering the external-links row and
                // marked the item processed before its IMDb link had mounted.
                const imdbId = item.ProviderIds?.Imdb || getImdbId(visiblePage);
                if (!imdbId) {
                    console.log(`${logPrefix} No IMDb ID found for ${item.Type}.`);
                    processedItemIds.add(itemId);
                    return;
                }
                letterboxdUrl = `https://letterboxd.com/imdb/${imdbId}`;
            }

            anchorElement.appendChild(document.createTextNode(' '));
            anchorElement.appendChild(createLinkButton("Letterboxd", letterboxdUrl, "letterboxd-link-icon"));
            processedItemIds.add(itemId);
        } catch (err) {
            console.error(`${logPrefix} Error adding Letterboxd link:`, err);
            // PERF(R9): fail open — only poison the processed set after repeated
            // failures; the shared body observer / nav probes retry until then.
            const attempts = (errorAttempts.get(itemId) || 0) + 1;
            if (attempts >= ERROR_MAX_ATTEMPTS) {
                processedItemIds.add(itemId);
                errorAttempts.delete(itemId);
            } else {
                errorAttempts.set(itemId, attempts);
            }
        } finally {
            isAddingLinks = false;
        }
    }

    function createLinkButton(text: string, url: string, className: string): HTMLAnchorElement {
        const button = extLink(url, { title: text });
        if (JE.pluginConfig.ShowLetterboxdLinkAsText) {
            button.textContent = text;
            button.className = 'button-link emby-button letterboxd-link';
        } else {
            button.className = 'button-link emby-button letterboxd-link letterboxd-link-icon';
        }
        return button;
    }

    // Coalesced, idle-scheduled lookup pass shared by every trigger below.
    let processingLetterboxd = false;
    function scheduleLetterboxdLinks(): void {
        if (processingLetterboxd) return;
        processingLetterboxd = true;
        if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(() => {
                void addLetterboxdLinks();
                processingLetterboxd = false;
            }, { timeout: 500 });
        } else {
            setTimeout(() => {
                void addLetterboxdLinks();
                processingLetterboxd = false;
            }, 100);
        }
    }

    // PERF(R3): this used to be a dedicated body-wide MutationObserver with
    // attributeFilter:['class'] — the filter opted it out of the multiplexer
    // and made it fire on every hover/focus/class write on EVERY page.
    // Structural changes (the external-links section mounting) now arrive via
    // the shared multiplexed body observer behind a cheap O(1) details-page
    // gate, and the cached-page re-show (a class flip with no structural
    // mutation — the only thing the attribute filter actually caught) is
    // covered by the navigation/viewshow probes below. addLetterboxdLinks
    // re-validates page visibility and de-dupes per item itself.
    const letterboxdSubscription = onBodyMutation('letterboxd-links', () => {
        if (!JE?.pluginConfig?.LetterboxdEnabled) {
            letterboxdSubscription.unsubscribe();
            console.log(`${logPrefix} Stopped - feature disabled`);
            return;
        }
        const page = document.getElementById('itemDetailPage');
        if (!page || page.classList.contains('hide')) return;
        scheduleLetterboxdLinks();
    });
    onNavigate(() => {
        if (JE?.pluginConfig?.LetterboxdEnabled) scheduleLetterboxdLinks();
    });
    onViewPage(() => {
        if (JE?.pluginConfig?.LetterboxdEnabled) scheduleLetterboxdLinks();
    });

    // Initial check
    if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => { void addLetterboxdLinks(); }, { timeout: 1000 });
    } else {
        setTimeout(() => { void addLetterboxdLinks(); }, 500);
    }

    try {
        console.log(`${logPrefix} Letterboxd links integration initialized successfully.`);
    } catch (err) {
        console.error(`${logPrefix} Failed to initialize`, err);
    }
};
