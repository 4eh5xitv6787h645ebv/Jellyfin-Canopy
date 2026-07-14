// src/enhanced/spoiler-guard/settings-tab.ts
//
// Settings-panel wiring for the Spoiler Guard per-user override section (the
// HTML for which lives in settings-panel/template.ts). Each checkbox has a
// data-pref (the SpoilerBlurUserPrefs field) and an id prefixed "sbPref" — the
// selector anchors on that prefix so an unrelated module's bare data-pref can't
// trigger this save path. Checked = inherit admin (pref=null); unchecked = user
// opt-out (pref=false). SkipDisableConfirm is the exception: a direct boolean.

import { JC } from '../../globals';
import { whenLoaded, isLoadOk, getUserPrefs, setUserPrefs, type SpoilerUserPrefs } from './state';
import type { IdentityContext } from '../../types/jc';

interface SettingsBinding {
    context: IdentityContext;
    boxes: HTMLInputElement[];
    cleanup(): void;
}

const settingsBindings = new Set<SettingsBinding>();

const logPrefix = '🪼 Jellyfin Canopy [SpoilerGuard]:';

/**
 * Wire the Spoiler Guard override checkboxes in the settings panel.
 * @param resetAutoCloseTimer - Panel helper to defer the auto-close timer.
 */
export function wireSpoilerGuardListeners(resetAutoCloseTimer: () => void): void {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    if (JC.pluginConfig?.SpoilerBlurEnabled !== true) return;

    // A normally-closed settings panel removes its DOM without notifying this
    // module. Prune that prior binding before wiring the next panel so the
    // synchronous reset registry stays bounded.
    for (const binding of Array.from(settingsBindings)) {
        if (!binding.boxes.some((box) => box.isConnected)) binding.cleanup();
    }

    const boxes = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][id^="sbPref"][data-pref]')
    );
    if (boxes.length === 0) return;

    let active = true;
    const isLive = (box?: HTMLInputElement): boolean => active
        && JC.identity.isCurrent(context)
        && (!box || box.isConnected);
    const setBoxesDisabled = (disabled: boolean): void => { for (const b of boxes) b.disabled = disabled; };

    const saveSbPrefs = async (changedBox: HTMLInputElement, previousChecked: boolean): Promise<void> => {
        if (!isLive(changedBox)) return;
        setBoxesDisabled(true);
        try {
            // Avoid the cold-load race: don't write from the in-memory cache
            // until loadState() populated it, or an early toggle POSTs an
            // empty-cache payload that silently clobbers stored prefs.
            await whenLoaded();
            if (!isLive(changedBox)) return;
            // Refuse to save when the initial GET failed — the cache is empty
            // and writing from it would clobber stored prefs.
            if (!isLoadOk()) {
                throw new Error('Initial Spoiler Guard load failed; refusing to overwrite stored prefs.');
            }
            // Build the payload from the authoritative cache, then overlay ONLY
            // the box just clicked — a full-DOM read is unsafe if the panel
            // rendered before load resolved.
            const current: SpoilerUserPrefs = getUserPrefs();
            const k = changedBox.dataset.pref!;
            if (k === 'SkipDisableConfirm') {
                current[k] = changedBox.checked;
            } else {
                // Unchecked = user opts to SEE the field (false); checked = follow
                // admin (null, so later admin policy flips track through).
                current[k] = changedBox.checked ? null : false;
            }
            if (!isLive(changedBox)) return;
            await setUserPrefs(current);
            if (!isLive(changedBox)) return;
            // The server cache is a projection of these per-user preferences.
            // A rescan cannot restore ratings/tags stripped from its existing
            // bytes (or remove already-rendered values in the reverse direction),
            // so rebuild the authoritative projection after any policy override.
            if (k !== 'SkipDisableConfirm') {
                await JC.tagPipeline?.invalidateServerCache?.();
                if (!isLive(changedBox)) return;
            }
        } catch (err) {
            if (!isLive(changedBox)) return;
            console.error(`${logPrefix} saveSbPrefs failed:`, err);
            // Revert the box the user clicked so they see the change didn't stick.
            changedBox.checked = previousChecked;
            JC.toast?.(JC.t!('spoiler_blur_error_toast'));
        } finally {
            // A's stale finally must not re-enable a retained control after B
            // has synchronously torn the panel down.
            if (isLive(changedBox)) setBoxesDisabled(false);
        }
    };

    const listeners = new Map<HTMLInputElement, () => void>();
    for (const box of boxes) {
        const listener = (): void => {
            if (!isLive(box)) return;
            // .checked already flipped by the time `change` fires; negate for revert.
            const previousChecked = !box.checked;
            void saveSbPrefs(box, previousChecked);
            if (isLive(box)) resetAutoCloseTimer();
        };
        listeners.set(box, listener);
        box.addEventListener('change', listener);
    }

    const binding: SettingsBinding = {
        context,
        boxes,
        cleanup(): void {
            if (!active) return;
            active = false;
            for (const [box, listener] of listeners) {
                box.removeEventListener('change', listener);
                box.disabled = true;
            }
            settingsBindings.delete(binding);
        },
    };
    settingsBindings.add(binding);

    // Rows render from a synchronous getUserPrefs() that may run before the
    // initial load resolves (or after it fails), defaulting every box to
    // "checked" (inherit). Re-sync once the load settles; if it failed, disable
    // the section rather than show editable-but-wrong checkboxes.
    void (async () => {
        try {
            await whenLoaded();
            if (!isLive()) return;
            if (!isLoadOk()) {
                setBoxesDisabled(true);
                return;
            }
            const loaded = getUserPrefs();
            for (const b of boxes) {
                if (!isLive(b)) return;
                const k = b.dataset.pref!;
                b.checked = k === 'SkipDisableConfirm'
                    ? !!loaded[k]
                    : loaded[k] !== false; // checked = inherit; unchecked = opt-out (false)
            }
        } catch (syncErr) {
            if (isLive()) console.warn(`${logPrefix} pref re-sync failed:`, syncErr);
        }
    })();
}

JC.identity.registerReset('spoiler-settings-controls', () => {
    for (const binding of Array.from(settingsBindings)) binding.cleanup();
});
