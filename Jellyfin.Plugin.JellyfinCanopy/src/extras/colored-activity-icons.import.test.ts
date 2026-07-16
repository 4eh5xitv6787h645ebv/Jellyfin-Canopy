import { describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

const activityGlobal = JC as typeof JC & {
    initializeActivityIcons?: () => void;
    stopActivityIconsMonitoring?: () => void;
};

describe('Colored Activity Icons feature-module import', () => {
    it('does not publish methods, register identity work, or inject CSS on import', async () => {
        vi.resetModules();
        activityGlobal.initializeActivityIcons = undefined;
        activityGlobal.stopActivityIconsMonitoring = undefined;
        const registerReset = vi.spyOn(JC.identity, 'registerReset');

        await import('./colored-activity-icons');

        expect(activityGlobal.initializeActivityIcons).toBeUndefined();
        expect(activityGlobal.stopActivityIconsMonitoring).toBeUndefined();
        expect(registerReset).not.toHaveBeenCalled();
        expect(document.getElementById('activity-icons-hide-svg')).toBeNull();
        registerReset.mockRestore();
    });

    it('keeps both compatibility method identities stable across live re-enable', async () => {
        vi.resetModules();
        const { installActivityIcons } = await import('./colored-activity-icons');
        const disposeFirst = installActivityIcons();
        const initialize = activityGlobal.initializeActivityIcons;
        const stop = activityGlobal.stopActivityIconsMonitoring;
        disposeFirst();
        const disposeSecond = installActivityIcons();

        expect(activityGlobal.initializeActivityIcons).toBe(initialize);
        expect(activityGlobal.stopActivityIconsMonitoring).toBe(stop);
        disposeSecond();
    });
});
