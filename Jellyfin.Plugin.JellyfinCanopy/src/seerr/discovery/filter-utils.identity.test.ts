import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';

describe('discovery managed request identity paving', () => {
    let jf: ReturnType<typeof vi.fn>;
    let getCached: ReturnType<typeof vi.fn>;
    let setCache: ReturnType<typeof vi.fn>;
    let fetchWithRetry: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.resetModules();
        jf = vi.fn().mockResolvedValue({ results: ['current'] });
        getCached = vi.fn();
        setCache = vi.fn();
        fetchWithRetry = vi.fn();
        JC.core.api = {
            jf,
        } as unknown as NonNullable<typeof JC.core.api>;
        JC.requestManager = {
            getCached,
            setCache,
            fetchWithRetry,
        } as unknown as NonNullable<typeof JC.requestManager>;
        const { installDiscoveryFilter } = await import('./filter-utils');
        installDiscoveryFilter();
    });

    it('delegates parsing, cache publication, and identity fencing to core API', async () => {
        const signal = new AbortController().signal;
        const result: unknown = await JC.discoveryFilter!.fetchWithManagedRequest(
            '/JellyfinCanopy/tmdb/genres/movie',
            'genre',
            { signal },
        );

        expect(result).toEqual({ results: ['current'] });
        expect(jf).toHaveBeenCalledWith(
            '/JellyfinCanopy/tmdb/genres/movie',
            {
                cacheKey: 'genre:/JellyfinCanopy/tmdb/genres/movie',
                cacheDisposition: undefined,
                cacheNotFound: undefined,
            },
        );
        expect(getCached).not.toHaveBeenCalled();
        expect(setCache).not.toHaveBeenCalled();
        expect(fetchWithRetry).not.toHaveBeenCalled();
    });

    it('cancels only the lifecycle waiter and leaves shared transport ownership in core', async () => {
        let resolve!: (value: unknown) => void;
        jf.mockReturnValue(new Promise(done => { resolve = done; }));
        const controller = new AbortController();

        const waiting = JC.discoveryFilter!.fetchWithManagedRequest(
            '/JellyfinCanopy/tmdb/search/person?query=a',
            'person',
            { signal: controller.signal },
        );
        controller.abort();

        await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
        expect(jf).toHaveBeenCalledWith(
            '/JellyfinCanopy/tmdb/search/person?query=a',
            expect.not.objectContaining({ signal: expect.anything() }),
        );

        // The underlying shared request remains settleable/cacheable for other
        // waiters; this aborted lifecycle did not own its transport.
        resolve({ results: [] });
        await Promise.resolve();
    });
});
