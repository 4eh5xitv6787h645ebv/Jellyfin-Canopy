// src/enhanced/events.ts
//
// Manages all event listeners and observers for the plugin.
// (Converted from js/enhanced/events.js — bodies semantically identical.)

import { JC } from '../globals';
import { createObserver } from '../core/dom-observer';
import { isAnyModalOpen } from '../core/modal-a11y';
import { toast } from '../core/ui-kit';
import { stampLayoutClass } from '../core/layout';
import { migrateLegacyClientStorage } from './legacy-storage-migration';
import { throttle } from './helpers';

/**
 * An always-active key listener specifically for opening the panel.
 * @param e The keyboard event.
 */
function panelKeyListener(e: KeyboardEvent): void {
    // INT-1: never open the panel through an open JC modal (`?` would otherwise
    // pop the panel up behind another dialog).
    if (isAnyModalOpen() || document.body.classList.contains('jc-modal-open')) return;
    // Don't open if the panel is already open or if typing in an input field.
    if (document.getElementById('jellyfin-canopy-panel') || ['INPUT', 'TEXTAREA'].includes(document.activeElement!.tagName)) {
        return;
    }

    if (e.key === '?') {
        e.preventDefault();
        e.stopPropagation();
        (JC as any).showEnhancedPanel();
    }
}

/**
 * The main key listener for all other shortcuts.
 * @param e The keyboard event.
 */
JC.keyListener = (e: KeyboardEvent) => {
    // INT-1: suppress every global shortcut while any JC modal is open so a
    // configured key can't fire through the dialog and navigate the SPA away.
    if (isAnyModalOpen() || document.body.classList.contains('jc-modal-open')) return;
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement!.tagName)) return;

    const key = e.key;
    const combo = (e.shiftKey ? 'Shift+' : '') +
                  (e.metaKey ? 'Meta+' : '') +
                  (e.ctrlKey ? 'Ctrl+' : '') +
                  (e.altKey ? 'Alt+' : '') +
                  (key.match(/^[a-zA-Z]$/) ? key.toUpperCase() : key);

    const video = document.querySelector('video');
    const activeShortcuts = JC.state!.activeShortcuts;

    // --- Global Shortcuts ---
    if (combo === activeShortcuts.OpenSearch) {
        e.preventDefault();
        document.querySelector<HTMLElement>('button.headerSearchButton')?.click();
        setTimeout(() => document.querySelector<HTMLInputElement>('input[type="search"]')?.focus(), 100);
        toast(JC.t!('toast_search'));
    } else if (combo === activeShortcuts.GoToHome) {
        e.preventDefault();
        window.location.hash = '#/home.html';
        toast(JC.t!('toast_home'));
    } else if (combo === activeShortcuts.GoToDashboard) {
        e.preventDefault();
        window.location.hash = '#/dashboard';
        toast(JC.t!('toast_dashboard'));
    } else if (combo === activeShortcuts.QuickConnect) {
        e.preventDefault();
        window.location.hash = '#/quickconnect';
        toast(`${JC.icon!(JC.IconName!.LINK)} Quick Connect`);
    } else if (combo === activeShortcuts.PlayRandomItem && !(JC as any).isVideoPage()) {
        e.preventDefault();
        document.getElementById('randomItemButton')?.click();
    }

    // --- Player-Only Shortcuts ---
    if (!(JC as any).isVideoPage() || !video) return;

    switch (combo) {
        case activeShortcuts.BookmarkCurrentTime:
            e.preventDefault();
            e.stopPropagation();
            // Open bookmark modal to add/view bookmarks
            if ((JC as any).bookmarks?.showModal) {
                (JC as any).bookmarks.showModal('add');
            } else {
                console.warn('🪼 Jellyfin Canopy: New bookmark system not loaded, using fallback');
            }
            break;
        case activeShortcuts.CycleAspectRatio:
            e.preventDefault();
            e.stopPropagation();
            JC.cycleAspect!();
            break;
        case activeShortcuts.ShowPlaybackInfo: {
            e.preventDefault();
            e.stopPropagation();
            // Check if stats dialog is already open
            const statsDialog = document.querySelector('.actionSheetContent button[data-id="stats"]');
            if (statsDialog) {
                // Stats menu is open, close it
                const dialogBackdropContainer = document.getElementById('dialogBackdropContainer');
                const dialogContainer = document.getElementById('dialogContainer');
                if (dialogBackdropContainer) dialogBackdropContainer.remove();
                if (dialogContainer) dialogContainer.remove();
            } else {
                // Stats menu is not open, open it
                JC.openSettings!(() => document.querySelector<HTMLElement>('.actionSheetContent button[data-id="stats"]')?.click());
            }
            break;
        }
        case activeShortcuts.SubtitleMenu: {
            e.preventDefault();
            e.stopPropagation();
            const subtitleMenuTitle = Array.from(document.querySelectorAll('.actionSheetContent .actionSheetTitle')).find(el => el.textContent === 'Subtitles');
            if (subtitleMenuTitle) {
                // Subtitle menu is already open, close it
                const dialogBackdrop = document.querySelector('.dialogBackdrop.dialogBackdropOpened');
                const dialogContainer = document.querySelector('.dialogContainer');
                if (dialogBackdrop) dialogBackdrop.remove();
                if (dialogContainer) dialogContainer.remove();
            } else {
                // Subtitle menu is not open, open it
                document.querySelector<HTMLElement>('button.btnSubtitles')?.click();
            }
            break;
        }
        case activeShortcuts.CycleSubtitleTracks:
            e.preventDefault();
            e.stopPropagation();
            JC.cycleSubtitleTrack!();
            break;
        case activeShortcuts.CycleAudioTracks:
            e.preventDefault();
            e.stopPropagation();
            JC.cycleAudioTrack!();
            break;
        case activeShortcuts.ResetPlaybackSpeed:
            e.preventDefault();
            e.stopPropagation();
            JC.resetPlaybackSpeed!();
            break;
        case activeShortcuts.IncreasePlaybackSpeed:
            e.preventDefault();
            e.stopPropagation();
            JC.adjustPlaybackSpeed!('increase');
            break;
        case activeShortcuts.DecreasePlaybackSpeed:
            e.preventDefault();
            e.stopPropagation();
            JC.adjustPlaybackSpeed!('decrease');
            break;
        case activeShortcuts.OpenEpisodePreview: {
            e.preventDefault();
            e.stopPropagation();
            const popupFocusContainer = document.getElementById('popupFocusContainer');
            if (popupFocusContainer && popupFocusContainer.classList.contains('opened')) {
                // Popup is already open, close it by removing all dialog elements
                const dialogBackdropContainer = document.getElementById('dialogBackdropContainer');
                const dialogContainer = document.getElementById('dialogContainer');

                if (dialogBackdropContainer) dialogBackdropContainer.remove();
                if (dialogContainer) dialogContainer.remove();
            } else {
                // Popup is not open, try to open it
                const popupPreviewButton = document.querySelector<HTMLElement>('button#popupPreviewButton.autoSize.paper-icon-button-light[is="paper-icon-button-light"]');
                if (popupPreviewButton) {
                    popupPreviewButton.click();
                }
            }
            break;
        }
        case activeShortcuts.SkipIntroOutro:
            e.preventDefault();
            e.stopPropagation();
            JC.skipIntroOutro!();
            break;
        case activeShortcuts.FrameStepBack:
            e.preventDefault();
            e.stopPropagation();
            void JC.frameStep!('back');
            break;
        case activeShortcuts.FrameStepForward:
            e.preventDefault();
            e.stopPropagation();
            void JC.frameStep!('forward');
            break;
        case activeShortcuts.JumpToLastPosition:
            e.preventDefault();
            e.stopPropagation();
            JC.jumpToLastPosition!();
            break;
    }

    if (key.match(/^[0-9]$/)) {
        JC.jumpToPercentage!(parseInt(key) * 10);
    }
};

/**
 * Sets up listeners for DOM changes to inject UI elements dynamically.
 */
function setupDOMObserver(): void {
    // PERF(R8): track the video-page state across ticks so the leave-page teardown
    // (stopAutoSkip) runs once on the transition instead of on every mutation
    // batch of every non-video page.
    let wasVideoPage = false;

    const runPageSpecificFunctions = () => {
        if ((JC as any).isVideoPage()) {
            wasVideoPage = true;
            (JC as any).addOsdSettingsButton();
            JC.initializeAutoSkipObserver!();
            (JC as any).applySavedStylesWhenReady();
            // Attach seek tracker to the video element as soon as it exists
            const video = document.querySelector('video');
            if (video) JC.attachSeekTracker!(video);
        } else if (wasVideoPage) {
            wasVideoPage = false;
            JC.stopAutoSkip!();
        }
    };

    // PERF(R4): the random button registers a keyed ensureInjected injector that
    // re-attaches itself on navigation/viewshow/body mutation — calling it once
    // here is enough. The old per-tick call re-resolved the header container
    // (a layout read via offsetParent) on every mutation batch (~10x/s while
    // cards stream in). Settings toggles re-call JC.addRandomButton directly.
    (JC as any).addRandomButton();

    // Create managed observer for general DOM changes
    createObserver(
        'dom-observer',
        throttle(() => {
            runPageSpecificFunctions();
            // Cheap idempotent probe (getElementById-gated); creates no observers.
            (JC as any).addUserPreferencesLink();
        }, 100),
        document.body,
        { childList: true, subtree: true }
    );
}

/**
 * Sets up the action-sheet observer that injects the "Remove" item.
 *
 * Injection is coalesced onto a requestAnimationFrame rather than a timer: rAF runs after
 * the mutation but BEFORE the browser paints the freshly-opened sheet, so the Remove item
 * is present on the sheet's first frame and never appears late to reflow it (which would
 * jank the open animation). Coalescing also means at most one pass per frame regardless of
 * how many mutations fire, and the handlers early-return cheaply when no sheet is open.
 */
function observeActionSheets(): void {
    let scheduled = false;
    const runInjection = () => {
        scheduled = false;
        if (!JC.currentSettings!.removeContinueWatchingEnabled) return;
        if (typeof (JC as any).addRemoveButton === 'function') {
            (JC as any).addRemoveButton();
        } else {
            console.warn('🪼 Jellyfin Canopy: addRemoveButton not available');
        }
        // Also offer Remove in the multi-select / long-press menu (touch devices
        // with no per-item "…" button).
        if (typeof (JC as any).addMultiSelectRemoveButton === 'function') {
            (JC as any).addMultiSelectRemoveButton();
        }
    };

    createObserver(
        'action-sheets',
        () => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(runInjection);
        },
        document.body,
        { childList: true, subtree: true }
    );
}

/**
 * Listens for menu triggers to capture which home surface ("Continue Watching" or
 * "Next Up") an item belongs to, so the matching Remove button can be added to the
 * action sheet that opens next. Context is captured on the trigger (menu mousedown /
 * right-click) because that is the only moment the source card is known.
 */
function addContextMenuListener(): void {
    /**
     * Records the item + its home surface (or clears it) for the action-sheet observer.
     * @param itemElement The element carrying the item's `data-id`.
     */
    const captureRemoveContext = (itemElement: Element | null) => {
        if (!itemElement) { JC.state!.removeContext = null; return; }

        const card = itemElement.closest('.card') || itemElement;
        const itemId = (card as HTMLElement)?.dataset?.id || (itemElement as HTMLElement)?.dataset?.id || null;
        if (!itemId) { JC.state!.removeContext = null; return; }

        const surface = (typeof (JC as any).detectCardSurface === 'function') ? (JC as any).detectCardSurface(card) : null;
        JC.state!.removeContext = { itemId, surface, card, ts: Date.now() };
        if (surface) {
            console.log(`🪼 Jellyfin Canopy: ${surface} item detected for Remove action sheet:`, itemId);
        }
    };

    // Clicks/right-clicks inside an already-open action sheet or dialog are menu interactions,
    // not card triggers — capturing context there would bind to a menu row (e.g. "resume").
    const isInsideOpenMenu = (target: Element) =>
        !!(target.closest && target.closest('.actionSheetContent, .actionSheet, .dialogContainer, dialog'));

    // Listen for three-dot menu button clicks
    document.body.addEventListener('mousedown', (e) => {
        if (!JC.currentSettings!.removeContinueWatchingEnabled) return;

        const menuButton = (e.target as Element).closest('button[data-action="menu"]');
        if (!menuButton) return;

        const itemElement = menuButton.closest('.card[data-id]') || menuButton.closest('[data-id]');
        captureRemoveContext(itemElement);
    }, true);

    // Listen for right-click (contextmenu) / long-press on home cards
    document.body.addEventListener('contextmenu', (e) => {
        if (!JC.currentSettings!.removeContinueWatchingEnabled) return;
        if (isInsideOpenMenu(e.target as Element)) return;

        // Only real cards carry a removable home surface; ignore other [data-id] targets.
        captureRemoveContext((e.target as Element).closest('.card[data-id]'));
    }, true);
}

/**
 * Initializes all event listeners for the core Jellyfin Canopy script.
 */
JC.initializeCanopyScript = function() {
    // Rebrand migration: adopt state written by pre-2.0 "Jellyfin Elevate" builds.
    migrateLegacyClientStorage();

    // Check if local storage needs to be cleared by admin request
    const serverClearTimestamp = JC.pluginConfig.ClearLocalStorageTimestamp || 0;
    const localClearedTimestamp = parseInt(localStorage.getItem('jellyfinCanopyLastCleared') || '0', 10);
    if (serverClearTimestamp > localClearedTimestamp) {
        localStorage.removeItem('jellyfinCanopySettings');
        localStorage.setItem('jellyfinCanopyLastCleared', serverClearTimestamp.toString());
    }

    // Initial UI setup
    (JC as any).injectGlobalStyles();
    // Stamp the modern/legacy layout class on <html> now that the app has
    // booted (the header is normally rendered by this point). The stamp is
    // idempotent and self-retries on navigation until the layout resolves.
    stampLayoutClass();
    (JC as any).addPluginMenuButton();
    (JC as any).applySavedStylesWhenReady();

    // Setup persistent listeners and observers
    setupDOMObserver();
    observeActionSheets();
    addContextMenuListener();

    // Always listen for the panel-opening key
    document.addEventListener('keydown', panelKeyListener);

    // Conditionally listen for all other shortcuts
    if (!JC.pluginConfig.DisableAllShortcuts) {
        document.addEventListener('keydown', JC.keyListener!);
    }

    // Add Long Press listeners if enabled
    if (JC.currentSettings!.longPress2xEnabled) {
        const videoPageCheck = (handler: (e: Event) => void) => (e: Event) => {
            if ((JC as any).isVideoPage()) {
                // Don't interfere with clicks on OSD buttons / the pause screen overlay / Enhanced Panel
                if (e.target && (e.target as Element).closest && (e.target as Element).closest('.osdControls, .pause-screen-active, .jellyfin-canopy-panel')) return;
                handler(e);
            }
        };

        document.addEventListener('mousedown', videoPageCheck(JC.handleLongPressDown!), true);
        document.addEventListener('mouseup', videoPageCheck(JC.handleLongPressUp!), true);
        document.addEventListener('mousemove', videoPageCheck(JC.handleLongPressMove!), true);
        document.addEventListener('click', videoPageCheck(JC.handleLongPressClick!), true);
        document.addEventListener('mouseleave', videoPageCheck(JC.handleLongPressCancel!), true);
        document.addEventListener('touchstart', videoPageCheck(JC.handleLongPressDown!), { capture: true, passive: true });
        document.addEventListener('touchmove', videoPageCheck(JC.handleLongPressMove!), { capture: true, passive: true });
        document.addEventListener('touchend', videoPageCheck(JC.handleLongPressUp!), { capture: true, passive: false });
        document.addEventListener('touchcancel', videoPageCheck(JC.handleLongPressCancel!), { capture: true, passive: false });
    }

    // Listeners for tab visibility (auto-pause/resume/PiP)
    document.addEventListener('visibilitychange', () => {
        const video = document.querySelector('video');
        if (!video) return;

        JC.attachSeekTracker!(video);

        if (document.hidden) {
            if (!video.paused && JC.currentSettings!.autoPauseEnabled) {
                video.pause();
                video.dataset.wasPlayingBeforeHidden = 'true';
            }
            if (JC.currentSettings!.autoPipEnabled && !document.pictureInPictureElement) {
                video.requestPictureInPicture().catch(err => console.error("🪼 Jellyfin Canopy: Auto PiP Error:", err));
            }
        } else {
            if (video.paused && video.dataset.wasPlayingBeforeHidden === 'true' && JC.currentSettings!.autoResumeEnabled) {
                void video.play();
            }
            delete video.dataset.wasPlayingBeforeHidden;
            if (JC.currentSettings!.autoPipEnabled && document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(err => console.error("🪼 Jellyfin Canopy: Auto PiP Error:", err));
            }
        }
    });
};
