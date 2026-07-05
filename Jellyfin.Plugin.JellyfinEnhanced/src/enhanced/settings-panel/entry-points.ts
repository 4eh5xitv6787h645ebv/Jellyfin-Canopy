// src/enhanced/settings-panel/entry-points.ts
//
// Page-location helpers and the panel entry points: sidebar menu button,
// video-OSD settings button and the user-preferences menu link.
// Split from ui.js (code motion; bodies verbatim).
// (Converted from js/enhanced/ui-entry-points.js — bodies semantically identical.)

import { JE } from '../../globals';
import { onBodyMutation } from '../../core/dom-observer';
import { onNavigate, onViewPage } from '../../core/navigation';
import { getSidebarContainer } from '../helpers';

/**
 * Helper function to determine if the current page is the video player.
 * @returns {boolean} True if the current page is the video player.
 */
JE.isVideoPage = () => window.location.hash.startsWith('#/video');

/**
 * Helper function to determine if the current page is an item details page.
 * @returns {boolean} True if on an item details page.
 */
JE.isDetailsPage = () => window.location.hash.includes('/details?id=');

// JE.toast moved to js/core/ui-kit.js (JE.core.ui.toast); the JE.toast
// alias is assigned there. Callers are unchanged.

/**
 * Adds the "Jellyfin Enhanced" menu button to the sidebar.
 */
JE.addPluginMenuButton = () => {
    const addMenuButton = (sidebar: HTMLElement) => {
        let jellyfinEnhancedSection = sidebar.querySelector<HTMLElement>('.jellyfinEnhancedSection');

        if (!jellyfinEnhancedSection) {
            jellyfinEnhancedSection = document.createElement('div');
            jellyfinEnhancedSection.className = 'jellyfinEnhancedSection';
            jellyfinEnhancedSection.innerHTML = '<h3 class="sidebarHeader">Jellyfin Enhanced</h3>';

            // Insert just above Media section
            const mediaSection = sidebar.querySelector('.libraryMenuOptions');
            if (mediaSection) {
                sidebar.insertBefore(jellyfinEnhancedSection, mediaSection);
            } else {
                sidebar.appendChild(jellyfinEnhancedSection);
            }
        }

        if (!jellyfinEnhancedSection.querySelector('#jellyfinEnhancedSettingsLink')) {
            const jellyfinEnhancedLink = document.createElement('a');
            jellyfinEnhancedLink.setAttribute('is', 'emby-linkbutton');
            jellyfinEnhancedLink.className = 'lnkMediaFolder navMenuOption emby-button';
            jellyfinEnhancedLink.href = '#';
            jellyfinEnhancedLink.id = 'jellyfinEnhancedSettingsLink';
            jellyfinEnhancedLink.innerHTML = `
                    <span class="material-icons navMenuOptionIcon" aria-hidden="true">tune</span>
                    <span class="sectionName navMenuOptionText">Enhanced Panel</span>
                `;

            jellyfinEnhancedLink.addEventListener('click', (e) => {
                e.preventDefault();
                void JE.showEnhancedPanel!();
            });

            jellyfinEnhancedSection.appendChild(jellyfinEnhancedLink);
        }
    };

    onBodyMutation('ui-menu-button', () => {
        // getSidebarContainer() falls back to the new MUI drawer (mobile only)
        // when the legacy sidebar is hidden under Jellyfin 12's experimental
        // layout. Every other module that looks for `.jellyfinEnhancedSection`
        // queries it unscoped, so creating it here - wherever it ends up - is
        // the only choke point that needs to know about the new drawer.
        const sidebar = getSidebarContainer();
        if (sidebar && !sidebar.querySelector('#jellyfinEnhancedSettingsLink')) {
            addMenuButton(sidebar);
        }
    });
};

/**
 * Injects the "Jellyfin Enhanced" settings button into the video player OSD.
 */
JE.addOsdSettingsButton = () => {
    if (document.getElementById('enhancedSettingsBtn')) return;
    const controlsContainer = document.querySelector('.videoOsdBottom .buttons.focuscontainer-x');
    if (!controlsContainer) return;
    const nativeSettingsButton = controlsContainer.querySelector('.btnVideoOsdSettings');
    if (!nativeSettingsButton) return;

    const enhancedSettingsBtn = document.createElement('button');
    enhancedSettingsBtn.id = 'enhancedSettingsBtn';
    enhancedSettingsBtn.setAttribute('is', 'paper-icon-button-light');
    enhancedSettingsBtn.className = 'autoSize paper-icon-button-light';
    enhancedSettingsBtn.title = 'Jellyfin Enhanced';
    enhancedSettingsBtn.innerHTML = '<span class="largePaperIconButton material-icons" aria-hidden="true">tune</span>';

    enhancedSettingsBtn.onclick = (e) => {
        e.stopPropagation();
        void JE.showEnhancedPanel!();
    };

    nativeSettingsButton.parentElement!.insertBefore(enhancedSettingsBtn, nativeSettingsButton);
};

// One-time guard for the navigation-driven retry hooks below (see
// JE.addUserPreferencesLink).
let prefsLinkNavHooksWired = false;

/**
 * Adds the preferences-menu link when the preferences page is visible.
 * Cheap non-layout probes (getElementById + classList) make this safe to call
 * on every structural mutation batch and navigation event.
 * @returns True when the link exists (or was just added).
 */
function addPrefsLinkIfOnPage(): boolean {
    const page = document.getElementById('myPreferencesMenuPage');
    if (!page || page.classList.contains('hide')) return false;

    const menuContainer = page.querySelector('.verticalSection');
    if (!menuContainer) return false;

    // Check if link already exists
    if (document.getElementById('jellyfinEnhancedUserPrefsLink')) return true;

    // Create the link element matching Jellyfin's structure
    const enhancedLink = document.createElement('a');
    enhancedLink.id = 'jellyfinEnhancedUserPrefsLink';
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
                    <div class="listItemBodyText">Advanced Settings (Jellyfin Enhanced)</div>
                </div>
            </div>
        `;

    enhancedLink.addEventListener('click', (e) => {
        e.preventDefault();
        void JE.showEnhancedPanel!();
    });

    // Insert at the end of the first vertical section
    menuContainer.appendChild(enhancedLink);
    return true;
}

/**
 * Injects the "Jellyfin Enhanced" link into the user preferences menu (mypreferencesmenu.html).
 * Adds it as the last item in the first vertical section (after Controls).
 */
JE.addUserPreferencesLink = () => {
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
