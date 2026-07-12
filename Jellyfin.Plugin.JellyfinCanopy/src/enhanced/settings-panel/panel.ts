// src/enhanced/settings-panel/panel.ts
//
// Settings/help panel host (JC.showEnhancedPanel): open/close lifecycle,
// settings refresh, dragging, auto-close, tab switching; delegates the
// HTML template and section wiring to the settings-panel/*.ts modules.
// Split from ui.js (code motion; bodies verbatim).
// (Converted from js/enhanced/ui-panel.js — bodies semantically identical.)

import { JC } from '../../globals';
import { installModalA11y, type ModalA11yHandle } from '../../core/modal-a11y';
import { buildPanelHtml } from './template';
import { wireShortcutEditor } from './shortcut-editor';
import { wireSettingsListeners, wireMiscSettingsControls } from './settings';
import { wireHiddenContentListeners } from './hidden-content-tab';
import { wireSpoilerGuardListeners } from '../spoiler-guard/settings-tab';
import { wireLanguageControls } from './language';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Shared context handed to the split panel modules (settings-panel/template.ts and
 * the settings-panel/*.ts wiring files). Assembled in JC.showEnhancedPanel.
 */
export interface PanelContext {
    help: HTMLElement;
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
    releaseNotesBg: string;
    checkUpdatesBorder: string;
    releaseNotesTextColor: string;
    logoUrl: string;
    createToast?: (featureKey: string, isEnabled: boolean) => string;
}

/**
 * Toggles the main settings and help panel for the plugin.
 */
JC.showEnhancedPanel = async () => {
    // Refresh user settings when panel opens to ensure correct user's settings are displayed
    const currentUserId = ApiClient.getCurrentUserId();
    if (currentUserId) {
        try {
            // Fetch fresh settings for the current user
            const settingsResponse = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinCanopy/user-settings/${currentUserId}/settings.json?_=${Date.now()}`),
                dataType: 'json'
            });

            // Update the userConfig with fresh data
            if (settingsResponse) {
                JC.userConfig = JC.userConfig || {};
                JC.userConfig.settings = (window.JellyfinCanopy as any).toCamelCase(settingsResponse);

                // Reload current settings
                if (typeof JC.loadSettings === 'function') {
                    JC.currentSettings = JC.loadSettings();
                }
            }
        } catch (e) {
            console.warn("🪼 Jellyfin Canopy: Could not refresh settings for panel display:", e);
        }
    }

    // Re-initialize shortcuts to ensure they're populated before building the panel
    if (typeof JC.initializeShortcuts === 'function') {
        JC.initializeShortcuts();
    }

    const panelId = 'jellyfin-canopy-panel';
    const existing = document.getElementById(panelId);
    if (existing) {
        // Toggle-close: release the modal-a11y handle BEFORE removal so the
        // jc-modal-open gate drops, focus is restored and the capture-phase
        // keydown listener is torn down — otherwise all JC shortcuts stay
        // suppressed for the rest of the session (the normal close paths below
        // already release; this early-return branch used to skip it).
        (existing as unknown as { _a11y?: ModalA11yHandle })._a11y?.release();
        existing.remove();
        return;
    }
    // Get theme-appropriate styles
    const themeVars: any = (JC as any).themer.getThemeVariables();

    // Define theme-aware variables
    const panelBgColor = themeVars.panelBg;
    const headerFooterBg = themeVars.secondaryBg;
    const detailsBackground = themeVars.secondaryBg;
    const primaryAccentColor = themeVars.primaryAccent;
    const toggleAccentColor = primaryAccentColor;
    const kbdBackground = themeVars.altAccent;
    const presetBoxBackground = themeVars.altAccent;
    const panelBlurValue = themeVars.blur;
    const githubButtonBg = `rgba(102, 179, 255, 0.1)`;
    const releaseNotesBg = primaryAccentColor;
    const checkUpdatesBorder = `1px solid ${primaryAccentColor}`;
    const releaseNotesTextColor = themeVars.textColor;
    const logoUrl = themeVars.logo;

    const help = document.createElement('div');
    help.id = panelId;
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
        minWidth: '350px',
        maxWidth: '90vw',
        maxHeight: '90vh',
        boxShadow: '0 10px 30px rgba(0,0,0,0.7)',
        border: '1px solid rgba(255,255,255,0.1)',
        overflow: 'hidden',
        cursor: 'grab',
        display: 'flex',
        fontFamily: 'inherit',
        flexDirection: 'column'
    });

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
    let a11y: ModalA11yHandle | null = null;

    const resetAutoCloseTimer = () => {
        if (autoCloseTimer) clearTimeout(autoCloseTimer);
        autoCloseTimer = window.setTimeout(() => {
            if (!isMouseInside && document.getElementById(panelId)) {
                help.remove();
                document.removeEventListener('keydown', closeHelp);
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
                // release() restores focus and drops the jc-modal-open gate that
                // suppresses JC.keyListener — no manual re-add of the listener.
                a11y?.release();
                a11y = null;
            }
        }, JC.CONFIG!.HELP_PANEL_AUTOCLOSE_DELAY as number);
    };

    const handleMouseDown = (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('.preset-box, button, a, details, input')) return;
        isDragging = true;
        offset = { x: e.clientX - help.getBoundingClientRect().left, y: e.clientY - help.getBoundingClientRect().top };
        help.style.cursor = 'grabbing';
        e.preventDefault();
        resetAutoCloseTimer();
    };

    const handleMouseMove = (e: MouseEvent) => {
        if (isDragging) {
            help.style.left = `${e.clientX - offset.x}px`;
            help.style.top = `${e.clientY - offset.y}px`;
            help.style.transform = 'none';
        }
        resetAutoCloseTimer();
    };

    const handleMouseUp = () => {
        isDragging = false;
        help.style.cursor = 'grab';
        resetAutoCloseTimer();
    };

    help.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    // Reset the auto-close timer when the mouse enters or leaves the panel.
    help.addEventListener('mouseenter', () => { isMouseInside = true; if (autoCloseTimer) clearTimeout(autoCloseTimer); });
    help.addEventListener('mouseleave', () => { isMouseInside = false; resetAutoCloseTimer(); });
    help.addEventListener('click', resetAutoCloseTimer);
    help.addEventListener('wheel', (e) => { e.stopPropagation(); resetAutoCloseTimer(); });

    // Shared context handed to the split panel modules
    // (settings-panel/template.ts and the settings-panel/*.ts wiring files).
    const ctx: PanelContext = {
        help,
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
        releaseNotesBg,
        checkUpdatesBorder,
        releaseNotesTextColor,
        logoUrl
    };

    help.innerHTML = buildPanelHtml(ctx);

    document.body.appendChild(help);

    wireShortcutEditor(ctx);
    resetAutoCloseTimer();

    // --- Tab Logic ---
    const tabButtons = help.querySelectorAll<HTMLElement>('.tab-button');
    const tabContents = help.querySelectorAll<HTMLElement>('.tab-content');
    const tabsContainer = help.querySelector<HTMLElement>('.tabs');

    if (JC.pluginConfig.DisableAllShortcuts) {
        // If shortcuts are disabled, hide the tab bar and show settings directly.
        if (tabsContainer) {
            tabsContainer.style.display = 'none';
        }
        const settingsContent = help.querySelector('#settings-content');
        if (settingsContent) {
            settingsContent.classList.add('active');
        }
    } else {
        // --- Remember last opened tab ---
        const lastTab = (JC.currentSettings as any).lastOpenedTab || 'shortcuts';
        tabButtons.forEach(btn => btn.classList.remove('active'));
        tabContents.forEach(content => content.classList.remove('active'));
        const activeTabButton = help.querySelector(`.tab-button[data-tab="${lastTab}"]`);
        if(activeTabButton) activeTabButton.classList.add('active');
        const activeTabContent = help.querySelector(`#${lastTab}-content`);
        if(activeTabContent) activeTabContent.classList.add('active');

        tabButtons.forEach(button => {
            button.addEventListener('click', () => {
                const tab = button.dataset.tab;
                tabButtons.forEach(btn => btn.classList.remove('active'));
                button.classList.add('active');
                tabContents.forEach(content => {
                    content.classList.remove('active');
                    if (content.id === `${tab}-content`) {
                        content.classList.add('active');
                    }
                });
                (JC.currentSettings as any).lastOpenedTab = tab;
                void JC.saveUserSettings!('settings.json', JC.currentSettings);
                resetAutoCloseTimer();
            });
        });
    }

    // Autoscroll when details sections open
    const allDetails = help.querySelectorAll('details');
    allDetails.forEach((details, index) => {
        details.addEventListener('toggle', () => {
            if (details.open) {
                setTimeout(() => {
                    details.scrollIntoView({ behavior: 'smooth', block: index === 0 ? 'center' : 'nearest' });
                }, 150);
            }
            resetAutoCloseTimer();
        });
    });

    // --- Event Handlers for Settings Panel ---
    const closeHelp = (ev: any) => {
        if ((ev.type === 'keydown' && (ev.key === 'Escape' || ev.key === '?')) || (ev.type === 'click' && ev.target.id === 'closeSettingsPanel')) {
            // modal-a11y's Escape path invokes this with a synthetic
            // `{ type, key }` object (not a DOM event), so stopPropagation may be
            // absent — guard it. Calling it unconditionally threw a TypeError
            // here, aborting the close so Escape never dismissed the panel.
            ev.stopPropagation?.();
            if (autoCloseTimer) clearTimeout(autoCloseTimer);
            help.remove();
            document.removeEventListener('keydown', closeHelp);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            a11y?.release();
            a11y = null;
        }
    };

    const createToast = (featureKey: string, isEnabled: boolean) => {
        const feature = JC.t!(featureKey);
        const status = JC.t!(isEnabled ? 'status_enabled' : 'status_disabled');
        return JC.t!('toast_feature_status', { feature, status });
    };
    document.addEventListener('keydown', closeHelp);
    document.getElementById('closeSettingsPanel')!.addEventListener('click', closeHelp);

    // Make the panel an accessible modal dialog: dialog role, focus trap +
    // restore, and the jc-modal-open gate that suppresses JC.keyListener while
    // it is open (INT-1) — replacing the former manual remove/re-add dance.
    a11y = installModalA11y(help, {
        label: JC.t!('panel_settings_tab'),
        onEscape: () => closeHelp({ type: 'keydown', key: 'Escape' }),
    });
    // Stash the handle on the panel element so the toggle-close early-return
    // branch (top of this function) can release it without re-entering this
    // closure. The close paths that DO reach this closure use `a11y` directly.
    (help as unknown as { _a11y?: ModalA11yHandle })._a11y = a11y;
    ctx.createToast = createToast;

    wireSettingsListeners(ctx);
    wireHiddenContentListeners(ctx);
    wireSpoilerGuardListeners(ctx.resetAutoCloseTimer);
    wireMiscSettingsControls(ctx);
    wireLanguageControls(ctx);
};
