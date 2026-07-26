import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../arr-globals';
import type { ApiApi } from '../../types/jc';

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('Requests page latest-intent reads', () => {
    let plugin: ReturnType<typeof vi.fn>;
    let data: typeof import('./data');
    let actions: typeof import('./actions');

    beforeEach(async () => {
        vi.resetModules();
        document.body.replaceChildren();
        JC.identity.transition('requests-race-server', 'requests-race-user', 'requests-race-start');
        JC.pluginConfig = {
            SeerrEnabled: true,
            DownloadsPageShowIssues: true,
        };
        plugin = vi.fn();
        JC.core.api = { plugin } as unknown as ApiApi;
        data = await import('./data');
        actions = await import('./actions');
    });

    it('aborts a slower Requests poll and cannot overwrite a newer filter response', async () => {
        const pollResult = deferred<unknown>();
        const filterResult = deferred<unknown>();
        plugin
            .mockReturnValueOnce(pollResult.promise)
            .mockReturnValueOnce(filterResult.promise);

        const poll = data.fetchRequests();
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));
        const pollSignal = (plugin.mock.calls[0]?.[1] as { signal: AbortSignal }).signal;

        actions.filterRequests('pending');
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(2));
        expect(pollSignal.aborted).toBe(true);
        expect(plugin.mock.calls[0]?.[0]).toContain('skip=0&filter=');
        expect(plugin.mock.calls[1]?.[0]).toContain('skip=0&filter=pending');

        filterResult.resolve({
            requests: [{ id: 'latest-filter-result' }],
            totalPages: 2,
        });
        await vi.waitFor(() => {
            expect(data.state.requests).toEqual([{ id: 'latest-filter-result' }]);
        });

        pollResult.resolve({
            requests: [{ id: 'stale-poll-result' }],
            totalPages: 9,
        });
        await poll;
        await Promise.resolve();

        expect(data.state.requests).toEqual([{ id: 'latest-filter-result' }]);
        expect(data.state.requestsTotalPages).toBe(2);
        expect(data.state.requestsFilter).toBe('pending');
    });

    it('keeps a slower page-one poll from rolling page two back', async () => {
        const pollResult = deferred<unknown>();
        const pageResult = deferred<unknown>();
        plugin
            .mockReturnValueOnce(pollResult.promise)
            .mockReturnValueOnce(pageResult.promise);
        data.state.requestsTotalPages = 3;

        const poll = data.fetchRequests();
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));
        const pollSignal = (plugin.mock.calls[0]?.[1] as { signal: AbortSignal }).signal;

        actions.nextPage();
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(2));
        expect(pollSignal.aborted).toBe(true);
        expect(plugin.mock.calls[1]?.[0]).toContain('skip=20');

        pageResult.resolve({
            requests: [{ id: 'page-two-result' }],
            totalPages: 3,
        });
        await vi.waitFor(() => {
            expect(data.state.requests).toEqual([{ id: 'page-two-result' }]);
        });

        pollResult.resolve({
            requests: [{ id: 'late-page-one-result' }],
            totalPages: 1,
        });
        await poll;
        await Promise.resolve();

        expect(data.state.requestsPage).toBe(2);
        expect(data.state.requests).toEqual([{ id: 'page-two-result' }]);
        expect(data.state.requestsTotalPages).toBe(3);
    });

    it('rejects a response when visible intent changed before its replacement read began', async () => {
        const held = deferred<unknown>();
        plugin.mockReturnValueOnce(held.promise);
        data.state.requests = [{ id: 'retained-result' }];

        const read = data.fetchRequests();
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));
        data.state.requestsPage = 2;
        held.resolve({
            requests: [{ id: 'obsolete-page-one-result' }],
            totalPages: 4,
        });
        await read;

        expect(data.state.requests).toEqual([{ id: 'retained-result' }]);
        expect(data.state.requestsPage).toBe(2);
    });

    it('applies the same latest-filter ownership to Issues polling', async () => {
        const pollResult = deferred<unknown>();
        const filterResult = deferred<unknown>();
        plugin
            .mockReturnValueOnce(pollResult.promise)
            .mockReturnValueOnce(filterResult.promise);

        const poll = data.fetchIssues();
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));
        const pollSignal = (plugin.mock.calls[0]?.[1] as { signal: AbortSignal }).signal;

        actions.filterIssues('resolved');
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(2));
        expect(pollSignal.aborted).toBe(true);
        expect(plugin.mock.calls[1]?.[0]).toContain('filter=resolved');

        filterResult.resolve({
            results: [{ message: 'latest resolved issue' }],
            pageInfo: { pages: 2 },
        });
        await vi.waitFor(() => {
            expect(data.state.issues).toEqual([{ message: 'latest resolved issue' }]);
        });

        pollResult.resolve({
            results: [{ message: 'stale open issue' }],
            pageInfo: { pages: 7 },
        });
        await poll;
        await Promise.resolve();

        expect(data.state.issues).toEqual([{ message: 'latest resolved issue' }]);
        expect(data.state.issuesTotalPages).toBe(2);
        expect(data.state.issuesFilter).toBe('resolved');
    });
});
