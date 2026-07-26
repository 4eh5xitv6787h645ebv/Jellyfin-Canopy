import { describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';

describe('admin-target page handoff import purity', () => {
    it('installs no identity, navigation, or timer work until a handoff is staged', async () => {
        vi.resetModules();
        const registerReset = vi.spyOn(JC.identity, 'registerReset');
        const originalNavigation = JC.core.navigation;
        const onNavigate = vi.fn(() => () => undefined);
        JC.core.navigation = {
            onNavigate,
        } as unknown as NonNullable<typeof JC.core.navigation>;
        const setTimeoutSpy = vi.spyOn(window, 'setTimeout');

        await import('./handoff');

        expect(registerReset).not.toHaveBeenCalled();
        expect(onNavigate).not.toHaveBeenCalled();
        expect(setTimeoutSpy).not.toHaveBeenCalled();
        JC.core.navigation = originalNavigation;
        vi.restoreAllMocks();
    });
});
