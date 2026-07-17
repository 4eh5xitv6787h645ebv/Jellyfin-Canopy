// src/enhanced/settings-panel/panel.ts
//
// Settings/help panel host (JC.showEnhancedPanel): open/close lifecycle,
// settings refresh, dragging, auto-close, tab switching; delegates the
// HTML template and section wiring to the settings-panel/*.ts modules.
// Split from ui.js (code motion; bodies verbatim).
// (Converted from js/enhanced/ui-panel.js — bodies semantically identical.)

import { JC } from '../../globals';
import { installModalA11y } from '../../core/modal-a11y';
import { buildPanelHtml } from './template';
import { wireShortcutEditor } from './shortcut-editor';
import { wireSettingsListeners, wireMiscSettingsControls } from './settings';
import { wireHiddenContentListeners } from './hidden-content-tab';
import { wireSpoilerGuardListeners } from '../spoiler-guard/settings-tab';
import { wireLanguageControls } from './language';
import { resetLanguageControls } from './language';
import { resetReleaseNotes } from './release-notes';
import type { IdentityContext } from '../../types/jc';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Shared context handed to the split panel modules (settings-panel/template.ts and
 * the settings-panel/*.ts wiring files). Assembled in JC.showEnhancedPanel.
 */
export interface PanelContext {
    help: HTMLElement;
    identityContext: IdentityContext;
    registerCleanup: (cleanup: () => void) => void;
    trackTimer: (timer: number) => void;
    pluginShortcuts: any[];
    resetAutoCloseTimer: () => void;
    panelBgColor: string;
    headerFooterBg: string;
    detailsBackground: string;
    primaryAccentColor: string;
    toggleAccentColor: string;
    kbdBackground: string;
    presetBoxBackground: string;
    githubButtonBg: string;
    releaseNotesTextColor: string;
    logoUrl: string;
    brandGradient: string;
    createToast?: (featureKey: string, isEnabled: boolean) => string;
}

// Canopy brand palette (docs/images + the branding kit are the source of truth).
const CANOPY_ACCENT = '#00D4FF';
const CANOPY_ACCENT_FILL = '#2F80FF';
const CANOPY_GRADIENT = 'linear-gradient(135deg, #00D4FF 0%, #2F80FF 52%, #7B4CFF 100%)';
const PANEL_ID = 'jellyfin-canopy-panel';
const BACKDROP_ID = 'jellyfin-canopy-panel-backdrop';

type PanelPhase = 'opening' | 'open' | 'disposed';

interface PanelOwner {
    readonly identityContext: IdentityContext;
    readonly abortController: AbortController;
    phase: PanelPhase;
    root: HTMLElement | null;
    isCurrent(): boolean;
    registerCleanup(cleanup: () => void): void;
    trackTimer(timer: number): void;
    forgetTimer(timer: number): void;
    dispose(): void;
}

let currentPanelOwner: PanelOwner | null = null;
let openingPromise: Promise<void> | null = null;

function createPanelOwner(identityContext: IdentityContext): PanelOwner {
    const cleanups: Array<() => void> = [];
    const timers = new Set<number>();
    const owner: PanelOwner = {
        identityContext,
        abortController: new AbortController(),
        phase: 'opening',
        root: null,
        isCurrent: () => owner.phase !== 'disposed'
            && currentPanelOwner === owner
            && JC.identity.isCurrent(identityContext),
        registerCleanup(cleanup) {
            if (owner.phase === 'disposed') {
                try { cleanup(); } catch (error) {
                    console.warn('🪼 Jellyfin Canopy: Settings panel late cleanup failed:', error);
                }
                return;
            }
            cleanups.push(cleanup);
        },
        trackTimer(timer) {
            if (owner.phase === 'disposed') clearTimeout(timer);
            else timers.add(timer);
        },
        forgetTimer(timer) {
            timers.delete(timer);
        },
        dispose() {
            if (owner.phase === 'disposed') return;
            owner.phase = 'disposed';
            if (currentPanelOwner === owner) currentPanelOwner = null;
            owner.abortController.abort();
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
            for (const cleanup of cleanups.splice(0).reverse()) {
                try { cleanup(); } catch (error) {
                    // One faulty child cleanup must not strand later listeners,
                    // the modal gate, focus restoration, or the exact panel DOM.
                    console.warn('🪼 Jellyfin Canopy: Settings panel cleanup failed:', error);
                }
            }
            owner.root = null;
        },
    };
    return owner;
}

type OwnedPanelElement = HTMLElement & { _identityCleanup?: () => void };

/** Toggle the main settings panel, joining calls made during the same open. */
export function showEnhancedPanel(): Promise<void> {
    if (currentPanelOwner?.phase === 'open') {
        currentPanelOwner.dispose();
        return Promise.resolve();
    }
    if (currentPanelOwner?.phase === 'opening' && openingPromise) return openingPromise;

    // A DOM node from an obsolete bundle cannot be a valid owner. Retire its
    // full stored disposer before any network work; raw removal is defensive
    // only for foreign/stale markup that never acquired resources here.
    const existing: OwnedPanelElement | null = document.getElementById(PANEL_ID);
    if (existing) {
        if (existing._identityCleanup) existing._identityCleanup();
        else existing.remove();
        document.getElementById(BACKDROP_ID)?.remove();
        return Promise.resolve();
    }
    document.getElementById(BACKDROP_ID)?.remove();

    const identityContext = JC.identity.capture();
    if (!identityContext) return Promise.resolve();
    const owner = createPanelOwner(identityContext);
    currentPanelOwner = owner;

    const opening = openPanel(owner).catch((error: unknown) => {
        owner.dispose();
        throw error;
    }).finally(() => {
        if (openingPromise === opening) openingPromise = null;
        // Every early/stale return leaves the reservation in opening state.
        if (owner.phase === 'opening') owner.dispose();
    });
    openingPromise = opening;
    return opening;
}

async function openPanel(owner: PanelOwner): Promise<void> {
    const { identityContext } = owner;
    // Refresh user settings when panel opens to ensure correct user's settings are displayed
    const currentUserId = identityContext.userId;
    if (currentUserId) {
        try {
            // Fetch fresh settings for the current user
            const settingsResponse = JC.core.api?.plugin
                ? await JC.core.api.plugin(
                    `/user-settings/${currentUserId}/settings.json?_=${Date.now()}`,
                    { skipCache: true, signal: owner.abortController.signal }
                )
                : await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/JellyfinCanopy/user-settings/${currentUserId}/settings.json?_=${Date.now()}`),
                    dataType: 'json',
                    signal: owner.abortController.signal
                });
            if (!owner.isCurrent()) return;

            // Update the userConfig with fresh data
            if (settingsResponse) {
                JC.userConfig = JC.userConfig || {};
                JC.userConfig.settings = JC.identity.own(
                    (window.JellyfinCanopy as any).toCamelCase(settingsResponse),
                    identityContext
                );

                // Reload current settings
                if (typeof JC.loadSettings === 'function') {
                    JC.currentSettings = JC.loadSettings();
                }
            }
        } catch (e) {
            if (!owner.isCurrent() || (e as Error)?.name === 'AbortError') return;
            console.warn("🪼 Jellyfin Canopy: Could not refresh settings for panel display:", e);
        }
    }

    if (!owner.isCurrent()) return;

    // Re-initialize shortcuts to ensure they're populated before building the panel
    if (typeof JC.initializeShortcuts === 'function') {
        JC.initializeShortcuts();
    }

    // Get theme-appropriate styles
    const themeVars: any = (JC as any).themer.getThemeVariables();

    // Define theme-aware variables
    const panelBgColor = themeVars.panelBg;
    const headerFooterBg = themeVars.secondaryBg;
    const detailsBackground = themeVars.secondaryBg;
    // Canopy brand identity: the panel is plugin-owned UI, so its ACCENT is the
    // constant Canopy brand (kit palette) — cyan for text/indicator roles on the
    // dark panel, the deeper brand blue for filled controls (white-text
    // contrast), and the signature gradient for the wordmark/active-tab/primary
    // action. Surfaces stay theme-derived so the panel still sits naturally on
    // the user's chosen Jellyfin theme.
    const primaryAccentColor = CANOPY_ACCENT;
    const toggleAccentColor = CANOPY_ACCENT_FILL;
    const kbdBackground = themeVars.altAccent;
    const presetBoxBackground = themeVars.altAccent;
    const panelBlurValue = themeVars.blur;
    const githubButtonBg = `rgba(102, 179, 255, 0.1)`;
    const releaseNotesTextColor = themeVars.textColor;
    const logoUrl = themeVars.logo;

    const help = document.createElement('div');
    help.id = PANEL_ID;
    help.setAttribute('data-jc-identity-owned', 'true');
    JC.identity.own(help, identityContext);
    owner.root = help;
    owner.registerCleanup(() => help.remove());
    Object.assign(help.style, {
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        background: 'rgb(24, 24, 24)',
        color: '#fff',
        padding: '0',
        borderRadius: '16px',
        zIndex: 999999,
        fontSize: '14px',
        backdropFilter: `blur(${panelBlurValue})`,
        width: 'min(1040px, 94vw)',
        height: 'min(720px, 90vh)',
        minWidth: '350px',
        maxWidth: '94vw',
        maxHeight: '90vh',
        boxShadow: '0 10px 30px rgba(0,0,0,0.7)',
        border: '1px solid rgba(255,255,255,0.1)',
        overflow: 'hidden',
        display: 'flex',
        fontFamily: 'inherit',
        flexDirection: 'column'
    });

    const backdrop = document.createElement('div');
    backdrop.id = BACKDROP_ID;
    backdrop.setAttribute('data-jc-identity-owned', 'true');
    backdrop.setAttribute('aria-hidden', 'true');
    JC.identity.own(backdrop, identityContext);
    Object.assign(backdrop.style, {
        position: 'fixed',
        inset: '0',
        zIndex: 999998,
        background: 'rgba(0, 0, 0, 0.45)',
    });
    backdrop.addEventListener('click', () => {
        if (owner.isCurrent()) owner.dispose();
    });
    owner.registerCleanup(() => backdrop.remove());

    const pluginShortcuts = Array.isArray(JC.pluginConfig.Shortcuts) ? JC.pluginConfig.Shortcuts : [];

    // Ensure activeShortcuts is initialized before building the panel
    if (!JC.state!.activeShortcuts || Object.keys(JC.state!.activeShortcuts).length === 0) {
        console.warn('🪼 Jellyfin Canopy: activeShortcuts not initialized, initializing now...');
        if (typeof JC.initializeShortcuts === 'function') {
            JC.initializeShortcuts();
        }
    }

    // --- Draggable Panel Logic ---------
    let isDragging = false;
    let offset = { x: 0, y: 0 };
    let autoCloseTimer: number | null = null;
    let isMouseInside = false;
    let closeHelp: (ev: any) => void = () => undefined;

    // Every descendant listener installed by the split panel modules is
    // authorization-gated at the panel root. This also protects a retained,
    // detached A control that a test/extension dispatches after B becomes live.
    const guardedEvents = [
        'click', 'change', 'input', 'keydown', 'focus', 'blur',
        'mousedown', 'mouseup', 'touchstart', 'touchend'
    ];
    const guardStalePanelEvent = (event: Event) => {
        if (owner.isCurrent()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    guardedEvents.forEach((type) => help.addEventListener(type, guardStalePanelEvent, true));
    // Deliberately do not unregister this root fence during owner disposal. The
    // panel subtree itself is removed, so it is collectible normally; if a host
    // or extension retains an A descendant, however, the capture listener must
    // remain on that detached ancestry and keep its existing child handlers
    // inert after B becomes current.

    const clearAutoCloseTimer = () => {
        if (autoCloseTimer === null) return;
        clearTimeout(autoCloseTimer);
        owner.forgetTimer(autoCloseTimer);
        autoCloseTimer = null;
    };
    owner.registerCleanup(() => {
        clearAutoCloseTimer();
        isDragging = false;
        isMouseInside = false;
        offset = { x: 0, y: 0 };
        help.style.cursor = '';
    });

    const resetAutoCloseTimer = () => {
        if (!owner.isCurrent()) return;
        clearAutoCloseTimer();
        const timer = window.setTimeout(() => {
            owner.forgetTimer(timer);
            if (autoCloseTimer === timer) autoCloseTimer = null;
            if (!isMouseInside && owner.isCurrent()) {
                owner.dispose();
            }
        }, JC.CONFIG!.HELP_PANEL_AUTOCLOSE_DELAY as number);
        autoCloseTimer = timer;
        owner.trackTimer(timer);
    };

    const handleMouseDown = (e: MouseEvent) => {
        if (!owner.isCurrent()) return;
        // Drag only from the header bar: the panes host interactive surfaces
        // (subtitle position grid, selects, sliders) that must own their own
        // pointer gestures — a blanket panel-drag stole them once the old
        // <details> exclusion stopped matching the pane markup.
        if (!(e.target as HTMLElement).closest('.jc-panel-header')) return;
        if ((e.target as HTMLElement).closest('.preset-box, button, a, input, select')) return;
        isDragging = true;
        offset = { x: e.clientX - help.getBoundingClientRect().left, y: e.clientY - help.getBoundingClientRect().top };
        help.style.cursor = 'grabbing';
        e.preventDefault();
        resetAutoCloseTimer();
    };

    const handleMouseMove = (e: MouseEvent) => {
        if (!owner.isCurrent()) return;
        if (isDragging) {
            help.style.left = `${e.clientX - offset.x}px`;
            help.style.top = `${e.clientY - offset.y}px`;
            help.style.transform = 'none';
        }
        resetAutoCloseTimer();
    };

    const handleMouseUp = () => {
        if (!owner.isCurrent()) return;
        isDragging = false;
        help.style.cursor = 'grab';
        resetAutoCloseTimer();
    };

    help.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    owner.registerCleanup(() => document.removeEventListener('mousemove', handleMouseMove));
    document.addEventListener('mouseup', handleMouseUp);
    owner.registerCleanup(() => document.removeEventListener('mouseup', handleMouseUp));
    // Reset the auto-close timer when the mouse enters or leaves the panel.
    help.addEventListener('mouseenter', () => { isMouseInside = true; clearAutoCloseTimer(); });
    help.addEventListener('mouseleave', () => { isMouseInside = false; resetAutoCloseTimer(); });
    help.addEventListener('click', resetAutoCloseTimer);
    help.addEventListener('wheel', (e) => { e.stopPropagation(); resetAutoCloseTimer(); });

    // Shared context handed to the split panel modules
    // (settings-panel/template.ts and the settings-panel/*.ts wiring files).
    const ctx: PanelContext = {
        help,
        identityContext,
        registerCleanup: (cleanup) => owner.registerCleanup(cleanup),
        trackTimer: (timer) => owner.trackTimer(timer),
        pluginShortcuts,
        resetAutoCloseTimer,
        panelBgColor,
        headerFooterBg,
        detailsBackground,
        primaryAccentColor,
        toggleAccentColor,
        kbdBackground,
        presetBoxBackground,
        githubButtonBg,
        releaseNotesTextColor,
        logoUrl,
        brandGradient: CANOPY_GRADIENT
    };

    help.innerHTML = buildPanelHtml(ctx);

    document.body.append(backdrop, help);

    wireShortcutEditor(ctx);
    resetAutoCloseTimer();

    // --- Section navigation (adaptive settings view) ---
    // The nav rail is built FROM the panes, so nav and content can never
    // drift: every .jc-pane's title becomes a nav item (icon included).
    // Missing markup (as in the headless unit-test template stub) no-ops.
    (function buildSectionNav() {
        const navHost = help.querySelector<HTMLElement>('.jc-panel-nav-items');
        const body = help.querySelector<HTMLElement>('.jc-panel-body');
        const panes = Array.from(help.querySelectorAll<HTMLElement>('.jc-pane'));
        if (!navHost || !body || panes.length === 0) return;

        const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const items: HTMLButtonElement[] = [];

        // Phone-mode focus ownership: the list and the detail pane are stacked
        // layers, so exactly one of them may own focus at a time. `inert`
        // removes the hidden layer from the tab order and the a11y tree;
        // desktop shows both columns side by side, so neither is inert there.
        const navColumn = help.querySelector<HTMLElement>('.jc-panel-nav');
        const mainColumn = help.querySelector<HTMLElement>('.jc-panel-main');
        const phoneMedia = window.matchMedia('(max-width: 760px)');
        const syncLayerFocus = (moveFocus: boolean) => {
            if (!navColumn || !mainColumn) return;
            if (phoneMedia.matches) {
                const detailOpen = body.classList.contains('jc-pane-open');
                navColumn.inert = detailOpen;
                mainColumn.inert = !detailOpen;
                if (moveFocus) {
                    const target = detailOpen
                        ? help.querySelector<HTMLElement>('#jcPanelBack')
                        : (items.find(b => b.classList.contains('active')) || items[0]);
                    target?.focus();
                }
            } else {
                navColumn.inert = false;
                mainColumn.inert = false;
            }
        };
        const handlePhoneMediaChange = () => syncLayerFocus(false);
        phoneMedia.addEventListener('change', handlePhoneMediaChange);
        owner.registerCleanup(() => phoneMedia.removeEventListener('change', handlePhoneMediaChange));

        const activate = (pane: HTMLElement, persist: boolean) => {
            panes.forEach(p => p.classList.toggle('active', p === pane));
            items.forEach(b => b.classList.toggle('active', b.dataset.tab === pane.dataset.pane));
            body.classList.add('jc-pane-open');
            syncLayerFocus(persist);
            if (persist) {
                (JC.currentSettings as any).lastOpenedTab = pane.dataset.pane;
                void JC.saveUserSettings!('settings.json', JC.currentSettings).catch(() => undefined);
            }
            resetAutoCloseTimer();
        };

        panes.forEach((pane, index) => {
            const title = pane.querySelector<HTMLElement>('.jc-pane-title');
            const label = (pane.dataset.paneLabel || title?.textContent || '').trim();
            if (!pane.dataset.pane) pane.dataset.pane = slug(label) || `pane-${index}`;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'tab-button';
            button.dataset.tab = pane.dataset.pane;
            // Title markup is template-authored (same document, already rendered),
            // duplicated verbatim so the nav item carries the pane heading's icon;
            // the fallback label is plain text.
            if (title) {
                button.innerHTML = title.innerHTML;
            } else {
                button.textContent = label;
            }
            button.addEventListener('click', () => activate(pane, true));
            navHost.appendChild(button);
            items.push(button);
        });

        // Mobile back button returns to the section list.
        help.querySelector('#jcPanelBack')?.addEventListener('click', () => {
            body.classList.remove('jc-pane-open');
            syncLayerFocus(true);
            resetAutoCloseTimer();
        });

        // Search filters the section list by each pane's full text.
        const search = help.querySelector<HTMLInputElement>('#jcPanelSearch');
        search?.addEventListener('input', () => {
            const query = search.value.trim().toLowerCase();
            items.forEach((button) => {
                const pane = panes.find(p => p.dataset.pane === button.dataset.tab);
                const hit = !query || !!pane && (pane.textContent || '').toLowerCase().includes(query);
                button.style.display = hit ? '' : 'none';
            });
            resetAutoCloseTimer();
        });

        // Initial view: desktop restores the last-open section; a phone-sized
        // viewport starts on the section list (nothing pre-opened).
        const lastTab = (JC.currentSettings as any).lastOpenedTab;
        const initial = panes.find(p => p.dataset.pane === lastTab) || panes[0];
        if (phoneMedia.matches) {
            panes.forEach(p => p.classList.remove('active'));
            syncLayerFocus(false);
        } else {
            activate(initial, false);
        }
    })();

    // Autoscroll when details sections open
    const allDetails = help.querySelectorAll('details');
    allDetails.forEach((details, index) => {
        details.addEventListener('toggle', () => {
            if (details.open) {
                const timer = window.setTimeout(() => {
                    owner.forgetTimer(timer);
                    if (!owner.isCurrent()) return;
                    details.scrollIntoView({ behavior: 'smooth', block: index === 0 ? 'center' : 'nearest' });
                }, 150);
                owner.trackTimer(timer);
            }
            resetAutoCloseTimer();
        });
    });

    // --- Event Handlers for Settings Panel ---
    closeHelp = (ev: any) => {
        if ((ev.type === 'keydown' && (ev.key === 'Escape' || ev.key === '?')) || (ev.type === 'click' && ev.target.id === 'closeSettingsPanel')) {
            // modal-a11y's Escape path invokes this with a synthetic
            // `{ type, key }` object (not a DOM event), so stopPropagation may be
            // absent — guard it. Calling it unconditionally threw a TypeError
            // here, aborting the close so Escape never dismissed the panel.
            ev.stopPropagation?.();
            owner.dispose();
        }
    };

    const createToast = (featureKey: string, isEnabled: boolean) => {
        const feature = JC.t!(featureKey);
        const status = JC.t!(isEnabled ? 'status_enabled' : 'status_disabled');
        return JC.t!('toast_feature_status', { feature, status });
    };
    document.addEventListener('keydown', closeHelp);
    owner.registerCleanup(() => document.removeEventListener('keydown', closeHelp));
    help.querySelector<HTMLElement>('#closeSettingsPanel')!.addEventListener('click', closeHelp);

    // Make the panel an accessible modal dialog: dialog role, focus trap +
    // restore, and the jc-modal-open gate that suppresses JC.keyListener while
    // it is open (INT-1) — replacing the former manual remove/re-add dance.
    const a11y = installModalA11y(help, {
        label: JC.t!('panel_settings_tab'),
        onEscape: () => closeHelp({ type: 'keydown', key: 'Escape' }),
    });
    owner.registerCleanup(() => a11y.release());
    // DOM consumers retain only the exact owner's full idempotent disposer;
    // there is no partial a11y-only close path.
    (help as OwnedPanelElement)._identityCleanup = () => owner.dispose();
    ctx.createToast = createToast;

    wireSettingsListeners(ctx);
    wireHiddenContentListeners(ctx);
    wireSpoilerGuardListeners(ctx.resetAutoCloseTimer);
    wireMiscSettingsControls(ctx);
    wireLanguageControls(ctx);
    if (!owner.isCurrent()) return;
    owner.phase = 'open';
}

export function resetSettingsPanel(): void {
    currentPanelOwner?.dispose();
    const panel: OwnedPanelElement | null = document.getElementById(PANEL_ID);
    if (panel?._identityCleanup) panel._identityCleanup();
    else panel?.remove();
    document.getElementById(BACKDROP_ID)?.remove();
    resetReleaseNotes();
    resetLanguageControls();
}
