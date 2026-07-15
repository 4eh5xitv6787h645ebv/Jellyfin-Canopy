// src/enhanced/settings-panel/shortcut-editor.ts
//
// Click-to-rebind editor for the shortcut keys shown in the panel's
// Shortcuts tab (rebind, conflict shake, Backspace-to-reset).
// Split from ui.js (code motion; bodies verbatim).
// (Converted from js/enhanced/ui-panel-shortcut-editor.js — bodies semantically identical.)

import { JC } from '../../globals';
import {
    formatShortcut,
    normalizeShortcutEntries,
    shortcutFromEvent,
    shortcutsEqual,
} from '../shortcut-codec';
import type { PanelContext } from './panel';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Wires the shortcut-key rebinding behaviour inside the open panel.
 * @param {object} ctx Shared panel context assembled in settings-panel/panel.ts.
 */
export function wireShortcutEditor(ctx: PanelContext): void {
    const { help, pluginShortcuts, primaryAccentColor, kbdBackground, identityContext, trackTimer } = ctx;
    const isCurrent = () => JC.identity.isCurrent(identityContext);

    // --- Shortcut Key Binding Logic ---
    if (!JC.pluginConfig.DisableAllShortcuts) {
        const shortcutKeys = help.querySelectorAll<HTMLElement>('.shortcut-key');
        shortcutKeys.forEach(keyElement => {
            const getOriginalKey = () => formatShortcut(JC.state!.activeShortcuts[keyElement.dataset.action!]);

            keyElement.addEventListener('click', () => { if (isCurrent()) keyElement.focus(); });

            keyElement.addEventListener('focus', () => {
                if (!isCurrent()) return;
                keyElement.textContent = JC.t!('panel_shortcuts_listening');
                keyElement.style.borderColor = primaryAccentColor;
                keyElement.style.width = '100px';
            });

            keyElement.addEventListener('blur', () => {
                if (!isCurrent()) return;
                keyElement.textContent = getOriginalKey();
                keyElement.style.borderColor = 'transparent';
                keyElement.style.width = 'auto';
            });

            keyElement.addEventListener('keydown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!isCurrent()) return;

                const labelWrapper = keyElement.nextElementSibling;
                const action = keyElement.dataset.action!;

                if (e.key === 'Backspace') {
                    const defaultConfig = pluginShortcuts.find((s: any) => s.Name === action);
                    const defaultKey = formatShortcut(defaultConfig ? defaultConfig.Key : '');

                    const shortcutIndex = (JC.userConfig as any).shortcuts.Shortcuts.findIndex((s: any) => s.Name === action);
                    if (shortcutIndex > -1) {
                        (JC.userConfig as any).shortcuts.Shortcuts.splice(shortcutIndex, 1);
                    }
                    normalizeShortcutEntries((JC.userConfig as any).shortcuts.Shortcuts);

                    void JC.saveUserSettings!('shortcuts.json', (JC.userConfig as any).shortcuts).then(() => {
                        if (!isCurrent()) return;
                        // Publish the shortcut and success UI only after the
                        // server acknowledges the matching revision.
                        JC.state!.activeShortcuts[action] = defaultKey;
                        keyElement.textContent = defaultKey;
                        labelWrapper?.querySelector('.modified-indicator')?.remove();
                        keyElement.blur();
                    }).catch(() => {
                        if (isCurrent()) keyElement.blur();
                    });
                    return;
                }

                const combo = shortcutFromEvent(e);
                if (!combo) return; // Don't allow setting only a modifier key.
                const existingAction = Object.keys(JC.state!.activeShortcuts)
                    .find(name => name !== action && shortcutsEqual(JC.state!.activeShortcuts[name], combo));
                if (existingAction) {
                    keyElement.style.background = 'rgb(255 0 0 / 60%)';
                    keyElement.classList.add('shake-error');
                    const timer = window.setTimeout(() => {
                        if (!isCurrent()) return;
                        keyElement.classList.remove('shake-error');
                        if (document.activeElement === keyElement) {
                            keyElement.style.background = kbdBackground;
                        }
                    }, 500);
                    trackTimer(timer);
                        // Reject the new keybinding and stop the function
                    return;
                }

                // Update or add the shortcut override
                const userShortcut = (JC.userConfig as any).shortcuts.Shortcuts.find((s: any) => s.Name === action);
                if (userShortcut) {
                    userShortcut.Key = combo;
                } else {
                    const defaultConfig = pluginShortcuts.find((s: any) => s.Name === action);
                    (JC.userConfig as any).shortcuts.Shortcuts.push({ ...defaultConfig, Key: combo });
                }
                normalizeShortcutEntries((JC.userConfig as any).shortcuts.Shortcuts);
                void JC.saveUserSettings!('shortcuts.json', (JC.userConfig as any).shortcuts).then(() => {
                    if (!isCurrent()) return;
                    JC.state!.activeShortcuts[action] = combo;
                    keyElement.textContent = combo;
                    if (labelWrapper && !labelWrapper.querySelector('.modified-indicator')) {
                        const indicator = document.createElement('span');
                        indicator.className = 'modified-indicator';
                        indicator.title = 'Modified by user';
                        indicator.style.cssText = `color:${primaryAccentColor}; font-size: 20px; line-height: 1;`;
                        indicator.textContent = '•';
                        labelWrapper.prepend(indicator);
                    }
                    keyElement.blur();
                }).catch(() => {
                    if (isCurrent()) keyElement.blur();
                });
            });
        });
    }
}
