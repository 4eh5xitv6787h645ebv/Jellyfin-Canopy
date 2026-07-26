// src/enhanced/settings-panel/entry-points.ts
//
// Page-location helpers and the panel entry points: sidebar menu button,
// video-OSD settings button and the user-preferences menu link.
// Split from ui.js (code motion; bodies verbatim).
// (Converted from js/enhanced/ui-entry-points.js — bodies semantically identical.)

import { JC } from '../../globals';
import { createStableMethodFacade } from '../../core/feature-loader';
import { onBodyMutation } from '../../core/dom-observer';
import {
    onNavigate,
    onViewBeforeShow,
    onViewPage,
} from '../../core/navigation';
import {
    queryElementsById,
    resolveCurrentViewRoot,
} from '../../core/view-root';
import { getSidebarContainer } from '../helpers';
import { ensureCanopySection, insertSectionEntry } from '../pages/entry-points';
import type { SettingsPanelLaunchContext } from './launch-context';
import { injectGlobalStyles, resetGlobalStyles } from './styles';

let menuButtonHandle: { disconnect(): void } | null = null;
let prefsLinkNavCleanups: Array<() => void> = [];
let panelModule: typeof import('./panel') | null = null;
let panelPromise: Promise<typeof import('./panel')> | null = null;
let launcherGeneration = 0;

function retirePanel(): void {
    launcherGeneration++;
    panelModule?.resetSettingsPanel();
}

/**
 * Helper function to determine if the current page is the video player.
 * @returns {boolean} True if the current page is the video player.
 */
export const isVideoPage = (): boolean => location.hash.indexOf('#/video') === 0;

/**
 * Helper function to determine if the current page is an item details page.
 * @returns {boolean} True if on an item details page.
 */
export const isDetailsPage = (): boolean => location.hash.indexOf('/details?id=') >= 0;

// JC.toast moved to js/core/ui-kit.js (JC.core.ui.toast); the JC.toast
// alias is assigned there. Callers are unchanged.

/**
 * Adds the "Jellyfin Canopy" menu button to the sidebar.
 */
export function addPluginMenuButton(): void {
    const ensureMenuButton = (): void => {
        const sidebar = getSidebarContainer();
        if (!sidebar) return;
        // pages/entry-points.ts is the single owner of the drawer section;
        // the panel link registers through it, pinned after the page entries.
        const jellyfinCanopySection = ensureCanopySection(sidebar);
        if (jellyfinCanopySection.querySelector('#jellyfinCanopySettingsLink')) return;
        const jellyfinCanopyLink = document.createElement('a');
        jellyfinCanopyLink.setAttribute('is', 'emby-linkbutton');
        jellyfinCanopyLink.className = 'lnkMediaFolder navMenuOption emby-button';
        jellyfinCanopyLink.href = '#';
        jellyfinCanopyLink.id = 'jellyfinCanopySettingsLink';
        jellyfinCanopyLink.innerHTML = `
                    <span class="material-icons navMenuOptionIcon" aria-hidden="true">tune</span>
                    <span class="sectionName navMenuOptionText">Canopy User Settings</span>
                `;
        jellyfinCanopyLink.addEventListener('click', (e) => {
            e.preventDefault();
            void JC.showEnhancedPanel!();
        });
        insertSectionEntry(jellyfinCanopySection, jellyfinCanopyLink, true);
    };
    ensureMenuButton();
    menuButtonHandle ??= onBodyMutation('ui-menu-button', ensureMenuButton);
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
    enhancedSettingsBtn.title = 'Canopy User Settings';
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
 * @returns True when the current preferences root owns or awaits the link.
 */
function addPrefsLinkIfOnPage(): boolean {
    const current = resolveCurrentViewRoot('myPreferencesMenuPage');
    if (!current) return false;
    const page = current.root;

    const menuContainer = page.querySelector('.verticalSection');
    if (!menuContainer) return true;

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
    enhancedLink.dataset.ripple = 'false';
    enhancedLink.href = '#';
    enhancedLink.className = 'listItem-border emby-button';
    enhancedLink.style.cssText = 'display:block;padding:0;margin:0';

    enhancedLink.innerHTML = `
            <div class="listItem">
                <span class="material-icons listItemIcon listItemIcon-transparent tune" aria-hidden="true"></span>
                <div class="listItemBody">
                    <div class="listItemBodyText">Canopy User Settings</div>
                </div>
            </div>
        `;

    enhancedLink.addEventListener('click', (e) => {
        e.preventDefault();
        void openEnhancedPanel(page);
    });

    // Insert at the end of the first vertical section
    menuContainer.appendChild(enhancedLink);
    return true;
}

function reconcilePreferencesView(): void {
    // A same-URL replacement of the native preferences root invalidates the
    // click-time target/view lease even when Jellyfin emits no history event.
    // An unrelated late Home lifecycle returns false and cannot cancel an
    // immediate panel open while its lazy chunk is still loading.
    if (addPrefsLinkIfOnPage()) retirePanel();
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
            onNavigate(addPrefsLinkIfOnPage),
            onViewPage(reconcilePreferencesView),
            onViewBeforeShow(reconcilePreferencesView),
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
export async function openEnhancedPanel(
    preferencesRoot?: HTMLElement,
): Promise<void> {
    const context = JC.identity.capture();
    if (!context) return;
    if (preferencesRoot
        && resolveCurrentViewRoot('myPreferencesMenuPage')?.root !== preferencesRoot) return;
    const launchContext: SettingsPanelLaunchContext | null = preferencesRoot
        ? {
            actor: context,
            url: location.href,
        }
        : null;
    const generation = launcherGeneration;
    try {
        const module = await loadPanel();
        if (generation !== launcherGeneration || !JC.identity.isCurrent(context)) return;
        await module.showEnhancedPanel(launchContext);
    } catch (error) {
        if (generation === launcherGeneration && JC.identity.isCurrent(context)) {
            console.warn(error);
        }
    }
}

export function resetSettingsLauncher(): void {
    retirePanel();
    menuButtonHandle?.disconnect();
    menuButtonHandle = null;
    prefsLinkNavCleanups.forEach((cleanup) => cleanup());
    prefsLinkNavCleanups = [];
    prefsLinkNavHooksWired = false;
    document.getElementById('jellyfinCanopySettingsLink')?.remove();
    queryElementsById('jellyfinCanopyUserPrefsLink').forEach((link) => link.remove());
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
    // A settings panel belongs to the exact page on which the user opened it.
    // Retire both a pending dynamic import/settings refresh and an active panel
    // on same-identity SPA navigation. This subscription is activation-owned,
    // so importing the lazy panel graph remains side-effect free.
    const unregisterNavigation = onNavigate(retirePanel);
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        unregisterNavigation();
        resetSettingsLauncher();
        unregisterReset();
        uninstall();
    };
}
