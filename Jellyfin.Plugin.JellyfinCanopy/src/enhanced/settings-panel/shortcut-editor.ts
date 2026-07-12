// src/enhanced/settings-panel/shortcut-editor.ts
//
// Click-to-rebind editor for the shortcut keys shown in the panel's
// Shortcuts tab (rebind, conflict shake, Backspace-to-reset).
// Split from ui.js (code motion; bodies verbatim).
// (Converted from js/enhanced/ui-panel-shortcut-editor.js — bodies semantically identical.)

import { JC } from '../../globals';
import type { PanelContext } from './panel';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Wires the shortcut-key rebinding behaviour inside the open panel.
 * @param {object} ctx Shared panel context assembled in settings-panel/panel.ts.
 */
export function wireShortcutEditor(ctx: PanelContext): void {
    const { help, pluginShortcuts, primaryAccentColor, kbdBackground } = ctx;

    // --- Shortcut Key Binding Logic ---
    if (!JC.pluginConfig.DisableAllShortcuts) {
        const shortcutKeys = help.querySelectorAll<HTMLElement>('.shortcut-key');
        shortcutKeys.forEach(keyElement => {
            const getOriginalKey = () => JC.state!.activeShortcuts[keyElement.dataset.action!];

            keyElement.addEventListener('click', () => keyElement.focus());

            keyElement.addEventListener('focus', () => {
                keyElement.textContent = JC.t!('panel_shortcuts_listening');
                keyElement.style.borderColor = primaryAccentColor;
                keyElement.style.width = '100px';
            });

            keyElement.addEventListener('blur', () => {
                keyElement.textContent = getOriginalKey();
                keyElement.style.borderColor = 'transparent';
                keyElement.style.width = 'auto';
            });

            keyElement.addEventListener('keydown', (e) => {
                e.preventDefault();
                e.stopPropagation();

                const labelWrapper = keyElement.nextElementSibling;
                const action = keyElement.dataset.action!;

                if (e.key === 'Backspace') {
                    const defaultConfig = pluginShortcuts.find((s: any) => s.Name === action);
                    const defaultKey = defaultConfig ? defaultConfig.Key : '';

                    const shortcutIndex = (JC.userConfig as any).shortcuts.Shortcuts.findIndex((s: any) => s.Name === action);
                    if (shortcutIndex > -1) {
                        (JC.userConfig as any).shortcuts.Shortcuts.splice(shortcutIndex, 1);
                    }

                    void JC.saveUserSettings!('shortcuts.json', (JC.userConfig as any).shortcuts);

                    // Update the active shortcuts in memory and what's shown on screen
                    JC.state!.activeShortcuts[action] = defaultKey;
                    keyElement.textContent = defaultKey;

                    const indicator = labelWrapper?.querySelector('.modified-indicator');
                    if (indicator) {
                        indicator.remove();
                    }
                    keyElement.blur(); // Exit the "Listening..." mode
                    return;
                }

                if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
                    return; // Don't allow setting only a modifier key
                }

                const combo = (e.metaKey ? 'Meta+' : '') + (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.key.match(/^[a-zA-Z]$/) ? e.key.toUpperCase() : e.key);
                const existingAction = Object.keys(JC.state!.activeShortcuts).find(name => JC.state!.activeShortcuts[name] === combo);
                if (existingAction && existingAction !== action) {
                    keyElement.style.background = 'rgb(255 0 0 / 60%)';
                    keyElement.classList.add('shake-error');
                    setTimeout(() => {
                        keyElement.classList.remove('shake-error');
                        if (document.activeElement === keyElement) {
                            keyElement.style.background = kbdBackground;
                        }
                    }, 500);
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
                void JC.saveUserSettings!('shortcuts.json', (JC.userConfig as any).shortcuts);

                // Update active shortcuts
                JC.state!.activeShortcuts[action] = combo;

                // Update the UI and exit edit mode
                keyElement.textContent = combo;
                if (labelWrapper && !labelWrapper.querySelector('.modified-indicator')) {
                    const indicator = document.createElement('span');
                    indicator.className = 'modified-indicator';
                    indicator.title = 'Modified by user';
                    indicator.style.cssText = `color:${primaryAccentColor}; font-size: 20px; line-height: 1;`;
                    indicator.textContent = '•';
                    labelWrapper.prepend(indicator);
                }
                keyElement.blur(); // Triggers the blur event to clean up styles
            });
        });
    }
}
