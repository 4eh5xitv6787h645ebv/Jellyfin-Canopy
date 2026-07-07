// src/jellyseerr/more-info-modal/actions.ts
// Action-area rendering: movie request buttons, requested chips, quota chip
// and the renderActions orchestrator for the action/chip/download mounts.
import { JE } from '../../globals';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload + DOM shapes; typed incrementally */
/* eslint-disable @typescript-eslint/no-misused-promises -- legacy async event listeners with fire-and-forget bodies; semantics preserved verbatim */


import { internal } from './internal';
import { buildSeerrPendingToggle } from '../../enhanced/spoiler-guard/seerr-toggle';
const state = internal.state;
const logPrefix = '🪼 Jellyfin Elevate: Jellyseerr More Info:';
const escapeHtml = JE.escapeHtml;
const DisplayStatus = JE.seerrStatus!.DISPLAY;

function buildSingle4kButton(data: any) {
const button = document.createElement('button');
button.className = 'jellyseerr-request-button jellyseerr-button-request';
button.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t!('jellyseerr_btn_request_4k') || 'Request in 4K'}</span>`;
button.addEventListener('click', async (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    if (JE.pluginConfig.JellyseerrShowAdvanced) {
        window.JellyfinElevate?.jellyseerrUI?.showMovieRequestModal?.(data.id, data.title || data.name, data, true);
        return;
    }
    button.disabled = true;
    button.innerHTML = `<span>${JE.t!('jellyseerr_btn_requesting')}</span><span class="jellyseerr-button-spinner"></span>`;
    try {
        await JE.jellyseerrAPI!.requestMedia(data.id, 'movie', { is4k: true }, false, data);
        mountRequestedChip(data, 'movie', true);
    } catch (error: any) {
        // Quota errors get a themed dialog; restore button to idle.
        if (JE.jellyseerrUI?.isQuotaError?.(error)) {
            await JE.jellyseerrUI.showQuotaErrorDialog(error, 'movie');
            button.disabled = false;
            button.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t!('jellyseerr_btn_request_4k') || 'Request in 4K'}</span>`;
            return;
        }
        // Escape API error message before innerHTML to prevent reflected XSS
        const errorMessage = error?.responseJSON?.message || JE.t!('jellyseerr_btn_error');
        button.disabled = false;
        button.innerHTML = `<span>${escapeHtml(errorMessage)}</span>`;
        button.classList.add('jellyseerr-button-error');
    }
});
return button;
}

function buildMovieActions(data: any, actionMount: any, chipMount: any, show4kOption: any) {
const status = data.mediaInfo ? data.mediaInfo.status : 1;
const status4k = data.mediaInfo ? data.mediaInfo.status4k : 1;
if (!JE.seerrStatus!.isRequestable(status)) {
    return null;
}

const container = document.createElement('div');
container.className = 'je-more-info-actions-row';

// Build split button (reuse card styling)
if (show4kOption) {
    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'jellyseerr-button-group je-more-info-button-group';

    const mainButton = document.createElement('button');
    mainButton.className = 'jellyseerr-request-button jellyseerr-split-main jellyseerr-button-request';
    mainButton.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t!('jellyseerr_btn_request')}</span>`;
    mainButton.dataset.tmdbId = data.id;
    mainButton.dataset.mediaType = 'movie';

    const arrowButton = document.createElement('button');
    arrowButton.className = 'jellyseerr-split-arrow';
    arrowButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 01-1.06 0l-7.5-7.5a.75.75 0 011.06-1.06L12 14.69l6.97-6.97a.75.75 0 111.06 1.06l-7.5 7.5z" clip-rule="evenodd" /></svg>';
    arrowButton.title = 'Request in 4K';
    arrowButton.dataset.tmdbId = data.id;
    arrowButton.dataset.toggle4k = 'true';

    mainButton.addEventListener('click', async (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        if (JE.pluginConfig.JellyseerrShowAdvanced) {
            window.JellyfinElevate?.jellyseerrUI?.showMovieRequestModal?.(data.id, data.title || data.name, data, false);
            return;
        }
        mainButton.disabled = true;
        mainButton.innerHTML = `<span>${JE.t!('jellyseerr_btn_requesting')}</span><span class="jellyseerr-button-spinner"></span>`;
        try {
            const response = await JE.jellyseerrAPI!.requestMedia(data.id, 'movie', {}, false, data);
            mountRequestedChip(data, 'movie', false, response);
        } catch (error: any) {
            // Quota errors get a themed dialog; restore button to idle.
            if (JE.jellyseerrUI?.isQuotaError?.(error)) {
                await JE.jellyseerrUI.showQuotaErrorDialog(error, 'movie');
                mainButton.disabled = false;
                mainButton.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t!('jellyseerr_btn_request')}</span>`;
                return;
            }
            mainButton.disabled = false;
            // Escape API error before innerHTML to prevent reflected XSS
            const errorMessage = error?.responseJSON?.message || JE.t!('jellyseerr_btn_error');
            mainButton.innerHTML = `<span>${escapeHtml(errorMessage)}</span>${JE.jellyseerrUIIcons?.error || ''}`;
            mainButton.classList.add('jellyseerr-button-error');
        }
    });

// 4K dropdown
let open4k: any = null;
const close4k = () => {
    if (open4k) {
        open4k.remove();
        open4k = null;
        document.removeEventListener('click', handleDocClick, true);
    }
};
const handleDocClick = (ev: any) => {
    if (!open4k) return;
    if (!open4k.contains(ev.target) && !arrowButton.contains(ev.target)) {
        close4k();
    }
};

    arrowButton.addEventListener('click', (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    if (open4k) {
        close4k();
        return;
    }
    const menu = document.createElement('div');
    menu.className = 'je-4k-popup';
    const option = document.createElement('button');
    option.className = 'je-4k-popup-item';

    const moviePopupDs4k = JE.seerrStatus!.resolveDisplayStatus(status4k, false);
    if (moviePopupDs4k === DisplayStatus.AVAILABLE) {
        option.textContent = 'Request in 4K';
        option.disabled = true;
        option.classList.add('je-4k-available');
    } else if (moviePopupDs4k === DisplayStatus.PENDING || moviePopupDs4k === DisplayStatus.REQUESTED || moviePopupDs4k === DisplayStatus.PROCESSING) {
        option.textContent = 'Request in 4K';
        option.disabled = true;
        option.classList.add(moviePopupDs4k === DisplayStatus.PROCESSING ? 'je-4k-processing' : 'je-4k-pending');
    } else if (moviePopupDs4k === DisplayStatus.BLOCKED) {
        option.textContent = 'Request in 4K';
        option.disabled = true;
        option.classList.add('je-4k-blocklisted');
    } else {
        option.textContent = 'Request in 4K';
        option.classList.add('je-4k-request');
        option.addEventListener('click', async (ev: any) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (JE.pluginConfig.JellyseerrShowAdvanced) {
                close4k();
                window.JellyfinElevate?.jellyseerrUI?.showMovieRequestModal?.(data.id, data.title || data.name, data, true);
                return;
            }
            option.disabled = true;
            option.textContent = JE.t!('jellyseerr_btn_requesting');
            try {
                const response = await JE.jellyseerrAPI!.requestMedia(data.id, 'movie', { is4k: true }, false, data);
                mountRequestedChip(data, 'movie', true, response);
                close4k();
            } catch (error: any) {
                // Quota errors get a themed dialog; restore option to idle.
                if (JE.jellyseerrUI?.isQuotaError?.(error)) {
                    await JE.jellyseerrUI.showQuotaErrorDialog(error, 'movie');
                    option.disabled = false;
                    option.textContent = 'Request in 4K';
                    return;
                }
                option.disabled = false;
                option.textContent = error?.responseJSON?.message || JE.t!('jellyseerr_btn_error');
            }
        });
    }

    menu.appendChild(option);
    document.body.appendChild(menu);
    const rect = arrowButton.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    requestAnimationFrame(() => menu.classList.add('show'));
    open4k = menu;
    document.addEventListener('click', handleDocClick, true);
});

    buttonGroup.appendChild(mainButton);
    buttonGroup.appendChild(arrowButton);
    container.appendChild(buttonGroup);
} else {
    const requestButton = document.createElement('button');
    requestButton.className = 'jellyseerr-request-button jellyseerr-button-request';
    requestButton.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t!('jellyseerr_btn_request')}</span>`;
    requestButton.addEventListener('click', async (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        if (JE.pluginConfig.JellyseerrShowAdvanced) {
            window.JellyfinElevate?.jellyseerrUI?.showMovieRequestModal?.(data.id, data.title || data.name, data, false);
            return;
        }
        requestButton.disabled = true;
        requestButton.innerHTML = `<span>${JE.t!('jellyseerr_btn_requesting')}</span><span class="jellyseerr-button-spinner"></span>`;
        try {
            await JE.jellyseerrAPI!.requestMedia(data.id, 'movie', {}, false, data);
            mountRequestedChip(data, 'movie', false);
        } catch (error: any) {
            // Quota errors get a themed dialog; restore button to idle.
            if (JE.jellyseerrUI?.isQuotaError?.(error)) {
                await JE.jellyseerrUI.showQuotaErrorDialog(error, 'movie');
                requestButton.disabled = false;
                requestButton.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t!('jellyseerr_btn_request')}</span>`;
                return;
            }
            requestButton.disabled = false;
            // Escape API error before innerHTML to prevent reflected XSS
            const errorMessage = error?.responseJSON?.message || JE.t!('jellyseerr_btn_error');
            requestButton.innerHTML = `<span>${escapeHtml(errorMessage)}</span>${JE.jellyseerrUIIcons?.error || ''}`;
            requestButton.classList.add('jellyseerr-button-error');
        }
    });
    container.appendChild(requestButton);
}
return container;
}

function mountRequestedChip(data: any, mediaType: any, is4k: any, response: any = null) {
const mediaInfo = data.mediaInfo = data.mediaInfo || {};
if (mediaType === 'movie') {
    if (is4k) {
        mediaInfo.status4k = response?.media?.status4k || 3;
    } else {
        mediaInfo.status = response?.media?.status || 3;
    }
} else {
    if (is4k) {
        mediaInfo.status4k = response?.media?.status4k || 3;
    } else {
        mediaInfo.status = response?.media?.status || 3;
    }
}

document.dispatchEvent(new CustomEvent('jellyseerr-media-requested', {
    detail: { tmdbId: data.id, mediaType, is4k: !!is4k }
}));

renderActions(data, mediaType);
}

// Token guards against stale chip insertion when the user navigates between items.
let _quotaRenderToken = 0;

async function maybeRenderMoreInfoQuotaChip(actionMount: any, mediaType: any) {
if (!actionMount) return;
const myToken = ++_quotaRenderToken;
actionMount.dataset.quotaRenderToken = String(myToken);

try {
    const quota = await JE.jellyseerrAPI?.fetchUserQuota?.();
    if (!actionMount.isConnected) return;
    if (actionMount.dataset.quotaRenderToken !== String(myToken)) return;

    const chip = JE.jellyseerrUI?.buildQuotaChip?.(quota, mediaType === 'tv' ? 'tv' : 'movie');
    if (chip instanceof Element) {
        chip.classList.add('je-more-info-quota-chip');
        actionMount.insertBefore(chip, actionMount.firstChild);
    }
} catch (err: any) {
    console.warn(`${logPrefix} quota chip render failed:`, err);
}
}

function renderActions(data: any, mediaType: any) {
if (!state.currentModal) return;

const actionMount = state.currentModal.querySelector('[data-mount="je-actions"]');
const chipMount = state.currentModal.querySelector('[data-mount="je-status-chip"]');
const downloadsMount = state.currentModal.querySelector('[data-mount="je-downloads"]');
if (actionMount) actionMount.innerHTML = '';
if (chipMount) chipMount.innerHTML = '';
if (downloadsMount) downloadsMount.innerHTML = '';

// Spoiler Guard pending toggle: a quiet secondary action that sits below the
// primary Request CTA, independent of request status (pre-arm before request,
// or register intent on a title someone else requested). Its own mount so the
// actionMount.innerHTML resets above don't wipe it.
const secondaryMount = state.currentModal.querySelector('[data-mount="je-secondary-actions"]');
if (secondaryMount) {
    secondaryMount.innerHTML = '';
    try {
        const spoilerBtn = buildSeerrPendingToggle(data, mediaType);
        if (spoilerBtn) secondaryMount.appendChild(spoilerBtn);
    } catch (err) {
        console.warn(`${logPrefix} failed to render spoiler toggle button:`, err);
    }
}

if (mediaType === 'movie') {
    const mediaInfo = data.mediaInfo || {};
    const status = mediaInfo.status ?? 1;
    const status4k = mediaInfo.status4k ?? 1;
    const downloads = mediaInfo.downloadStatus || [];
    const downloads4k = mediaInfo.downloadStatus4k || [];
    const jellyfinMediaId = mediaInfo.jellyfinMediaId || null;
    const jellyfinMediaId4k = mediaInfo.jellyfinMediaId4k || null;
    const show4k = !!JE.pluginConfig.JellyseerrEnable4KRequests;

    // Show both chips if both statuses exist
    const hasNormalStatus = JE.seerrStatus!.hasStatus(status);
    const has4kStatus = JE.seerrStatus!.hasStatus(status4k);

    if (chipMount) {
        if (hasNormalStatus && has4kStatus) {
            // Show both chips
            const chipNormal = internal.buildStatusChip(status, status4k, true, downloads, downloads4k, jellyfinMediaId, jellyfinMediaId4k, false);
            const chip4k = internal.buildStatusChip(status, status4k, true, downloads, downloads4k, jellyfinMediaId, jellyfinMediaId4k, true);
            if (chipNormal) chipMount.appendChild(chipNormal);
            if (chip4k) {
                chip4k.style.marginLeft = '0.5em';
                chipMount.appendChild(chip4k);
            }
        } else if (hasNormalStatus) {
            // Show only normal chip
            const chip = internal.buildStatusChip(status, status4k, true, downloads, downloads4k, jellyfinMediaId, jellyfinMediaId4k, false);
            if (chip) chipMount.appendChild(chip);
        } else if (has4kStatus) {
            // Show only 4K chip
            const chip = internal.buildStatusChip(status, status4k, true, downloads, downloads4k, jellyfinMediaId, jellyfinMediaId4k, true);
            if (chip) chipMount.appendChild(chip);
        }
    }

    const bars = internal.buildDownloadBars(downloads, downloads4k);
    if (bars && downloadsMount) downloadsMount.appendChild(bars);

    const effectiveMovieStatus = JE.seerrStatus!.effectiveMediaStatus(status, jellyfinMediaId);
    const effectiveMovieStatus4k = JE.seerrStatus!.effectiveMediaStatus(status4k, jellyfinMediaId4k);

    const canRequestNormal = JE.seerrStatus!.isRequestable(effectiveMovieStatus);
    const canRequest4k = JE.seerrStatus!.isRequestable(effectiveMovieStatus4k);

    if (!canRequestNormal) {
        if (show4k && canRequest4k && actionMount) {
            const followUp = buildSingle4kButton(data);
            if (followUp) actionMount.appendChild(followUp);
            void maybeRenderMoreInfoQuotaChip(actionMount, 'movie');
        }
        return;
    }

    const actions = buildMovieActions(data, actionMount, chipMount, show4k);
    if (actions && actionMount) actionMount.appendChild(actions);
    void maybeRenderMoreInfoQuotaChip(actionMount, 'movie');
} else {
    const mediaInfo = data.mediaInfo || {};
    const status = mediaInfo.status ?? 1;
    const status4k = mediaInfo.status4k ?? 1;
    const downloads = mediaInfo.downloadStatus || [];
    const downloads4k = mediaInfo.downloadStatus4k || [];
    const jellyfinMediaId = mediaInfo.jellyfinMediaId || null;
    const jellyfinMediaId4k = mediaInfo.jellyfinMediaId4k || null;
    const show4kTv = !!JE.pluginConfig.JellyseerrEnable4KTvRequests;

    // Show both chips if both statuses exist
    const hasNormalStatus = JE.seerrStatus!.hasStatus(status);
    const has4kStatus = JE.seerrStatus!.hasStatus(status4k);

    if (chipMount) {
        if (hasNormalStatus && has4kStatus) {
            // Show both chips
            const chipNormal = internal.buildStatusChip(status, status4k, false, downloads, downloads4k, jellyfinMediaId, jellyfinMediaId4k, false);
            const chip4k = internal.buildStatusChip(status, status4k, false, downloads, downloads4k, jellyfinMediaId, jellyfinMediaId4k, true);
            if (chipNormal) chipMount.appendChild(chipNormal);
            if (chip4k) {
                chip4k.style.marginLeft = '0.5em';
                chipMount.appendChild(chip4k);
            }
        } else if (hasNormalStatus) {
            // Show only normal chip
            const chip = internal.buildStatusChip(status, status4k, false, downloads, downloads4k, jellyfinMediaId, jellyfinMediaId4k, false);
            if (chip) chipMount.appendChild(chip);
        } else if (has4kStatus) {
            // Show only 4K chip
            const chip = internal.buildStatusChip(status, status4k, false, downloads, downloads4k, jellyfinMediaId, jellyfinMediaId4k, true);
            if (chip) chipMount.appendChild(chip);
        }
    }

    const bars = internal.buildDownloadBars(downloads, downloads4k);
    if (bars && downloadsMount) downloadsMount.appendChild(bars);

    const effectiveStatus = JE.seerrStatus!.effectiveMediaStatus(status, jellyfinMediaId);
    const effectiveStatus4k = JE.seerrStatus!.effectiveMediaStatus(status4k, jellyfinMediaId4k);

    const canRequestNormal = JE.seerrStatus!.isRequestable(effectiveStatus);
    const canRequest4k = JE.seerrStatus!.isRequestable(effectiveStatus4k);
    if (canRequestNormal) {
        const actions = internal.buildTvActions(data, show4kTv);
        if (actions && actionMount) actionMount.appendChild(actions);
        void maybeRenderMoreInfoQuotaChip(actionMount, 'tv');
        return;
    }

    const hasStatus = hasNormalStatus || has4kStatus;
    const hasDeletedStatus = effectiveStatus === 7 || effectiveStatus4k === 7;

    // Check if there are unrequested seasons
    if (hasStatus) {
        if (hasDeletedStatus && actionMount) {
            const requestMoreButton = internal.buildTvRequestMoreButton(data, show4kTv, canRequest4k);
            if (requestMoreButton) actionMount.appendChild(requestMoreButton);
            void maybeRenderMoreInfoQuotaChip(actionMount, 'tv');
            return;
        }
        void internal.checkForUnrequestedSeasons(data).then((hasUnrequestedSeasons: any) => {
            if (hasUnrequestedSeasons && actionMount) {
                const requestMoreButton = internal.buildTvRequestMoreButton(data, show4kTv, canRequest4k);
                if (requestMoreButton) actionMount.appendChild(requestMoreButton);
                void maybeRenderMoreInfoQuotaChip(actionMount, 'tv');
            } else if (show4kTv && canRequest4k && actionMount) {
                const followUp4k = internal.buildSingleTv4kButton(data);
                if (followUp4k) actionMount.appendChild(followUp4k);
                void maybeRenderMoreInfoQuotaChip(actionMount, 'tv');
            }
        });
        return;
    }

    const actions = internal.buildTvActions(data);
    if (actions && actionMount) actionMount.appendChild(actions);
    void maybeRenderMoreInfoQuotaChip(actionMount, 'tv');
}
}
internal.buildSingle4kButton = buildSingle4kButton;
internal.buildMovieActions = buildMovieActions;
internal.mountRequestedChip = mountRequestedChip;
internal.maybeRenderMoreInfoQuotaChip = maybeRenderMoreInfoQuotaChip;
internal.renderActions = renderActions;
