// src/seerr/ui/popover.ts
// Download-progress hover popover and the 4K request popup.
import { JC } from '../../globals';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload + DOM shapes; typed incrementally */


import { ui, internal } from './internal';
import { seerrStatus } from '../seerr-status';
const logPrefix = '🪼 Jellyfin Canopy: Seerr UI:';
const DisplayStatus = seerrStatus.DISPLAY;
const state = internal.state;
const escapeHtml = JC.escapeHtml;
const icons = internal.icons; // requires ui-icons.js to be loaded first
const popupTimers = new Set<ReturnType<typeof setTimeout>>();

function hoverPopoverElement(): HTMLElement | null {
    const value: unknown = state.seerrHoverPopover;
    return value instanceof HTMLElement ? value : null;
}

function active4KPopupElement(): HTMLElement | null {
    const value: unknown = state.active4KPopup;
    return value instanceof HTMLElement ? value : null;
}

// ================================
// DOWNLOAD PROGRESS POPOVER SYSTEM
// ================================

/**
 * Creates or returns existing hover popover element.
 * Used for showing download progress on hover/focus.
 */
function ensureHoverPopover() {
    const identity = JC.identity.capture();
    if (!identity) return null;
    let popover = hoverPopoverElement();
    if (popover && !JC.identity.isOwned(popover, identity)) {
        popover.remove();
        state.seerrHoverPopover = null;
        popover = null;
    }
    if (!popover) {
        popover = document.createElement('div');
        popover.className = 'seerr-hover-popover';
        popover.dataset.jcIdentityOwned = 'true';
        JC.identity.own(popover, identity);
        document.body.appendChild(popover);
        state.seerrHoverPopover = popover;
    }
    return popover;
}

/**
 * Format ETA text for download status.
 * @param {Object} downloadStatus - Download status object with estimatedCompletionTime.
 * @returns {string|null} - Formatted ETA string or null.
 */
function formatEtaText(downloadStatus: any) {
    try {
        const rawEta = downloadStatus?.estimatedCompletionTime;
        if (!rawEta) return null;

        const etaTime = new Date(rawEta);
        const now = new Date();
        const timeUntilMs = etaTime.getTime() - now.getTime();
        if (isNaN(timeUntilMs)) return null;
        if (timeUntilMs <= 0) return 'Estimated soon';

        const totalMinutesRemaining = Math.round(timeUntilMs / 60000);
        if (totalMinutesRemaining >= 1440) {
            const daysRemaining = Math.round(totalMinutesRemaining / 1440);
            return `Estimated in ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''}`;
        }
        if (totalMinutesRemaining >= 60) {
            const hoursRemaining = Math.round(totalMinutesRemaining / 60);
            return `Estimated in ${hoursRemaining} hour${hoursRemaining !== 1 ? 's' : ''}`;
        }
        return `Estimated in ${totalMinutesRemaining} min`;
    } catch (_: any) {
        return null;
    }
}

/**
 * Fills popover with download progress information.
 * @param {Object} item - Media item with download status.
 * @returns {HTMLElement|null} - Popover element or null if no download data.
 */
function fillHoverPopover(item: any) {

    const allDownloads = [
        ...(item.mediaInfo?.downloadStatus || []),
        ...(item.mediaInfo?.downloadStatus4k || [])
    ];

    // Download status fields originate from the Seerr API and must be
    // escaped before interpolation into HTML to prevent stored XSS.
    if (allDownloads.length === 0) {
        console.debug(`${logPrefix} No download status found`);
        return null;
    }

    const popover = ensureHoverPopover();
    if (!popover) return null;
    let popoverHTML = '';

    allDownloads.forEach((downloadStatus: any) => {
        const hasValidSizeData = (typeof downloadStatus.size === 'number' &&
                                typeof downloadStatus.sizeLeft === 'number' &&
                                downloadStatus.size > 0);

        const isQueued = (downloadStatus.status && downloadStatus.status.toLowerCase() === 'queued');
        const isWarning = (downloadStatus.status && downloadStatus.status.toLowerCase() === 'warning');

        if (!hasValidSizeData && !isQueued && !isWarning) {
            return; // Skip this item
        }

        if (isQueued || downloadStatus.size <= 0) {
            // For queued items, show 0% progress
            popoverHTML += `
                <div class="seerr-popover-item">
                    <div class="title">${escapeHtml(downloadStatus.title) || JC.t!('seerr_popover_downloading')}</div>
                    <div class="seerr-hover-progress" role="progressbar" aria-label="${escapeHtml(downloadStatus.title) || JC.t!('seerr_popover_downloading')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="bar" style="width:0%;"></div></div>
                    <div class="row">
                        <div>0%</div>
                        <div class="status">Queued</div>
                    </div>
                </div>`;
        } else {
            // For downloading/warning items, show actual progress
            const percentage = Math.max(0, Math.min(100, Math.round(100 * (1 - downloadStatus.sizeLeft / downloadStatus.size))));
            const statusDisplay = isWarning ? 'Warning' : (downloadStatus.status || 'Downloading').toString().replace(/^./, (c: any) => c.toUpperCase());
            const etaText = formatEtaText(downloadStatus);
            popoverHTML += `
                <div class="seerr-popover-item">
                    <div class="title">${escapeHtml(downloadStatus.title) || JC.t!('seerr_popover_downloading')}</div>
                    <div class="seerr-hover-progress" role="progressbar" aria-label="${escapeHtml(downloadStatus.title) || JC.t!('seerr_popover_downloading')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentage}"><div class="bar" style="width:${percentage}%;"></div></div>
                    <div class="row">
                        <div>${percentage}%</div>
                        <div class="status">${escapeHtml(statusDisplay)}</div>
                        ${etaText ? `<div class="eta">${escapeHtml(etaText)}</div>` : ''}
                    </div>
                </div>`;
        }
    });

    popover.innerHTML = popoverHTML;
    console.debug(`${logPrefix} Popover filled for ${allDownloads.length} download item(s)`);
    return popover;
}

/**
 * Positions popover to stay within screen bounds.
 * @param {HTMLElement} element - Popover element to position.
 * @param {number} x - Target X coordinate.
 * @param {number} y - Target Y coordinate.
 */
function positionHoverPopover(element: any, x: any, y: any) {
    const padding = 12;
    const rect = element.getBoundingClientRect();
    const newX = Math.min(Math.max(x + 14, padding), window.innerWidth - rect.width - padding);
    const newY = Math.min(Math.max(y - rect.height - 14, padding), window.innerHeight - rect.height - padding);
    element.style.transform = `translate(${newX}px, ${newY}px)`;
}

/**
 * Hides the hover popover (respects mobile lock).
 */
function hideHoverPopover(): void {
    const popover = hoverPopoverElement();
    if (popover && !state.seerrHoverLock) {
        popover.classList.remove('show');
        delete popover.dataset.tmdbId;
        delete popover.dataset.clientX;
        delete popover.dataset.clientY;
    }
}
ui.hideHoverPopover = hideHoverPopover;

/**
 * Toggles the lock state for the hover popover, used for mobile tap interactions.
 * @param {boolean} [lockState] - Optional state to force lock/unlock. Toggles if omitted.
 */
ui.toggleHoverPopoverLock = function (lockState: any) {
    state.seerrHoverLock = typeof lockState === 'boolean' ? lockState : !state.seerrHoverLock;
};

/**
 * Creates inline download progress display for season items.
 * @param {Object} downloadStatus - Download status object.
 * @returns {HTMLElement|null} - Progress element or null.
 */
function createInlineProgress(downloadStatus: any) {
    if (!downloadStatus || typeof downloadStatus.size !== 'number' || typeof downloadStatus.sizeLeft !== 'number' || downloadStatus.size <= 0) {
        return null;
    }
    const percentage = Math.max(0, Math.min(100, Math.round(100 * (1 - downloadStatus.sizeLeft / downloadStatus.size))));
    const progressContainer = document.createElement('div');
    progressContainer.className = 'seerr-inline-progress';
    progressContainer.innerHTML = `
        <div class="seerr-inline-progress-bar" role="progressbar" aria-label="${escapeHtml(downloadStatus.title || 'Download')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentage}"><div class="seerr-inline-progress-fill" style="width: ${percentage}%"></div></div>
        <div class="seerr-inline-progress-text">${percentage}% • ${escapeHtml((downloadStatus.status || 'downloading').replace(/^./, (c: any) => c.toUpperCase()))}</div>`;
    return progressContainer;
}

// ================================
// 4K POPUP MANAGEMENT
// ================================

/**
 * Hides any active 4K popup menu.
 */
function hide4KPopup() {
    const popup = active4KPopupElement();
    if (popup) {
        popup.remove();
        state.active4KPopup = null;
    }
}

/**
 * Shows the 4K request popup menu below the button group.
 * @param {HTMLElement} buttonGroup - The split button container.
 * @param {Object} item - Media item data.
 */
function show4KPopup(buttonGroup: HTMLElement, item: any) {
    const identity = JC.identity.capture();
    const ownerNode = buttonGroup.closest('.seerr-card') || buttonGroup;
    if (!identity || !JC.identity.isCurrent(identity) || !JC.identity.isOwned(ownerNode, identity)) return;
    hide4KPopup();

    const popup = document.createElement('div');
    popup.className = 'seerr-4k-popup';
    popup.dataset.jcIdentityOwned = 'true';
    JC.identity.own(popup, identity);

    const status4k = item.mediaInfo ? item.mediaInfo.status4k : 1;

    // Create 4K button
    const request4KBtn = document.createElement('button');
    request4KBtn.className = 'seerr-4k-popup-item';
    JC.identity.own(request4KBtn, identity);

    const popupDs4k = JC.seerrStatus!.resolveDisplayStatus(status4k, false);
    if (popupDs4k === DisplayStatus.AVAILABLE) {
        request4KBtn.innerHTML = `<span>4K Available</span>${icons.available}`;
        request4KBtn.disabled = true;
        request4KBtn.classList.add('seerr-4k-available', 'chip-available');
    } else if (popupDs4k === DisplayStatus.PENDING || popupDs4k === DisplayStatus.REQUESTED || popupDs4k === DisplayStatus.PROCESSING) {
        request4KBtn.innerHTML = `<span>4K Requested</span>${icons.pending}`;
        request4KBtn.disabled = true;
        request4KBtn.classList.add(popupDs4k === DisplayStatus.PROCESSING ? 'chip-processing' : 'chip-pending');
    } else if (popupDs4k === DisplayStatus.BLOCKED) {
        request4KBtn.innerHTML = `<span>${JC.t!('seerr_btn_blocklisted')}</span>${icons.cancel}`;
        request4KBtn.disabled = true;
        request4KBtn.classList.add('chip-blocklisted');
    } else {
        request4KBtn.innerHTML = `<span>${JC.t!('seerr_btn_request_4k')}</span>`;
        request4KBtn.dataset.tmdbId = item.id;
        request4KBtn.dataset.mediaType = item.mediaType || 'movie';
        request4KBtn.dataset.action = 'request4k';
        request4KBtn.classList.add('chip-requested');
    }

    popup.appendChild(request4KBtn);
    document.body.appendChild(popup);
    state.active4KPopup = popup;

    // Position the popup relative to the button group
    const rect = buttonGroup.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.width = `${rect.width}px`;

    const timer = setTimeout(() => {
        popupTimers.delete(timer);
        if (JC.identity.isCurrent(identity) && state.active4KPopup === popup) popup.classList.add('show');
    }, 10);
    popupTimers.add(timer);
}

/**
 * Adds download progress hover functionality to a button.
 * @param {HTMLElement} button - Button element.
 * @param {Object} item - Media item with download status.
 */
function addDownloadProgressHover(button: HTMLElement, item: any) {
    const identity = JC.identity.capture();
    if (identity) JC.identity.own(button, identity);
    const isCurrent = () => !!identity && JC.identity.isCurrent(identity) && JC.identity.isOwned(button, identity);
    const showPopover = (e: any) => {
        if (!isCurrent()) return;
        const popover = fillHoverPopover(item);
        if (popover) {
            const clientX = e.clientX || (e.target.getBoundingClientRect().right);
            const clientY = e.clientY || (e.target.getBoundingClientRect().top - 8);
            positionHoverPopover(popover, clientX, clientY);
            popover.classList.add('show');
            popover.dataset.tmdbId = item.id;
            popover.dataset.clientX = clientX;
            popover.dataset.clientY = clientY;
        }
    };

    button.addEventListener('mouseenter', showPopover);
    button.addEventListener('mousemove', (e: any) => {
        if (!isCurrent()) return;
        if (state.seerrHoverPopover?.classList.contains('show') && !state.seerrHoverLock) {
            state.seerrHoverPopover.dataset.clientX = e.clientX;
            state.seerrHoverPopover.dataset.clientY = e.clientY;
            positionHoverPopover(state.seerrHoverPopover, e.clientX, e.clientY);
        }
    });
    button.addEventListener('mouseleave', () => {
        if (isCurrent()) hideHoverPopover();
    });
    button.addEventListener('focus', showPopover);
    button.addEventListener('blur', () => {
        if (!isCurrent()) return;
        ui.toggleHoverPopoverLock(false);
        hideHoverPopover();
    });
    button.addEventListener('touchstart', (e: any) => {
        if (!isCurrent()) return;
        e.preventDefault();
        const popover = fillHoverPopover(item);
        if (popover) {
            const rect = button.getBoundingClientRect();
            ui.toggleHoverPopoverLock();
            if (state.seerrHoverLock) {
                const clientX = rect.left + rect.width / 2;
                const clientY = rect.top - 8;
                positionHoverPopover(popover, clientX, clientY);
                popover.classList.add('show');
                popover.dataset.tmdbId = item.id;
                popover.dataset.clientX = String(clientX);
                popover.dataset.clientY = String(clientY);
            } else {
                popover.classList.remove('show');
            }
        }
    }, { passive: false });
}
ui.formatEtaText = formatEtaText;

internal.ensureHoverPopover = ensureHoverPopover;
internal.formatEtaText = formatEtaText;
internal.fillHoverPopover = fillHoverPopover;
internal.positionHoverPopover = positionHoverPopover;
internal.createInlineProgress = createInlineProgress;
internal.hide4KPopup = hide4KPopup;
internal.show4KPopup = show4KPopup;
internal.addDownloadProgressHover = addDownloadProgressHover;

export function resetSeerrPopovers(): void {
    for (const timer of popupTimers) clearTimeout(timer);
    popupTimers.clear();
    hoverPopoverElement()?.remove();
    active4KPopupElement()?.remove();
    state.seerrHoverPopover = null;
    state.active4KPopup = null;
    state.seerrHoverLock = false;
}

export function installSeerrPopovers(): () => void {
    const uninstallIdentityReset = JC.identity.registerReset('seerr-popovers', resetSeerrPopovers);
    let installed = true;
    return () => {
        if (!installed) return;
        installed = false;
        uninstallIdentityReset();
        resetSeerrPopovers();
    };
}
