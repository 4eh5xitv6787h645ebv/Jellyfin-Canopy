// src/jellyseerr/ui/request-modals.ts
// Advanced request modals for movies and collections.
import { JC } from '../../globals';
// PERF(R6): no remote assets — poster placeholder embedded in the plugin DLL.
import { assetUrl } from '../../core/asset-urls';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload + DOM shapes; typed incrementally */


import { ui, internal } from './internal';
const MediaStatus = JC.seerrStatus!.MEDIA;
const logPrefix = '🪼 Jellyfin Canopy: Seerr UI:';
const escapeHtml = JC.escapeHtml;
const icons = internal.icons; // requires ui-icons.js to be loaded first

/**
 * Shows the advanced request modal for movies.
 * @param {number} tmdbId - TMDB ID of the movie.
 * @param {string} title - Display title of the movie.
 * @param {Object|null} searchResultItem - Original search result data.
 */
ui.showMovieRequestModal = async function (tmdbId: any, title: any, searchResultItem: any, is4k: any = false) {
    const { create, createAdvancedOptionsHTML, populateAdvancedOptions } = JC.jellyseerrModal!;
    const { requestMedia, fetchAdvancedRequestData, fetchUserQuota } = JC.jellyseerrAPI!;

    const bodyHtml = createAdvancedOptionsHTML('movie');
    const { modalElement, show } = create({
        title: JC.t!('jellyseerr_modal_title_movie'),
        subtitle: title,
        bodyHtml,
        backdropPath: searchResultItem?.backdropPath,
        onSave: async (modalEl: any, requestBtn: any, closeFn: any) => {
            const serverSelect = modalEl.querySelector('#movie-server');
            const qualitySelect = modalEl.querySelector('#movie-quality');
            const folderSelect = modalEl.querySelector('#movie-folder');

            if (!serverSelect.value || !qualitySelect.value || !folderSelect.value) {
                JC.toast!(JC.t!('jellyseerr_modal_toast_options_missing'), 3000);
                return;
            }

            requestBtn.disabled = true;
            requestBtn.innerHTML = `${JC.t!('jellyseerr_modal_requesting')}<span class="jellyseerr-button-spinner"></span>`;
            const settings = { serverId: parseInt(serverSelect.value), profileId: parseInt(qualitySelect.value), rootFolder: folderSelect.value, tags: [] };

            try {
                await requestMedia(tmdbId, 'movie', settings, is4k, searchResultItem);
                // Manually update the original button on the card
                const originalButton = document.querySelector(`.jellyseerr-request-button[data-tmdb-id="${tmdbId}"]`);
                if (originalButton) {
                    originalButton.innerHTML = `<span>${JC.t!('jellyseerr_btn_requested')}</span>${icons.requested}`;
                    originalButton.classList.remove('jellyseerr-button-request');
                    originalButton.classList.add('jellyseerr-button-pending');
                }
                closeFn();
            } catch (error: any) {
                await internal.handleRequestError(error, 'movie', requestBtn, JC.t!('jellyseerr_modal_request'));
            }
        }
    });
    show();

    // Quota chip — runs in parallel with advanced-options fetch.
    const bodyEl = modalElement.querySelector('.jellyseerr-modal-body');
    if (bodyEl) {
        fetchUserQuota().then((quota: any) => {
            const chip = internal.buildQuotaChip(quota, 'movie');
            if (chip && document.body.contains(modalElement)) {
                bodyEl.insertBefore(chip, bodyEl.firstChild);
            }
        }).catch((err: any) => console.warn(`${logPrefix} Quota chip render failed:`, err));
    }

    try {
        const data = await fetchAdvancedRequestData('movie');
        populateAdvancedOptions(modalElement, data, 'movie');
    } catch (error: any) {
        console.error(`${logPrefix} Failed to load advanced options:`, error);
        JC.toast!(JC.t!('jellyseerr_err_load_server_options'), 3000);
    }


};

/**
 * Resolves a collection movie row's badge + selectability from a Seerr media
 * status. Shared between the initial (standard-quality) render and the 4K-mode
 * re-evaluation so the two never drift. Already-available, already-requested and
 * blocklisted movies are non-selectable.
 */
function describeCollectionRowStatus(status: number, hasActiveDownloads: boolean): { statusClass: string; statusText: string; isDisabled: boolean } {
    let statusClass = 'not-requested';
    let statusText = JC.t!('jellyseerr_season_status_not_requested') || 'Not Requested';

    if (status === MediaStatus.AVAILABLE) {
        statusClass = 'available';
        statusText = JC.t!('jellyseerr_btn_available') || 'Available';
    } else if (status === MediaStatus.PARTIALLY_AVAILABLE) {
        statusClass = 'partially-available';
        statusText = JC.t!('jellyseerr_btn_partially_available') || 'Partially Available';
    } else if (status === MediaStatus.PROCESSING) {
        if (hasActiveDownloads) {
            statusClass = 'processing';
            statusText = JC.t!('jellyseerr_btn_processing') || 'Processing';
        } else {
            statusClass = 'pending';
            statusText = JC.t!('jellyseerr_btn_requested') || 'Requested';
        }
    } else if (status === MediaStatus.PENDING) {
        statusClass = 'pending';
        statusText = JC.t!('jellyseerr_btn_pending') || 'Pending';
    } else if (status === MediaStatus.BLOCKED) {
        statusClass = 'blocklisted';
        statusText = JC.t!('jellyseerr_btn_blocklisted') || 'Blocklisted';
    }

    const isDisabled = status === MediaStatus.AVAILABLE
        || status === MediaStatus.PENDING
        || status === MediaStatus.PROCESSING
        || status === MediaStatus.BLOCKED;
    return { statusClass, statusText, isDisabled };
}

/**
 * Shows a modal for requesting a collection (all movies in a TMDB collection).
 * @param {number} collectionId - The TMDB collection IDisplayStatus.
 * @param {string} collectionName - The name of the collection.
 * @param {object} searchResultItem - Optional search result item data.
 */
ui.showCollectionRequestModal = async function (collectionId: any, collectionName: any, searchResultItem: any = null) {
    const { create, createAdvancedOptionsHTML, populateAdvancedOptions } = JC.jellyseerrModal!;
    const { fetchCollectionDetails, requestMedia, fetchAdvancedRequestData } = JC.jellyseerrAPI!;

    // Fetch collection details
    let collectionDetails;
    try {
        collectionDetails = await fetchCollectionDetails(collectionId);
    } catch (error: any) {
        JC.toast!(JC.t!('jellyseerr_toast_collection_fetch_failed'), 4000);
        return;
    }

    if (!collectionDetails?.parts || collectionDetails.parts.length === 0) {
        JC.toast!(JC.t!('jellyseerr_toast_no_movies_in_collection'), 4000);
        return;
    }

    const showAdvanced = JC.pluginConfig.JellyseerrShowAdvanced;
    // Offer a "request the whole collection in 4K" toggle only when 4K requests
    // are actually available to this user (admin toggle AND Seerr 4K capability
    // AND the user's 4K permission). Collections are movies, so gate on 'movie'.
    const show4k = JC.jellyseerrAPI!.canRequest4k('movie');

    // Create checkbox list of movies in the collection with posters and status badges.
    // Each row carries BOTH the standard and 4K status so the 4K toggle can
    // re-evaluate which movies are already available/requested without re-fetching.
    const movieListHtml = collectionDetails.parts.map((movie: any) => {
        const m = movie as {
            id?: number | string;
            title?: string;
            releaseDate?: string;
            posterPath?: string;
            mediaInfo?: { status?: number; status4k?: number; downloadStatus?: unknown[]; downloadStatus4k?: unknown[] };
        };
        const status = m.mediaInfo?.status || MediaStatus.UNKNOWN;
        const status4k = m.mediaInfo?.status4k || MediaStatus.UNKNOWN;
        const hasActiveDownloads = (m.mediaInfo?.downloadStatus?.length ?? 0) > 0;
        const hasActiveDownloads4k = (m.mediaInfo?.downloadStatus4k?.length ?? 0) > 0;
        const { statusClass, statusText, isDisabled } = describeCollectionRowStatus(status, hasActiveDownloads);

        const year = m.releaseDate ? new Date(m.releaseDate).getFullYear() : '';
        const poster = m.posterPath
            ? `https://image.tmdb.org/t/p/w92${m.posterPath}`
            : assetUrl('jellyseerr/poster-fallback.svg');

        return `
            <div class="jellyseerr-collection-movie-row"
                 data-status="${Number(status) || 1}"
                 data-status4k="${Number(status4k) || 1}"
                 data-has-downloads="${hasActiveDownloads ? '1' : '0'}"
                 data-has-downloads4k="${hasActiveDownloads4k ? '1' : '0'}">
                <input type="checkbox"
                       class="jellyseerr-collection-checkbox"
                       id="movie-${escapeHtml(m.id)}"
                       data-tmdb-id="${escapeHtml(m.id)}"
                       ${isDisabled ? 'disabled' : 'checked'}>
                <img src="${escapeHtml(poster)}" alt="${escapeHtml(m.title)}" class="jellyseerr-collection-movie-poster">
                <div class="jellyseerr-collection-movie-details">
                    <div class="title">${escapeHtml(m.title)}</div>
                    <div class="year">${escapeHtml(year)}</div>
                </div>
                <div class="jellyseerr-season-status jellyseerr-season-status-${escapeHtml(statusClass)}">${escapeHtml(statusText)}</div>
            </div>
        `;
    }).join('');

    const request4kLabel = JC.t!('jellyseerr_btn_request_4k') || 'Request in 4K';
    const the4kToggleHtml = show4k
        ? `<label class="jellyseerr-collection-4k-toggle">
               <input type="checkbox" id="jellyseerr-collection-4k">
               <span>${escapeHtml(request4kLabel)}</span>
           </label>`
        : '';

    const bodyHtml = `
        ${the4kToggleHtml}
        <div class="jellyseerr-collection-list" style="max-height: 600px; overflow-y: auto;">
            <div class="jellyseerr-collection-header-row">
                <input type="checkbox" class="jellyseerr-collection-checkbox" id="jellyseerr-select-all-movies">
                <label class="jellyseerr-collection-header-label" for="jellyseerr-select-all-movies">${JC.t!('jellyseerr_select_all_movies') || 'Select All'}</label>
                <div></div>
                <div></div>
            </div>
            ${movieListHtml}
        </div>
        ${showAdvanced ? createAdvancedOptionsHTML('movie') : ''}
    `;

    const modalInstance = create({
        title: JC.t!('jellyseerr_modal_request_collection') || 'Request Collection',
        subtitle: collectionName,
        bodyHtml,
        backdropPath: collectionDetails.backdrop_path || collectionDetails.backdropPath,
        buttonText: JC.t!('jellyseerr_modal_request_selected_movies') || 'Request Selected Movies',
        onSave: async (modalEl: any, requestBtn: any, closeFn: any) => {
            requestBtn.disabled = true;
            requestBtn.innerHTML = `${JC.t!('jellyseerr_modal_requesting') || 'Requesting'}<span class="jellyseerr-button-spinner"></span>`;

            const is4k = !!(modalEl.querySelector('#jellyseerr-collection-4k') as HTMLInputElement | null)?.checked;

            let settings = {};
            if (showAdvanced) {
                const server = modalEl.querySelector('#movie-server').value;
                const quality = modalEl.querySelector('#movie-quality').value;
                const folder = modalEl.querySelector('#movie-folder').value;
                if (!server || !quality || !folder) {
                    JC.toast!(JC.t!('jellyseerr_modal_toast_options_missing') || 'Please select all options', 3000);
                    requestBtn.disabled = false;
                    requestBtn.textContent = JC.t!('jellyseerr_modal_request_selected_movies') || 'Request Selected Movies';
                    return;
                }
                settings = { serverId: parseInt(server), profileId: parseInt(quality), rootFolder: folder, tags: [] };
            }

            try {
                const selectedMovies = Array.from(modalEl.querySelectorAll('.jellyseerr-collection-movie-row .jellyseerr-collection-checkbox:checked:not(:disabled)'))
                    .map((cb: any) => parseInt(cb.dataset.tmdbId));

                if (selectedMovies.length === 0) {
                    JC.toast!(JC.t!('jellyseerr_modal_toast_select_movie') || 'Please select at least one movie', 3000);
                    requestBtn.disabled = false;
                    requestBtn.textContent = JC.t!('jellyseerr_modal_request_selected_movies') || 'Request Selected Movies';
                    return;
                }

                let successCount = 0;
                let otherFailures = 0;
                let quotaHitError: any = null;
                for (const tmdbId of selectedMovies) {
                    try {
                        await requestMedia(tmdbId, 'movie', settings, is4k, searchResultItem);
                        successCount++;
                    } catch (error: any) {
                        // Once quota is hit every remaining request will also fail — break.
                        if (ui.isQuotaError && ui.isQuotaError(error)) {
                            quotaHitError = error;
                            break;
                        }
                        otherFailures++;
                        console.error(`Failed to request movie ${tmdbId}:`, error);
                    }
                }

                const requestedLabel = JC.t!('jellyseerr_toast_collection_requested') || 'Requested';
                const moviesLabel = JC.t!('jellyseerr_toast_movies') || 'movies';
                const total = selectedMovies.length;
                let toastText = `${requestedLabel} ${successCount} of ${total} ${moviesLabel}`;
                if (otherFailures > 0) {
                    toastText += ' ' + JC.t!('jellyseerr_toast_collection_failed_count', { count: otherFailures });
                }
                JC.toast!(toastText, 4000);
                if (quotaHitError) {
                    await ui.showQuotaErrorDialog(quotaHitError, 'movie');
                }
                closeFn();

                // Refresh search results
                setTimeout(() => {
                    const query = new URLSearchParams(window.location.hash.split('?')[1])?.get('query');
                    if (query) {
                        const mainController = JC.jellyseerr;
                        if (mainController) {
                            mainController.fetchAndRenderResults(query);
                        }
                    }
                }, 1000);
            } catch (error: any) {
                JC.toast!(JC.t!('jellyseerr_modal_toast_request_fail') || 'Request failed', 4000);
                requestBtn.disabled = false;
                requestBtn.textContent = JC.t!('jellyseerr_modal_request_selected_movies') || 'Request Selected Movies';
            }
        }
    });

    // Populate advanced options if needed
    if (showAdvanced) {
        try {
            const advancedData = await fetchAdvancedRequestData('movie');
            populateAdvancedOptions(modalInstance.modalElement, advancedData, 'movie');
        } catch (error: any) {
            console.error('Failed to load advanced options:', error);
        }
    }

    modalInstance.show();

    // Add Select All checkbox functionality
    const selectAllCheckbox = modalInstance.modalElement.querySelector<HTMLInputElement>('#jellyseerr-select-all-movies')!;
    const movieList = modalInstance.modalElement.querySelector('.jellyseerr-collection-list')!;

    if (selectAllCheckbox && movieList) {
        const updateSelectAllState = () => {
            const allCheckboxes = movieList.querySelectorAll('.jellyseerr-collection-movie-row .jellyseerr-collection-checkbox:not(:disabled)');
            const checkedCount = movieList.querySelectorAll('.jellyseerr-collection-movie-row .jellyseerr-collection-checkbox:not(:disabled):checked').length;
            selectAllCheckbox.checked = checkedCount > 0 && checkedCount === allCheckboxes.length;
            selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < allCheckboxes.length;
        };

        selectAllCheckbox.addEventListener('change', () => {
            const allCheckboxes = movieList.querySelectorAll('.jellyseerr-collection-movie-row .jellyseerr-collection-checkbox:not(:disabled)');
            allCheckboxes.forEach((checkbox: any) => {
                checkbox.checked = selectAllCheckbox.checked;
            });
        });

        movieList.addEventListener('change', (e: any) => {
            if (e.target.classList.contains('jellyseerr-collection-checkbox') && e.target.id !== 'jellyseerr-select-all-movies') {
                updateSelectAllState();
            }
        });

        // 4K toggle: re-evaluate every row against the standard vs 4K status so
        // the "already available/requested" disabling and badges track the mode.
        const fourKToggle = modalInstance.modalElement.querySelector<HTMLInputElement>('#jellyseerr-collection-4k');
        if (fourKToggle) {
            fourKToggle.addEventListener('change', () => {
                const is4k = fourKToggle.checked;
                movieList.querySelectorAll<HTMLElement>('.jellyseerr-collection-movie-row').forEach((row) => {
                    const checkbox = row.querySelector<HTMLInputElement>('.jellyseerr-collection-checkbox');
                    const badge = row.querySelector<HTMLElement>('.jellyseerr-season-status');
                    if (!checkbox || !badge) return;
                    const status = Number(is4k ? row.dataset.status4k : row.dataset.status) || MediaStatus.UNKNOWN;
                    const hasDownloads = (is4k ? row.dataset.hasDownloads4k : row.dataset.hasDownloads) === '1';
                    const { statusClass, statusText, isDisabled } = describeCollectionRowStatus(status, hasDownloads);
                    const wasDisabled = checkbox.disabled;
                    checkbox.disabled = isDisabled;
                    // Preserve the user's manual selections across a mode toggle: only
                    // force-uncheck rows that just became disabled. Rows that stay
                    // selectable keep their current checked state; rows that flip from
                    // disabled→enabled default to checked.
                    if (isDisabled) {
                        checkbox.checked = false;
                    } else if (wasDisabled) {
                        checkbox.checked = true;
                    }
                    badge.className = `jellyseerr-season-status jellyseerr-season-status-${statusClass}`;
                    badge.textContent = statusText;
                });
                updateSelectAllState();
            });
        }

        updateSelectAllState();
    }
};
