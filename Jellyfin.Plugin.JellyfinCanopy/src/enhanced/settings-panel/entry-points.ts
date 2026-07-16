// src/enhanced/settings-panel/entry-points.ts
//
// Page-location helpers and the panel entry points: sidebar menu button,
// video-OSD settings button and the user-preferences menu link.
// Split from ui.js (code motion; bodies verbatim).
// (Converted from js/enhanced/ui-entry-points.js — bodies semantically identical.)

import { JC } from '../../globals';
import { onBodyMutation } from '../../core/dom-observer';
import { onNavigate, onViewPage } from '../../core/navigation';
import { queryElementsById, resolveCurrentViewRoot } from '../../core/view-root';
import { getSidebarContainer } from '../helpers';
import { ensureCanopySection, insertSectionEntry } from '../pages/entry-points';

/**
 * Helper function to determine if the current page is the video player.
 * @returns {boolean} True if the current page is the video player.
 */
JC.isVideoPage = () => window.location.hash.startsWith('#/video');

/**
 * Helper function to determine if the current page is an item details page.
 * @returns {boolean} True if on an item details page.
 */
JC.isDetailsPage = () => window.location.hash.includes('/details?id=');

// JC.toast moved to js/core/ui-kit.js (JC.core.ui.toast); the JC.toast
// alias is assigned there. Callers are unchanged.

/**
 * Adds the "Jellyfin Canopy" menu button to the sidebar.
 */
JC.addPluginMenuButton = () => {
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

    onBodyMutation('ui-menu-button', () => {
        // getSidebarContainer() falls back to the new MUI drawer (mobile only)
        // when the legacy sidebar is hidden under Jellyfin 12's experimental
        // layout. Every other module that looks for `.jellyfinCanopySection`
        // queries it unscoped, so creating it here - wherever it ends up - is
        // the only choke point that needs to know about the new drawer.
        const sidebar = getSidebarContainer();
        if (sidebar && !sidebar.querySelector('#jellyfinCanopySettingsLink')) {
            addMenuButton(sidebar);
        }
    });
};

/**
 * Injects the "Jellyfin Canopy" settings button into the video player OSD.
 */
JC.addOsdSettingsButton = () => {
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
};

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
JC.addUserPreferencesLink = () => {
    // PERF(R3): retries are driven by the shared navigation/viewshow events (plus
    // the shared body observer tick in events.ts) instead of creating a new
    // body-wide attribute MutationObserver per call — the old pattern leaked
    // one observer per call whenever this ran off the preferences page.
    if (!prefsLinkNavHooksWired) {
        prefsLinkNavHooksWired = true;
        // viewshow covers cached legacy pages re-shown via a class flip only
        // (no structural mutation for the body observer to see); onNavigate
        // covers the modern router where viewshow never fires.
        onNavigate(() => { addPrefsLinkIfOnPage(); });
        onViewPage(() => { addPrefsLinkIfOnPage(); });
    }

    addPrefsLinkIfOnPage();
};
