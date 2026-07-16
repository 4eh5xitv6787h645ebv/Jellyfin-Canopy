// src/enhanced/settings-panel/entry-points.ts
//
// Page-location helpers and the panel entry points: sidebar menu button,
// video-OSD settings button and the user-preferences menu link.
// Split from ui.js (code motion; bodies verbatim).
// (Converted from js/enhanced/ui-entry-points.js — bodies semantically identical.)

import { JC } from '../../globals';
import { createStableMethodFacade } from '../../core/feature-loader';
import { onBodyMutation } from '../../core/dom-observer';
import { onNavigate, onViewPage } from '../../core/navigation';
import { queryElementsById, resolveCurrentViewRoot } from '../../core/view-root';
import { getSidebarContainer } from '../helpers';
import { ensureCanopySection, insertSectionEntry } from '../pages/entry-points';
import { injectGlobalStyles, resetGlobalStyles } from './styles';

let menuButtonHandle: { disconnect(): void } | null = null;
let prefsLinkNavCleanups: Array<() => void> = [];
let panelModule: typeof import('./panel') | null = null;
let panelPromise: Promise<typeof import('./panel')> | null = null;
let launcherGeneration = 0;

/**
 * Helper function to determine if the current page is the video player.
 * @returns {boolean} True if the current page is the video player.
 */
export const isVideoPage = (): boolean => window.location.hash.startsWith('#/video');

/**
 * Helper function to determine if the current page is an item details page.
 * @returns {boolean} True if on an item details page.
 */
export const isDetailsPage = (): boolean => window.location.hash.includes('/details?id=');

// JC.toast moved to js/core/ui-kit.js (JC.core.ui.toast); the JC.toast
// alias is assigned there. Callers are unchanged.

/**
 * Adds the "Jellyfin Canopy" menu button to the sidebar.
 */
export function addPluginMenuButton(): void {
    const addMenuButton = (sidebar: HTMLElement) => {
        // pages/entry-points.ts is the single owner of the drawer section;
        // the panel link registers through it, pinned after the page entries.
        const jellyfinCanopySection = ensureCanopySection(sidebar);

        if (!jellyfinCanopySection.querySelector('#jellyfinCanopySettingsLink')) {
            const jellyfinCanopyLink = document.createElement('a');
            jellyfinCanopyLink.setAttribute('is', 'emby-linkbutton');
            jellyfinCanopyLink.className = 'lnkMediaFolder navMenuOption emby-button';
            jellyfinCanopyLink.href = '#';
            jellyfinCanopyLink.id = 'jellyfinCanopySettingsLink';
            jellyfinCanopyLink.innerHTML = `
                    <span class="material-icons navMenuOptionIcon" aria-hidden="true">tune</span>
                    <span class="sectionName navMenuOptionText">Enhanced Panel</span>
                `;

            jellyfinCanopyLink.addEventListener('click', (e) => {
                e.preventDefault();
                void JC.showEnhancedPanel!();
            });

            insertSectionEntry(jellyfinCanopySection, jellyfinCanopyLink, true);
        }
    };

    const ensureMenuButton = (): void => {
        // getSidebarContainer() falls back to the new MUI drawer (mobile only)
        // when the legacy sidebar is hidden under Jellyfin 12's experimental
        // layout. Every other module that looks for `.jellyfinCanopySection`
        // queries it unscoped, so creating it here - wherever it ends up - is
        // the only choke point that needs to know about the new drawer.
        const sidebar = getSidebarContainer();
        if (sidebar && !sidebar.querySelector('#jellyfinCanopySettingsLink')) {
            addMenuButton(sidebar);
        }
    };
    ensureMenuButton();
    if (!menuButtonHandle) {
        menuButtonHandle = onBodyMutation('ui-menu-button', ensureMenuButton);
    }
}

/**
 * Injects the "Jellyfin Canopy" settings button into the video player OSD.
 */
export function addOsdSettingsButton(): void {
    if (document.getElementById('enhancedSettingsBtn')) return;
    const controlsContainer = document.querySelector('.videoOsdBottom .buttons.focuscontainer-x');
    if (!controlsContainer) return;
    const nativeSettingsButton = controlsContainer.querySelector('.btnVideoOsdSettings');
    if (!nativeSettingsButton) return;

    const enhancedSettingsBtn = document.createElement('button');
    enhancedSettingsBtn.id = 'enhancedSettingsBtn';
    enhancedSettingsBtn.setAttribute('is', 'paper-icon-button-light');
    enhancedSettingsBtn.className = 'autoSize paper-icon-button-light';
    enhancedSettingsBtn.title = 'Jellyfin Canopy';
    enhancedSettingsBtn.innerHTML = '<span class="largePaperIconButton material-icons" aria-hidden="true">tune</span>';

    enhancedSettingsBtn.onclick = (e) => {
        e.stopPropagation();
        void JC.showEnhancedPanel!();
    };

    nativeSettingsButton.parentElement!.insertBefore(enhancedSettingsBtn, nativeSettingsButton);
}

// One-time guard for the navigation-driven retry hooks below (see
// JC.addUserPreferencesLink).
let prefsLinkNavHooksWired = false;

/**
 * Adds the preferences-menu link when the preferences page is visible.
 * Cheap non-layout probes (getElementById + classList) make this safe to call
 * on every structural mutation batch and navigation event.
 * @returns True when the link exists (or was just added).
 */
function addPrefsLinkIfOnPage(): boolean {
    const current = resolveCurrentViewRoot('myPreferencesMenuPage');
    if (!current) return false;
    const page = current.root;

    const menuContainer = page.querySelector('.verticalSection');
    if (!menuContainer) return false;

    // Cached native views can retain the same page/link ids. Ownership follows
    // the current view root: remove stale/duplicate copies, then gate only on a
    // link inside this root.
    const links = queryElementsById('jellyfinCanopyUserPrefsLink');
    let currentLink: HTMLElement | null = null;
    for (const link of links) {
        if (page.contains(link) && !currentLink) currentLink = link;
        else link.remove();
    }
    if (currentLink) return true;

    // Create the link element matching Jellyfin's structure
    const enhancedLink = document.createElement('a');
    enhancedLink.id = 'jellyfinCanopyUserPrefsLink';
    enhancedLink.setAttribute('is', 'emby-linkbutton');
    enhancedLink.setAttribute('data-ripple', 'false');
    enhancedLink.href = '#';
    enhancedLink.className = 'listItem-border emby-button';
    enhancedLink.style.display = 'block';
    enhancedLink.style.padding = '0';
    enhancedLink.style.margin = '0';

    enhancedLink.innerHTML = `
            <div class="listItem">
                <span class="material-icons listItemIcon listItemIcon-transparent tune" aria-hidden="true"></span>
                <div class="listItemBody">
                    <div class="listItemBodyText">Advanced Settings (Jellyfin Canopy)</div>
                </div>
            </div>
        `;

    enhancedLink.addEventListener('click', (e) => {
        e.preventDefault();
        void JC.showEnhancedPanel!();
    });

    // Insert at the end of the first vertical section
    menuContainer.appendChild(enhancedLink);
    return true;
}

/**
 * Injects the "Jellyfin Canopy" link into the user preferences menu (mypreferencesmenu.html).
 * Adds it as the last item in the first vertical section (after Controls).
 */
export function addUserPreferencesLink(): void {
    // PERF(R3): retries are driven by the shared navigation/viewshow events (plus
    // the shared body observer tick in events.ts) instead of creating a new
    // body-wide attribute MutationObserver per call — the old pattern leaked
    // one observer per call whenever this ran off the preferences page.
    if (!prefsLinkNavHooksWired) {
        prefsLinkNavHooksWired = true;
        // viewshow covers cached legacy pages re-shown via a class flip only
        // (no structural mutation for the body observer to see); onNavigate
        // covers the modern router where viewshow never fires.
        prefsLinkNavCleanups = [
            onNavigate(() => { addPrefsLinkIfOnPage(); }),
            onViewPage(() => { addPrefsLinkIfOnPage(); }),
        ];
    }

    addPrefsLinkIfOnPage();
}

async function loadPanel(): Promise<typeof import('./panel')> {
    if (panelModule) return panelModule;
    panelPromise ??= import('./panel').then((module) => {
        panelModule = module;
        return module;
    }).catch((error: unknown) => {
        panelPromise = null;
        throw error;
    });
    return panelPromise;
}

/** Load the large settings panel graph only after an explicit user gesture. */
export async function openEnhancedPanel(): Promise<void> {
    const context = JC.identity.capture();
    if (!context) return;
    const generation = launcherGeneration;
    try {
        const module = await loadPanel();
        if (generation !== launcherGeneration || !JC.identity.isCurrent(context)) return;
        await module.showEnhancedPanel();
    } catch (error) {
        if (generation === launcherGeneration && JC.identity.isCurrent(context)) {
            console.warn('🪼 Jellyfin Canopy: Could not load the Enhanced Panel:', error);
        }
    }
}

export function resetSettingsLauncher(): void {
    launcherGeneration += 1;
    menuButtonHandle?.disconnect();
    menuButtonHandle = null;
    prefsLinkNavCleanups.forEach((cleanup) => cleanup());
    prefsLinkNavCleanups = [];
    prefsLinkNavHooksWired = false;
    panelModule?.resetSettingsPanel();
    document.getElementById('jellyfinCanopySettingsLink')?.remove();
    document.getElementById('jellyfinCanopyUserPrefsLink')?.remove();
    document.getElementById('enhancedSettingsBtn')?.remove();
    resetGlobalStyles();
}

const settingsLauncherApi = {
    addMenu: addPluginMenuButton,
    addOsd: addOsdSettingsButton,
    addPreferences: addUserPreferencesLink,
    detailsPage: isDetailsPage,
    injectStyles: injectGlobalStyles,
    show: openEnhancedPanel,
    videoPage: isVideoPage,
};
const stableSettingsLauncher = createStableMethodFacade<typeof settingsLauncherApi>({
    addMenu() {},
    addOsd() {},
    addPreferences() {},
    detailsPage: () => false,
    injectStyles() {},
    show: () => Promise.resolve(),
    videoPage: () => false,
});

/** Publish the lightweight panel launcher for one loader-owned activation. */
export function installSettingsLauncher(): () => void {
    const uninstall = stableSettingsLauncher.install(settingsLauncherApi);
    JC.addPluginMenuButton = stableSettingsLauncher.facade.addMenu;
    JC.addOsdSettingsButton = stableSettingsLauncher.facade.addOsd;
    JC.addUserPreferencesLink = stableSettingsLauncher.facade.addPreferences;
    JC.injectGlobalStyles = stableSettingsLauncher.facade.injectStyles;
    JC.isDetailsPage = stableSettingsLauncher.facade.detailsPage;
    JC.isVideoPage = stableSettingsLauncher.facade.videoPage;
    JC.showEnhancedPanel = stableSettingsLauncher.facade.show;
    const unregisterReset = JC.identity.registerReset('settings-launcher', resetSettingsLauncher);
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        resetSettingsLauncher();
        unregisterReset();
        uninstall();
    };
}
