// src/enhanced/spoiler-guard/settings-tab.ts
//
// Settings-panel wiring for the Spoiler Guard per-user override section (the
// HTML for which lives in settings-panel/template.ts). Each checkbox has a
// data-pref (the SpoilerBlurUserPrefs field) and an id prefixed "sbPref" — the
// selector anchors on that prefix so an unrelated module's bare data-pref can't
// trigger this save path. Checked = inherit admin (pref=null); unchecked = user
// opt-out (pref=false). SkipDisableConfirm is the exception: a direct boolean.

import { JE } from '../../globals';
import { whenLoaded, isLoadOk, getUserPrefs, setUserPrefs, type SpoilerUserPrefs } from './state';

const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';

/**
 * Wire the Spoiler Guard override checkboxes in the settings panel.
 * @param resetAutoCloseTimer - Panel helper to defer the auto-close timer.
 */
export function wireSpoilerGuardListeners(resetAutoCloseTimer: () => void): void {
    if (JE.pluginConfig?.SpoilerBlurEnabled !== true) return;

    const boxes = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][id^="sbPref"][data-pref]')
    );
    if (boxes.length === 0) return;

    const setBoxesDisabled = (disabled: boolean): void => { for (const b of boxes) b.disabled = disabled; };

    const saveSbPrefs = async (changedBox: HTMLInputElement, previousChecked: boolean): Promise<void> => {
        setBoxesDisabled(true);
        try {
            // Avoid the cold-load race: don't write from the in-memory cache
            // until loadState() populated it, or an early toggle POSTs an
            // empty-cache payload that silently clobbers stored prefs.
            await whenLoaded();
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
            await setUserPrefs(current);
        } catch (err) {
            console.error(`${logPrefix} saveSbPrefs failed:`, err);
            // Revert the box the user clicked so they see the change didn't stick.
            changedBox.checked = previousChecked;
            JE.toast?.(JE.t!('spoiler_blur_error_toast'));
        } finally {
            setBoxesDisabled(false);
        }
    };

    for (const box of boxes) {
        box.addEventListener('change', () => {
            // .checked already flipped by the time `change` fires; negate for revert.
            const previousChecked = !box.checked;
            void saveSbPrefs(box, previousChecked);
            resetAutoCloseTimer();
        });
    }

    // Rows render from a synchronous getUserPrefs() that may run before the
    // initial load resolves (or after it fails), defaulting every box to
    // "checked" (inherit). Re-sync once the load settles; if it failed, disable
    // the section rather than show editable-but-wrong checkboxes.
    void (async () => {
        try {
            await whenLoaded();
            if (!isLoadOk()) {
                setBoxesDisabled(true);
                return;
            }
            const loaded = getUserPrefs();
            for (const b of boxes) {
                const k = b.dataset.pref!;
                b.checked = k === 'SkipDisableConfirm'
                    ? !!loaded[k]
                    : loaded[k] !== false; // checked = inherit; unchecked = opt-out (false)
            }
        } catch (syncErr) {
            console.warn(`${logPrefix} pref re-sync failed:`, syncErr);
        }
    })();
}
