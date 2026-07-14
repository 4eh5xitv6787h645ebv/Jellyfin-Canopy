import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { ApiApi } from '../../types/jc';
import { displayReleaseDate } from './release-dates';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function tmdbRelease(date: string): unknown {
    return {
        results: [{
            iso_3166_1: 'US',
            release_dates: [{ type: 3, release_date: date }],
        }],
    };
}

describe('release-date identity ownership', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        JC.identity.transition('test-server-id', 'user-a', 'release-date-test-start');
        JC.pluginConfig = { DEFAULT_REGION: 'US' };
        JC.t = (key: string) => key;
        JC.escapeHtml = (value: unknown) => typeof value === 'string' ? value : '';
        ApiClient.getItem = vi.fn().mockResolvedValue({ Type: 'Movie', ProviderIds: { Tmdb: '42' } });
    });

    it('drops a held A response and refetches instead of replaying it for B', async () => {
        const heldA = deferred<unknown>();
        const plugin = vi.fn()
            .mockImplementationOnce(() => heldA.promise)
            .mockResolvedValueOnce(tmdbRelease('2030-02-03'));
        JC.core.api = { plugin } as unknown as ApiApi;
        const container = document.createElement('div');
        document.body.appendChild(container);

        displayReleaseDate('same-item', container);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

        JC.identity.transition('test-server-id', 'user-b', 'account-switch');
        expect(container.querySelector('.mediaInfoItem-releaseDate')).toBeNull();
        heldA.resolve(tmdbRelease('2000-01-02'));
        await Promise.resolve();
        await Promise.resolve();
        expect(container.textContent).not.toContain('2000');

        displayReleaseDate('same-item', container);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(container.textContent).toContain('2030'));
        expect(container.textContent).not.toContain('2000');
    });
});
