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

    it('lets B succeed from the same shared request after A aborts', async () => {
        let resolve!: (value: unknown) => void;
        const sharedRequest = new Promise(done => { resolve = done; });
        jf.mockReturnValue(sharedRequest);
        const controllerA = new AbortController();
        const controllerB = new AbortController();

        const waitingA = JC.discoveryFilter!.fetchWithManagedRequest(
            '/JellyfinCanopy/tmdb/search/person?query=a',
            'person',
            { signal: controllerA.signal },
        );
        controllerA.abort();

        await expect(waitingA).rejects.toMatchObject({ name: 'AbortError' });

        const waitingB = JC.discoveryFilter!.fetchWithManagedRequest(
            '/JellyfinCanopy/tmdb/search/person?query=a',
            'person',
            { signal: controllerB.signal },
        );
        expect(jf).toHaveBeenNthCalledWith(
            2,
            '/JellyfinCanopy/tmdb/search/person?query=a',
            expect.not.objectContaining({ signal: expect.anything() }),
        );

        // A's lifecycle abort cannot poison the identity-owned shared transport
        // that a current B waiter legitimately reuses.
        resolve({ results: ['current-b'] });
        await expect(waitingB).resolves.toEqual({ results: ['current-b'] });
    });
});
