import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

describe('Seerr issue query ownership', () => {
    let originalIdentity = JC.identity.capture()!;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.resetModules();
        originalIdentity = JC.identity.capture()!;
        fetchMock = vi.fn();
        JC.core.api = {
            fetch: fetchMock,
            plugin: vi.fn(),
        } as unknown as NonNullable<typeof JC.core.api>;
        await import('./api');
    });

    afterEach(() => {
        JC.identity.transition(
            originalIdentity.serverId,
            originalIdentity.userId,
            'seerr-issue-pagination-test-restore',
        );
    });

    it('asks Canopy for the supported title-owned issue projection in one request', async () => {
        fetchMock.mockResolvedValue({
            pageInfo: { pages: 1, pageSize: 50, results: 1, page: 1 },
            results: [{ id: 71 }],
            jellyfinCanopyPagination: { contract: 'media-relation-owner', totalExact: true },
        });

        const result = await JC.seerrAPI!.fetchIssuesForMedia(42, 'movie', {
            take: 50,
            filter: 'open',
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url] = fetchMock.mock.calls[0] as [string];
        expect(url).toContain('/JellyfinCanopy/seerr/issue?');
        expect(url).toContain('tmdbId=42');
        expect(url).toContain('mediaType=movie');
        expect(url).toContain('take=50');
        expect(result.results).toHaveLength(1);
        expect(result.pageInfo.results).toBe(1);
    });

    it('preserves an exact empty title projection from Canopy', async () => {
        fetchMock.mockResolvedValue({
            pageInfo: { pages: 0, pageSize: 20, results: 0, page: 1 },
            results: [],
            jellyfinCanopyPagination: { contract: 'media-relation-owner', totalExact: true },
        });

        const result = await JC.seerrAPI!.fetchIssuesForMedia(42, 'movie');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.pageInfo.results).toBe(0);
        expect(result.jellyfinCanopyPagination.totalExact).toBe(true);
    });

    it('fetches every bounded matching issue for the modal in one owner snapshot', async () => {
        const rows = Array.from({ length: 51 }, (_, index) => ({ id: index + 1 }));
        fetchMock.mockResolvedValue({
            pageInfo: { pages: 1, pageSize: 1000, results: 51, page: 1 },
            results: rows,
            jellyfinCanopyPagination: { contract: 'media-relation-owner', totalExact: true },
        });

        const result = await JC.seerrAPI!.fetchIssuesForMedia(42, 'movie', {
            all: true,
            filter: 'all',
        });

        const [url] = fetchMock.mock.calls[0] as [string];
        expect(url).toContain('take=1000');
        expect(url).toContain('skip=0');
        expect(result.results).toHaveLength(51);
        expect(result.pageInfo.results).toBe(51);
    });

    it('rejects non-canonical media coordinates before constructing an owner path', async () => {
        const result = await JC.seerrAPI!.fetchIssuesForMedia('../issue', 'movie');

        expect(result.results).toEqual([]);
        expect(result.pageInfo.results).toBe(0);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps an upstream owner failure distinguishable from an exact empty title', async () => {
        fetchMock.mockRejectedValue(new Error('Seerr unavailable'));

        await expect(JC.seerrAPI!.fetchIssuesForMedia(42, 'movie'))
            .rejects.toThrow('Seerr unavailable');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects a malformed projection instead of treating missing rows as zero issues', async () => {
        fetchMock.mockResolvedValue({ results: [] });

        await expect(JC.seerrAPI!.fetchIssuesForMedia(42, 'movie'))
            .rejects.toThrow(/incomplete title issue projection/i);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects a stale owner lookup instead of issuing its issue query as the next identity', async () => {
        let resolveProjection!: (value: unknown) => void;
        fetchMock.mockImplementationOnce(
            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- deferred identity-race fixture
            () => new Promise((resolve) => { resolveProjection = resolve; }),
        );

        const pending = JC.seerrAPI!.fetchIssuesForMedia(42, 'movie');
        JC.identity.transition('server-b', 'user-b', 'seerr-issue-owner-race');
        resolveProjection({ results: [] });

        await expect(pending).rejects.toThrow(/stale identity/i);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
