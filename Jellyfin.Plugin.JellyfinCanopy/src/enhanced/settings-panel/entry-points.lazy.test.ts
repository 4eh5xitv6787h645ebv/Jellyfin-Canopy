import { afterEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';

const mocks = vi.hoisted(() => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    return {
        held,
        loadCount: 0,
        release,
        reset: vi.fn(),
        show: vi.fn().mockResolvedValue(undefined),
    };
});

vi.mock('./panel', async () => {
    mocks.loadCount += 1;
    await mocks.held;
    return {
        resetSettingsPanel: mocks.reset,
        showEnhancedPanel: mocks.show,
    };
});

import { installSettingsLauncher, openEnhancedPanel } from './entry-points';

let dispose: (() => void) | null = null;

afterEach(() => {
    dispose?.();
    dispose = null;
});

describe('settings panel dynamic import fence', () => {
    it('singleflights the graph and rejects a completion from an obsolete identity', async () => {
        JC.identity.transition('', '', 'settings-lazy-test-logout');
        JC.identity.transition('server', 'user-a', 'settings-lazy-test-a');
        dispose = installSettingsLauncher();

        const first = openEnhancedPanel();
        const second = openEnhancedPanel();
        await vi.waitFor(() => expect(mocks.loadCount).toBe(1));
        expect(mocks.show).not.toHaveBeenCalled();

        JC.identity.transition('server', 'user-b', 'settings-lazy-test-b');
        mocks.release();
        await Promise.all([first, second]);

        expect(mocks.loadCount).toBe(1);
        expect(mocks.show).not.toHaveBeenCalled();
    });
});
