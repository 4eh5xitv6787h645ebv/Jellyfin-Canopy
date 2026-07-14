import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    whenLoaded: vi.fn<() => Promise<void>>(),
    getUserPrefs: vi.fn(() => ({ SkipDisableConfirm: false })),
    isDisableSnoozed: vi.fn(() => false),
    setDisableSnooze: vi.fn<() => void>(),
}));

vi.mock('./state', () => ({
    whenLoaded: () => mocks.whenLoaded(),
    getUserPrefs: () => mocks.getUserPrefs(),
}));

vi.mock('./snooze', () => ({
    isDisableSnoozed: () => mocks.isDisableSnoozed(),
    setDisableSnooze: () => mocks.setDisableSnooze(),
}));

import { JC } from '../../globals';
import { confirmDisableSpoiler } from './dialog';

function deferred(): { promise: Promise<void>; resolve(): void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('Spoiler Guard disable-confirm identity ownership', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        JC.identity.transition('', '', 'dialog-test-reset');
        JC.identity.transition('server-a', 'user-a', 'dialog-test-start');
        JC.t = (key: string) => key;
        mocks.whenLoaded.mockReset().mockResolvedValue(undefined);
        mocks.getUserPrefs.mockClear();
        mocks.isDisableSnoozed.mockClear();
        mocks.setDisableSnooze.mockClear();
    });

    afterEach(() => {
        JC.identity.transition('', '', 'dialog-test-cleanup');
        document.body.innerHTML = '';
    });

    it('does not read B preferences or open a dialog when A whenLoaded settles late', async () => {
        const held = deferred();
        mocks.whenLoaded.mockReturnValueOnce(held.promise);
        const ownerA = JC.identity.capture()!;

        const result = confirmDisableSpoiler(ownerA);
        JC.identity.transition('server-a', 'user-b', 'account-switch');
        held.resolve();

        await expect(result).resolves.toBe(false);
        expect(mocks.getUserPrefs).not.toHaveBeenCalled();
        expect(document.querySelector('.jc-spoiler-confirm-overlay')).toBeNull();
    });

    it('closes A synchronously and a retained confirm cannot authorize or snooze B', async () => {
        const ownerA = JC.identity.capture()!;
        const result = confirmDisableSpoiler(ownerA);
        await flush();

        const overlay = document.querySelector<HTMLElement>('.jc-spoiler-confirm-overlay')!;
        const retainedConfirm = overlay.querySelector<HTMLButtonElement>('.jc-spoiler-confirm-ok')!;
        overlay.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = true;
        expect(overlay).toBeTruthy();

        JC.identity.transition('server-a', 'user-b', 'account-switch');

        expect(document.querySelector('.jc-spoiler-confirm-overlay')).toBeNull();
        await expect(result).resolves.toBe(false);
        retainedConfirm.click();
        expect(mocks.setDisableSnooze).not.toHaveBeenCalled();
        expect(document.body.classList.contains('jc-modal-open')).toBe(false);
    });
});
