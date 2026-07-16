import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { ApiApi } from '../../types/jc';
import { installRemoveHome, removeFromHomeSurface } from './remove-home';

let disposeFeature: (() => void) | null = null;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('Continue Watching removal identity ownership', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        JC.identity.transition('test-server-id', 'user-a', 'remove-home-test-start');
        JC.t = (key: string) => key;
        JC.escapeHtml = (value: unknown) => typeof value === 'string' ? value : '';
        disposeFeature = installRemoveHome();
    });

    afterEach(() => {
        disposeFeature?.();
        disposeFeature = null;
    });

    it('drops a held A completion without mutating B UI or hidden state', async () => {
        const held = deferred<unknown>();
        const plugin = vi.fn(() => held.promise);
        JC.core.api = { plugin } as unknown as ApiApi;
        const markScopedHidden = vi.fn();
        JC.hiddenContent = {
            flushPendingSave: vi.fn().mockResolvedValue(undefined),
            markScopedHidden,
        } as unknown as NonNullable<typeof JC.hiddenContent>;

        const card = document.createElement('div');
        document.body.appendChild(card);
        const result = removeFromHomeSurface('item-a', 'continuewatching', card);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

        JC.identity.transition('test-server-id', 'user-b', 'account-switch');
        held.resolve({});

        await expect(result).resolves.toBe(false);
        expect(card.style.display).toBe('');
        expect(markScopedHidden).not.toHaveBeenCalled();
    });

    it('reverses an A-owned optimistic hide synchronously on transition', async () => {
        JC.core.api = { plugin: vi.fn().mockResolvedValue({}) } as unknown as ApiApi;
        JC.hiddenContent = {
            flushPendingSave: vi.fn().mockResolvedValue(undefined),
            markScopedHidden: vi.fn(),
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        const card = document.createElement('div');
        document.body.appendChild(card);

        await expect(removeFromHomeSurface('item-a', 'continuewatching', card)).resolves.toBe(true);
        expect(card.style.display).toBe('none');

        JC.identity.transition('test-server-id', 'user-b', 'account-switch');
        expect(card.style.display).toBe('');
        expect(card.dataset.jcHomeRemoved).toBeUndefined();
    });
});
