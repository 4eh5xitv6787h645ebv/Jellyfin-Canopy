// src/seerr/more-info-modal/actions.ts
// Action-area rendering: movie request buttons, requested chips, quota chip
// and the renderActions orchestrator for the action/chip/download mounts.
import { JC } from '../../globals';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload + DOM shapes; typed incrementally */
/* eslint-disable @typescript-eslint/no-misused-promises -- legacy async event listeners with fire-and-forget bodies; semantics preserved verbatim */


import { internal } from './internal';
import { buildSeerrPendingToggle } from '../../enhanced/spoiler-guard/seerr-toggle';
const state = internal.state;
const logPrefix = '🪼 Jellyfin Canopy: Seerr More Info:';
const escapeHtml = JC.escapeHtml;
const DisplayStatus = JC.seerrStatus!.DISPLAY;

function buildSingle4kButton(data: any) {
const button = document.createElement('button');
button.className = 'seerr-request-button seerr-button-request';
button.innerHTML = `${JC.seerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JC.t!('seerr_btn_request_4k') || 'Request in 4K'}</span>`;
button.addEventListener('click', async (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    if (JC.pluginConfig.SeerrShowAdvanced) {
        window.JellyfinCanopy?.seerrUI?.showMovieRequestModal?.(data.id, data.title || data.name, data, true);
        return;
    }
    button.disabled = true;
    button.innerHTML = `<span>${JC.t!('seerr_btn_requesting')}</span><span class="seerr-button-spinner"></span>`;
    try {
        await JC.seerrAPI!.requestMedia(data.id, 'movie', { is4k: true }, false, data);
        mountRequestedChip(data, 'movie', true);
    } catch (error: any) {
        // Quota errors get a themed dialog; restore button to idle.
        if (JC.seerrUI?.isQuotaError?.(error)) {
            await JC.seerrUI.showQuotaErrorDialog(error, 'movie');
            button.disabled = false;
            button.innerHTML = `${JC.seerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JC.t!('seerr_btn_request_4k') || 'Request in 4K'}</span>`;
            return;
        }
        // Escape API error message before innerHTML to prevent reflected XSS
        const errorMessage = error?.responseJSON?.message || JC.t!('seerr_btn_error');
        button.disabled = false;
        button.innerHTML = `<span>${escapeHtml(errorMessage)}</span>`;
        button.classList.add('seerr-button-error');
    }
});
return button;
}

function buildMovieActions(data: any, actionMount: any, chipMount: any, show4kOption: any) {
const status = data.mediaInfo ? data.mediaInfo.status : 1;
const status4k = data.mediaInfo ? data.mediaInfo.status4k : 1;
if (!JC.seerrStatus!.isRequestable(status)) {
    return null;
}

const container = document.createElement('div');
container.className = 'jc-more-info-actions-row';

// Build split button (reuse card styling)
if (show4kOption) {
    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'seerr-button-group jc-more-info-button-group';

    const mainButton = document.createElement('button');
    mainButton.className = 'seerr-request-button seerr-split-main seerr-button-request';
    mainButton.innerHTML = `${JC.seerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JC.t!('seerr_btn_request')}</span>`;
    mainButton.dataset.tmdbId = data.id;
    mainButton.dataset.mediaType = 'movie';

    const arrowButton = document.createElement('button');
    arrowButton.className = 'seerr-split-arrow';
    arrowButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 01-1.06 0l-7.5-7.5a.75.75 0 011.06-1.06L12 14.69l6.97-6.97a.75.75 0 111.06 1.06l-7.5 7.5z" clip-rule="evenodd" /></svg>';
    arrowButton.title = 'Request in 4K';
    arrowButton.dataset.tmdbId = data.id;
    arrowButton.dataset.toggle4k = 'true';

    mainButton.addEventListener('click', async (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        if (JC.pluginConfig.SeerrShowAdvanced) {
            window.JellyfinCanopy?.seerrUI?.showMovieRequestModal?.(data.id, data.title || data.name, data, false);
            return;
        }
        mainButton.disabled = true;
        mainButton.innerHTML = `<span>${JC.t!('seerr_btn_requesting')}</span><span class="seerr-button-spinner"></span>`;
        try {
            const response = await JC.seerrAPI!.requestMedia(data.id, 'movie', {}, false, data);
            mountRequestedChip(data, 'movie', false, response);
        } catch (error: any) {
            // Quota errors get a themed dialog; restore button to idle.
            if (JC.seerrUI?.isQuotaError?.(error)) {
                await JC.seerrUI.showQuotaErrorDialog(error, 'movie');
                mainButton.disabled = false;
                mainButton.innerHTML = `${JC.seerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JC.t!('seerr_btn_request')}</span>`;
                return;
            }
            mainButton.disabled = false;
            // Escape API error before innerHTML to prevent reflected XSS
            const errorMessage = error?.responseJSON?.message || JC.t!('seerr_btn_error');
            mainButton.innerHTML = `<span>${escapeHtml(errorMessage)}</span>${JC.seerrUIIcons?.error || ''}`;
            mainButton.classList.add('seerr-button-error');
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
    menu.className = 'jc-4k-popup';
    const option = document.createElement('button');
    option.className = 'jc-4k-popup-item';

    const moviePopupDs4k = JC.seerrStatus!.resolveDisplayStatus(status4k, false);
    if (moviePopupDs4k === DisplayStatus.AVAILABLE) {
        option.textContent = 'Request in 4K';
        option.disabled = true;
        option.classList.add('jc-4k-available');
    } else if (moviePopupDs4k === DisplayStatus.PENDING || moviePopupDs4k === DisplayStatus.REQUESTED || moviePopupDs4k === DisplayStatus.PROCESSING) {
        option.textContent = 'Request in 4K';
        option.disabled = true;
        option.classList.add(moviePopupDs4k === DisplayStatus.PROCESSING ? 'jc-4k-processing' : 'jc-4k-pending');
    } else if (moviePopupDs4k === DisplayStatus.BLOCKED) {
        option.textContent = 'Request in 4K';
        option.disabled = true;
        option.classList.add('jc-4k-blocklisted');
    } else {
        option.textContent = 'Request in 4K';
        option.classList.add('jc-4k-request');
        option.addEventListener('click', async (ev: any) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (JC.pluginConfig.SeerrShowAdvanced) {
                close4k();
                window.JellyfinCanopy?.seerrUI?.showMovieRequestModal?.(data.id, data.title || data.name, data, true);
                return;
            }
            option.disabled = true;
            option.textContent = JC.t!('seerr_btn_requesting');
            try {
                const response = await JC.seerrAPI!.requestMedia(data.id, 'movie', { is4k: true }, false, data);
                mountRequestedChip(data, 'movie', true, response);
                close4k();
            } catch (error: any) {
                // Quota errors get a themed dialog; restore option to idle.
                if (JC.seerrUI?.isQuotaError?.(error)) {
                    await JC.seerrUI.showQuotaErrorDialog(error, 'movie');
                    option.disabled = false;
                    option.textContent = 'Request in 4K';
                    return;
                }
                option.disabled = false;
                option.textContent = error?.responseJSON?.message || JC.t!('seerr_btn_error');
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
    requestButton.className = 'seerr-request-button seerr-button-request';
    requestButton.innerHTML = `${JC.seerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JC.t!('seerr_btn_request')}</span>`;
    requestButton.addEventListener('click', async (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        if (JC.pluginConfig.SeerrShowAdvanced) {
            window.JellyfinCanopy?.seerrUI?.showMovieRequestModal?.(data.id, data.title || data.name, data, false);
            return;
        }
        requestButton.disabled = true;
        requestButton.innerHTML = `<span>${JC.t!('seerr_btn_requesting')}</span><span class="seerr-button-spinner"></span>`;
        try {
            await JC.seerrAPI!.requestMedia(data.id, 'movie', {}, false, data);
            mountRequestedChip(data, 'movie', false);
        } catch (error: any) {
            // Quota errors get a themed dialog; restore button to idle.
            if (JC.seerrUI?.isQuotaError?.(error)) {
                await JC.seerrUI.showQuotaErrorDialog(error, 'movie');
                requestButton.disabled = false;
                requestButton.innerHTML = `${JC.seerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JC.t!('seerr_btn_request')}</span>`;
                return;
            }
            requestButton.disabled = false;
            // Escape API error before innerHTML to prevent reflected XSS
            const errorMessage = error?.responseJSON?.message || JC.t!('seerr_btn_error');
            requestButton.innerHTML = `<span>${escapeHtml(errorMessage)}</span>${JC.seerrUIIcons?.error || ''}`;
            requestButton.classList.add('seerr-button-error');
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

document.dispatchEvent(new CustomEvent('seerr-media-requested', {
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
    const quota = await JC.seerrAPI?.fetchUserQuota?.();
    if (!actionMount.isConnected) return;
    if (actionMount.dataset.quotaRenderToken !== String(myToken)) return;

    const chip = JC.seerrUI?.buildQuotaChip?.(quota, mediaType === 'tv' ? 'tv' : 'movie');
    if (chip instanceof Element) {
        chip.classList.add('jc-more-info-quota-chip');
        actionMount.insertBefore(chip, actionMount.firstChild);
    }
} catch (err: any) {
    console.warn(`${logPrefix} quota chip render failed:`, err);
}
}

function renderActions(data: any, mediaType: any) {
if (!state.currentModal) return;

const actionMount = state.currentModal.querySelector('[data-mount="jc-actions"]');
const chipMount = state.currentModal.querySelector('[data-mount="jc-status-chip"]');
const downloadsMount = state.currentModal.querySelector('[data-mount="jc-downloads"]');
if (actionMount) actionMount.innerHTML = '';
if (chipMount) chipMount.innerHTML = '';
if (downloadsMount) downloadsMount.innerHTML = '';

// Spoiler Guard pending toggle: a quiet secondary action that sits below the
// primary Request CTA, independent of request status (pre-arm before request,
// or register intent on a title someone else requested). Its own mount so the
// actionMount.innerHTML resets above don't wipe it.
const secondaryMount = state.currentModal.querySelector('[data-mount="jc-secondary-actions"]');
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
    const show4k = JC.seerrAPI!.canRequest4k('movie');

    // Show both chips if both statuses exist
    const hasNormalStatus = JC.seerrStatus!.hasStatus(status);
    const has4kStatus = JC.seerrStatus!.hasStatus(status4k);

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

    const effectiveMovieStatus = JC.seerrStatus!.effectiveMediaStatus(status, jellyfinMediaId);
    const effectiveMovieStatus4k = JC.seerrStatus!.effectiveMediaStatus(status4k, jellyfinMediaId4k);

    const canRequestNormal = JC.seerrStatus!.isRequestable(effectiveMovieStatus);
    const canRequest4k = JC.seerrStatus!.isRequestable(effectiveMovieStatus4k);

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
    const show4kTv = JC.seerrAPI!.canRequest4k('tv');

    // Show both chips if both statuses exist
    const hasNormalStatus = JC.seerrStatus!.hasStatus(status);
    const has4kStatus = JC.seerrStatus!.hasStatus(status4k);

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

    const effectiveStatus = JC.seerrStatus!.effectiveMediaStatus(status, jellyfinMediaId);
    const effectiveStatus4k = JC.seerrStatus!.effectiveMediaStatus(status4k, jellyfinMediaId4k);

    const canRequestNormal = JC.seerrStatus!.isRequestable(effectiveStatus);
    const canRequest4k = JC.seerrStatus!.isRequestable(effectiveStatus4k);
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
