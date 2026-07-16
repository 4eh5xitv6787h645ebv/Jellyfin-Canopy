import { describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';

describe('Hidden Content lazy graph', () => {
    it('does not publish hidden facades or register hidden/pagehide work on import', async () => {
        vi.resetModules();
        JC.hiddenContent = undefined;
        JC.initializeHiddenContent = undefined;
        const registerReset = vi.spyOn(JC.identity, 'registerReset');
        const addEventListener = vi.spyOn(window, 'addEventListener');

        await import('../../entries/hidden-content-runtime');

        expect(JC.hiddenContent).toBeUndefined();
        expect(JC.initializeHiddenContent).toBeUndefined();
        expect(registerReset.mock.calls.filter(([name]) => String(name).startsWith('hidden-content'))).toEqual([]);
        expect(addEventListener.mock.calls.filter(([name]) => name === 'pagehide')).toEqual([]);
        expect(document.getElementById('jc-hidden-content')).toBeNull();
        registerReset.mockRestore();
        addEventListener.mockRestore();
    });

    it('preserves facade and method identity across live disable/re-enable', async () => {
        vi.resetModules();
        const { installHiddenContent } = await import('./init');
        const disposeFirst = installHiddenContent();
        const facade = JC.hiddenContent;
        const initializer = JC.initializeHiddenContent;
        const isHidden = Reflect.get(JC.hiddenContent as object, 'isHidden') as unknown;
        disposeFirst();
        const disposeSecond = installHiddenContent();

        expect(JC.hiddenContent).toBe(facade);
        expect(JC.initializeHiddenContent).toBe(initializer);
        expect(Reflect.get(JC.hiddenContent as object, 'isHidden')).toBe(isHidden);
        disposeSecond();
    });
});
