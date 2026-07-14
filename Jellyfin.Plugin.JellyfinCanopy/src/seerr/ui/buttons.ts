// src/seerr/ui/buttons.ts
// Request-button configuration for movie/TV/collection cards.
import { JC } from '../../globals';
import type { IdentityContext } from '../../types/jc';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload + DOM shapes; typed incrementally */


import { ui, internal } from './internal';
const state = internal.state;
const escapeHtml = JC.escapeHtml;
const MediaStatus = JC.seerrStatus!.MEDIA;
const DisplayStatus = JC.seerrStatus!.DISPLAY;
const icons = internal.icons; // requires ui/icons.ts to be loaded first

function resolveIdentity(node: unknown): IdentityContext | null {
    const element = node instanceof Element ? node : null;
    return JC.identity.ownerOf(node)
        || JC.identity.ownerOf(element?.closest('.seerr-card'))
        || JC.identity.capture();
}

function isLive(node: unknown, identity: IdentityContext | null | undefined): boolean {
    const card = node instanceof Element ? node.closest('.seerr-card') : null;
    return !!identity
        && JC.identity.isCurrent(identity)
        && (JC.identity.isOwned(node, identity) || (!!card && JC.identity.isOwned(card, identity)));
}

/**
 * Configures the request button based on item status and type.
 * @param {HTMLElement} button - Button element to configure.
 * @param {Object} item - Media item data.
 * @param {boolean} isSeerrActive - If the server is reachable.
 * @param {boolean} seerrUserFound - If the current user is linked.
 */
function configureRequestButton(button: any, item: any, isSeerrActive: any, seerrUserFound: any) {
    const identity = resolveIdentity(button);
    JC.identity.own(button, identity);
    if (!isSeerrActive) {
        button.innerHTML = `<span>${JC.t!('seerr_btn_offline')}</span>${icons.cloud_off}`;
        button.disabled = true;
        button.classList.add('seerr-button-offline');
        return;
    }
    if (!seerrUserFound) {
        button.innerHTML = `<span>${JC.t!('seerr_btn_user_not_found')}</span>${icons.person_off}`;
        button.disabled = true;
        button.classList.add('seerr-button-no-user');
        return;
    }

    if (item.mediaType === 'collection') {
        configureCollectionButton(button, item);
    } else if (item.mediaType === 'tv') {
        button.dataset.searchResultItem = JSON.stringify(item);
        button.classList.add('seerr-button-tv');
        if (item.mediaInfo) button.dataset.mediaInfo = JSON.stringify(item.mediaInfo);
        const seasonAnalysis = item.mediaInfo?.seasons ? internal.analyzeSeasonStatuses(item.mediaInfo.seasons) : null;
        const overallStatus = seasonAnalysis ? seasonAnalysis.overallStatus : (item.mediaInfo ? item.mediaInfo.status : 1);
        configureTvShowButton(button, overallStatus, seasonAnalysis, item);
    } else {
        configureMovieButton(button, item);
    }
}

/**
 * Configures button for collections.
 * @param {HTMLElement} button - Button element.
 * @param {Object} item - Collection item data.
 */
function configureCollectionButton(button: any, item: any) {
    button.dataset.searchResultItem = JSON.stringify(item);
    button.dataset.mediaType = 'collection';
    button.dataset.collectionId = item.id;
    button.innerHTML = `${icons.request}<span>${JC.t!('seerr_modal_request_collection')}</span>`;
    button.className = 'seerr-request-button seerr-button-request seerr-button-collection';
    button.disabled = false;
}

/**
 * Configures button for TV shows based on season analysis.
 * @param {HTMLElement} button - Button element.
 * @param {number} overallStatus - Calculated overall status.
 * @param {Object|null} seasonAnalysis - Season analysis results.
 * @param {Object} item - Media item data.
 */
function configureTvShowButton(button: any, overallStatus: any, seasonAnalysis: any, item: any) {
    const identity = resolveIdentity(button);
    JC.identity.own(button, identity);
    const setButton = (text: any, icon: any, className: any, disabled: any = false, summary: any = seasonAnalysis?.statusSummary) => {
        button.innerHTML = `${icon || ''}<span>${text}</span>`;
        if (summary) button.innerHTML += `<div class="seerr-season-summary">${summary}</div>`;
        button.disabled = disabled;
        button.className = `seerr-request-button seerr-button-tv ${className}`; // Reset classes
    };
    switch (overallStatus) {
        case MediaStatus.PENDING: setButton(JC.t!('seerr_btn_pending'), icons.pending, 'seerr-button-pending'); break;
        case MediaStatus.PROCESSING: setButton(JC.t!('seerr_btn_request'), icons.request, 'seerr-button-request'); break;
        case MediaStatus.DELETED: setButton(JC.t!(seasonAnalysis?.availableCount > 0 ? 'seerr_btn_request_more' : 'seerr_btn_request'), icons.request, 'seerr-button-request'); break;
        case MediaStatus.PARTIALLY_AVAILABLE:
            setButton(JC.t!('seerr_btn_request_missing'), icons.request, 'seerr-button-partially-available');
            if (item?.mediaInfo?.downloadStatus?.length > 0 || item?.mediaInfo?.downloadStatus4k?.length > 0) {
                internal.addDownloadProgressHover(button, item);
            }
            break;
        case MediaStatus.AVAILABLE: setButton(JC.t!('seerr_btn_available'), icons.available, 'seerr-button-available', true, seasonAnalysis?.total > 1 ? JC.t!('seerr_all_seasons', {count: Number(seasonAnalysis.total) || 0}) : null); break;
        case MediaStatus.BLOCKED: setButton(JC.t!('seerr_btn_blocklisted'), icons.cancel, 'seerr-button-blocklisted', true); break;
        default: setButton(JC.t!('seerr_btn_request'), icons.request, 'seerr-button-request', false, seasonAnalysis?.total > 1 ? JC.t!('seerr_seasons_available', {count: Number(seasonAnalysis.total) || 0}) : null); break;
    }

    // Gate on admin toggle AND Seerr 4K capability AND this user's 4K permission.
    const show4KOption = JC.seerrAPI!.canRequest4k('tv');
    const status4k = item.mediaInfo ? item.mediaInfo.status4k : 1;

    if (show4KOption && !button.closest('.seerr-button-group')) {
        const buttonGroup = document.createElement('div');
        buttonGroup.className = 'seerr-button-group';
        JC.identity.own(buttonGroup, identity);

        const mainButton = button.cloneNode(true);
        JC.identity.own(mainButton, identity);
        mainButton.classList.add('seerr-split-main');
        mainButton.dataset.tmdbId = item.id;
        mainButton.dataset.mediaType = 'tv';
        mainButton.dataset.searchResultItem = JSON.stringify(item);

        const arrowButton = document.createElement('button');
        JC.identity.own(arrowButton, identity);
        arrowButton.className = 'seerr-split-arrow';
        arrowButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 01-1.06 0l-7.5-7.5a.75.75 0 011.06-1.06L12 14.69l6.97-6.97a.75.75 0 111.06 1.06l-7.5 7.5z" clip-rule="evenodd" /></svg>';
        arrowButton.dataset.tmdbId = item.id;
        arrowButton.dataset.toggle4k = 'true';

        const tvDs4k = JC.seerrStatus!.resolveDisplayStatus(status4k, false);
        if (tvDs4k === DisplayStatus.AVAILABLE) {
            arrowButton.disabled = true;
            arrowButton.classList.add('seerr-split-arrow-disabled', 'seerr-4k-available');
            arrowButton.title = '4K Available';
        } else if (tvDs4k === DisplayStatus.PENDING || tvDs4k === DisplayStatus.REQUESTED || tvDs4k === DisplayStatus.PROCESSING) {
            arrowButton.classList.add('seerr-4k-pending');
            arrowButton.title = '4K Requested';
        } else {
            arrowButton.title = JC.t!('seerr_btn_request_4k');
        }

        buttonGroup.appendChild(mainButton);
        buttonGroup.appendChild(arrowButton);
        button.replaceWith(buttonGroup);

        arrowButton.addEventListener('click', (e: any) => {
            e.stopPropagation();
            if (!isLive(arrowButton, identity)) return;
            if (state.active4KPopup && state.active4KPopup.parentElement === buttonGroup) {
                internal.hide4KPopup();
            } else {
                internal.show4KPopup(buttonGroup, item);
            }
        });
    }
}

/**
 * Configures button for movies.
 * @param {HTMLElement} button - Button element.
 * @param {Object} item - Movie item data.
 */
function configureMovieButton(button: any, item: any) {
    const identity = resolveIdentity(button);
    JC.identity.own(button, identity);
    button.dataset.searchResultItem = JSON.stringify(item);
    const status = item.mediaInfo ? item.mediaInfo.status : 1;
    const status4k = item.mediaInfo ? item.mediaInfo.status4k : 1;

    // Show split button when 4K is offered: admin toggle AND Seerr 4K capability
    // AND this user's 4K permission.
    const show4KOption = JC.seerrAPI!.canRequest4k('movie');

    const setButton = (text: any, icon: any, className: any, disabled: any = false) => {
        button.innerHTML = `${icon || ''}<span>${text}</span>`;
        button.disabled = disabled;
        button.className = `seerr-request-button ${className}`;
    };

    // Create split button with 4K option if enabled
    if (show4KOption && !button.closest('.seerr-button-group')) {
        // Create button group
        const buttonGroup = document.createElement('div');
        buttonGroup.className = 'seerr-button-group';
        JC.identity.own(buttonGroup, identity);

        const hasMainDownloads = item.mediaInfo?.downloadStatus?.length > 0 || item.mediaInfo?.downloadStatus4k?.length > 0;
        const mainDisplayStatus = JC.seerrStatus!.resolveDisplayStatus(status, hasMainDownloads);
        const { labelKey: mainLabelKey, cssClass: mainButtonClass, disabled: mainButtonDisabled, showSpinner: mainShowSpinner, iconKey } = JC.seerrStatus!.getButtonConfig(mainDisplayStatus);
        const mainButtonText = JC.t!(mainLabelKey);
        const mainButtonIcon = icons[iconKey] || '';

        // Main button
        const mainButton = document.createElement('button');
        JC.identity.own(mainButton, identity);
        mainButton.className = `seerr-request-button seerr-split-main ${mainButtonClass}`;
        mainButton.disabled = mainButtonDisabled;
        mainButton.innerHTML = `${mainButtonIcon}<span>${mainButtonText}</span>${mainShowSpinner ? '<span class="seerr-button-spinner"></span>' : ''}`;
        mainButton.dataset.tmdbId = item.id;
        mainButton.dataset.mediaType = 'movie';
        mainButton.dataset.searchResultItem = JSON.stringify(item);

        if (hasMainDownloads && mainButtonDisabled) {
            internal.addDownloadProgressHover(mainButton, item);
        }

        const arrowButton = document.createElement('button');
        JC.identity.own(arrowButton, identity);
        arrowButton.className = 'seerr-split-arrow';
        arrowButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 01-1.06 0l-7.5-7.5a.75.75 0 011.06-1.06L12 14.69l6.97-6.97a.75.75 0 111.06 1.06l-7.5 7.5z" clip-rule="evenodd" /></svg>';
        arrowButton.dataset.tmdbId = item.id;
        arrowButton.dataset.toggle4k = 'true';

        const ds4k = JC.seerrStatus!.resolveDisplayStatus(status4k, false);
        if (ds4k === DisplayStatus.AVAILABLE) {
            arrowButton.disabled = true;
            arrowButton.classList.add('seerr-split-arrow-disabled', 'seerr-4k-available');
            arrowButton.title = '4K Available';
        } else if (ds4k === DisplayStatus.PENDING || ds4k === DisplayStatus.REQUESTED || ds4k === DisplayStatus.PROCESSING) {
            arrowButton.classList.add('seerr-4k-pending');
            arrowButton.title = '4K Requested';
        } else {
            arrowButton.title = JC.t!('seerr_btn_request_4k');
        }

        buttonGroup.appendChild(mainButton);
        buttonGroup.appendChild(arrowButton);
        button.replaceWith(buttonGroup);

        if (!mainButtonDisabled) {
            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- legacy async listener; errors handled inside
            mainButton.addEventListener('click', async (e: any) => {
                e.stopPropagation();
                if (!isLive(mainButton, identity)) return;
                if (JC.pluginConfig.SeerrShowAdvanced) {
                    ui.showMovieRequestModal(item.id, item.title || item.name, item, false);
                } else {
                    mainButton.disabled = true;
                    mainButton.innerHTML = `<span>${JC.t!('seerr_btn_requesting')}</span><span class="seerr-button-spinner"></span>`;
                    try {
                        await JC.seerrAPI!.requestMedia(item.id, 'movie', {}, false, item);
                        if (!isLive(mainButton, identity)) return;
                        if (!item.mediaInfo) item.mediaInfo = {};
                        item.mediaInfo.status = 3;
                        mainButton.innerHTML = `<span>${JC.t!('seerr_btn_requested')}</span>${icons.requested}`;
                        mainButton.classList.remove('seerr-button-request');
                        mainButton.classList.add('seerr-button-pending');
                    } catch (error: any) {
                        if (!isLive(mainButton, identity)) return;
                        mainButton.disabled = false;
                        // Quota errors get a themed dialog; restore button to idle.
                        if (ui.isQuotaError && ui.isQuotaError(error)) {
                            await ui.showQuotaErrorDialog(error, 'movie');
                            if (!isLive(mainButton, identity)) return;
                            mainButton.innerHTML = `${icons.request}<span>${JC.t!('seerr_btn_request')}</span>`;
                            return;
                        }
                        let errorMessage = JC.t!('seerr_btn_error');
                        if (error.status === 404) {
                            errorMessage = JC.t!('seerr_btn_user_not_found');
                        } else if (error.status === 403) {
                            const code = error.responseJSON?.code;
                            errorMessage = JC.t!(code ? `seerr_err_${code}` : 'seerr_err_no_request_permission')
                                || JC.t!('seerr_err_no_request_permission');
                        } else if (error.responseJSON?.message) {
                            errorMessage = error.responseJSON.message;
                        }
                        // Escape API-sourced error message before inserting into HTML
                        mainButton.innerHTML = `<span>${escapeHtml(errorMessage)}</span>${icons.error}`;
                        mainButton.classList.add('seerr-button-error');
                    }
                }
            });
        }

        arrowButton.addEventListener('click', (e: any) => {
            e.stopPropagation();
            if (!isLive(arrowButton, identity)) return;
            if (state.active4KPopup && state.active4KPopup.parentElement === buttonGroup) {
                internal.hide4KPopup();
            } else {
                internal.show4KPopup(buttonGroup, item);
            }
        });
        return;
    }

    const hasStdDownloads = item.mediaInfo?.downloadStatus?.length > 0 || item.mediaInfo?.downloadStatus4k?.length > 0;
    const stdDisplayStatus = JC.seerrStatus!.resolveDisplayStatus(status, hasStdDownloads);
    const { labelKey: stdLabelKey, cssClass: stdClass, disabled: stdDisabled, showSpinner: stdSpinner, iconKey: stdIconKey } = JC.seerrStatus!.getButtonConfig(stdDisplayStatus);

    if (stdSpinner) {
        button.innerHTML = `${icons[stdIconKey] || ''}<span>${JC.t!(stdLabelKey)}</span><span class="seerr-button-spinner"></span>`;
        button.disabled = true;
        button.className = `seerr-request-button ${stdClass}`;
        if (hasStdDownloads) internal.addDownloadProgressHover(button, item);
    } else {
        setButton(JC.t!(stdLabelKey), icons[stdIconKey] || '', stdClass, stdDisabled);
    }

    // Add click handler for request button (for overview button and standard button)
    if (!button.disabled && !button.closest('.seerr-button-group')) {
        button.addEventListener('click', async (e: any) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isLive(button, identity)) return;
            if (JC.pluginConfig.SeerrShowAdvanced) {
                ui.showMovieRequestModal(item.id, item.title || item.name, item, false);
            } else {
                button.disabled = true;
                button.innerHTML = `<span>${JC.t!('seerr_btn_requesting')}</span><span class="seerr-button-spinner"></span>`;
                try {
                    await JC.seerrAPI!.requestMedia(item.id, 'movie', {}, false, item);
                    if (!isLive(button, identity)) return;
                    if (!item.mediaInfo) item.mediaInfo = {};
                    item.mediaInfo.status = 3;
                    button.innerHTML = `<span>${JC.t!('seerr_btn_requested')}</span>${icons.requested}`;
                    button.classList.remove('seerr-button-request');
                    button.classList.add('seerr-button-pending');
                } catch (error: any) {
                    if (!isLive(button, identity)) return;
                    button.disabled = false;
                    // Quota errors get a themed dialog; restore button to idle.
                    if (ui.isQuotaError && ui.isQuotaError(error)) {
                        await ui.showQuotaErrorDialog(error, 'movie');
                        if (!isLive(button, identity)) return;
                        button.innerHTML = `${icons.request}<span>${JC.t!('seerr_btn_request')}</span>`;
                        return;
                    }
                    let errorMessage = JC.t!('seerr_btn_error');
                    if (error.status === 404) {
                        errorMessage = JC.t!('seerr_btn_user_not_found');
                    } else if (error.status === 403) {
                        const code = error.responseJSON?.code;
                        errorMessage = JC.t!(code ? `seerr_err_${code}` : 'seerr_err_no_request_permission')
                            || JC.t!('seerr_err_no_request_permission');
                    } else if (error.responseJSON?.message) {
                        errorMessage = error.responseJSON.message;
                    }
                    button.innerHTML = `<span>${escapeHtml(errorMessage)}</span>${icons.error}`;
                    button.classList.add('seerr-button-error');
                }
            }
        });
    }
}
ui.configureRequestButton = configureRequestButton;

internal.configureRequestButton = configureRequestButton;
internal.configureCollectionButton = configureCollectionButton;
internal.configureTvShowButton = configureTvShowButton;
internal.configureMovieButton = configureMovieButton;
