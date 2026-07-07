// src/enhanced/spoiler-guard/settings-tab.test.ts
//
// The panel save-guard: a per-user override toggle must REFUSE to save (and
// revert its checkbox) when the initial Spoiler Guard state load failed, so an
// empty in-memory cache can't clobber the user's stored prefs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setUserPrefs = vi.fn((_next?: unknown) => Promise.resolve({}));
let loadOkValue = true;

vi.mock('./state', () => ({
    whenLoaded: () => Promise.resolve(),
    isLoadOk: () => loadOkValue,
    getUserPrefs: () => ({}),
    setUserPrefs: (next: unknown) => setUserPrefs(next),
}));

import { JE } from '../../globals';
import { wireSpoilerGuardListeners } from './settings-tab';

function renderRatingsBox(checked: boolean): HTMLInputElement {
    document.body.innerHTML = `
        <input type="checkbox" id="sbPrefHideRatings" data-pref="HideRatings" ${checked ? 'checked' : ''}>`;
    return document.getElementById('sbPrefHideRatings') as HTMLInputElement;
}

async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

describe('spoiler-guard settings-tab save-guard', () => {
    beforeEach(() => {
        (JE.pluginConfig as Record<string, unknown>).SpoilerBlurEnabled = true;
        setUserPrefs.mockClear();
        loadOkValue = true;
    });
    afterEach(() => { document.body.innerHTML = ''; });

    it('saves when the initial load succeeded', async () => {
        const box = renderRatingsBox(true);
        wireSpoilerGuardListeners(() => { /* noop */ });
        await flush(); // let the initial re-sync settle before interacting
        box.checked = false; // user opts out of hiding ratings
        box.dispatchEvent(new Event('change'));
        await flush();
        expect(setUserPrefs).toHaveBeenCalledTimes(1);
        expect(setUserPrefs).toHaveBeenCalledWith({ HideRatings: false });
    });

    it('REFUSES to save and reverts the checkbox when load failed (loadOk=false)', async () => {
        loadOkValue = false;
        const box = renderRatingsBox(true);
        wireSpoilerGuardListeners(() => { /* noop */ });
        await flush(); // re-sync disables the section on load failure
        box.checked = false;
        box.dispatchEvent(new Event('change'));
        await flush();
        expect(setUserPrefs).not.toHaveBeenCalled();
        // The box the user clicked is reverted to its pre-click state.
        expect(box.checked).toBe(true);
    });
});
