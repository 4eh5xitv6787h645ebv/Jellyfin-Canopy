// src/enhanced/settings-panel/shortcut-editor.ts
//
// Click-to-rebind editor for the shortcut keys shown in the panel's
// Shortcuts tab (rebind, conflict shake, Backspace-to-reset).
// Split from ui.js (code motion; bodies verbatim).
// (Converted from js/enhanced/ui-panel-shortcut-editor.js — bodies semantically identical.)

import { JC } from '../../globals';
import {
    canonicalizeShortcut,
    formatShortcut,
    normalizeShortcutEntries,
    PERCENTAGE_SHORTCUT_NAME,
    PERCENTAGE_SHORTCUT_RANGE,
    shortcutBindingsConflict,
    shortcutFromEvent,
} from '../shortcut-codec';
import type { PanelContext } from './panel';
import { toast } from '../../core/ui-kit';
import { AdminTargetPersistenceError, createSelfPanelEditorContext } from './editor-context';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Wires the shortcut-key rebinding behaviour inside the open panel.
 * @param {object} ctx Shared panel context assembled in settings-panel/panel.ts.
 */
export function wireShortcutEditor(ctx: PanelContext): void {
    const { help, pluginShortcuts, primaryAccentColor, kbdBackground, trackTimer } = ctx;
    const editor = ctx.editor || createSelfPanelEditorContext(ctx.identityContext);
    const shortcuts = editor.shortcuts as { Shortcuts?: any[] } & Record<string, unknown>;
    if (!Array.isArray(shortcuts.Shortcuts)) shortcuts.Shortcuts = [];
    const activeShortcuts = editor.activeShortcuts;
    const isCurrent = () => editor.isCurrent();
    const canSettleSave = () => editor.mode === 'admin-target'
        ? isCurrent()
        : editor.appliesToActor && JC.identity.isCurrent(editor.actor);
    const handleSaveFailure = async (error: unknown, keyElement: HTMLElement) => {
        const classified = error instanceof AdminTargetPersistenceError ? error : null;
        if (classified?.kind === 'cancelled' || !isCurrent()) return;
        if (editor.mode === 'admin-target') {
            const key = classified?.kind === 'conflict'
                ? 'panel_admin_target_conflict_error'
                : classified?.kind === 'authorization'
                    ? 'panel_admin_target_unauthorized'
                    : 'panel_admin_target_save_error';
            toast(JC.t!(key), undefined, 'error');
        }
        keyElement.blur();
        await ctx.reconcileAfterSaveFailure?.();
    };

    const shortcutEntries = shortcuts.Shortcuts;
    const defaultFor = (action: string): any => pluginShortcuts.find((shortcut: any) => shortcut?.Name === action);
    const hasOverride = (action: string): boolean => shortcutEntries.some((shortcut: any) => shortcut?.Name === action);
    const effectiveDefault = (action: string): string => canonicalizeShortcut(defaultFor(action)?.Key);
    const replaceOverride = (action: string, binding: string | null): void => {
        let preserved: any = null;
        for (let index = shortcutEntries.length - 1; index >= 0; index -= 1) {
            if (shortcutEntries[index]?.Name !== action) continue;
            if (!preserved) preserved = shortcutEntries[index];
            shortcutEntries.splice(index, 1);
        }
        if (binding !== null) {
            shortcutEntries.push({
                ...defaultFor(action),
                ...preserved,
                Name: action,
                Key: binding,
            });
        }
        normalizeShortcutEntries(shortcutEntries);
    };
    const conflictFor = (action: string, binding: string): string | undefined => Object.keys(activeShortcuts)
        .find(name => name !== action && shortcutBindingsConflict(activeShortcuts[name], binding));
    const showConflict = (keyElement: HTMLElement): void => {
        keyElement.style.background = 'rgb(255 0 0 / 60%)';
        keyElement.classList.add('shake-error');
        const timer = window.setTimeout(() => {
            if (!isCurrent()) return;
            keyElement.classList.remove('shake-error');
            keyElement.style.background = kbdBackground;
        }, 500);
        trackTimer(timer);
    };
    const refreshRow = (action: string): void => {
        const keyElement = Array.from(help.querySelectorAll<HTMLElement>('.shortcut-key'))
            .find(element => element.dataset.action === action);
        if (!keyElement) return;
        const grouped = action === PERCENTAGE_SHORTCUT_NAME;
        const binding = canonicalizeShortcut(activeShortcuts[action]);
        const disabled = binding === '';
        const display = disabled ? JC.t!('status_disabled') : formatShortcut(binding);
        const label = keyElement.dataset.label || defaultFor(action)?.Label || action;
        keyElement.textContent = display;
        keyElement.setAttribute('aria-label', `${label}: ${display}`);
        keyElement.classList.toggle('shortcut-disabled', disabled);
        keyElement.style.opacity = disabled ? '0.72' : '1';
        keyElement.style.background = kbdBackground;
        const labelWrapper = keyElement.nextElementSibling;
        const modified = hasOverride(action);
        let indicator = labelWrapper?.querySelector<HTMLElement>('.modified-indicator') || null;
        if (modified && !indicator && labelWrapper) {
            indicator = document.createElement('span');
            indicator.className = 'modified-indicator';
            indicator.title = 'Modified by user';
            indicator.style.cssText = `color:${primaryAccentColor}; font-size:20px; line-height:1;`;
            indicator.textContent = '•';
            labelWrapper.prepend(indicator);
        } else if (!modified) {
            indicator?.remove();
        }
        const row = keyElement.closest('.jc-shortcut-row');
        const stateButton = row?.querySelector<HTMLButtonElement>('.shortcut-state-button');
        if (stateButton) {
            const operationLabel = disabled ? JC.t!('shortcut_enable') : JC.t!('shortcut_disable');
            stateButton.dataset.operation = disabled ? 'enable' : 'disable';
            stateButton.textContent = operationLabel;
            stateButton.setAttribute('aria-label', `${operationLabel}: ${label}`);
            stateButton.disabled = !grouped && disabled;
        }
        const resetButton = row?.querySelector<HTMLButtonElement>('.shortcut-reset-button');
        if (resetButton) resetButton.disabled = !modified;
    };
    const saveBinding = (
        action: string,
        binding: string | null,
        effectiveAfterSave: string,
        keyElement: HTMLElement,
    ): void => {
        replaceOverride(action, binding);
        const rowButtons = keyElement.closest('.jc-shortcut-row')?.querySelectorAll<HTMLButtonElement>('button');
        rowButtons?.forEach(button => { button.disabled = true; });
        void editor.saveShortcuts().then(() => {
            if (!canSettleSave()) return;
            // A self save still publishes after its initiating panel closes;
            // an admin-target map remains panel-local and actor-isolated.
            activeShortcuts[action] = effectiveAfterSave;
            if (!isCurrent()) return;
            refreshRow(action);
            keyElement.blur();
        }).catch((error: unknown) => {
            void handleSaveFailure(error, keyElement);
        });
    };

    // --- Shortcut Key Binding Logic ---
    if (!JC.pluginConfig.DisableAllShortcuts) {
        const shortcutKeys = help.querySelectorAll<HTMLElement>('.shortcut-key:not(.shortcut-group-key)');
        shortcutKeys.forEach(keyElement => {
            const getOriginalKey = () => {
                const binding = canonicalizeShortcut(activeShortcuts[keyElement.dataset.action!]);
                return binding ? formatShortcut(binding) : JC.t!('status_disabled');
            };

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

                const action = keyElement.dataset.action!;

                if (e.key === 'Backspace') {
                    saveBinding(action, null, effectiveDefault(action), keyElement);
                    return;
                }

                const combo = shortcutFromEvent(e);
                if (!combo) return; // Don't allow setting only a modifier key.
                const existingAction = conflictFor(action, combo);
                if (existingAction) {
                    showConflict(keyElement);
                    return;
                }

                saveBinding(action, combo, combo, keyElement);
            });
        });

        help.querySelectorAll<HTMLButtonElement>('.shortcut-state-button').forEach(button => {
            button.addEventListener('click', () => {
                if (!isCurrent()) return;
                const action = button.dataset.action!;
                const keyElement = Array.from(help.querySelectorAll<HTMLElement>('.shortcut-key'))
                    .find(element => element.dataset.action === action);
                if (!keyElement) return;
                if (button.dataset.operation === 'enable') {
                    // Only the static percentage group exposes Enable. Ordinary
                    // disabled rows are re-enabled by assigning a key or Reset.
                    if (action !== PERCENTAGE_SHORTCUT_NAME) return;
                    if (conflictFor(action, PERCENTAGE_SHORTCUT_RANGE)) {
                        showConflict(keyElement);
                        return;
                    }
                    saveBinding(action, PERCENTAGE_SHORTCUT_RANGE, PERCENTAGE_SHORTCUT_RANGE, keyElement);
                    return;
                }
                saveBinding(action, '', '', keyElement);
            });
        });

        help.querySelectorAll<HTMLButtonElement>('.shortcut-reset-button').forEach(button => {
            button.addEventListener('click', () => {
                if (!isCurrent() || button.disabled) return;
                const action = button.dataset.action!;
                const keyElement = Array.from(help.querySelectorAll<HTMLElement>('.shortcut-key'))
                    .find(element => element.dataset.action === action);
                if (!keyElement) return;
                // Reset always reveals the lower-precedence admin value, even
                // when legacy persisted bindings collide.
                saveBinding(action, null, effectiveDefault(action), keyElement);
            });
        });
    }
}
