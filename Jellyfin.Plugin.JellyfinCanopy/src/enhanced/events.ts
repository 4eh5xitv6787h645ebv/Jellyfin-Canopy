// src/enhanced/events.ts
//
// Manages all event listeners and observers for the plugin.
// (Converted from js/enhanced/events.js — bodies semantically identical.)

import { JC } from '../globals';
import { createObserver, disconnectObserver } from '../core/dom-observer';
import { createStableMethodFacade } from '../core/feature-loader';
import { isAnyModalOpen } from '../core/modal-a11y';
import { toast } from '../core/ui-kit';
import { stampLayoutClass } from '../core/layout';
import { migrateLegacyClientStorage } from './legacy-storage-migration';
import type { IdentityContext } from '../types/jc';
import { canonicalizeShortcut, shortcutFromEvent, shortcutsEqual } from './shortcut-codec';

interface EventOwner {
    isCurrent(): boolean;
    schedule(callback: () => void, delay: number): number;
}

function callOptional(name: string, ...args: unknown[]): unknown {
    const method = (JC as unknown as Record<string, unknown>)[name];
    return typeof method === 'function' ? Reflect.apply(method, JC, args) : undefined;
}

function isVideoPage(): boolean {
    return callOptional('isVideoPage') === true;
}

/**
 * An always-active key listener specifically for opening the panel.
 * @param e The keyboard event.
 */
function panelKeyListener(e: KeyboardEvent, owner: EventOwner): void {
    if (!owner.isCurrent()) return;
    // INT-1: never open the panel through an open JC modal (`?` would otherwise
    // pop the panel up behind another dialog).
    if (isAnyModalOpen() || document.body.classList.contains('jc-modal-open')) return;
    // Don't open if the panel is already open or if typing in an input field.
    if (document.getElementById('jellyfin-canopy-panel')
        || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName || '')) {
        return;
    }

    if (e.key === '?') {
        e.preventDefault();
        e.stopPropagation();
        callOptional('showEnhancedPanel');
    }
}

/**
 * The main key listener for all other shortcuts.
 * @param e The keyboard event.
 */
function keyListener(e: KeyboardEvent, owner: EventOwner): void {
    const context = JC.identity.capture();
    if (!owner.isCurrent() || !context
        || JC.pluginConfig?.DisableAllShortcuts
        || JC.currentSettings?.disableAllShortcuts) return;
    // INT-1: suppress every global shortcut while any JC modal is open so a
    // configured key can't fire through the dialog and navigate the SPA away.
    if (isAnyModalOpen() || document.body.classList.contains('jc-modal-open')) return;
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName || '')) return;

    const combo = shortcutFromEvent(e);
    if (!combo) return;

    const video = document.querySelector('video');
    const activeShortcuts = JC.state?.activeShortcuts || {};
    const matches = (name: string) => shortcutsEqual(combo, activeShortcuts[name]);

    // --- Global Shortcuts ---
    if (matches('OpenSearch')) {
        e.preventDefault();
        document.querySelector<HTMLElement>('button.headerSearchButton')?.click();
        owner.schedule(() => {
            document.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
        }, 100);
        toast(JC.t!('toast_search'));
    } else if (matches('GoToHome')) {
        e.preventDefault();
        window.location.hash = '#/home.html';
        toast(JC.t!('toast_home'));
    } else if (matches('GoToDashboard')) {
        e.preventDefault();
        window.location.hash = '#/dashboard';
        toast(JC.t!('toast_dashboard'));
    } else if (matches('QuickConnect')) {
        e.preventDefault();
        window.location.hash = '#/quickconnect';
        const icon = JC.IconName?.LINK ? callOptional('icon', JC.IconName.LINK) : '';
        toast(`${typeof icon === 'string' ? icon : ''} Quick Connect`.trim());
    } else if (matches('PlayRandomItem') && !isVideoPage()) {
        e.preventDefault();
        document.getElementById('randomItemButton')?.click();
    }

    // --- Player-Only Shortcuts ---
    if (!isVideoPage() || !video) return;

    switch (combo) {
        case canonicalizeShortcut(activeShortcuts.BookmarkCurrentTime):
            e.preventDefault();
            e.stopPropagation();
            // Open bookmark modal to add/view bookmarks
            if (typeof JC.bookmarks?.showModal === 'function') {
                void JC.bookmarks.showModal('add');
            } else {
                console.warn('🪼 Jellyfin Canopy: New bookmark system not loaded, using fallback');
            }
            break;
        case canonicalizeShortcut(activeShortcuts.CycleAspectRatio):
            e.preventDefault();
            e.stopPropagation();
            callOptional('cycleAspect');
            break;
        case canonicalizeShortcut(activeShortcuts.ShowPlaybackInfo): {
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
                document.querySelector<HTMLElement>(
                    '.videoOsdBottom .btnVideoOsdSettings, ' +
                    '.videoOsdBottom button[title="Settings"], ' +
                    '.videoOsdBottom button[aria-label="Settings"]'
                )?.click();
                owner.schedule(() => {
                    if (owner.isCurrent() && JC.identity.isCurrent(context)) {
                        document.querySelector<HTMLElement>('.actionSheetContent button[data-id="stats"]')?.click();
                    }
                }, 120);
            }
            break;
        }
        case canonicalizeShortcut(activeShortcuts.SubtitleMenu): {
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
        case canonicalizeShortcut(activeShortcuts.CycleSubtitleTracks):
            e.preventDefault();
            e.stopPropagation();
            callOptional('cycleSubtitleTrack');
            break;
        case canonicalizeShortcut(activeShortcuts.CycleAudioTracks):
            e.preventDefault();
            e.stopPropagation();
            callOptional('cycleAudioTrack');
            break;
        case canonicalizeShortcut(activeShortcuts.ResetPlaybackSpeed):
            e.preventDefault();
            e.stopPropagation();
            callOptional('resetPlaybackSpeed');
            break;
        case canonicalizeShortcut(activeShortcuts.IncreasePlaybackSpeed):
            e.preventDefault();
            e.stopPropagation();
            callOptional('adjustPlaybackSpeed', 'increase');
            break;
        case canonicalizeShortcut(activeShortcuts.DecreasePlaybackSpeed):
            e.preventDefault();
            e.stopPropagation();
            callOptional('adjustPlaybackSpeed', 'decrease');
            break;
        case canonicalizeShortcut(activeShortcuts.OpenEpisodePreview): {
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
        case canonicalizeShortcut(activeShortcuts.SkipIntroOutro):
            e.preventDefault();
            e.stopPropagation();
            callOptional('skipIntroOutro');
            break;
        case canonicalizeShortcut(activeShortcuts.FrameStepBack):
            e.preventDefault();
            e.stopPropagation();
            callOptional('frameStep', 'back');
            break;
        case canonicalizeShortcut(activeShortcuts.FrameStepForward):
            e.preventDefault();
            e.stopPropagation();
            callOptional('frameStep', 'forward');
            break;
        case canonicalizeShortcut(activeShortcuts.JumpToLastPosition):
            e.preventDefault();
            e.stopPropagation();
            callOptional('jumpToLastPosition');
            break;
    }

    if (e.key.match(/^[0-9]$/)) {
        callOptional('jumpToPercentage', parseInt(e.key) * 10);
    }
}

/**
 * Sets up listeners for DOM changes to inject UI elements dynamically.
 */
let activationSequence = 0;
let latestActivation = 0;

class EnhancedEventsActivation implements EventOwner {
    readonly id = ++activationSequence;
    private readonly timers = new Set<number>();
    private readonly observerIds = new Set<string>();
    private readonly listenerCleanups: Array<() => void> = [];
    private actionSheetFrame: number | null = null;
    private wasVideoPage = false;
    private initialized = false;
    private retired = false;

    constructor(private readonly context: IdentityContext) {
        latestActivation = this.id;
    }

    isCurrent(): boolean {
        return !this.retired && this.id === latestActivation && JC.identity.isCurrent(this.context);
    }

    schedule(callback: () => void, delay: number): number {
        if (!this.isCurrent()) return 0;
        const timer = window.setTimeout(() => {
            this.timers.delete(timer);
            if (this.isCurrent()) callback();
        }, delay);
        this.timers.add(timer);
        return timer;
    }

    private listen(target: EventTarget, type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void {
        target.addEventListener(type, listener, options);
        this.listenerCleanups.push(() => target.removeEventListener(type, listener, options));
    }

    private observe(name: string, callback: MutationCallback): void {
        const id = `enhanced-events-${name}-${this.id}`;
        createObserver(id, callback, document.body, { childList: true, subtree: true });
        this.observerIds.add(id);
    }

    private setupDOMObserver(): void {
        const runPageSpecificFunctions = (): void => {
            if (!this.isCurrent() || !JC.currentSettings) return;
            if (isVideoPage()) {
                this.wasVideoPage = true;
                callOptional('addOsdSettingsButton');
                callOptional('initializeAutoSkipObserver');
                callOptional('applySavedStylesWhenReady');
                const video = document.querySelector('video');
                if (video) callOptional('attachSeekTracker', video);
            } else if (this.wasVideoPage) {
                this.wasVideoPage = false;
                callOptional('stopAutoSkip');
            }
        };

        callOptional('addRandomButton');
        if (!this.isCurrent()) return;
        let throttleTimer: number | null = null;
        this.observe('dom', () => {
            if (!this.isCurrent() || throttleTimer !== null) return;
            runPageSpecificFunctions();
            callOptional('addUserPreferencesLink');
            throttleTimer = this.schedule(() => { throttleTimer = null; }, 100);
        });
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
    private observeActionSheets(): void {
        this.observe('action-sheets', () => {
            if (!this.isCurrent() || this.actionSheetFrame !== null) return;
            this.actionSheetFrame = requestAnimationFrame(() => {
                this.actionSheetFrame = null;
                if (!this.isCurrent() || !JC.currentSettings?.removeContinueWatchingEnabled) return;
                callOptional('addRemoveButton');
                callOptional('addMultiSelectRemoveButton');
            });
        });
    }

/**
 * Listens for menu triggers to capture which home surface ("Continue Watching" or
 * "Next Up") an item belongs to, so the matching Remove button can be added to the
 * action sheet that opens next. Context is captured on the trigger (menu mousedown /
 * right-click) because that is the only moment the source card is known.
 */
    private addContextMenuListener(): void {
        const captureRemoveContext = (itemElement: Element | null): void => {
            if (!itemElement) { JC.state!.removeContext = null; return; }

            const card = itemElement.closest('.card') || itemElement;
            const itemId = (card as HTMLElement)?.dataset?.id
                || (itemElement as HTMLElement)?.dataset?.id
                || null;
            if (!itemId) { JC.state!.removeContext = null; return; }

            const detectedSurface = callOptional('detectCardSurface', card);
            const surface = detectedSurface === 'continuewatching' || detectedSurface === 'nextup'
                ? detectedSurface
                : null;
            JC.state!.removeContext = { itemId, surface, card, ts: Date.now() };
            if (surface) {
                console.log(`🪼 Jellyfin Canopy: ${surface} item detected for Remove action sheet:`, itemId);
            }
        };

        const isInsideOpenMenu = (target: Element): boolean =>
            Boolean(target.closest?.('.actionSheetContent, .actionSheet, .dialogContainer, dialog'));

        const onMouseDown = (e: Event): void => {
            if (!this.isCurrent() || !JC.currentSettings?.removeContinueWatchingEnabled) return;
            const menuButton = (e.target as Element).closest('button[data-action="menu"]');
            if (!menuButton) return;
            const itemElement = menuButton.closest('.card[data-id]') || menuButton.closest('[data-id]');
            captureRemoveContext(itemElement);
        };
        this.listen(document.body, 'mousedown', onMouseDown, true);

        const onContextMenu = (e: Event): void => {
            if (!this.isCurrent() || !JC.currentSettings?.removeContinueWatchingEnabled) return;
            if (isInsideOpenMenu(e.target as Element)) return;
            captureRemoveContext((e.target as Element).closest('.card[data-id]'));
        };
        this.listen(document.body, 'contextmenu', onContextMenu, true);
    }

/**
 * Initializes all event listeners for the core Jellyfin Canopy script.
 */
    private installProcessListeners(): void {
        this.setupDOMObserver();
        this.observeActionSheets();
        this.addContextMenuListener();

        this.listen(document, 'keydown', (event) => panelKeyListener(event as KeyboardEvent, this));
        this.listen(document, 'keydown', stableEvents.facade.keyListener as EventListener);

        const videoPageCheck = (handlerName: string) => (e: Event): void => {
            if (!this.isCurrent() || !JC.currentSettings?.longPress2xEnabled || !isVideoPage()) return;
            if (e.target && (e.target as Element).closest
                && (e.target as Element).closest('.osdControls, .pause-screen-active, .jellyfin-canopy-panel')) return;
            callOptional(handlerName, e);
        };

        this.listen(document, 'mousedown', videoPageCheck('handleLongPressDown'), true);
        this.listen(document, 'mouseup', videoPageCheck('handleLongPressUp'), true);
        this.listen(document, 'mousemove', videoPageCheck('handleLongPressMove'), true);
        this.listen(document, 'click', videoPageCheck('handleLongPressClick'), true);
        this.listen(document, 'mouseleave', videoPageCheck('handleLongPressCancel'), true);
        this.listen(document, 'touchstart', videoPageCheck('handleLongPressDown'), { capture: true, passive: true });
        this.listen(document, 'touchmove', videoPageCheck('handleLongPressMove'), { capture: true, passive: true });
        this.listen(document, 'touchend', videoPageCheck('handleLongPressUp'), { capture: true, passive: false });
        this.listen(document, 'touchcancel', videoPageCheck('handleLongPressCancel'), { capture: true, passive: false });

        // Visibility behaviour is likewise gated from the live settings.
        this.listen(document, 'visibilitychange', () => {
            const settings = JC.currentSettings;
            if (!this.isCurrent() || !settings) return;
            const video = document.querySelector('video');
            if (!video) return;

            callOptional('attachSeekTracker', video);

            if (document.hidden) {
                if (!video.paused && settings.autoPauseEnabled) {
                    video.pause();
                    video.dataset.wasPlayingBeforeHidden = 'true';
                }
                if (settings.autoPipEnabled && !document.pictureInPictureElement) {
                    void video.requestPictureInPicture().catch(err => {
                        if (this.isCurrent()) console.error("🪼 Jellyfin Canopy: Auto PiP Error:", err);
                    });
                }
            } else {
                if (video.paused && video.dataset.wasPlayingBeforeHidden === 'true' && settings.autoResumeEnabled) {
                    void video.play();
                }
                delete video.dataset.wasPlayingBeforeHidden;
                if (settings.autoPipEnabled && document.pictureInPictureElement) {
                    void document.exitPictureInPicture().catch(err => {
                        if (this.isCurrent()) console.error("🪼 Jellyfin Canopy: Auto PiP Error:", err);
                    });
                }
            }
        });
    }

    initialize(): void {
        if (this.initialized || !this.isCurrent()) return;
        this.initialized = true;
        migrateLegacyClientStorage();
        if (!this.isCurrent()) return;

        const serverClearTimestamp = JC.pluginConfig?.ClearLocalStorageTimestamp || 0;
        const clearTimestamp = JC.storage.local.readNumber(
            'canopy',
            'jellyfinCanopyLastCleared',
            (value) => value >= 0,
            'clear-timestamp',
        );
        if (!this.isCurrent()) return;
        const localClearedTimestamp = clearTimestamp.state === 'Valid' ? clearTimestamp.value : 0;
        if (serverClearTimestamp > localClearedTimestamp) {
            JC.storage.local.remove('canopy', 'jellyfinCanopySettings', 'legacy-settings');
            if (!this.isCurrent()) return;
            JC.storage.local.write('canopy', 'jellyfinCanopyLastCleared', serverClearTimestamp.toString(), 'clear-timestamp');
        }
        if (!this.isCurrent()) return;
        callOptional('injectGlobalStyles');
        if (!this.isCurrent()) return;
        stampLayoutClass();
        if (!this.isCurrent()) return;
        callOptional('addPluginMenuButton');
        if (!this.isCurrent()) return;
        callOptional('applySavedStylesWhenReady');
        if (!this.isCurrent()) return;
        this.installProcessListeners();
    }

    retire(): void {
        if (this.retired) return;
        const ownedSharedSurfaces = this.id === latestActivation;
        this.retired = true;
        for (const cleanup of this.listenerCleanups.splice(0).reverse()) cleanup();
        for (const id of this.observerIds) disconnectObserver(id);
        this.observerIds.clear();
        if (this.actionSheetFrame !== null) cancelAnimationFrame(this.actionSheetFrame);
        this.actionSheetFrame = null;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        this.wasVideoPage = false;
        if (!ownedSharedSurfaces) return;
        if (JC.state) JC.state.removeContext = null;
        try { callOptional('handleLongPressCancel', new Event('identitychange')); } catch { /* best-effort teardown */ }
        try { callOptional('stopAutoSkip'); } catch { /* best-effort teardown */ }
        const panel = document.getElementById('jellyfin-canopy-panel');
        const ownedPanel = panel as unknown as {
            _identityCleanup?: () => void;
            _a11y?: { release(): void };
        } | null;
        if (ownedPanel?._identityCleanup) ownedPanel._identityCleanup();
        else {
            ownedPanel?._a11y?.release();
            panel?.remove();
        }
        document.getElementById('enhancedSettingsBtn')?.remove();
        document.querySelectorAll('[data-speed-overlay="true"]').forEach((node) => node.remove());
    }
}

const fallbackEvents = { keyListener(_event: KeyboardEvent) {}, initialize() {} };
const stableEvents = createStableMethodFacade(fallbackEvents);
let installedActivation: EnhancedEventsActivation | null = null;
let installedDispose: (() => void) | null = null;

/** Publish stable event-shell methods and own one identity activation. */
export function installEnhancedEvents(): () => void {
    const context = JC.identity.capture();
    if (!context) return () => undefined;
    installedDispose?.();
    const activation = new EnhancedEventsActivation(context);
    installedActivation = activation;
    const api = {
        keyListener: (event: KeyboardEvent): void => keyListener(event, activation),
        initialize: (): void => activation.initialize(),
    };
    const uninstall = stableEvents.install(api);
    JC.keyListener = stableEvents.facade.keyListener;
    JC.initializeCanopyScript = stableEvents.facade.initialize;
    const unregisterReset = JC.identity.registerReset('enhanced-events', () => activation.retire());
    let disposed = false;
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        activation.retire();
        unregisterReset();
        uninstall();
        if (installedActivation === activation) installedActivation = null;
        if (installedDispose === dispose) installedDispose = null;
    };
    installedDispose = dispose;
    return dispose;
}

/** Initialize the installed event shell without resolving through the global facade. */
export function initializeInstalledEnhancedEvents(): void {
    installedActivation?.initialize();
}
