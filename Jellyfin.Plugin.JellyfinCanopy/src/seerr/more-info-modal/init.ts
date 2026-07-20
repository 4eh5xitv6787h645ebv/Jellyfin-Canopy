// src/seerr/more-info-modal/init.ts
// Public surface + orchestration for the Seerr more-info modal:
// open/close, modal lifecycle, refresh and navigation cleanup.
import { JC } from '../../globals';
import { installModalA11y, type ModalA11yHandle } from '../../core/modal-a11y';
import type { IdentityContext } from '../../types/jc';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload + DOM shapes; typed incrementally */
/* eslint-disable @typescript-eslint/no-misused-promises -- legacy async event listeners with fire-and-forget bodies; semantics preserved verbatim */


interface MoreInfoModalElement extends HTMLDivElement {
    _identityCleanups: Set<() => void>;
    _actionCleanups: Set<() => void>;
    _cleanupTvListener?: () => void;
    _a11y?: ModalA11yHandle;
    _activationTimer?: ReturnType<typeof setTimeout>;
    _removeTimer?: ReturnType<typeof setTimeout>;
    _isClosing?: boolean;
}

interface MoreInfoModalApi {
    open: (tmdbId: any, mediaType: any) => Promise<void>;
    close: (immediate?: boolean) => void;
    checkForUnrequestedSeasons?: (data: any) => Promise<boolean>;
}

const moreInfoModal = {} as MoreInfoModalApi;
import { internal } from './internal';
const state: {
    currentModal: MoreInfoModalElement | null;
    identity: IdentityContext | null;
    openGeneration: number;
} = internal.state;
const logPrefix = '🪼 Jellyfin Canopy: Seerr More Info:';

/**
 * Open the more info modal for a movie or TV show
 * @param {number} tmdbId - The TMDB ID
 * @param {string} mediaType - 'movie' or 'tv'
 */
moreInfoModal.open = async function (tmdbId: any, mediaType: any) {
const identity = JC.identity.capture();
if (!identity || !JC.identity.isCurrent(identity)) return;
const generation = ++state.openGeneration;
const isCurrent = () => generation === state.openGeneration && JC.identity.isCurrent(identity);
try {
    // Fetch details first so the modal can open immediately
    const data = await internal.fetchMediaDetails(tmdbId, mediaType);
    if (!isCurrent()) return;
    if (!data) {
        internal.showError('Failed to load media information');
        return;
    }

    // Render modal immediately
    showModal(data, mediaType, identity, generation);

    // For TV shows, backfill missing season metadata (poster, overview, airDate) from TMDB/episodes
    if (mediaType === 'tv' && data.seasons?.some((s: any) => s.episodeCount > 0 && (!s.airDate || !s.posterPath))) {
        internal.backfillSeasonMetadata(tmdbId, data);
    }

    // Fetch ratings in the background and populate when ready
    internal.fetchRatings(tmdbId, mediaType)
        .then((ratings: any) => {
            if (!isCurrent()) return;
            // Modal might have been closed or replaced; ensure we're updating the correct one
            if (!state.currentModal) return;
            const modalTmdbId = state.currentModal?.dataset?.tmdbId;
            const modalMediaType = state.currentModal?.dataset?.mediaType;
            if (String(modalTmdbId) !== String(data.id) || modalMediaType !== mediaType) return;

            data.ratings = ratings;
            const mount = state.currentModal.querySelector('[data-mount="ratings"]');
            if (mount) {
                const logos = internal.buildRatingLogos(ratings, data, mediaType, tmdbId);
                mount.innerHTML = logos || '';
            }
        })
        .catch((error: any) => {
            if (!isCurrent()) return;
            console.error(`${logPrefix} Failed to fetch ratings for TMDB ID ${tmdbId}:`, error);
            // Silently fail; modal is already shown without ratings
        });
} catch (error: any) {
    if (!isCurrent()) return;
    console.error('Error opening more info modal:', error);
    internal.showError('Failed to load media information');
}
}

/**
 * Refresh modal data and update displays
 */
async function refreshModalData(
    data: any,
    mediaType: any,
    modal: MoreInfoModalElement,
    refreshBtn: HTMLButtonElement
) {
const identity = JC.identity.ownerOf(modal);
const isCurrent = () => !!identity
    && JC.identity.isCurrent(identity)
    && state.currentModal === modal
    && modal.isConnected;
if (!isCurrent()) return;
try {
    // Show loading state on button
    refreshBtn.classList.add('loading');
    refreshBtn.disabled = true;

    // Fetch fresh data
    const freshData = await internal.fetchMediaDetails(data.id, mediaType);
    if (!isCurrent()) return;
    if (!freshData) {
        internal.showError('Failed to refresh media information');
        refreshBtn.classList.remove('loading');
        refreshBtn.disabled = false;
        return;
    }

    // Update data object with fresh info
    Object.assign(data, freshData);

    // Re-render the action buttons/chips to show updated status (chip, downloads, request button)
    internal.renderActions(data, mediaType);
    if (mediaType === 'tv') {
        internal.enrichSeasonCardsWithJellyfinLinks(data, modal);
    }

    refreshBtn.classList.remove('loading');
    refreshBtn.disabled = false;

} catch (error: any) {
    if (!isCurrent()) return;
    console.error('Error refreshing modal data:', error);
    internal.showError('Failed to refresh modal data');
    refreshBtn.classList.remove('loading');
    refreshBtn.disabled = false;
}
}

/**
 * Show the modal with media information
 */
function showModal(data: any, mediaType: any, identity: IdentityContext, generation: number) {
if (!JC.identity.isCurrent(identity) || generation !== state.openGeneration) return;
// Close existing modal if any
moreInfoModal.close(true);

const modal = document.createElement('div') as MoreInfoModalElement;
modal.className = 'jc-more-info-modal';
modal.dataset.jcIdentityOwned = 'true';
JC.identity.own(modal, identity);
modal.innerHTML = internal.buildModalContent(data, mediaType);
// Tag modal so async updates only apply to the current item
modal.dataset.tmdbId = String(data.id || '');
modal.dataset.mediaType = mediaType;
modal._identityCleanups = new Set<() => void>();
modal._actionCleanups = new Set<() => void>();

// Add event listeners
modal.addEventListener('click', (e: any) => {
    if (!JC.identity.isCurrent(identity) || state.currentModal !== modal) return;
    if (e.target === modal || e.target.classList.contains('modal-overlay')) {
        moreInfoModal.close();
    }
});

// Refresh button handler
const refreshBtn = modal.querySelector<HTMLButtonElement>('.modal-refresh');
if (refreshBtn) {
    refreshBtn.addEventListener('click', async (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        if (JC.identity.isCurrent(identity) && state.currentModal === modal) {
            await refreshModalData(data, mediaType, modal, refreshBtn);
        }
    });
}

// Close button handler
const closeBtn = modal.querySelector('.modal-close');
if (closeBtn) {
    closeBtn.addEventListener('click', (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        if (JC.identity.isCurrent(identity) && state.currentModal === modal) moreInfoModal.close();
    });
}

// Collection button handler
const collectionBtn = modal.querySelector<HTMLElement>('.jc-collection-card-button');
if (collectionBtn) {
    collectionBtn.addEventListener('click', (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        if (!JC.identity.isCurrent(identity) || state.currentModal !== modal) return;
        const collectionId = parseInt(collectionBtn.dataset.collectionId || "", 10);
        const collectionName = collectionBtn.dataset.collectionName;
        if (collectionId && collectionName) {
            JC.seerrUI!.showCollectionRequestModal(collectionId, collectionName);
        }
    });
}

document.body.appendChild(modal);
state.currentModal = modal;
state.identity = identity;

// Accessible dialog: role/aria, focus trap + restore, Escape, and the
// jc-modal-open gate that suppresses JC global shortcuts while open (A11Y-1 /
// INT-1). Replaces the former hand-rolled Escape-only keydown listener.
modal._a11y = installModalA11y(modal, {
    dialogElement: modal.querySelector<HTMLElement>('.modal-container') ?? modal,
    labelledBy: 'jc-more-info-title',
    onEscape: () => moreInfoModal.close(),
});

// Render action buttons/chips after mount
internal.renderActions(data, mediaType);
if (mediaType === 'tv') {
    internal.enrichSeasonCardsWithJellyfinLinks(data, modal);
}

// Listen for TV season requests to update status
if (mediaType === 'tv') {
    const handleTvRequest = async (e: any) => {
        if (!JC.identity.isCurrent(identity) || state.currentModal !== modal) return;
        if (!e.detail?.tmdbId || String(e.detail.tmdbId) !== String(data.id)) return;

        try {
            // Refresh details to pull latest status/progress
            const fresh = await internal.fetchMediaDetails(data.id, 'tv');
            if (!JC.identity.isCurrent(identity) || state.currentModal !== modal) return;
            if (fresh?.mediaInfo) {
                data.mediaInfo = fresh.mediaInfo;
            } else {
                // Fallback: mark requested
                const mediaInfo = data.mediaInfo || (data.mediaInfo = {});
                mediaInfo.status = mediaInfo.status || 2;
            }
        } catch (_: any) {
            if (!JC.identity.isCurrent(identity) || state.currentModal !== modal) return;
            const mediaInfo = data.mediaInfo || (data.mediaInfo = {});
            mediaInfo.status = mediaInfo.status || 2;
        }

        if (!JC.identity.isCurrent(identity) || state.currentModal !== modal) return;
        internal.renderActions(data, mediaType);
        internal.enrichSeasonCardsWithJellyfinLinks(data, modal);
    };
    document.addEventListener('seerr-tv-requested', handleTvRequest);
    modal._cleanupTvListener = () => document.removeEventListener('seerr-tv-requested', handleTvRequest);
}

// Trigger animation
const activationTimer = setTimeout(() => {
    if (JC.identity.isCurrent(identity) && state.currentModal === modal) modal.classList.add('active');
}, 10);
modal._activationTimer = activationTimer;
}

/**
 * Close the modal
 */
moreInfoModal.close = function (immediate = false) {
const target = state.currentModal;
if (target) {
    if (target._isClosing && !immediate) return;
    target._isClosing = true;

    if (target._activationTimer) clearTimeout(target._activationTimer);
    if (target._removeTimer) clearTimeout(target._removeTimer);
    for (const cleanup of target._identityCleanups || []) {
        try { cleanup(); } catch { /* continue closing */ }
    }
    target._identityCleanups?.clear?.();
    for (const cleanup of target._actionCleanups || []) {
        try { cleanup(); } catch { /* continue closing */ }
    }
    target._actionCleanups?.clear?.();

    // Clean up TV request listener if exists
    if (target._cleanupTvListener) {
        target._cleanupTvListener();
    }
    // Release the a11y handle now (before the 300ms removal) so focus restores
    // immediately and the jc-modal-open gate lifts.
    if (target._a11y) {
        target._a11y.release();
    }
    target.classList.remove('active');
    const finish = () => {
        target.remove();
        if (state.currentModal === target) {
            state.currentModal = null;
            state.identity = null;
        }
    };
    if (immediate) finish();
    else target._removeTimer = setTimeout(finish, 300);
}
}

function retireMoreInfoModal(): void {
    state.openGeneration += 1;
    moreInfoModal.close(true);
}

function closeMoreInfoOnView(): void {
    if (state.currentModal) {
        moreInfoModal.close();
    }
}

let unregisterIdentityReset: (() => void) | null = null;
let listenersInstalled = false;

export function installSeerrMoreInfo(): () => void {
    JC.seerrMoreInfo = moreInfoModal;
    unregisterIdentityReset ??= JC.identity.registerReset(
        'seerr-more-info-modal',
        retireMoreInfoModal,
    );
    if (!listenersInstalled) {
        document.addEventListener('viewshow', closeMoreInfoOnView);
        window.addEventListener('jc:config-changed', retireMoreInfoModal);
        listenersInstalled = true;
    }
    let installed = true;
    return () => {
        if (!installed) return;
        installed = false;
        unregisterIdentityReset?.();
        unregisterIdentityReset = null;
        if (listenersInstalled) {
            document.removeEventListener('viewshow', closeMoreInfoOnView);
            window.removeEventListener('jc:config-changed', retireMoreInfoModal);
            listenersInstalled = false;
        }
        retireMoreInfoModal();
    };
}

// Expose helpers used by other modules (e.g., item-details.js for the
// Series page "Request More" button) so the unrequested-seasons check
// logic does not need to be duplicated.
moreInfoModal.checkForUnrequestedSeasons = internal.checkForUnrequestedSeasons;
