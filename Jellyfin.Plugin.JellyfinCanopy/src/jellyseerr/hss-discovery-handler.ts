/**
 * Home Screen Sections (HSS) Discovery Handler
 * Intercepts discover card clicks and opens the Jellyseerr more-info modal
 * instead of navigating to the Jellyseerr website
 */

import { JC } from '../globals';


const logPrefix = '🪼 Jellyfin Canopy: HSS Discovery Handler:';

function initDiscoveryHandler() {

    document.addEventListener('click', function(e: any) {
        // Don't intercept if clicking the request button
        if (e.target.closest('.discover-requestbutton')) {
            return;
        }

        // Target any click on the discover card (except the request button)
        const discoverCard = e.target.closest('.discover-card');

        if (!discoverCard) {
            return;
        }

        const tmdbId = discoverCard.dataset.tmdbId;
        const mediaType = discoverCard.dataset.mediaType;

        // Check if JC.jellyseerrMoreInfo is available
        if (!tmdbId || !mediaType || !JC?.jellyseerrMoreInfo?.open) {
            return;
        }

        console.log(`${logPrefix} Opening more-info modal for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

        e.preventDefault();
        e.stopPropagation();

        // Open the more-info modal
        JC.jellyseerrMoreInfo.open(tmdbId, mediaType);
    }, true);
}

initDiscoveryHandler();
