// src/seerr/more-info-modal/actions-tv.ts
// TV request buttons: season request split-button, 4K variants and
// the "Request More" button.
import { JC } from '../../globals';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload + DOM shapes; typed incrementally */
/* eslint-disable @typescript-eslint/no-misused-promises, @typescript-eslint/require-await -- legacy async event listeners with fire-and-forget bodies; semantics preserved verbatim */


import { internal } from './internal';
const DisplayStatus = JC.seerrStatus!.DISPLAY;

/**
 * Render request/4K actions and download progress inside the modal.
 */
function buildTvActions(data: any, show4kOption: any = false) {
const mediaInfo = data.mediaInfo || {};
const status = mediaInfo.status ?? 1;
const status4k = mediaInfo.status4k ?? 1;

// If Seerr reports Available (5) but the item has no Jellyfin media ID,
// the library was wiped and Seerr's status is stale — treat as requestable.
const jellyfinMediaId = mediaInfo.jellyfinMediaId || null;
const jellyfinMediaId4k = mediaInfo.jellyfinMediaId4k || null;
const effectiveStatus = JC.seerrStatus!.effectiveMediaStatus(status, jellyfinMediaId);
const effectiveStatus4k = JC.seerrStatus!.effectiveMediaStatus(status4k, jellyfinMediaId4k);

if (!JC.seerrStatus!.isRequestable(effectiveStatus)) {
    return null;
}

const container = document.createElement('div');
container.className = 'jc-more-info-actions-row';

if (show4kOption) {
    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'seerr-button-group jc-more-info-button-group';

    const mainButton = document.createElement('button');
    mainButton.className = 'seerr-request-button seerr-split-main seerr-button-request';
    mainButton.innerHTML = `${JC.seerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JC.t!('seerr_btn_request')}</span>`;
    mainButton.dataset.tmdbId = data.id;
    mainButton.dataset.mediaType = 'tv';

    const arrowButton = document.createElement('button');
    arrowButton.className = 'seerr-split-arrow';
    arrowButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 01-1.06 0l-7.5-7.5a.75.75 0 011.06-1.06L12 14.69l6.97-6.97a.75.75 0 111.06 1.06l-7.5 7.5z" clip-rule="evenodd" /></svg>';
    arrowButton.title = JC.t!('seerr_btn_request_4k') || 'Request in 4K';
    arrowButton.dataset.tmdbId = data.id;
    arrowButton.dataset.toggle4k = 'true';

    mainButton.addEventListener('click', async (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        if (JC.seerrUI?.showSeasonSelectionModal) {
            JC.seerrUI.showSeasonSelectionModal(data.id, 'tv', data.title || data.name, data, false);
        }
    });

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

        const tvPopupDs4k = JC.seerrStatus!.resolveDisplayStatus(status4k, false);
        if (tvPopupDs4k === DisplayStatus.AVAILABLE) {
            option.textContent = `4K ${JC.t!('seerr_btn_available') || 'Available'}`;
            option.disabled = true;
            option.classList.add('jc-4k-available');
        } else if (tvPopupDs4k === DisplayStatus.PENDING || tvPopupDs4k === DisplayStatus.REQUESTED || tvPopupDs4k === DisplayStatus.PROCESSING) {
            option.textContent = `4K ${JC.t!('seerr_btn_requested') || 'Requested'}`;
            option.disabled = true;
            option.classList.add(tvPopupDs4k === DisplayStatus.PROCESSING ? 'jc-4k-processing' : 'jc-4k-pending');
        } else if (tvPopupDs4k === DisplayStatus.BLOCKED) {
            option.textContent = `4K ${JC.t!('seerr_btn_blocklisted') || 'Blocklisted'}`;
            option.disabled = true;
            option.classList.add('jc-4k-blocklisted');
        } else {
            option.textContent = JC.t!('seerr_btn_request_4k') || 'Request in 4K';
            option.classList.add('jc-4k-request');
            option.addEventListener('click', async (ev: any) => {
                ev.preventDefault();
                ev.stopPropagation();
                close4k();
                if (JC.seerrUI?.showSeasonSelectionModal) {
                    JC.seerrUI.showSeasonSelectionModal(data.id, 'tv', data.title || data.name, data, true);
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
    return container;
}

const requestButton = document.createElement('button');
requestButton.className = 'seerr-request-button seerr-button-request';
requestButton.innerHTML = `${JC.seerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JC.t!('seerr_btn_request')}</span>`;
requestButton.addEventListener('click', async (e: any) => {
    e.preventDefault();
    e.stopPropagation();

    // TV always shows season selection modal
    if (JC.seerrUI?.showSeasonSelectionModal) {
        JC.seerrUI.showSeasonSelectionModal(data.id, 'tv', data.title || data.name, data);
    }
});

container.appendChild(requestButton);
return container;
}

function buildSingleTv4kButton(data: any) {
const button = document.createElement('button');
button.className = 'seerr-request-button seerr-button-request';
button.innerHTML = `${JC.seerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JC.t!('seerr_btn_request_4k') || 'Request in 4K'}</span>`;
button.addEventListener('click', async (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    if (JC.seerrUI?.showSeasonSelectionModal) {
        JC.seerrUI.showSeasonSelectionModal(data.id, 'tv', data.title || data.name, data, true);
    }
});
return button;
}

/**
 * Build "Request More" button for TV shows with some seasons already requested
 */
function buildTvRequestMoreButton(data: any, show4kOption: any = false, canRequest4k: any = false) {
const container = document.createElement('div');
container.className = 'jc-more-info-actions-row';

if (show4kOption) {
    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'seerr-button-group jc-more-info-button-group';

    const mainButton = document.createElement('button');
    mainButton.className = 'seerr-request-button seerr-split-main seerr-button-request';
    mainButton.innerHTML = `${JC.seerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JC.t!('seerr_btn_request_more') || 'Request More'}</span>`;
    mainButton.dataset.tmdbId = data.id;
    mainButton.dataset.mediaType = 'tv';
    mainButton.addEventListener('click', async (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        if (JC.seerrUI?.showSeasonSelectionModal) {
            JC.seerrUI.showSeasonSelectionModal(data.id, 'tv', data.title || data.name, data, false);
        }
    });

    const arrowButton = document.createElement('button');
    arrowButton.className = 'seerr-split-arrow';
    arrowButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 01-1.06 0l-7.5-7.5a.75.75 0 011.06-1.06L12 14.69l6.97-6.97a.75.75 0 111.06 1.06l-7.5 7.5z" clip-rule="evenodd" /></svg>';
    arrowButton.title = JC.t!('seerr_btn_request_4k') || 'Request in 4K';

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
        option.textContent = JC.t!('seerr_btn_request_4k') || 'Request in 4K';

        if (!canRequest4k) {
            option.disabled = true;
            option.textContent = `4K ${JC.t!('seerr_btn_requested') || 'Requested'}`;
            option.classList.add('jc-4k-pending');
        } else {
            option.classList.add('jc-4k-request');
            option.addEventListener('click', async (ev: any) => {
                ev.preventDefault();
                ev.stopPropagation();
                close4k();
                if (JC.seerrUI?.showSeasonSelectionModal) {
                    JC.seerrUI.showSeasonSelectionModal(data.id, 'tv', data.title || data.name, data, true);
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
    return container;
}

const requestButton = document.createElement('button');
requestButton.className = 'seerr-request-button seerr-button-request';
requestButton.innerHTML = `${JC.seerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JC.t!('seerr_btn_request_more') || 'Request More'}</span>`;
requestButton.addEventListener('click', async (e: any) => {
    e.preventDefault();
    e.stopPropagation();

    // Show season selection modal for partially available shows
    if (JC.seerrUI?.showSeasonSelectionModal) {
        JC.seerrUI.showSeasonSelectionModal(data.id, 'tv', data.title || data.name, data);
    }
});

container.appendChild(requestButton);
return container;
}
internal.buildTvActions = buildTvActions;
internal.buildSingleTv4kButton = buildSingleTv4kButton;
internal.buildTvRequestMoreButton = buildTvRequestMoreButton;
