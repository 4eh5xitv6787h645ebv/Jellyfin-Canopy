// src/enhanced/settings-panel/hidden-content/tab.ts
//
// Hidden Content section wiring inside the settings panel (toggles,
// surface filters, experimental options, manage button).
// Split from ui.js (code motion; bodies verbatim).
// (Converted from js/enhanced/ui-panel-hidden-content.js — bodies semantically identical.)

import { JE } from '../../globals';
import type { PanelContext } from './panel';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Wires the Hidden Content settings-panel listeners.
 * @param {object} ctx Shared panel context assembled in settings-panel/panel.ts.
 */
export function wireHiddenContentListeners(ctx: PanelContext): void {
    const { resetAutoCloseTimer } = ctx;

    // ============================================================
    // Hidden Content — settings panel event listeners
    // Binds change handlers for all hidden-content toggles:
    // master enable, button visibility, surface filters,
    // confirmation dialog, experimental collections, and
    // the "Manage Hidden Content" button.
    // ============================================================
    if ((JE as any).hiddenContent) {
        const hiddenButtonToggles = [
            ['hiddenShowButtonJellyseerr', 'showButtonJellyseerr'],
            ['hiddenShowButtonLibrary', 'showButtonLibrary'],
            ['hiddenShowButtonDetails', 'showButtonDetails'],
            ['hiddenShowButtonCast', 'showButtonCast']
        ];
        for (const [id, key] of hiddenButtonToggles) {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', (e) => {
                    (JE as any).hiddenContent.updateSettings({ [key]: (e.target as HTMLInputElement).checked });
                    if (key === 'showButtonLibrary' || key === 'showButtonCast') {
                        if ((e.target as HTMLInputElement).checked) {
                            (JE as any).hiddenContent.addLibraryHideButtons();
                        } else {
                            (JE as any).hiddenContent.removeLibraryHideButtons();
                            (JE as any).hiddenContent.addLibraryHideButtons();
                        }
                    }
                    resetAutoCloseTimer();
                });
            }
        }
        const hiddenSurfaceToggles = [
            ['hiddenFilterLibrary', 'filterLibrary'],
            ['hiddenFilterDiscovery', 'filterDiscovery'],
            ['hiddenFilterSearch', 'filterSearch'],
            ['hiddenFilterCalendar', 'filterCalendar'],
            ['hiddenFilterUpcoming', 'filterUpcoming'],
            ['hiddenFilterRecommendations', 'filterRecommendations'],
            ['hiddenFilterRequests', 'filterRequests'],
            ['hiddenFilterNextUp', 'filterNextUp'],
            ['hiddenFilterContinueWatching', 'filterContinueWatching']
        ];
        const masterToggle = document.getElementById('hiddenContentEnabledToggle');
        if (masterToggle) {
            masterToggle.addEventListener('change', (e) => {
                (JE as any).hiddenContent.updateSettings({ enabled: (e.target as HTMLInputElement).checked });
                resetAutoCloseTimer();
            });
        }
        const buttonsToggle = document.getElementById('hiddenShowHideButtons');
        if (buttonsToggle) {
            buttonsToggle.addEventListener('change', (e) => {
                (JE as any).hiddenContent.updateSettings({ showHideButtons: (e.target as HTMLInputElement).checked });
                if ((e.target as HTMLInputElement).checked) {
                    if ((JE as any).hiddenContent.getSettings().showButtonLibrary) {
                        (JE as any).hiddenContent.addLibraryHideButtons();
                    }
                } else {
                    (JE as any).hiddenContent.removeLibraryHideButtons();
                }
                resetAutoCloseTimer();
            });
        }
        for (const [id, key] of hiddenSurfaceToggles) {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', (e) => {
                    (JE as any).hiddenContent.updateSettings({ [key]: (e.target as HTMLInputElement).checked });
                    resetAutoCloseTimer();
                });
            }
        }
        const confirmToggle = document.getElementById('hiddenShowConfirmation');
        if (confirmToggle) {
            confirmToggle.addEventListener('change', (e) => {
                (JE as any).hiddenContent.updateSettings({ showHideConfirmation: (e.target as HTMLInputElement).checked });
                localStorage.removeItem('je_hide_confirm_suppressed_until');
                resetAutoCloseTimer();
            });
        }
        const experimentalCollections = document.getElementById('hiddenExperimentalCollections');
        if (experimentalCollections) {
            experimentalCollections.addEventListener('change', (e) => {
                (JE as any).hiddenContent.updateSettings({ experimentalHideCollections: (e.target as HTMLInputElement).checked });
                if (!(e.target as HTMLInputElement).checked) {
                    (JE as any).hiddenContent.removeLibraryHideButtons();
                    (JE as any).hiddenContent.addLibraryHideButtons();
                }
                resetAutoCloseTimer();
            });
        }
        const manageBtn = document.getElementById('manageHiddenContentBtn');
        if (manageBtn) {
            manageBtn.addEventListener('click', () => {
                if (JE.pluginConfig?.HiddenContentEnabled && (JE as any).hiddenContentPage) {
                    (JE as any).hiddenContentPage.showPage();
                } else {
                    (JE as any).hiddenContent.showManagementPanel();
                }
            });
        }
    }
}
