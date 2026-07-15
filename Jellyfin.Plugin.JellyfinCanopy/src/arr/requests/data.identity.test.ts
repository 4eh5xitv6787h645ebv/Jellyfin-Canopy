import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../arr-globals';
import type { ApiApi } from '../../types/jc';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('Requests page identity ownership', () => {
    beforeEach(() => {
        vi.resetModules();
        document.body.innerHTML = '';
        JC.identity.transition('server-a', 'user-a', 'requests-test-start');
        JC.pluginConfig = {
            SeerrEnabled: true,
            DownloadsPageShowIssues: true,
        };
        JC.toast = vi.fn();
    });

    it('drops a held A response, clears A state, and refetches for B', async () => {
        const heldA = deferred<unknown>();
        const plugin = vi.fn()
            .mockImplementationOnce(() => heldA.promise)
            .mockResolvedValueOnce({ requests: [{ id: 'b-request' }], totalPages: 1 });
        JC.core.api = { plugin } as unknown as ApiApi;
        const { fetchRequests, state } = await import('./data');

        const first = fetchRequests();
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));
        JC.identity.transition('server-a', 'user-b', 'account-switch');
        expect(state.requests).toEqual([]);

        heldA.resolve({ requests: [{ id: 'a-request' }], totalPages: 1 });
        await first;
        expect(state.requests).toEqual([]);

        await fetchRequests();
        expect(state.requests).toEqual([{ id: 'b-request' }]);
        expect(plugin).toHaveBeenCalledTimes(2);
    });

    it('refuses an A-owned retained approve control after B becomes current', async () => {
        const plugin = vi.fn().mockResolvedValue({});
        JC.core.api = { plugin } as unknown as ApiApi;
        const { handleRequestAction } = await import('./data');
        const contextA = JC.identity.capture();
        const button = document.createElement('button');
        button.setAttribute('data-request-id', '9');
        button.setAttribute('data-source-token', 'a-token');
        JC.identity.own(button, contextA);

        JC.identity.transition('server-a', 'user-b', 'account-switch');
        await handleRequestAction(button, 'approve');

        expect(plugin).not.toHaveBeenCalled();
    });

    it('delegates issue-media ownership to the bounded core cache and retries transient failure', async () => {
        const plugin = vi.fn()
            .mockRejectedValueOnce(new Error('temporary upstream failure'))
            .mockResolvedValueOnce({ id: 42, title: 'Recovered' });
        JC.core.api = { plugin } as unknown as ApiApi;
        const { fetchIssueMediaDetails } = await import('./data');
        const context = JC.identity.capture()!;

        await expect(fetchIssueMediaDetails('movie', 42, undefined, context)).resolves.toBeNull();
        await expect(fetchIssueMediaDetails('movie', 42, undefined, context))
            .resolves.toMatchObject({ id: 42, title: 'Recovered' });

        expect(plugin).toHaveBeenCalledTimes(2);
        expect(plugin).toHaveBeenNthCalledWith(1, '/seerr/movie/42', {
            cacheKey: 'arr:issue-media:/seerr/movie/42',
            cacheDisposition: expect.any(Function),
            cacheNotFound: true,
        });
        expect(plugin).toHaveBeenNthCalledWith(2, '/seerr/movie/42', {
            cacheKey: 'arr:issue-media:/seerr/movie/42',
            cacheDisposition: expect.any(Function),
            cacheNotFound: true,
        });
    });
});
