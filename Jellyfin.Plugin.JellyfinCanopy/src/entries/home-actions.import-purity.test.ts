import { describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

describe('lazy home action graphs', () => {
    it('publish no facades or identity hooks on import', async () => {
        vi.resetModules();
        JC.addRandomButton = undefined;
        JC.addRemoveButton = undefined;
        JC.addMultiSelectRemoveButton = undefined;
        JC.detectCardSurface = undefined;
        JC.hideEmptyHomeSections = undefined;
        const registerReset = vi.spyOn(JC.identity, 'registerReset');
        const registerActivate = vi.spyOn(JC.identity, 'registerActivate');

        await import('./random-button');
        await import('./remove-home-actions');

        expect(JC.addRandomButton).toBeUndefined();
        expect(JC.addRemoveButton).toBeUndefined();
        expect(JC.addMultiSelectRemoveButton).toBeUndefined();
        expect(JC.detectCardSurface).toBeUndefined();
        expect(JC.hideEmptyHomeSections).toBeUndefined();
        expect(registerReset.mock.calls.filter(([name]) =>
            ['random-button', 'remove-home', 'remove-multiselect'].includes(String(name))
        )).toEqual([]);
        expect(registerActivate).not.toHaveBeenCalled();
        registerReset.mockRestore();
        registerActivate.mockRestore();
    });

    it('preserves public method identity across disable and re-enable', async () => {
        vi.resetModules();
        const { installRandomButton } = await import('../enhanced/features/random-button');
        const { installRemoveHome } = await import('../enhanced/features/remove-home');
        const { installRemoveMultiSelect } = await import('../enhanced/features/remove-multiselect');
        const disposeFirst = [
            installRandomButton(),
            installRemoveHome(),
            installRemoveMultiSelect(),
        ];
        const first = {
            random: JC.addRandomButton,
            remove: JC.addRemoveButton,
            multi: JC.addMultiSelectRemoveButton,
            detect: JC.detectCardSurface,
            hideEmpty: JC.hideEmptyHomeSections,
        };
        disposeFirst.reverse().forEach((dispose) => dispose());
        const disposeSecond = [
            installRandomButton(),
            installRemoveHome(),
            installRemoveMultiSelect(),
        ];

        expect(JC.addRandomButton).toBe(first.random);
        expect(JC.addRemoveButton).toBe(first.remove);
        expect(JC.addMultiSelectRemoveButton).toBe(first.multi);
        expect(JC.detectCardSurface).toBe(first.detect);
        expect(JC.hideEmptyHomeSections).toBe(first.hideEmpty);
        disposeSecond.reverse().forEach((dispose) => dispose());
    });
});
