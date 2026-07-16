import { afterEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { PanelContext } from './panel';
import { wireHiddenContentListeners } from './hidden-content-tab';

describe('hidden-content settings controls', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('adds cast buttons when the master button toggle is enabled in cast-only mode', () => {
        document.body.innerHTML = '<input id="hiddenShowHideButtons" type="checkbox">';
        const updateSettings = vi.fn();
        const addLibraryHideButtons = vi.fn();
        JC.hiddenContent = {
            updateSettings,
            getSettings: vi.fn(() => ({ showButtonLibrary: false, showButtonCast: true })),
            addLibraryHideButtons,
            removeLibraryHideButtons: vi.fn(),
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        const resetAutoCloseTimer = vi.fn();
        wireHiddenContentListeners({ resetAutoCloseTimer } as unknown as PanelContext);

        const toggle = document.getElementById('hiddenShowHideButtons') as HTMLInputElement;
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));

        expect(updateSettings).toHaveBeenCalledWith({ showHideButtons: true });
        expect(addLibraryHideButtons).toHaveBeenCalledTimes(1);
        expect(resetAutoCloseTimer).toHaveBeenCalledTimes(1);
    });
});
