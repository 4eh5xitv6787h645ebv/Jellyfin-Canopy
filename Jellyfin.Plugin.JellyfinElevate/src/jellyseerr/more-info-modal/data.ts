// src/jellyseerr/more-info-modal/data.ts
// Fetch + pure data helpers for the more-info modal (ratings, details,
// content rating resolution, currency formatting, error reporting).
import { JE } from '../../globals';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload + DOM shapes; typed incrementally */


import { internal } from './internal';
const logPrefix = '🪼 Jellyfin Elevate: Jellyseerr More Info:';

/**
 * Fetch ratings from Jellyseerr API
 */
async function fetchRatings(tmdbId: any, mediaType: any) {
// prefer request-manager (retry, dedup, abort, cache, cf-ray
// logging) over raw ApiClient.ajax. Falls back to ApiClient.ajax only if
// request-manager hasn't loaded yet (early page navigations).
try {
    const endpoint = mediaType === 'tv'
        ? `/tv/${tmdbId}/ratings`
        : `/movie/${tmdbId}/ratingscombined`;
    const url = ApiClient.getUrl(`/JellyfinElevate/jellyseerr${endpoint}`);
    let response;
    const JE = window.JellyfinElevate;
    if (JE && JE.requestManager) {
        const httpResponse = await JE.requestManager.fetchWithRetry(url, {
            method: 'GET',
            headers: {
                'X-Jellyfin-User-Id': ApiClient.getCurrentUserId(),
                'Authorization': 'MediaBrowser Token="' + ApiClient.accessToken() + '"',
                'Accept': 'application/json'
            }
        });
        response = await httpResponse.json();
    } else {
        response = await ApiClient.ajax({
            type: 'GET',
            url,
            headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
            dataType: 'json'
        });
    }
    if (mediaType === 'tv') {
        return response ? { rt: response } : null;
    }
    return response;
} catch (error: any) {
    console.warn(`${logPrefix} Failed to fetch ratings for ${mediaType} ${tmdbId}:`, error);
    return null;
}
}

/**
 * Fetch media details from Jellyseerr API via proxy.  */
async function fetchMediaDetails(tmdbId: any, mediaType: any) {
try {
    const JE = window.JellyfinElevate;
    if (JE && JE.jellyseerrAPI) {
        return mediaType === 'movie'
            ? await JE.jellyseerrAPI.fetchMovieDetails(tmdbId)
            : await JE.jellyseerrAPI.fetchTvShowDetails(tmdbId);
    }
    const endpoint = mediaType === 'movie'
        ? `/movie/${tmdbId}`
        : `/tv/${tmdbId}`;

    const response = await ApiClient.ajax({
        type: 'GET',
        url: ApiClient.getUrl(`/JellyfinElevate/jellyseerr${endpoint}`),
        headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
        dataType: 'json'
    });

    return response;
} catch (error: any) {
    console.error(`${logPrefix} Failed to fetch ${mediaType} details for TMDB ID ${tmdbId}:`, error);
    throw error;
}
}

/**
 * Get content rating for specified region
 */
function getContentRating(data: any, mediaType: any) {
// Resolve region: prefer Elsewhere user setting → plugin fallback → US
const region = ((JE?.userConfig?.elsewhere as any)?.Region || JE?.pluginConfig?.DEFAULT_REGION || 'US')?.toUpperCase();

if (mediaType === 'movie') {
    // For movies: releases.results[].release_dates[].certification
    const releases = data.releases?.results;
    if (!Array.isArray(releases)) return 'N/A';

    // Find region release
    let regionRelease = releases.find((r: any) => r.iso_3166_1 === region);
    if (!regionRelease) {
        regionRelease = releases.find((r: any) => r.iso_3166_1 === 'US');
    }
    if (!regionRelease && releases.length > 0) {
        regionRelease = releases[0];
    }

    if (!regionRelease?.release_dates?.length) return 'N/A';

    // Get first theatrical release (type 3) with certification
    let release = regionRelease.release_dates.find((rd: any) => rd.type === 3 && rd.certification);
    if (!release) {
        release = regionRelease.release_dates.find((rd: any) => rd.certification);
    }

    return release?.certification || 'N/A';
} else {
    // For TV: contentRatings.results[].rating
    const results = data.contentRatings?.results;
    if (!Array.isArray(results)) return 'N/A';

    let regionRating = results.find((r: any) => r.iso_3166_1 === region);
    if (!regionRating) {
        regionRating = results.find((r: any) => r.iso_3166_1 === 'US');
    }
    if (!regionRating && results.length > 0) {
        regionRating = results[0];
    }

    return regionRating?.rating || 'N/A';
}
}

/**
 * Show error message
 */
function showError(message: any) {
// You can customize this to match your error handling
console.error(message);
alert(message);
}

/**
 * Format currency
 */
function formatCurrency(amount: any) {
if (!amount || amount === 0) return null;
return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
}).format(amount);
}
internal.fetchRatings = fetchRatings;
internal.fetchMediaDetails = fetchMediaDetails;
internal.getContentRating = getContentRating;
internal.showError = showError;
internal.formatCurrency = formatCurrency;
