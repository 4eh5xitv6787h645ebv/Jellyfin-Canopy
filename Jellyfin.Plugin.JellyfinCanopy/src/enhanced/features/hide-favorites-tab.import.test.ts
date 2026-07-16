import { describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';

describe('Hide Favorites feature-module import', () => {
    it('does not publish its facade, register identity work, or inject CSS', async () => {
        vi.resetModules();
        JC.applyHideFavoritesTab = undefined;
        const registerReset = vi.spyOn(JC.identity, 'registerReset');
        JC.core.ui = { injectCss: vi.fn() } as unknown as NonNullable<typeof JC.core.ui>;
        const injectCss = vi.spyOn(JC.core.ui, 'injectCss');

        await import('./hide-favorites-tab');

        expect(JC.applyHideFavoritesTab).toBeUndefined();
        expect(registerReset).not.toHaveBeenCalled();
        expect(injectCss).not.toHaveBeenCalled();
        registerReset.mockRestore();
        injectCss.mockRestore();
    });

    it('keeps the compatibility method identity stable across live re-enable', async () => {
        vi.resetModules();
        const { installHideFavoritesTab } = await import('./hide-favorites-tab');
        const disposeFirst = installHideFavoritesTab();
        const facade = JC.applyHideFavoritesTab;
        disposeFirst();
        const disposeSecond = installHideFavoritesTab();

        expect(JC.applyHideFavoritesTab).toBe(facade);
        disposeSecond();
    });
});
