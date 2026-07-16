// src/enhanced/settings-panel/hidden-content/tab.ts
//
// Hidden Content section wiring inside the settings panel (toggles,
// surface filters, experimental options, manage button).
// Split from ui.js (code motion; bodies verbatim).
// (Converted from js/enhanced/ui-panel-hidden-content.js — bodies semantically identical.)

import { JC } from '../../globals';
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
    if ((JC as any).hiddenContent) {
        const hiddenButtonToggles = [
            ['hiddenShowButtonSeerr', 'showButtonSeerr'],
            ['hiddenShowButtonLibrary', 'showButtonLibrary'],
            ['hiddenShowButtonDetails', 'showButtonDetails'],
            ['hiddenShowButtonCast', 'showButtonCast']
        ];
        for (const [id, key] of hiddenButtonToggles) {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', (e) => {
                    (JC as any).hiddenContent.updateSettings({ [key]: (e.target as HTMLInputElement).checked });
                    if (key === 'showButtonLibrary' || key === 'showButtonCast') {
                        if ((e.target as HTMLInputElement).checked) {
                            (JC as any).hiddenContent.addLibraryHideButtons();
                        } else {
                            (JC as any).hiddenContent.removeLibraryHideButtons();
                            (JC as any).hiddenContent.addLibraryHideButtons();
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
                (JC as any).hiddenContent.updateSettings({ enabled: (e.target as HTMLInputElement).checked });
                resetAutoCloseTimer();
            });
        }
        const buttonsToggle = document.getElementById('hiddenShowHideButtons');
        if (buttonsToggle) {
            buttonsToggle.addEventListener('change', (e) => {
                (JC as any).hiddenContent.updateSettings({ showHideButtons: (e.target as HTMLInputElement).checked });
                if ((e.target as HTMLInputElement).checked) {
                    if ((JC as any).hiddenContent.getSettings().showButtonLibrary) {
                        (JC as any).hiddenContent.addLibraryHideButtons();
                    }
                } else {
                    (JC as any).hiddenContent.removeLibraryHideButtons();
                }
                resetAutoCloseTimer();
            });
        }
        for (const [id, key] of hiddenSurfaceToggles) {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', (e) => {
                    (JC as any).hiddenContent.updateSettings({ [key]: (e.target as HTMLInputElement).checked });
                    resetAutoCloseTimer();
                });
            }
        }
        const confirmToggle = document.getElementById('hiddenShowConfirmation');
        if (confirmToggle) {
            confirmToggle.addEventListener('change', (e) => {
                (JC as any).hiddenContent.updateSettings({ showHideConfirmation: (e.target as HTMLInputElement).checked });
                JC.storage.local.remove('hidden-content-settings', 'jc_hide_confirm_suppressed_until', 'legacy-suppression');
                resetAutoCloseTimer();
            });
        }
        const experimentalCollections = document.getElementById('hiddenExperimentalCollections');
        if (experimentalCollections) {
            experimentalCollections.addEventListener('change', (e) => {
                (JC as any).hiddenContent.updateSettings({ experimentalHideCollections: (e.target as HTMLInputElement).checked });
                if (!(e.target as HTMLInputElement).checked) {
                    (JC as any).hiddenContent.removeLibraryHideButtons();
                    (JC as any).hiddenContent.addLibraryHideButtons();
                }
                resetAutoCloseTimer();
            });
        }
        const manageBtn = document.getElementById('manageHiddenContentBtn');
        if (manageBtn) {
            manageBtn.addEventListener('click', () => {
                if (JC.pluginConfig?.HiddenContentEnabled && (JC as any).hiddenContentPage) {
                    (JC as any).hiddenContentPage.showPage();
                } else {
                    (JC as any).hiddenContent.showManagementPanel();
                }
            });
        }
    }
}
