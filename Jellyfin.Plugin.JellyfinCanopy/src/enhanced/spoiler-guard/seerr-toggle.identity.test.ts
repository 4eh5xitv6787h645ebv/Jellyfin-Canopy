import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    enabled: false,
    whenLoaded: vi.fn<() => Promise<void>>(),
    enableForTmdb: vi.fn<() => Promise<unknown>>(),
    disableForTmdb: vi.fn<() => Promise<unknown>>(),
    confirmDisableSpoiler: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('./state', () => ({
    isTmdbEnabled: () => mocks.enabled,
    whenLoaded: () => mocks.whenLoaded(),
    enableForTmdb: () => mocks.enableForTmdb(),
    disableForTmdb: () => mocks.disableForTmdb(),
}));

vi.mock('./dialog', () => ({
    confirmDisableSpoiler: () => mocks.confirmDisableSpoiler(),
}));

import { JC } from '../../globals';
import { buildSeerrPendingToggle } from './seerr-toggle';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('Spoiler Guard Seerr control identity ownership', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        JC.identity.transition('', '', 'seerr-toggle-test-reset');
        JC.identity.transition('server-a', 'user-a', 'seerr-toggle-test-start');
        (JC.pluginConfig as Record<string, unknown>).SpoilerBlurEnabled = true;
        JC.t = (key: string) => key;
        JC.toast = vi.fn();
        mocks.enabled = false;
        mocks.whenLoaded.mockReset().mockResolvedValue(undefined);
        mocks.enableForTmdb.mockReset().mockResolvedValue({ promoted: 'pending' });
        mocks.disableForTmdb.mockReset().mockResolvedValue({});
        mocks.confirmDisableSpoiler.mockReset().mockResolvedValue(true);
    });

    afterEach(() => {
        JC.identity.transition('', '', 'seerr-toggle-test-cleanup');
        document.body.innerHTML = '';
    });

    it('drops A held-load label work, removes A, and creates a distinct B control', async () => {
        const held = deferred<void>();
        mocks.whenLoaded.mockReturnValueOnce(held.promise);
        const retainedA = buildSeerrPendingToggle({ id: 42, title: 'A' }, 'movie')!;
        document.body.appendChild(retainedA);
        expect(retainedA.textContent).toContain('spoiler_blur_pending_button_off');

        JC.identity.transition('server-a', 'user-b', 'account-switch');
        expect(document.querySelector('.jc-spoiler-pending-btn')).toBeNull();
        mocks.enabled = true;
        held.resolve(undefined);
        await flush();

        expect(retainedA.textContent).toContain('spoiler_blur_pending_button_off');
        retainedA.click();
        expect(mocks.enableForTmdb).not.toHaveBeenCalled();
        expect(mocks.disableForTmdb).not.toHaveBeenCalled();

        const buttonB = buildSeerrPendingToggle({ id: 42, title: 'B' }, 'movie')!;
        document.body.appendChild(buttonB);
        await flush();
        expect(buttonB).not.toBe(retainedA);
        expect(buttonB.textContent).toContain('spoiler_blur_pending_button_on');
    });

    it('does not let a retained A confirmation disable B state', async () => {
        mocks.enabled = true;
        const heldConfirm = deferred<boolean>();
        mocks.confirmDisableSpoiler.mockReturnValueOnce(heldConfirm.promise);
        const retainedA = buildSeerrPendingToggle({ id: 7, title: 'A' }, 'tv')!;
        document.body.appendChild(retainedA);
        retainedA.click();
        expect(mocks.confirmDisableSpoiler).toHaveBeenCalledTimes(1);

        JC.identity.transition('server-a', 'user-b', 'account-switch');
        heldConfirm.resolve(true);
        await flush();

        expect(mocks.disableForTmdb).not.toHaveBeenCalled();
        expect(JC.toast).not.toHaveBeenCalled();
        expect(document.querySelector('.jc-spoiler-pending-btn')).toBeNull();
    });
});
