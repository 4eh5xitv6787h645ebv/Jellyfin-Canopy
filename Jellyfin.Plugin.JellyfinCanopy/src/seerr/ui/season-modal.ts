// src/seerr/ui/season-modal.ts
// Season-selection request modal for TV shows.
import { JC } from '../../globals';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload + DOM shapes; typed incrementally */


import { ui, internal } from './internal';
const logPrefix = '🪼 Jellyfin Canopy: Seerr UI:';
const escapeHtml = JC.escapeHtml;
let refreshModalTimer: ReturnType<typeof setTimeout> | null = null;
let refreshModalAbortController: AbortController | null = null;
let refreshModalGeneration = 0;
type IdentityCleanupElement = HTMLElement & { _jcIdentityCleanups?: Set<() => void> };

function cancelSeasonModalRefresh(): void {
    refreshModalGeneration += 1;
    if (refreshModalTimer !== null) {
        clearTimeout(refreshModalTimer);
        refreshModalTimer = null;
    }
    if (refreshModalAbortController) {
        refreshModalAbortController.abort();
        refreshModalAbortController = null;
    }
}

/**
 * Shows the enhanced season selection modal for TV shows.
 * @param {number} tmdbId - TMDB ID of the TV show.
 * @param {string} mediaType - Should be 'tv'.
 * @param {string} showTitle - Display title of the show.
 * @param {Object|null} searchResultItem - Original search result data.
 */
ui.showSeasonSelectionModal = async function (tmdbId: any, mediaType: any, showTitle: any, searchResultItem: any = null, is4k: any = false) {
    if (mediaType !== 'tv') return;
    const identity = JC.identity.capture();
    if (!identity || !JC.identity.isCurrent(identity)) return;
    cancelSeasonModalRefresh();
    const modalGeneration = refreshModalGeneration;
    const isCurrentGeneration = () => modalGeneration === refreshModalGeneration
        && JC.identity.isCurrent(identity);


    const { create, createAdvancedOptionsHTML, populateAdvancedOptions } = JC.seerrModal!;
    const { fetchTvShowDetails, fetchTvSeasonDetails, fetchTmdbTvDetails, requestTvSeasons, fetchAdvancedRequestData, fetchRequestSettings, requestMedia } = JC.seerrAPI!;

    // These settings decide whether the primary action requests selected
    // seasons or the whole show. A transport/schema failure cannot safely be
    // interpreted as `partialRequestsEnabled: false`.
    let requestSettings: Awaited<ReturnType<typeof fetchRequestSettings>> | null = null;
    try {
        requestSettings = await fetchRequestSettings();
    } catch (error: any) {
        console.warn(`${logPrefix} Failed to verify request settings:`, error);
    }
    if (!isCurrentGeneration()) return;
    if (!requestSettings?.available) {
        JC.toast!(JC.t!('seerr_toast_no_season_info'), 4000);
        return;
    }
    const { partialRequestsEnabled, enableSpecialEpisodes } = requestSettings;

    const initialRequestController = new AbortController();
    refreshModalAbortController = initialRequestController;
    let tvDetails: any = null;
    try {
        tvDetails = await fetchTvShowDetails(tmdbId, {
            signal: initialRequestController.signal,
        });
    } catch (error: any) {
        if (!initialRequestController.signal.aborted) {
            console.warn(`${logPrefix} Initial TV-detail request failed:`, error);
        }
    } finally {
        if (refreshModalAbortController === initialRequestController) {
            refreshModalAbortController = null;
        }
    }
    if (!isCurrentGeneration() || initialRequestController.signal.aborted) return;
    if (!tvDetails?.seasons) {
        JC.toast!(JC.t!('seerr_toast_no_season_info'), 4000);
        return;
    }

    const normalizedTitle = String(showTitle || '').trim();
    const isGenericFallbackTitle = ['this show', 'this movie', 'this collection'].includes(normalizedTitle.toLowerCase());
    const resolvedShowTitle = (!isGenericFallbackTitle && normalizedTitle)
        || tvDetails?.name
        || tvDetails?.title
        || searchResultItem?.name
        || searchResultItem?.title
        || searchResultItem?.originalName
        || searchResultItem?.originalTitle
        || normalizedTitle
        || 'Unknown Show';

    const showAdvanced = JC.pluginConfig.SeerrShowAdvanced;

    // Show season selection UI with Select All checkbox header
    const bodyHtml = `<div class="seerr-season-list">
        ${partialRequestsEnabled ? '<div class="seerr-season-header-row"><input type="checkbox" class="seerr-season-checkbox" id="seerr-select-all-seasons"><label class="seerr-season-header-label" for="seerr-select-all-seasons">' + JC.t!('seerr_select_all_seasons') + '</label><div></div><div></div></div>' : ''}
    </div>${showAdvanced ? createAdvancedOptionsHTML('tv') : ''}`;
    const modalInstance = create({
        title: is4k ? `${JC.t!('seerr_modal_title')} - 4K` : JC.t!('seerr_modal_title'),
        subtitle: resolvedShowTitle,
        bodyHtml,
        backdropPath: tvDetails.backdropPath,
        buttonText: is4k ? (JC.t!('seerr_btn_request_4k') || 'Request in 4K') : undefined,
        onClose: () => {
            if (isCurrentGeneration()) cancelSeasonModalRefresh();
        },
        onSave: async (modalEl: any, requestBtn: any, closeFn: any) => {
            const liveModal = modalEl as IdentityCleanupElement;
            if (!isCurrentGeneration() || !liveModal.isConnected) return;
            requestBtn.disabled = true;
            requestBtn.innerHTML = `${JC.t!('seerr_modal_requesting')}<span class="seerr-button-spinner"></span>`;

            // Polling can invalidate or replace the relationship graph after
            // the modal opens. Rendering disabled rows is not an authorization
            // barrier: the non-partial path does not read checkboxes at all.
            // Require the latest validated snapshot before either request path.
            if (seasonList?._requestStateValid !== true) {
                JC.toast!(JC.t!('seerr_toast_no_season_info'), 4000);
                requestBtn.disabled = false;
                requestBtn.textContent = is4k
                    ? (JC.t!('seerr_btn_request_4k') || 'Request in 4K')
                    : (partialRequestsEnabled ? JC.t!('seerr_modal_request_selected') : JC.t!('seerr_modal_request'));
                return;
            }

            let settings = {};
            if (showAdvanced) {
                const server = modalEl.querySelector('#tv-server').value;
                const quality = modalEl.querySelector('#tv-quality').value;
                const folder = modalEl.querySelector('#tv-folder').value;
                if (!server || !quality || !folder) {
                    JC.toast!(JC.t!('seerr_modal_toast_options_missing'), 3000);
                    requestBtn.disabled = false;
                    requestBtn.textContent = is4k ? (JC.t!('seerr_btn_request_4k') || 'Request in 4K') : (partialRequestsEnabled ? JC.t!('seerr_modal_request_selected') : JC.t!('seerr_modal_request'));
                    return;
                }
                settings = { serverId: parseInt(server), profileId: parseInt(quality), rootFolder: folder, tags: [] };
            }

            try {
                if (partialRequestsEnabled) {
                    // Partial requests enabled: request selected seasons (exclude the Select All checkbox)
                    const selectedSeasons = Array.from(modalEl.querySelectorAll('.seerr-season-item .seerr-season-checkbox:checked:not(:disabled)')).map((cb: any) => parseInt(cb.dataset.seasonNumber));
                    if (selectedSeasons.length === 0) {
                        JC.toast!(JC.t!('seerr_modal_toast_select_season'), 3000);
                        requestBtn.disabled = false;
                        requestBtn.textContent = is4k ? (JC.t!('seerr_btn_request_4k') || 'Request in 4K') : JC.t!('seerr_modal_request_selected');
                        return;
                    }
                    await requestTvSeasons(tmdbId, selectedSeasons, settings, searchResultItem, is4k);
                    if (!isCurrentGeneration() || !liveModal.isConnected) return;
                    JC.toast!(JC.t!('seerr_modal_toast_request_success', { count: selectedSeasons.length, title: JC.escapeHtml(resolvedShowTitle) }), 4000);
                } else {
                    // Partial requests disabled: request all non-special seasons to avoid locking specials
                    const allSeasons = Array.isArray(seasonList._validatedRegularSeasonNumbers)
                        ? seasonList._validatedRegularSeasonNumbers.slice()
                        : [];

                    if (allSeasons.length > 0) {
                        await requestTvSeasons(tmdbId, allSeasons, settings, searchResultItem, is4k);
                    } else {
                        await requestMedia(tmdbId, 'tv', settings, is4k, searchResultItem);
                    }
                    if (!isCurrentGeneration() || !liveModal.isConnected) return;

                    JC.toast!(JC.t!('seerr_modal_toast_request_success', { count: 'all', title: JC.escapeHtml(resolvedShowTitle) }), 4000);
                }
                // Notify any listening modals that TV was requested
                document.dispatchEvent(new CustomEvent('seerr-tv-requested', { detail: { tmdbId, mediaType: 'tv', is4k } }));
                document.dispatchEvent(new CustomEvent('seerr-media-requested', { detail: { tmdbId, mediaType: 'tv', is4k } }));

                // Update original card button to pending state
                internal.markCardRequested(tmdbId, 'tv', is4k);

                closeFn();
                const resultsRefreshTimer = setTimeout(() => {
                    if (!isCurrentGeneration()) return;
                    const query = new URLSearchParams(window.location.hash.split('?')[1])?.get('query');
                    if (query) {
                        const mainController = JC.seerr;
                        if (mainController) {
                            mainController.fetchAndRenderResults(query, { skipCache: true });
                        }
                    }
                }, 1000);
                liveModal._jcIdentityCleanups?.add(() => clearTimeout(resultsRefreshTimer));
            } catch (error: any) {
                if (!isCurrentGeneration() || !liveModal.isConnected) return;
                const resetLabel = is4k
                    ? (JC.t!('seerr_btn_request_4k') || 'Request in 4K')
                    : (partialRequestsEnabled ? JC.t!('seerr_modal_request_selected') : JC.t!('seerr_modal_request'));
                await internal.handleRequestError(error, 'tv', requestBtn, resetLabel);
            }
        }
    });

    // Populate season list inside the modal (shows immediately, air dates may be empty)
    const seasonList: any = modalInstance.modalElement.querySelector('.seerr-season-list');
    let renderedDetailVersion = 1;
    updateSeasonList(seasonList, tvDetails, partialRequestsEnabled, enableSpecialEpisodes, is4k);
    modalInstance.show();
    const isLiveModal = () => isCurrentGeneration()
        && document.body.contains(modalInstance.modalElement);

    // Quota chip — runs async so it doesn't block modal open.
    const tvBodyEl = modalInstance.modalElement.querySelector('.seerr-modal-body');
    if (tvBodyEl) {
        JC.seerrAPI?.fetchUserQuota?.().then((quota: any) => {
            if (!isCurrentGeneration()) return;
            const chip = internal.buildQuotaChip(quota, 'tv');
            if (chip && document.body.contains(modalInstance.modalElement)) {
                tvBodyEl.insertBefore(chip, tvBodyEl.firstChild);
            }
        }).catch((err: any) => console.warn(`${logPrefix} Quota chip render failed:`, err));
    }

    // Cached air dates — populated once, applied on every render (including polling refreshes)
    const airDateCache: any = {};

    /**
     * Validates that a string starts with an ISO date format (YYYY-MM-DD).
     * @param {string} d - The date string to validate.
     * @returns {boolean} True if the string matches the date pattern.
     */
    const isValidDate = (d: any) => /^\d{4}-\d{2}-\d{2}/.test(d);

    /**
     * Merges cached air dates into a Seerr tvDetails object.
     * Seasons without an airDate are backfilled from the cache (immutable per-season).
     * @param {object} details - The Seerr TV show details object.
     */
    function applyAirDateBackfill(details: any) {
        if (!details?.seasons || Object.keys(airDateCache).length === 0) return;
        details.seasons = details.seasons.map((s: any) => {
            if (!s.airDate && airDateCache[s.seasonNumber]) {
                return { ...s, airDate: airDateCache[s.seasonNumber] };
            }
            return s;
        });
    }

    // Async backfill: fetch air dates from per-season episode data, with TMDB as fallback
    const seasonsNeedingDates = tvDetails.seasons.filter((s: any) => s.episodeCount > 0 && !s.airDate);
    if (seasonsNeedingDates.length > 0) {
        const backfillDetailVersion = renderedDetailVersion;
        // Primary: fetch first episode air date from each season (Seerr/TheTVDB has these)
        const seasonFetches = seasonsNeedingDates.map((s: any) =>
            fetchTvSeasonDetails(tmdbId, s.seasonNumber).then((detail: any) => {
                if (!isCurrentGeneration()) return;
                const firstEp = detail?.episodes?.[0];
                if (firstEp?.airDate && isValidDate(firstEp.airDate)) {
                    airDateCache[s.seasonNumber] = firstEp.airDate;
                }
            }).catch(() => {})
        );

        // Fallback: also try TMDB for any gaps (runs in parallel)
        const tmdbFetch = JC.pluginConfig?.TmdbEnabled
            ? fetchTmdbTvDetails(tmdbId).then((tmdbData: any) => {
                if (!isCurrentGeneration()) return;
                if (!tmdbData?.seasons) return;
                tmdbData.seasons.forEach((s: any) => {
                    const date = s.air_date || '';
                    if (isValidDate(date) && !airDateCache[s.season_number]) {
                        airDateCache[s.season_number] = date;
                    }
                });
            }).catch(() => {})
            : Promise.resolve();

        // When all fetches complete, re-render with backfilled dates
        void Promise.all([...seasonFetches, tmdbFetch]).then(() => {
            // A poll may have rendered newer request/media state while this
            // metadata-only backfill was in flight. Never restore the captured
            // initial TV-detail snapshot over that newer state.
            if (!isLiveModal() || renderedDetailVersion !== backfillDetailVersion) return;
            applyAirDateBackfill(tvDetails);
            updateSeasonList(seasonList, tvDetails, partialRequestsEnabled, enableSpecialEpisodes, is4k);
        });
    }

    // Add Select All checkbox functionality
    if (partialRequestsEnabled) {
        const selectAllCheckbox = modalInstance.modalElement.querySelector<HTMLInputElement>('#seerr-select-all-seasons');
        if (selectAllCheckbox) {
            // Selector for regular season checkboxes (excludes Season 0 / Specials)
            const regularSeasonSelector = '.seerr-season-item:not([data-season-number="0"]) .seerr-season-checkbox:not(:disabled)';

            // Update Select All checkbox state when individual checkboxes change
            const updateSelectAllState = () => {
                const allSeasonCheckboxes = seasonList.querySelectorAll(regularSeasonSelector);
                const checkedCount = seasonList.querySelectorAll(`${regularSeasonSelector}:checked`).length;
                selectAllCheckbox.checked = checkedCount > 0 && checkedCount === allSeasonCheckboxes.length;
                selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < allSeasonCheckboxes.length;
            };

            // Handle Select All checkbox click — only toggles regular seasons, not Specials
            selectAllCheckbox.addEventListener('change', () => {
                if (!isCurrentGeneration()) return;
                const allSeasonCheckboxes = seasonList.querySelectorAll(regularSeasonSelector);
                allSeasonCheckboxes.forEach((checkbox: any) => {
                    checkbox.checked = selectAllCheckbox.checked;
                });
            });

            // Add change listeners to individual season checkboxes
            seasonList.addEventListener('change', (e: any) => {
                if (!isCurrentGeneration()) return;
                if (e.target.classList.contains('seerr-season-checkbox') && e.target.id !== 'seerr-select-all-seasons') {
                    updateSelectAllState();
                }
            });

            // Initialize Select All state
            updateSelectAllState();

            seasonList._updateSelectAllState = updateSelectAllState;
        }
    }

    // Poll recursively so at most one request is in flight. Every poll crosses
    // both cache layers using the dedicated fresh-TV-detail contract.
    const scheduleRefresh = () => {
        if (!isLiveModal()) return;
        refreshModalTimer = setTimeout(() => {
            refreshModalTimer = null;
            void refreshSeasonState();
        }, 10000);
    };
    const refreshSeasonState = async () => {
        if (!isLiveModal()) return;

        const controller = new AbortController();
        refreshModalAbortController = controller;
        let freshTvDetails: any = null;
        try {
            freshTvDetails = await fetchTvShowDetails(tmdbId, {
                fresh: true,
                signal: controller.signal,
            });
        } catch (error: any) {
            console.warn(`${logPrefix} TV-detail refresh failed:`, error);
        } finally {
            if (refreshModalAbortController === controller) {
                refreshModalAbortController = null;
            }
        }

        if (controller.signal.aborted || !isLiveModal()) return;
        renderedDetailVersion += 1;
        if (freshTvDetails) {
            applyAirDateBackfill(freshTvDetails);
            updateSeasonList(seasonList, freshTvDetails, partialRequestsEnabled, enableSpecialEpisodes, is4k);
        } else {
            invalidateSeasonRequestState(seasonList);
        }
        if (seasonList._updateSelectAllState) {
            seasonList._updateSelectAllState();
        }
        scheduleRefresh();
    };
    scheduleRefresh();

    if (showAdvanced) {
        try {
            const data = await fetchAdvancedRequestData('tv');
            if (!isLiveModal()) return;
            populateAdvancedOptions(modalInstance.modalElement, data, 'tv');
        } catch (error: any) {
            if (!isLiveModal()) return;
            console.error(`${logPrefix} Failed to load TV advanced options:`, error);
            JC.toast!(JC.t!('seerr_err_load_server_options'), 3000);
        }
    }
};

let uninstallIdentityReset: (() => void) | null = null;
let installLeases = 0;

export function installSeerrSeasonModal(): () => void {
    if (installLeases === 0) {
        uninstallIdentityReset = JC.identity.registerReset(
            'seerr-season-modal',
            cancelSeasonModalRefresh,
        );
    }
    installLeases += 1;
    let installed = true;
    return () => {
        if (!installed) return;
        installed = false;
        installLeases -= 1;
        if (installLeases > 0) return;
        uninstallIdentityReset?.();
        uninstallIdentityReset = null;
        cancelSeasonModalRefresh();
        document.querySelectorAll('.seerr-season-modal').forEach((modal) => modal.remove());
    };
}


function invalidateSeasonRequestState(seasonListElement: any): void {
    if (!seasonListElement) return;
    seasonListElement._requestStateValid = false;
    seasonListElement._validatedRegularSeasonNumbers = [];
    seasonListElement.querySelectorAll('.seerr-season-checkbox').forEach((checkbox: HTMLInputElement) => {
        checkbox.checked = false;
        checkbox.disabled = true;
    });
    seasonListElement.querySelectorAll('.seerr-season-item').forEach((row: HTMLElement) => {
        row.classList.add('disabled');
    });
}

function updateSeasonList(seasonListElement: any, tvDetails: any, partialRequestsEnabled: any = true, enableSpecialEpisodes: any = false, is4kMode: any = false) {
    if (!seasonListElement) return;

    // Publish validity only after the entire relationship graph and every row
    // have rendered successfully. A malformed refresh must never inherit the
    // previous snapshot's authorization marker.
    seasonListElement._requestStateValid = false;
    seasonListElement._validatedRegularSeasonNumbers = [];
    if (!tvDetails || typeof tvDetails !== 'object') {
        invalidateSeasonRequestState(seasonListElement);
        return;
    }

    try {

    const MediaStatus = JC.seerrStatus!.MEDIA;
    const RequestStatus = JC.seerrStatus!.REQUEST;
    const mediaStatusMap: any = {};
    const validMediaStatuses = new Set(Object.values(MediaStatus));
    const validRequestStatuses = new Set(Object.values(RequestStatus));
    let relationStateValid = true;
    let globallyBlocked = false;

    // Request state and media availability are separate Seerr enum domains.
    // An active same-mode parent request blocks a duplicate, but its child
    // status integer must never overwrite or be interpreted as MediaStatus.
    const activeRequestSeasons = new Set<number>();
    const mediaInfo = tvDetails.mediaInfo;
    if (mediaInfo !== undefined && mediaInfo !== null) {
        if (typeof mediaInfo !== 'object'
            || !validMediaStatuses.has(mediaInfo.status)
            || !validMediaStatuses.has(mediaInfo.status4k)
            || !Array.isArray(mediaInfo.seasons)
            || !Array.isArray(mediaInfo.requests)) {
            relationStateValid = false;
        } else {
            const selectedTopStatus = is4kMode ? mediaInfo.status4k : mediaInfo.status;
            globallyBlocked = mediaInfo.status === MediaStatus.BLOCKED
                || selectedTopStatus === MediaStatus.BLOCKED;
            const seenMediaSeasons = new Set<number>();
            for (const seasonState of mediaInfo.seasons) {
                const seasonNumber = seasonState?.seasonNumber;
                if (!Number.isInteger(seasonNumber)
                    || seasonNumber < 0
                    || seenMediaSeasons.has(seasonNumber)
                    || !validMediaStatuses.has(seasonState?.status)
                    || !validMediaStatuses.has(seasonState?.status4k)) {
                    relationStateValid = false;
                    break;
                }
                seenMediaSeasons.add(seasonNumber);
                mediaStatusMap[seasonNumber] = is4kMode
                    ? seasonState.status4k
                    : seasonState.status;
            }

            const seenRequestIds = new Set<number>();
            for (const request of mediaInfo.requests) {
                const requestId = request?.id;
                if (!relationStateValid
                    || !Number.isInteger(requestId)
                    || requestId <= 0
                    || seenRequestIds.has(requestId)
                    || typeof request?.is4k !== 'boolean'
                    || !validRequestStatuses.has(request?.status)
                    || !Array.isArray(request?.seasons)) {
                    relationStateValid = false;
                    break;
                }
                seenRequestIds.add(requestId);

                const seenRequestSeasons = new Set<number>();
                for (const requestSeason of request.seasons) {
                    const seasonNumber = requestSeason?.seasonNumber;
                    if (!Number.isInteger(seasonNumber)
                        || seasonNumber < 0
                        || seenRequestSeasons.has(seasonNumber)
                        || !validRequestStatuses.has(requestSeason?.status)) {
                        relationStateValid = false;
                        break;
                    }
                    seenRequestSeasons.add(seasonNumber);
                    if (request.is4k === !!is4kMode
                        && request.status !== RequestStatus.DECLINED
                        && request.status !== RequestStatus.COMPLETED) {
                        activeRequestSeasons.add(seasonNumber);
                    }
                }

                if (!relationStateValid) break;
            }
        }
    }

    // Filter out seasons with no episodes, and hide Season 0 (Specials) unless enabled in Seerr
    const rootSeasons = Array.isArray(tvDetails.seasons) ? tvDetails.seasons : [];
    if (!Array.isArray(tvDetails.seasons)) relationStateValid = false;
    const seenRootSeasons = new Set<number>();
    const seasons = rootSeasons
        .filter((season: any) => {
            const seasonNumber = season?.seasonNumber;
            if (!Number.isInteger(seasonNumber)
                || seasonNumber < 0
                || !Number.isInteger(season?.episodeCount)
                || season.episodeCount < 0
                || seenRootSeasons.has(seasonNumber)) {
                relationStateValid = false;
                return false;
            }
            seenRootSeasons.add(seasonNumber);
            if ((season.name !== undefined && season.name !== null && typeof season.name !== 'string')
                || (season.airDate !== undefined && season.airDate !== null && typeof season.airDate !== 'string')) {
                relationStateValid = false;
            }
            return true;
        })
        .filter((s: any) => s.episodeCount && s.episodeCount > 0)
        .filter((s: any) => s.seasonNumber !== 0 || enableSpecialEpisodes)
        .slice()
        .sort((a: any, b: any) => (a.seasonNumber || 0) - (b.seasonNumber || 0));
    const visibleSeasonNumbers = new Set(
        seasons.map((season: any) => Number(season.seasonNumber)),
    );
    seasonListElement.querySelectorAll('.seerr-season-item').forEach((row: HTMLElement) => {
        const seasonNumber = Number(row.dataset.seasonNumber);
        if (!visibleSeasonNumbers.has(seasonNumber)) row.remove();
    });
    seasons.forEach((season: any) => {
        const seasonNumber = season.seasonNumber;
        let seasonItem = seasonListElement.querySelector(`.seerr-season-item[data-season-number="${seasonNumber}"]`);

        // If the season item doesn't exist, create it
        if (!seasonItem) {
            seasonItem = document.createElement('div');
            seasonItem.className = 'seerr-season-item';
            seasonItem.dataset.seasonNumber = seasonNumber;
            seasonListElement.appendChild(seasonItem);
        }

        const rawMediaStatus = !relationStateValid || globallyBlocked
            ? MediaStatus.BLOCKED
            : mediaStatusMap[seasonNumber];
        const hasActiveRequest = !relationStateValid
            || activeRequestSeasons.has(Number(seasonNumber));

        // Jellyfin link IDs are not authoritative absence evidence: Seerr can
        // aggregate multiple libraries and retain a different contributing ID.
        // effectiveMediaStatus therefore preserves AVAILABLE until a future
        // server-owned reconciliation source can prove global absence.
        const showJellyfinId = is4kMode
            ? (tvDetails.mediaInfo?.jellyfinMediaId4k || null)
            : (tvDetails.mediaInfo?.jellyfinMediaId || null);
        const effectiveMediaStatus = JC.seerrStatus!.effectiveMediaStatus(rawMediaStatus, showJellyfinId);
        const mediaIsRequestable = JC.seerrStatus!.isRequestable(effectiveMediaStatus);
        const canRequest = relationStateValid && !globallyBlocked && !hasActiveRequest && mediaIsRequestable;
        const rawModeDownloads = is4kMode ? tvDetails.mediaInfo?.downloadStatus4k : tvDetails.mediaInfo?.downloadStatus;
        const modeDownloads = Array.isArray(rawModeDownloads) ? rawModeDownloads : [];
        const hasSeasonDownloads = modeDownloads.some((ds: any) => ds.episode?.seasonNumber === seasonNumber);
        // Preserve canonical media state. When it is otherwise requestable but
        // an active request exists, synthesize MediaStatus.PENDING for display
        // only; getDisplayInfo then renders Requested/Processing without ever
        // conflating the two upstream enum domains.
        const displayStatus = hasActiveRequest && mediaIsRequestable
            ? MediaStatus.PENDING
            : effectiveMediaStatus;
        const { labelKey, cssClass: statusClass } = JC.seerrStatus!.getDisplayInfo(displayStatus, hasSeasonDownloads);
        const statusText = JC.t!(labelKey);

        // Preserve a selection only while the refreshed row remains
        // requestable. Polling can make a previously selected season active;
        // carrying its checked state onto a disabled checkbox would still let
        // an older submit path include it.
        const existingCheckbox = seasonItem.querySelector('.seerr-season-checkbox');
        const isChecked = existingCheckbox ? existingCheckbox.checked : false;

        // Disable checkbox if partial requests are disabled OR if the season can't be requested
        const checkboxDisabled = !partialRequestsEnabled || !canRequest;

        // Derive a display name: if the API returns just the number (TheTVDB), generate a proper label.
        // The numeric regex catches bare numbers and zero-padded variants (e.g., "01");
        // this may also match year-named seasons, which is an acceptable tradeoff.
        const trimmedName = typeof season.name === 'string' ? season.name.trim() : '';
        const airDate = typeof season.airDate === 'string' ? season.airDate : '';
        const isNumericOnly = trimmedName === String(seasonNumber) || /^0*\d+$/.test(trimmedName);
        const displayName = (trimmedName && !isNumericOnly)
            ? trimmedName
            : (seasonNumber === 0 ? JC.t!('seerr_season_specials') : JC.t!('seerr_season_name', { number: seasonNumber }));

        // All interpolated values are escaped via escapeHtml() to prevent XSS
        seasonItem.innerHTML = `
            <input type="checkbox" class="seerr-season-checkbox" data-season-number="${escapeHtml(seasonNumber)}" ${checkboxDisabled ? 'disabled' : ''} style="${!partialRequestsEnabled ? 'cursor: not-allowed;' : ''}">
            <div class="seerr-season-info">
                <div class="seerr-season-name">${escapeHtml(displayName)}</div>
                <div class="seerr-season-meta">${escapeHtml(airDate ? airDate.substring(0, 4) : '')}</div>
            </div>
            <div class="seerr-season-episodes">${escapeHtml(season.episodeCount || 0)} ep</div>
            <div class="seerr-season-status seerr-season-status-${escapeHtml(statusClass)}">${escapeHtml(statusText)}</div>
        `;

        if(existingCheckbox && !checkboxDisabled) {
            seasonItem.querySelector('.seerr-season-checkbox').checked = isChecked;
        }

        seasonItem.classList.toggle('disabled', !canRequest);

        // Add/Update inline download progress
        const existingProgress = seasonItem.querySelector('.seerr-inline-progress');
        if (existingProgress) existingProgress.remove();

        if (hasSeasonDownloads && modeDownloads.length > 0) {
            const seasonDownloads = modeDownloads.filter((ds: any) => ds.episode?.seasonNumber === seasonNumber);
            if (seasonDownloads.length > 0) {
                const totalSize = seasonDownloads.reduce((sum: any, ds: any) => sum + (ds.size || 0), 0);
                const totalSizeLeft = seasonDownloads.reduce((sum: any, ds: any) => sum + (ds.sizeLeft || 0), 0);
                if (totalSize > 0) {
                    const aggregatedStatus = { size: totalSize, sizeLeft: totalSizeLeft, status: `${seasonDownloads.length} episode(s) downloading` };
                    const progressElement = internal.createInlineProgress(aggregatedStatus);
                    if (progressElement) seasonItem.appendChild(progressElement);
                }
            }
        }
    });

    if (relationStateValid && !globallyBlocked) {
        seasonListElement._validatedRegularSeasonNumbers = seasons
            .map((season: any) => Number(season.seasonNumber))
            .filter((seasonNumber: number) => Number.isInteger(seasonNumber) && seasonNumber > 0);
        const selectAllCheckbox = seasonListElement.querySelector('#seerr-select-all-seasons') as HTMLInputElement | null;
        if (selectAllCheckbox) selectAllCheckbox.disabled = !partialRequestsEnabled;
        // This assignment is deliberately last: any exception above leaves the
        // submit path fail-closed.
        seasonListElement._requestStateValid = true;
    } else {
        invalidateSeasonRequestState(seasonListElement);
    }
    } catch (error: any) {
        console.warn(`${logPrefix} Refusing malformed TV-detail season state:`, error);
        invalidateSeasonRequestState(seasonListElement);
    }
}
internal.updateSeasonList = updateSeasonList;
