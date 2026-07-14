// src/seerr/more-info-modal/seasons.ts
// Season-level logic: metadata backfill from TMDB, Jellyfin season links,
// availability chips, unrequested-season detection and the seasons section.
import { JC } from '../../globals';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload + DOM shapes; typed incrementally */


import { internal } from './internal';
const state = internal.state;
const logPrefix = '🪼 Jellyfin Canopy: Seerr More Info:';
const escapeHtml = JC.escapeHtml;
const MediaStatus = JC.seerrStatus!.MEDIA;

/**
 * Validates that a string starts with an ISO date format (YYYY-MM-DD).
 * @param {string} d - The date string to validate.
 * @returns {boolean} True if the string matches the date pattern.
 */
const isValidDate = (d: any) => /^\d{4}-\d{2}-\d{2}/.test(d);

/** Validates that a TMDB poster path matches the expected format (e.g., /abc123.jpg). */
const isValidPosterPath = (p: any) => /^\/[a-zA-Z0-9._-]+\.[a-zA-Z]+$/.test(p);

function normalizeSeasonNumber(value: any): number | null {
if (value === null || value === undefined || typeof value === 'boolean') return null;
if (typeof value === 'string' && value.trim() === '') return null;
const normalized = Number(value);
return Number.isInteger(normalized) && normalized >= 0 ? normalized : null;
}

/**
 * Backfills missing season metadata (posterPath, overview, airDate) from TMDB and episode data.
 * Fetches data asynchronously, then updates DOM season cards in-place.
 * @param {number} tmdbId - The TMDB ID of the TV show.
 * @param {object} data - The Seerr TV show details object (seasons are mutated with backfilled values).
 */
async function backfillSeasonMetadata(tmdbId: any, data: any) {
try {
    if (!state.currentModal || !data?.seasons) return;

    const api = JC.seerrAPI;
    const seasonsMissingData = data.seasons.filter((s: any) => s.episodeCount > 0 && (!s.airDate || !s.posterPath || !s.overview));
    if (seasonsMissingData.length === 0) return;

    // Fetch TMDB data + per-season episode data in parallel
    const tmdbPromise = (JC.pluginConfig?.TmdbEnabled && api?.fetchTmdbTvDetails)
        ? api.fetchTmdbTvDetails(tmdbId).catch(() => null)
        : Promise.resolve(null);

    const episodePromises = (api?.fetchTvSeasonDetails)
        ? seasonsMissingData.map((s: any) =>
            api.fetchTvSeasonDetails(tmdbId, s.seasonNumber)
                .then((detail: any) => ({ seasonNumber: s.seasonNumber, firstEpDate: detail?.episodes?.[0]?.airDate || '' }))
                .catch(() => ({ seasonNumber: s.seasonNumber, firstEpDate: '' }))
        )
        : [];

    const [tmdbData, ...episodeResults] = await Promise.all([tmdbPromise, ...episodePromises]);

    // Build TMDB season lookup
    const tmdbMap: any = {};
    if (tmdbData?.seasons) {
        tmdbData.seasons.forEach((s: any) => { tmdbMap[s.season_number] = s; });
    }

    // Build episode air date lookup
    const epDateMap: any = {};
    episodeResults.forEach((r: any) => {
        if (r.firstEpDate && isValidDate(r.firstEpDate)) {
            epDateMap[r.seasonNumber] = r.firstEpDate;
        }
    });

    // Bail if modal was closed/replaced during async fetch
    if (!state.currentModal || String(state.currentModal.dataset?.tmdbId) !== String(tmdbId)) return;

    // Update each season card in the DOM
    data.seasons.forEach((season: any) => {
        const sNum = season.seasonNumber;
        const card = state.currentModal.querySelector(`.season-card[data-season-number="${CSS.escape(String(sNum))}"]`);
        if (!card) return;

        const tmdbSeason = tmdbMap[sNum];

        // Backfill posterPath (validate format to prevent loading from unexpected URLs)
        // Try TMDB season poster first, then fall back to the show poster
        if (!season.posterPath) {
            const tmdbPoster = tmdbSeason?.poster_path;
            const fallbackPoster = (tmdbPoster && isValidPosterPath(tmdbPoster)) ? tmdbPoster : data.posterPath;
            if (fallbackPoster && isValidPosterPath(fallbackPoster)) {
                season.posterPath = fallbackPoster;
                const posterEl = card.querySelector('.season-poster');
                if (posterEl) {
                    const newSrc = `https://image.tmdb.org/t/p/w185${season.posterPath}`;
                    const existingImg = posterEl.querySelector('img');
                    if (existingImg) {
                        // Update src if it changed (e.g., replacing show poster with season poster)
                        if (existingImg.src !== newSrc) existingImg.src = newSrc;
                    } else {
                        const img = document.createElement('img');
                        img.src = newSrc;
                        img.alt = card.querySelector('.season-name')?.textContent || '';
                        posterEl.appendChild(img);
                    }
                }
            }
        }

        // Backfill overview (textContent is safe from XSS)
        if (!season.overview && tmdbSeason?.overview) {
            season.overview = tmdbSeason.overview;
            const infoEl = card.querySelector('.season-info');
            if (infoEl && !infoEl.querySelector('.season-overview')) {
                const overviewEl = document.createElement('div');
                overviewEl.className = 'season-overview';
                overviewEl.textContent = season.overview;
                infoEl.appendChild(overviewEl);
            }
        }

        // Backfill airDate (episode date first, then TMDB fallback)
        if (!season.airDate) {
            const epDate = epDateMap[sNum];
            const tmdbDate = tmdbSeason?.air_date || '';
            const bestDate = epDate || (isValidDate(tmdbDate) ? tmdbDate : '');
            if (bestDate) {
                season.airDate = bestDate;
                const metaEl = card.querySelector('.season-meta');
                if (metaEl) {
                    const year = new Date(bestDate).getFullYear();
                    const currentText = metaEl.textContent || '';
                    if (!currentText.includes(String(year))) {
                        metaEl.textContent = `${season.episodeCount} Episodes \u2022 ${year}`;
                    }
                }
            }
        }
    });
} catch (e: any) {
    console.debug(`${logPrefix} Failed to backfill season metadata:`, e);
}
}

function getSeasonStatusInfo(data: any, seasonNumber: any) {
const seasons = data?.mediaInfo?.seasons;
const normalizedSeasonNumber = normalizeSeasonNumber(seasonNumber);
if (!Array.isArray(seasons) || normalizedSeasonNumber === null) return null;
return seasons.find((s: any) => normalizeSeasonNumber(s?.seasonNumber) === normalizedSeasonNumber) || null;
}

function getSeasonJellyfinId(seasonInfo: any, is4k: any = false) {
if (!seasonInfo || typeof seasonInfo !== 'object') return null;
if (is4k) {
    return seasonInfo.jellyfinMediaId4k || seasonInfo.jellyfinSeasonId4k || seasonInfo.jellyfinId4k || null;
}
return seasonInfo.jellyfinMediaId || seasonInfo.jellyfinSeasonId || seasonInfo.jellyfinId || null;
}

function buildSeasonAvailabilityLinks(seasonInfo: any, jellyfinSeasonId: any = null, jellyfinSeasonId4k: any = null) {
const normalStatus = seasonInfo?.status;
const status4k = seasonInfo?.status4k;
// Seerr media status remains authoritative for display and request safety. A
// stored/viewer-visible Jellyfin id can turn the pill into a link, but its
// absence cannot prove that the season is globally absent from every scanner
// library.
const isNormalAvailable = normalStatus === MediaStatus.AVAILABLE
    || normalStatus === MediaStatus.PARTIALLY_AVAILABLE
    || (!normalStatus && !!jellyfinSeasonId);
const is4kAvailable = status4k === MediaStatus.AVAILABLE
    || status4k === MediaStatus.PARTIALLY_AVAILABLE
    || (!status4k && !!jellyfinSeasonId4k);

const pills: any[] = [];

if (isNormalAvailable) {
    if (jellyfinSeasonId) {
        pills.push(`<a is="emby-linkbutton" class="season-link-chip available" href="#!/details?id=${encodeURIComponent(jellyfinSeasonId)}">Available</a>`);
    } else {
        pills.push('<span class="season-link-chip available">Available</span>');
    }
}

if (is4kAvailable) {
    if (jellyfinSeasonId4k) {
        pills.push(`<a is="emby-linkbutton" class="season-link-chip available-4k" href="#!/details?id=${encodeURIComponent(jellyfinSeasonId4k)}">4K Available</a>`);
    } else if (jellyfinSeasonId) {
        pills.push(`<a is="emby-linkbutton" class="season-link-chip available-4k" href="#!/details?id=${encodeURIComponent(jellyfinSeasonId)}">4K Available</a>`);
    } else {
        pills.push('<span class="season-link-chip available-4k">4K Available</span>');
    }
}

if (!pills.length) return '';
return `<div class="season-links">${pills.join('')}</div>`;
}

async function fetchJellyfinSeasonMap(seriesId: any) {
const userId = ApiClient.getCurrentUserId?.();
if (!userId || !seriesId) return {};

try {
    const response: any = await ApiClient.ajax({
        type: 'GET',
        url: ApiClient.getUrl(`/Users/${userId}/Items`, {
            ParentId: seriesId,
            IncludeItemTypes: 'Season',
            Recursive: false,
            Fields: 'ParentIndexNumber,IndexNumber,Name'
        }),
        dataType: 'json'
    });

    const map: any = {};
    const items = Array.isArray(response?.Items) ? response.Items : [];
    for (const season of items) {
        const seasonNumber = normalizeSeasonNumber(season?.IndexNumber);
        if (season?.Id && seasonNumber !== null) {
            map[seasonNumber] = { id: season.Id, name: season.Name || null };
        }
    }
    return map;
} catch (error: any) {
    console.debug(`${logPrefix} Could not load Jellyfin season links:`, error);
    return {};
}
}

async function enrichSeasonCardsWithJellyfinLinks(data: any, modal: any = state.currentModal) {
if (!modal || data?.mediaType === 'movie') return;

const cards = modal.querySelectorAll('[data-season-number]');
if (!cards.length) return;

const seriesId = data?.mediaInfo?.jellyfinMediaId;
if (!seriesId) return;

if (!data._jellyfinSeasonIdMap) {
    data._jellyfinSeasonIdMap = await fetchJellyfinSeasonMap(seriesId);
}

cards.forEach((card: any) => {
    const seasonNumber = Number(card.dataset.seasonNumber);
    const mount = card.querySelector('[data-season-links]');
    if (!mount || !Number.isFinite(seasonNumber)) return;

    const seasonInfo = getSeasonStatusInfo(data, seasonNumber);
    const jellyfinEntry = data._jellyfinSeasonIdMap?.[seasonNumber];
    const jellyfinId = typeof jellyfinEntry === 'object' ? jellyfinEntry?.id : jellyfinEntry;
    const seasonId = jellyfinId || getSeasonJellyfinId(seasonInfo, false) || null;
    const seasonId4k = getSeasonJellyfinId(seasonInfo, true) || null;
    mount.innerHTML = buildSeasonAvailabilityLinks(seasonInfo, seasonId, seasonId4k);

    // Override the season display name with what Jellyfin actually calls it,
    // so TVDB subtitles like "Beast Hunters" are replaced with "Season 3".
    const jellyfinName = typeof jellyfinEntry === 'object' ? jellyfinEntry?.name : null;
    if (jellyfinName) {
        const nameEl = card.querySelector('.season-name');
        if (nameEl) nameEl.textContent = jellyfinName;
    }
});
}

/**
 * Check if a TV show has any unrequested seasons by querying the request endpoint
 * @param {object} data - The TV show data from Seerr
 * @returns {Promise<boolean>} - True if there are seasons that can be requested
 */
// Kept async because callers and the exported internal test seam consume a
// Promise; the unsafe viewer-scoped Jellyfin read was deliberately removed.
// eslint-disable-next-line @typescript-eslint/require-await
async function checkForUnrequestedSeasons(data: any) {
// Get all seasons from TMDB data that have episodes (excluding specials and unaired seasons)
const tmdbSeasons = (data.seasons || []).filter((s: any) => s.seasonNumber > 0 && s.episodeCount > 0);
if (tmdbSeasons.length === 0) return false;

try {
    // Seerr's TV-detail response loads this media row with its complete
    // `requests` relation, and each MediaRequest eagerly loads its season rows.
    // Consume that bounded per-title relation instead of scanning the server's
    // entire request history (which can exceed any practical global cap).
    // No mediaInfo means the title has never had a Seerr media/request record.
    const mediaInfo = data?.mediaInfo;
    let requests: any[] = [];
    if (mediaInfo != null) {
        if (!Array.isArray(mediaInfo.requests)) {
            throw new Error('TV detail did not contain a complete per-title request relation.');
        }
        requests = mediaInfo.requests;
    }

    // MediaRequestStatus and MediaStatus are different enum domains even
    // though both are integer-backed. Track active request membership
    // separately from the season's media availability so, for example, a
    // declined request (3) is never mistaken for processing media (3).
    // Match Seerr's own duplicate-season rule: normal requests remain active
    // until their parent request is declined or completed. A 4K-only request
    // must not suppress the normal Request More path.
    const activeNormalRequestSeasons = new Set<number>();

    for (const request of requests) {
        const requestStatus = Number(request?.status);
        if (!request
            || request.type !== 'tv'
            || typeof request.is4k !== 'boolean'
            || !Number.isInteger(requestStatus)
            || requestStatus < 1
            || requestStatus > 5
            || !Array.isArray(request.seasons)) {
            throw new Error('TV detail contained an invalid per-title request row.');
        }

        for (const season of request.seasons) {
            const seasonNum = Number(season?.seasonNumber);
            const seasonRequestStatus = Number(season?.status);
            if (!Number.isInteger(seasonNum)
                || seasonNum < 0
                || !Number.isInteger(seasonRequestStatus)
                || seasonRequestStatus < 1
                || seasonRequestStatus > 5) {
                throw new Error('TV detail contained an invalid season-request row.');
            }

            if (!request.is4k && requestStatus !== 3 && requestStatus !== 5) {
                activeNormalRequestSeasons.add(seasonNum);
            }
        }
    }

    const mediaStatusMap = new Map<number, number>();
    if (mediaInfo != null) {
        if (!Array.isArray(mediaInfo.seasons)) {
            throw new Error('TV detail did not contain a complete per-title media-season relation.');
        }

        for (const season of mediaInfo.seasons) {
            const seasonNum = Number(season?.seasonNumber);
            const mediaStatus = Number(season?.status);
            if (!Number.isInteger(seasonNum)
                || seasonNum < 0
                || !Number.isInteger(mediaStatus)
                || mediaStatus < 1
                || mediaStatus > 7) {
                throw new Error('TV detail contained an invalid media-season row.');
            }

            const previousStatus = mediaStatusMap.get(seasonNum);
            if (previousStatus !== undefined && previousStatus !== mediaStatus) {
                throw new Error('TV detail contained conflicting media-season rows.');
            }
            mediaStatusMap.set(seasonNum, mediaStatus);
        }
    }

    // Check if any TMDB season is unrequested. Status 0/undefined and 1
    // (Unknown) mean it has never been requested. Status 7 (Deleted) means
    // a prior request was removed and the season can be re-requested. Raw
    // AVAILABLE stays fail-closed: viewer-scoped Jellyfin reads and stored
    // link IDs cannot prove global absence across all scanner libraries.
    const jellyfinMediaId = data.mediaInfo?.jellyfinMediaId || null;

    for (const tmdbSeason of tmdbSeasons) {
        const seasonNumber = Number(tmdbSeason.seasonNumber);
        if (activeNormalRequestSeasons.has(seasonNumber)) {
            continue;
        }

        const rawStatus = mediaStatusMap.get(seasonNumber);
        const effectiveStatus = JC.seerrStatus!.effectiveMediaStatus(rawStatus, jellyfinMediaId);
        if (JC.seerrStatus!.isRequestable(effectiveStatus)) {
            return true;
        }
    }

    return false;
} catch (error: any) {
    console.error(`[More Info Modal] Error checking unrequested seasons:`, error);
    return false;
}
}

/**
 * Build seasons section (TV shows only)
 */
function buildSeasonsSection(data: any) {
if (!data.seasons || !data.seasons.length) return '';

return `
    <div class="seasons-section">
        <h3>Seasons</h3>
        <div class="seasons-grid">
            ${data.seasons.map((season: any) => {
                const seasonInfo = getSeasonStatusInfo(data, season.seasonNumber);
                const seasonJellyfinId = getSeasonJellyfinId(seasonInfo, false);
                const seasonJellyfinId4k = getSeasonJellyfinId(seasonInfo, true);
                const seasonPosterPath = season.posterPath
                    || (data.posterPath && isValidPosterPath(data.posterPath) ? data.posterPath : null);
                const posterUrl = seasonPosterPath
                    ? `https://image.tmdb.org/t/p/w185${seasonPosterPath}`
                    : '';

                // Derive a display name: if the API returns just the number (TheTVDB), generate a proper label.
                // The numeric regex catches bare numbers and zero-padded variants (e.g., "01");
                // this may also match year-named seasons, which is an acceptable tradeoff.
                const sNum = season.seasonNumber;
                const trimmedName = (season.name || '').trim();
                const isNumericOnly = trimmedName === String(sNum) || /^0*\d+$/.test(trimmedName);
                const displayName = (trimmedName && !isNumericOnly)
                    ? trimmedName
                    : (sNum === 0 ? JC.t!('seerr_season_specials') : JC.t!('seerr_season_name', { number: sNum }));

                return `
                    <div class="season-card" data-season-number="${escapeHtml(String(sNum))}">
                        <div class="season-poster">
                            ${posterUrl ? `<img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(displayName)}" />` : ''}
                        </div>
                        <div class="season-info">
                            <div class="season-name">${escapeHtml(displayName)}</div>
                            <div class="season-meta">
                                ${escapeHtml(season.episodeCount || 0)} Episodes
                                ${season.airDate && isValidDate(season.airDate) ? ` \u2022 ${escapeHtml(season.airDate.substring(0, 4))}` : ''}
                            </div>
                            <div data-season-links>${buildSeasonAvailabilityLinks(seasonInfo, seasonJellyfinId, seasonJellyfinId4k)}</div>
                            ${season.overview ? `<div class="season-overview">${escapeHtml(season.overview)}</div>` : ''}
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    </div>
`;
}
internal.backfillSeasonMetadata = backfillSeasonMetadata;
internal.getSeasonStatusInfo = getSeasonStatusInfo;
internal.getSeasonJellyfinId = getSeasonJellyfinId;
internal.buildSeasonAvailabilityLinks = buildSeasonAvailabilityLinks;
internal.fetchJellyfinSeasonMap = fetchJellyfinSeasonMap;
internal.enrichSeasonCardsWithJellyfinLinks = enrichSeasonCardsWithJellyfinLinks;
internal.checkForUnrequestedSeasons = checkForUnrequestedSeasons;
internal.buildSeasonsSection = buildSeasonsSection;
