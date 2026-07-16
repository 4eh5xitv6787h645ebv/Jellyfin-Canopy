/**
 * Home Screen Sections (HSS) Discovery Handler
 * Intercepts discover card clicks and opens the Seerr more-info modal
 * instead of navigating to the Seerr website
 */

import { JC } from '../globals';


const logPrefix = '🪼 Jellyfin Canopy: HSS Discovery Handler:';

function handleDiscoveryClick(e: Event): void {
        const target = e.target instanceof Element ? e.target : null;
        if (!target) return;
        // Don't intercept if clicking the request button
        if (target.closest('.discover-requestbutton')) {
            return;
        }

        // Target any click on the discover card (except the request button)
        const discoverCard = target.closest<HTMLElement>('.discover-card');

        if (!discoverCard) {
            return;
        }

        const tmdbId = discoverCard.dataset.tmdbId;
        const mediaType = discoverCard.dataset.mediaType;

        // Check if JC.seerrMoreInfo is available
        if (!tmdbId || !mediaType || !JC?.seerrMoreInfo?.open) {
            return;
        }

        console.log(`${logPrefix} Opening more-info modal for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

        e.preventDefault();
        e.stopPropagation();

        // Open the more-info modal
        JC.seerrMoreInfo.open(tmdbId, mediaType);
}

export function installHssDiscoveryHandler(): () => void {
    document.addEventListener('click', handleDiscoveryClick, true);
    let installed = true;
    return () => {
        if (!installed) return;
        installed = false;
        document.removeEventListener('click', handleDiscoveryClick, true);
    };
}
