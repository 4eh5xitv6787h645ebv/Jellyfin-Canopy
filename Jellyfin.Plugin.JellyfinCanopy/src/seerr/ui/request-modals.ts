// src/seerr/ui/request-modals.ts
// Advanced request modals for movies and collections.
import { JC } from '../../globals';
// PERF(R6): no remote assets — poster placeholder embedded in the plugin DLL.
import { assetUrl } from '../../core/asset-urls';
import { seerrStatus } from '../seerr-status';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload + DOM shapes; typed incrementally */


import { ui, internal } from './internal';
const MediaStatus = seerrStatus.MEDIA;
const logPrefix = '🪼 Jellyfin Canopy: Seerr UI:';
const escapeHtml = JC.escapeHtml;
const icons = internal.icons; // requires ui-icons.js to be loaded first
type IdentityCleanupElement = HTMLElement & { _jcIdentityCleanups?: Set<() => void> };

/**
 * Shows the advanced request modal for movies.
 * @param {number} tmdbId - TMDB ID of the movie.
 * @param {string} title - Display title of the movie.
 * @param {Object|null} searchResultItem - Original search result data.
 */
ui.showMovieRequestModal = async function (tmdbId: any, title: any, searchResultItem: any, is4k: any = false) {
    const identity = JC.identity.capture();
    if (!identity || !JC.identity.isCurrent(identity)) return;
    const { create, createAdvancedOptionsHTML, populateAdvancedOptions } = JC.seerrModal!;
    const { requestMedia, fetchAdvancedRequestData, fetchUserQuota } = JC.seerrAPI!;

    const bodyHtml = createAdvancedOptionsHTML('movie');
    const { modalElement, show } = create({
        title: JC.t!('seerr_modal_title_movie'),
        subtitle: title,
        bodyHtml,
        backdropPath: searchResultItem?.backdropPath,
        onSave: async (modalEl: HTMLElement, requestBtn: HTMLButtonElement, closeFn: () => void) => {
            const isCurrent = () => JC.identity.isCurrent(identity) && modalEl.isConnected;
            if (!isCurrent()) return;
            const serverSelect = modalEl.querySelector<HTMLSelectElement>('#movie-server');
            const qualitySelect = modalEl.querySelector<HTMLSelectElement>('#movie-quality');
            const folderSelect = modalEl.querySelector<HTMLSelectElement>('#movie-folder');

            if (!serverSelect?.value || !qualitySelect?.value || !folderSelect?.value) {
                JC.toast!(JC.t!('seerr_modal_toast_options_missing'), 3000);
                return;
            }

            requestBtn.disabled = true;
            requestBtn.innerHTML = `${JC.t!('seerr_modal_requesting')}<span class="seerr-button-spinner"></span>`;
            const settings = { serverId: parseInt(serverSelect.value), profileId: parseInt(qualitySelect.value), rootFolder: folderSelect.value, tags: [] };

            try {
                await requestMedia(tmdbId, 'movie', settings, is4k, searchResultItem);
                if (!isCurrent()) return;
                // Manually update the original button on the card
                const originalButton = document.querySelector<HTMLButtonElement>(
                    `.seerr-request-button[data-tmdb-id="${tmdbId}"]`
                );
                if (originalButton && JC.identity.isOwned(originalButton, identity)) {
                    originalButton.innerHTML = `<span>${JC.t!('seerr_btn_requested')}</span>${icons.requested}`;
                    originalButton.classList.remove('seerr-button-request');
                    originalButton.classList.add('seerr-button-pending');
                }
                closeFn();
            } catch (error: any) {
                if (!isCurrent()) return;
                await internal.handleRequestError(error, 'movie', requestBtn, JC.t!('seerr_modal_request'));
            }
        }
    });
    show();

    // Quota chip — runs in parallel with advanced-options fetch.
    const bodyEl = modalElement.querySelector('.seerr-modal-body');
    if (bodyEl) {
        fetchUserQuota().then((quota: any) => {
            if (!JC.identity.isCurrent(identity)) return;
            const chip = internal.buildQuotaChip(quota, 'movie');
            if (chip && document.body.contains(modalElement)) {
                bodyEl.insertBefore(chip, bodyEl.firstChild);
            }
        }).catch((err: any) => console.warn(`${logPrefix} Quota chip render failed:`, err));
    }

    try {
        const data = await fetchAdvancedRequestData('movie');
        if (!JC.identity.isCurrent(identity) || !modalElement.isConnected) return;
        populateAdvancedOptions(modalElement, data, 'movie');
    } catch (error: any) {
        if (!JC.identity.isCurrent(identity) || !modalElement.isConnected) return;
        console.error(`${logPrefix} Failed to load advanced options:`, error);
        JC.toast!(JC.t!('seerr_err_load_server_options'), 3000);
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
    let statusText = JC.t!('seerr_season_status_not_requested') || 'Not Requested';

    if (status === MediaStatus.AVAILABLE) {
        statusClass = 'available';
        statusText = JC.t!('seerr_btn_available') || 'Available';
    } else if (status === MediaStatus.PARTIALLY_AVAILABLE) {
        statusClass = 'partially-available';
        statusText = JC.t!('seerr_btn_partially_available') || 'Partially Available';
    } else if (status === MediaStatus.PROCESSING) {
        if (hasActiveDownloads) {
            statusClass = 'processing';
            statusText = JC.t!('seerr_btn_processing') || 'Processing';
        } else {
            statusClass = 'pending';
            statusText = JC.t!('seerr_btn_requested') || 'Requested';
        }
    } else if (status === MediaStatus.PENDING) {
        statusClass = 'pending';
        statusText = JC.t!('seerr_btn_pending') || 'Pending';
    } else if (status === MediaStatus.BLOCKED) {
        statusClass = 'blocklisted';
        statusText = JC.t!('seerr_btn_blocklisted') || 'Blocklisted';
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
    const identity = JC.identity.capture();
    if (!identity || !JC.identity.isCurrent(identity)) return;
    const { create, createAdvancedOptionsHTML, populateAdvancedOptions } = JC.seerrModal!;
    const { fetchCollectionDetails, requestMedia, fetchAdvancedRequestData } = JC.seerrAPI!;

    // Fetch collection details
    let collectionDetails;
    try {
        collectionDetails = await fetchCollectionDetails(collectionId);
        if (!JC.identity.isCurrent(identity)) return;
    } catch (error: any) {
        if (!JC.identity.isCurrent(identity)) return;
        JC.toast!(JC.t!('seerr_toast_collection_fetch_failed'), 4000);
        return;
    }

    if (!collectionDetails?.parts || collectionDetails.parts.length === 0) {
        JC.toast!(JC.t!('seerr_toast_no_movies_in_collection'), 4000);
        return;
    }

    const showAdvanced = JC.pluginConfig.SeerrShowAdvanced;
    // Offer a "request the whole collection in 4K" toggle only when 4K requests
    // are actually available to this user (admin toggle AND Seerr 4K capability
    // AND the user's 4K permission). Collections are movies, so gate on 'movie'.
    const show4k = JC.seerrAPI!.canRequest4k('movie');

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
            : assetUrl('seerr/poster-fallback.svg');

        return `
            <div class="seerr-collection-movie-row"
                 data-status="${Number(status) || 1}"
                 data-status4k="${Number(status4k) || 1}"
                 data-has-downloads="${hasActiveDownloads ? '1' : '0'}"
                 data-has-downloads4k="${hasActiveDownloads4k ? '1' : '0'}">
                <input type="checkbox"
                       class="seerr-collection-checkbox"
                       id="movie-${escapeHtml(m.id)}"
                       data-tmdb-id="${escapeHtml(m.id)}"
                       ${isDisabled ? 'disabled' : 'checked'}>
                <img src="${escapeHtml(poster)}" alt="${escapeHtml(m.title)}" class="seerr-collection-movie-poster">
                <div class="seerr-collection-movie-details">
                    <div class="title">${escapeHtml(m.title)}</div>
                    <div class="year">${escapeHtml(year)}</div>
                </div>
                <div class="seerr-season-status seerr-season-status-${escapeHtml(statusClass)}">${escapeHtml(statusText)}</div>
            </div>
        `;
    }).join('');

    const request4kLabel = JC.t!('seerr_btn_request_4k') || 'Request in 4K';
    const the4kToggleHtml = show4k
        ? `<label class="seerr-collection-4k-toggle">
               <input type="checkbox" id="seerr-collection-4k">
               <span>${escapeHtml(request4kLabel)}</span>
           </label>`
        : '';

    const bodyHtml = `
        ${the4kToggleHtml}
        <div class="seerr-collection-list" style="max-height: 600px; overflow-y: auto;">
            <div class="seerr-collection-header-row">
                <input type="checkbox" class="seerr-collection-checkbox" id="seerr-select-all-movies">
                <label class="seerr-collection-header-label" for="seerr-select-all-movies">${JC.t!('seerr_select_all_movies') || 'Select All'}</label>
                <div></div>
                <div></div>
            </div>
            ${movieListHtml}
        </div>
        ${showAdvanced ? createAdvancedOptionsHTML('movie') : ''}
    `;

    const modalInstance = create({
        title: JC.t!('seerr_modal_request_collection') || 'Request Collection',
        subtitle: collectionName,
        bodyHtml,
        backdropPath: collectionDetails.backdrop_path || collectionDetails.backdropPath,
        buttonText: JC.t!('seerr_modal_request_selected_movies') || 'Request Selected Movies',
        onSave: async (
            modalEl: IdentityCleanupElement,
            requestBtn: HTMLButtonElement,
            closeFn: () => void
        ) => {
            const isCurrent = () => JC.identity.isCurrent(identity) && modalEl.isConnected;
            if (!isCurrent()) return;
            requestBtn.disabled = true;
            requestBtn.innerHTML = `${JC.t!('seerr_modal_requesting') || 'Requesting'}<span class="seerr-button-spinner"></span>`;

            const is4k = !!modalEl.querySelector<HTMLInputElement>('#seerr-collection-4k')?.checked;

            let settings = {};
            if (showAdvanced) {
                const server = modalEl.querySelector<HTMLSelectElement>('#movie-server')?.value;
                const quality = modalEl.querySelector<HTMLSelectElement>('#movie-quality')?.value;
                const folder = modalEl.querySelector<HTMLSelectElement>('#movie-folder')?.value;
                if (!server || !quality || !folder) {
                    JC.toast!(JC.t!('seerr_modal_toast_options_missing') || 'Please select all options', 3000);
                    requestBtn.disabled = false;
                    requestBtn.textContent = JC.t!('seerr_modal_request_selected_movies') || 'Request Selected Movies';
                    return;
                }
                settings = { serverId: parseInt(server), profileId: parseInt(quality), rootFolder: folder, tags: [] };
            }

            try {
                const selectedMovies = Array.from(modalEl.querySelectorAll<HTMLInputElement>(
                    '.seerr-collection-movie-row .seerr-collection-checkbox:checked:not(:disabled)'
                )).map((checkbox) => Number.parseInt(checkbox.dataset.tmdbId || '', 10));

                if (selectedMovies.length === 0) {
                    JC.toast!(JC.t!('seerr_modal_toast_select_movie') || 'Please select at least one movie', 3000);
                    requestBtn.disabled = false;
                    requestBtn.textContent = JC.t!('seerr_modal_request_selected_movies') || 'Request Selected Movies';
                    return;
                }

                let successCount = 0;
                let otherFailures = 0;
                let quotaHitError: any = null;
                for (const tmdbId of selectedMovies) {
                    if (!isCurrent()) return;
                    try {
                        await requestMedia(tmdbId, 'movie', settings, is4k, searchResultItem);
                        if (!isCurrent()) return;
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

                const requestedLabel = JC.t!('seerr_toast_collection_requested') || 'Requested';
                const moviesLabel = JC.t!('seerr_toast_movies') || 'movies';
                const total = selectedMovies.length;
                let toastText = `${requestedLabel} ${successCount} of ${total} ${moviesLabel}`;
                if (otherFailures > 0) {
                    toastText += ' ' + JC.t!('seerr_toast_collection_failed_count', { count: otherFailures });
                }
                JC.toast!(toastText, 4000);
                if (quotaHitError) {
                    await ui.showQuotaErrorDialog(quotaHitError, 'movie');
                    if (!isCurrent()) return;
                }
                closeFn();

                // Refresh search results
                const refreshTimer = setTimeout(() => {
                    if (!JC.identity.isCurrent(identity)) return;
                    const query = new URLSearchParams(window.location.hash.split('?')[1])?.get('query');
                    if (query) {
                        const mainController = JC.seerr;
                        if (mainController) {
                            mainController.fetchAndRenderResults(query);
                        }
                    }
                }, 1000);
                modalEl._jcIdentityCleanups?.add(() => clearTimeout(refreshTimer));
            } catch (error: any) {
                if (!isCurrent()) return;
                JC.toast!(JC.t!('seerr_modal_toast_request_fail') || 'Request failed', 4000);
                requestBtn.disabled = false;
                requestBtn.textContent = JC.t!('seerr_modal_request_selected_movies') || 'Request Selected Movies';
            }
        }
    });

    // Populate advanced options if needed
    if (showAdvanced) {
        try {
            const advancedData = await fetchAdvancedRequestData('movie');
            if (!JC.identity.isCurrent(identity)) return;
            populateAdvancedOptions(modalInstance.modalElement, advancedData, 'movie');
        } catch (error: any) {
            if (!JC.identity.isCurrent(identity)) return;
            console.error('Failed to load advanced options:', error);
        }
    }

    if (!JC.identity.isCurrent(identity)) return;
    modalInstance.show();

    // Add Select All checkbox functionality
    const selectAllCheckbox = modalInstance.modalElement.querySelector<HTMLInputElement>('#seerr-select-all-movies')!;
    const movieList = modalInstance.modalElement.querySelector('.seerr-collection-list')!;

    if (selectAllCheckbox && movieList) {
        const updateSelectAllState = () => {
            const allCheckboxes = movieList.querySelectorAll('.seerr-collection-movie-row .seerr-collection-checkbox:not(:disabled)');
            const checkedCount = movieList.querySelectorAll('.seerr-collection-movie-row .seerr-collection-checkbox:not(:disabled):checked').length;
            selectAllCheckbox.checked = checkedCount > 0 && checkedCount === allCheckboxes.length;
            selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < allCheckboxes.length;
        };

        selectAllCheckbox.addEventListener('change', () => {
            if (!JC.identity.isCurrent(identity)) return;
            const allCheckboxes = movieList.querySelectorAll('.seerr-collection-movie-row .seerr-collection-checkbox:not(:disabled)');
            allCheckboxes.forEach((checkbox: any) => {
                checkbox.checked = selectAllCheckbox.checked;
            });
        });

        movieList.addEventListener('change', (e: any) => {
            if (!JC.identity.isCurrent(identity)) return;
            if (e.target.classList.contains('seerr-collection-checkbox') && e.target.id !== 'seerr-select-all-movies') {
                updateSelectAllState();
            }
        });

        // 4K toggle: re-evaluate every row against the standard vs 4K status so
        // the "already available/requested" disabling and badges track the mode.
        const fourKToggle = modalInstance.modalElement.querySelector<HTMLInputElement>('#seerr-collection-4k');
        if (fourKToggle) {
            fourKToggle.addEventListener('change', () => {
                if (!JC.identity.isCurrent(identity)) return;
                const is4k = fourKToggle.checked;
                movieList.querySelectorAll<HTMLElement>('.seerr-collection-movie-row').forEach((row) => {
                    const checkbox = row.querySelector<HTMLInputElement>('.seerr-collection-checkbox');
                    const badge = row.querySelector<HTMLElement>('.seerr-season-status');
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
                    badge.className = `seerr-season-status seerr-season-status-${statusClass}`;
                    badge.textContent = statusText;
                });
                updateSelectAllState();
            });
        }

        updateSelectAllState();
    }
};
