import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('more-info unrequested-season per-title request state', () => {
    let ajax: ReturnType<typeof vi.fn>;
    let checkForUnrequestedSeasons: (data: unknown) => Promise<boolean>;
    let buildSeasonAvailabilityLinks: (seasonInfo: unknown, normalId?: string | null, fourKId?: string | null) => string;
    let getSeasonStatusInfo: (data: unknown, seasonNumber: unknown) => any;
    let fetchJellyfinSeasonMap: (seriesId: unknown) => Promise<Record<number, any>>;
    let buildSeasonsSection: (data: unknown) => string;

    beforeEach(async () => {
        vi.resetModules();
        ajax = vi.fn();
        const client = ApiClient as unknown as Record<string, unknown>;
        client.ajax = ajax;
        client.getUrl = (path: string) => `http://jellyfin.test${path}`;
        client.getCurrentUserId = () => 'test-user-id';

        const { installSeerrStatus } = await import('../seerr-status');
        installSeerrStatus();
        const { internal } = await import('./internal');
        await import('./seasons');
        checkForUnrequestedSeasons = internal.checkForUnrequestedSeasons as typeof checkForUnrequestedSeasons;
        buildSeasonAvailabilityLinks = internal.buildSeasonAvailabilityLinks as typeof buildSeasonAvailabilityLinks;
        getSeasonStatusInfo = internal.getSeasonStatusInfo as typeof getSeasonStatusInfo;
        fetchJellyfinSeasonMap = internal.fetchJellyfinSeasonMap as typeof fetchJellyfinSeasonMap;
        buildSeasonsSection = internal.buildSeasonsSection as typeof buildSeasonsSection;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('uses the complete per-title relation without scanning global request history', async () => {
        const requests = Array.from({ length: 5_000 }, (_, index) => ({
            id: index + 1,
            type: 'tv',
            is4k: false,
            status: 2,
            seasons: [{ seasonNumber: 2, status: 2 }],
        }));
        requests.push({
            id: 5_001,
            type: 'tv',
            is4k: false,
            status: 2,
            seasons: [{ seasonNumber: 1, status: 2 }],
        });

        await expect(checkForUnrequestedSeasons({
            id: 42,
            seasons: [{ seasonNumber: 1, episodeCount: 10 }],
            mediaInfo: { requests, seasons: [] },
        })).resolves.toBe(false);

        expect(ajax).not.toHaveBeenCalled();
    });

    it('blocks a season covered by another user\'s active normal request', async () => {
        await expect(checkForUnrequestedSeasons({
            id: 42,
            seasons: [{ seasonNumber: 1, episodeCount: 10 }],
            mediaInfo: {
                requests: [{
                    id: 1,
                    type: 'tv',
                    is4k: false,
                    status: 2,
                    requestedBy: { id: 999 },
                    seasons: [{ seasonNumber: 1, status: 2 }],
                }],
                seasons: [],
            },
        })).resolves.toBe(false);
        expect(ajax).not.toHaveBeenCalled();
    });

    it('does not confuse a declined request status with processing media', async () => {
        await expect(checkForUnrequestedSeasons({
            id: 42,
            seasons: [{ seasonNumber: 1, episodeCount: 10 }],
            mediaInfo: {
                requests: [{
                    id: 1,
                    type: 'tv',
                    is4k: false,
                    status: 3,
                    seasons: [{ seasonNumber: 1, status: 3 }],
                }],
                seasons: [],
            },
        })).resolves.toBe(true);
        expect(ajax).not.toHaveBeenCalled();
    });

    it('does not let a 4K-only request suppress the normal request path', async () => {
        await expect(checkForUnrequestedSeasons({
            id: 42,
            seasons: [{ seasonNumber: 1, episodeCount: 10 }],
            mediaInfo: {
                requests: [{
                    id: 1,
                    type: 'tv',
                    is4k: true,
                    status: 2,
                    seasons: [{ seasonNumber: 1, status: 2 }],
                }],
                seasons: [],
            },
        })).resolves.toBe(true);
        expect(ajax).not.toHaveBeenCalled();
    });

    it('keeps raw AVAILABLE fail-closed without a viewer-scoped Jellyfin absence query', async () => {
        await expect(checkForUnrequestedSeasons({
            id: 42,
            seasons: [{ seasonNumber: 1, episodeCount: 10 }],
            mediaInfo: {
                requests: [],
                seasons: [{ seasonNumber: 1, status: 5, status4k: 5 }],
                jellyfinMediaId: 'shared-series',
                jellyfinMediaId4k: 'shared-series',
            },
        })).resolves.toBe(false);
        expect(ajax).not.toHaveBeenCalled();
    });

    it('renders authoritative AVAILABLE status without inventing a Jellyfin link', () => {
        const html = buildSeasonAvailabilityLinks({ status: 5 }, null, null);

        expect(html).toContain('<span class="season-link-chip available">Available</span>');
        expect(html).not.toContain('href=');
    });

    it('retains Specials season 0 status and its Jellyfin detail link', () => {
        const specialsInfo = {
            seasonNumber: 0,
            status: 5,
            status4k: 1,
            jellyfinMediaId: 'specials-season-id',
        };
        const data = {
            seasons: [{ seasonNumber: 0, episodeCount: 3, name: 'Specials' }],
            mediaInfo: { seasons: [specialsInfo] },
        };

        expect(getSeasonStatusInfo(data, 0)).toBe(specialsInfo);
        expect(getSeasonStatusInfo(data, null)).toBeNull();
        const html = buildSeasonsSection(data);
        expect(html).toContain('data-season-number="0"');
        expect(html).toContain('href="#!/details?id=specials-season-id"');
        expect(html).toContain('season-link-chip available');
    });

    it('includes Specials season 0 in the Jellyfin season map', async () => {
        ajax.mockResolvedValue({
            Items: [
                { Id: 'malformed-season-id', IndexNumber: null, Name: 'Malformed' },
                { Id: 'specials-season-id', IndexNumber: 0, Name: 'Specials' },
            ],
        });

        await expect(fetchJellyfinSeasonMap('series-id')).resolves.toEqual({
            0: { id: 'specials-season-id', name: 'Specials' },
        });
    });

    it('treats an absent media record as a title with no prior requests', async () => {
        await expect(checkForUnrequestedSeasons({
            id: 42,
            seasons: [{ seasonNumber: 1, episodeCount: 10 }],
        })).resolves.toBe(true);
        expect(ajax).not.toHaveBeenCalled();
    });

    it.each([
        {},
        { requests: null },
        { requests: [], seasons: null },
        { requests: [{ id: 1, type: 'movie', is4k: false, status: 2, seasons: [] }], seasons: [] },
        { requests: [{ id: 1, type: 'tv', status: 2, seasons: [] }], seasons: [] },
        { requests: [{ id: 1, type: 'tv', is4k: false, status: 99, seasons: [] }], seasons: [] },
        { requests: [{ id: 1, type: 'tv', is4k: false, status: 2, seasons: [{ seasonNumber: 1, status: 99 }] }], seasons: [] },
        { requests: [], seasons: [{ seasonNumber: 1, status: 99 }] },
    ])('fails closed when per-title request state is malformed', async (mediaInfo) => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await expect(checkForUnrequestedSeasons({
            id: 42,
            seasons: [{ seasonNumber: 1, episodeCount: 10 }],
            mediaInfo,
        })).resolves.toBe(false);
        expect(log).toHaveBeenCalledTimes(1);
        expect(ajax).not.toHaveBeenCalled();
    });
});
