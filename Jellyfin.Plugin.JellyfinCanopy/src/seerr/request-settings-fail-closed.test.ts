import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Seerr request settings fail closed', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    let postMock: ReturnType<typeof vi.fn>;
    let toast: ReturnType<typeof vi.fn>;
    let createModal: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.resetModules();
        fetchMock = vi.fn();
        postMock = vi.fn();
        toast = vi.fn();
        createModal = vi.fn();

        const client = ApiClient as unknown as Record<string, any>;
        client.getUrl = vi.fn((path: string) => `http://jellyfin.test${path}`);

        const jc = window.JellyfinCanopy as unknown as Record<string, any>;
        jc.core = { api: { fetch: fetchMock, plugin: postMock } };
        jc.pluginConfig = {};
        jc.t = (key: string) => key;
        jc.toast = toast;
        jc.seerrUI = {};
        jc.seerrModal = {
            create: createModal,
            createAdvancedOptionsHTML: vi.fn(() => ''),
            populateAdvancedOptions: vi.fn(),
        };

        await import('./api');
        await import('./ui/season-modal');
    });

    function jc(): Record<string, any> {
        return window.JellyfinCanopy as Record<string, any>;
    }

    it.each([
        { name: 'network failure', failure: new Error('network unavailable') },
        { name: '503 response', failure: { status: 503, message: 'Seerr unavailable' } },
    ])('does not open or POST the request modal after a cold $name', async ({ failure }) => {
        fetchMock.mockRejectedValue(failure);

        await jc().seerrUI.showSeasonSelectionModal(123, 'tv', 'Example Show');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(createModal).not.toHaveBeenCalled();
        expect(postMock).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith('seerr_toast_no_season_info', 4000);
    });

    it.each([
        null,
        {},
        { partialRequestsEnabled: 'false', enableSpecialEpisodes: false },
        { partialRequestsEnabled: false },
    ])('does not open or POST when settings payload is invalid: %j', async (payload) => {
        fetchMock.mockResolvedValue(payload);

        await jc().seerrUI.showSeasonSelectionModal(123, 'tv', 'Example Show');

        expect(createModal).not.toHaveBeenCalled();
        expect(postMock).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith('seerr_toast_no_season_info', 4000);
    });

    it('keeps a later outage unavailable instead of reusing unscoped last-good settings', async () => {
        fetchMock
            .mockResolvedValueOnce({ partialRequestsEnabled: true, enableSpecialEpisodes: true })
            .mockRejectedValueOnce(new Error('network unavailable'));

        await expect(jc().seerrAPI.fetchRequestSettings()).resolves.toEqual({
            available: true,
            partialRequestsEnabled: true,
            enableSpecialEpisodes: true,
        });
        await expect(jc().seerrAPI.fetchRequestSettings()).resolves.toEqual({ available: false });
    });

    it('distinguishes a verified false setting from unavailable settings', async () => {
        fetchMock.mockResolvedValue({ partialRequestsEnabled: false, enableSpecialEpisodes: false });

        await expect(jc().seerrAPI.fetchRequestSettings()).resolves.toEqual({
            available: true,
            partialRequestsEnabled: false,
            enableSpecialEpisodes: false,
        });
    });

    it('uses both the browser and server cache-bypass contract for a fresh TV detail', async () => {
        fetchMock.mockResolvedValue({ seasons: [] });
        const controller = new AbortController();

        await jc().seerrAPI.fetchTvShowDetails(123, {
            fresh: true,
            signal: controller.signal,
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('http://jellyfin.test/JellyfinCanopy/seerr/tv/123?fresh=true');
        expect(options).toEqual(expect.objectContaining({
            signal: controller.signal,
            skipCache: true,
            cacheKey: null,
        }));
    });
});
