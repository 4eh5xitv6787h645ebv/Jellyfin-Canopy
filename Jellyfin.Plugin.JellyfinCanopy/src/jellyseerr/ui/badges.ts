// src/jellyseerr/ui/badges.ts
// Card badge helpers: status badge, media-type/collection badges and
// streaming-provider icons.
import { JC } from '../../globals';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload + DOM shapes; typed incrementally */


import { ui, internal } from './internal';
const escapeHtml = JC.escapeHtml;
const DisplayStatus = JC.seerrStatus!.DISPLAY;
const logPrefix = '🪼 Jellyfin Canopy: Seerr UI:';

/**
 * Sets the status badge icon based on the item's media status.
 * @param {HTMLElement} card - The card element.
 * @param {Object} item - The search result item.
 */
function setStatusBadge(card: any, item: any) {
    const badge = card.querySelector('.jellyseerr-status-badge');
    if (!badge || !item.mediaInfo) {
        if (badge) badge.style.display = 'none';
        return;
    }

    // Determine status based on media type
    let status;
    if (item.mediaType === 'tv' && item.mediaInfo.seasons) {
        const seasonAnalysis = internal.analyzeSeasonStatuses(item.mediaInfo.seasons);
        status = seasonAnalysis ? seasonAnalysis.overallStatus : item.mediaInfo.status;
    } else {
        status = item.mediaInfo.status || 1;
    }

    const hasDownloads = (item.mediaInfo?.downloadStatus?.length > 0 || item.mediaInfo?.downloadStatus4k?.length > 0);
    const displayStatus = JC.seerrStatus!.resolveDisplayStatus(status, hasDownloads);
    const badgeConfig = JC.seerrStatus!.getBadgeConfig(displayStatus);

    if (!badgeConfig) {
        badge.style.display = 'none';
        return;
    }

    badge.innerHTML = badgeConfig.icon;
    badge.className = `jellyseerr-status-badge ${badgeConfig.cssClass}`;
    badge.style.display = 'flex';

    if (displayStatus === DisplayStatus.PARTIAL && item.mediaType === 'tv' && hasDownloads) {
        badge.style.cursor = 'pointer';
        internal.addDownloadProgressHover(badge, item);
    }
}

/**
 * Fetches streaming provider icons from the TMDB API and adds them to a specified container element on a Seerr poster.
 * This function is called only if the "Show Elsewhere on Seerr" setting is enabled and a TMDB API key is present.
 * It retrieves providers based on the default region and filters configured in the Elsewhere plugin settings.
 *
 * @async
 * @function fetchProviderIcons
 * @param {HTMLElement} container - The DOM element where the provider icons will be appended.
 * @param {string|number} tmdbId - The The Movie Database (TMDB) ID for the movie or TV show.
 * @param {string} mediaType - The type of media, either 'movie' or 'tv'.
 * @returns {Promise<void>} A promise that resolves when the icons have been fetched and added, or if the process fails.
 */
async function fetchProviderIcons(container: any, tmdbId: any, mediaType: any) {
    if (!container || !tmdbId || !mediaType) return;

    // Early exit if TMDB is not configured - prevents slow/failing API calls
    if (!JC.pluginConfig?.TmdbEnabled) {
        return;
    }

    const DEFAULT_REGION = (JC.pluginConfig.DEFAULT_REGION as string) || 'US';
    const DEFAULT_PROVIDERS = JC.pluginConfig.DEFAULT_PROVIDERS ? (JC.pluginConfig.DEFAULT_PROVIDERS as string).replace(/'/g, '').replace(/\n/g, ',').split(',').map((s: any) => s.trim()).filter((s: any) => s) : [];
    const IGNORE_PROVIDERS = JC.pluginConfig.IGNORE_PROVIDERS ? (JC.pluginConfig.IGNORE_PROVIDERS as string).replace(/'/g, '').replace(/\n/g, ',').split(',').map((s: any) => s.trim()).filter((s: any) => s) : [];

    try {
        // Routed through the core API client (auth headers, retry, dedup);
        // non-OK responses throw and land in the catch below.
        const data: any = await JC.core.api!.plugin(`/tmdb/${mediaType}/${tmdbId}/watch/providers`);
        let providers = data.results?.[DEFAULT_REGION]?.flatrate;

        if (providers && providers.length > 0) {

            // 1. If a default provider list is set, only include providers from that list.
            if (DEFAULT_PROVIDERS.length > 0) {
                providers = providers.filter((provider: any) => DEFAULT_PROVIDERS.includes(provider.provider_name));
            }

            // 2. If an ignore list is set, exclude any providers that match.
            if (IGNORE_PROVIDERS.length > 0) {
                try {
                    const ignorePatterns = IGNORE_PROVIDERS.map((pattern: any) => new RegExp(pattern, 'i'));
                    providers = providers.filter((provider: any) =>
                        !ignorePatterns.some((regex: any) => regex.test(provider.provider_name))
                    );
                } catch (e: any) {
                    console.error(`${logPrefix} Invalid regex in IGNORE_PROVIDERS setting.`, e);
                }
            }

            if (providers.length > 0) {
                providers.slice(0, 4).forEach((provider: any) => { // Limit to max 4 icons to avoid clutter
                    const img = document.createElement('img');
                    img.src = `https://image.tmdb.org/t/p/w92${provider.logo_path}`;
                    img.title = provider.provider_name;
                    container.appendChild(img);
                });

                if (container.childElementCount > 0) {
                    container.classList.add('has-icons');
                }
            }
        }
    } catch (error: any) {
        console.warn(`${logPrefix} Could not fetch provider icons for TMDB ID ${tmdbId}:`, error);
    }
}

/**
 * Adds media type badge to card.
 * @param {HTMLElement} card - Card element.
 * @param {Object} item - Media item data.
 */
function addMediaTypeBadge(card: any, item: any) {
    if (item.mediaType === 'movie' || item.mediaType === 'tv' || item.mediaType === 'collection') {
        const imageContainer = card.querySelector('.cardImageContainer');
        if (imageContainer) {
            const badge = document.createElement('div');
            badge.className = 'jellyseerr-media-badge';
            if (item.mediaType === 'movie') {
                badge.classList.add('jellyseerr-media-badge-movie');
                badge.textContent = JC.t!('jellyseerr_card_badge_movie');
            } else if (item.mediaType === 'tv') {
                badge.classList.add('jellyseerr-media-badge-series');
                badge.textContent = JC.t!('jellyseerr_card_badge_series');
            } else {
                badge.classList.add('jellyseerr-media-badge-collection');
                badge.textContent = JC.t!('jellyseerr_card_badge_collection');
            }
            imageContainer.appendChild(badge);
        }
    }
}

// Adds a small badge indicating the movie belongs to a collection; clicking opens the request modal
function addCollectionMembershipBadge(card: any, item: any) {
    if (!item.collection || item.mediaType !== 'movie') return;
    const imageContainer = card.querySelector('.cardImageContainer');
    if (!imageContainer) return;
    const badge = document.createElement('div');
    badge.className = 'jellyseerr-collection-badge';
    badge.innerHTML = `<span class="material-icons">collections</span><span>${escapeHtml(item.collection.name) || JC.t!('jellyseerr_card_badge_collection')}</span>`; // collection name escaped
    badge.title = `Part of ${item.collection.name || 'collection'}`;
    badge.addEventListener('click', (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        ui.showCollectionRequestModal(item.collection.id, item.collection.name, item);
    });
    imageContainer.appendChild(badge);
}
internal.setStatusBadge = setStatusBadge;
internal.fetchProviderIcons = fetchProviderIcons;
internal.addMediaTypeBadge = addMediaTypeBadge;
internal.addCollectionMembershipBadge = addCollectionMembershipBadge;
