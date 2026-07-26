import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { downloadsPageAvailable, fetchStatus, navigateToDownloads } from './actions';

const originalApi = JC.core.api;
const originalConfig = JC.pluginConfig;
const globalWithDownloads = JC as typeof JC & {
    downloadsPage?: { showPage: () => void };
};
const originalDownloadsPage = globalWithDownloads.downloadsPage;

describe('arr search normalized status actions', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    afterEach(() => {
        JC.core.api = originalApi;
        JC.pluginConfig = originalConfig;
        globalWithDownloads.downloadsPage = originalDownloadsPage;
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('returns the typed degraded envelope without dropping successful rows', async () => {
        const row = {
            instanceName: 'TV',
            service: 'sonarr' as const,
            lifecycle: 'waitingForImport' as const,
            section: 'processing' as const,
            reasonCode: 'transitionPending',
            progress: 100,
            timeRemaining: null,
        };
        const plugin = vi.fn().mockResolvedValue({
            items: [row],
            errors: [{ instanceName: 'Backup', reason: 'page 1: network error' }],
            isComplete: false,
        });
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;
        const controller = new AbortController();

        await expect(fetchStatus('item/id', controller.signal)).resolves.toEqual({
            items: [row],
            errors: [{ instanceName: 'Backup', reason: 'page 1: network error' }],
            isComplete: false,
        });
        expect(plugin).toHaveBeenCalledWith(
            '/arr/search/status?itemId=item%2Fid',
            { signal: controller.signal, timeoutMs: 15_000 }
        );
    });

    it('treats missing completion metadata as degraded', async () => {
        const plugin = vi.fn().mockResolvedValue({ items: [], errors: [] });
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        await expect(fetchStatus('item')).resolves.toEqual({
            items: [],
            errors: [],
            isComplete: false,
        });
    });

    it('navigates through the Downloads facade without querying a legacy nav link', () => {
        const showPage = vi.fn();
        globalWithDownloads.downloadsPage = { showPage };
        const query = vi.spyOn(document, 'querySelector');

        expect(navigateToDownloads()).toBe(true);
        expect(showPage).toHaveBeenCalledTimes(1);
        expect(query).not.toHaveBeenCalled();
    });

    it('only advertises the Downloads deep-link when the shared page is visible', () => {
        JC.pluginConfig = {
            DownloadsPageEnabled: true,
            ShowDownloadsInRequests: true,
        };
        expect(downloadsPageAvailable()).toBe(true);

        JC.pluginConfig.ShowDownloadsInRequests = false;
        expect(downloadsPageAvailable()).toBe(false);

        JC.pluginConfig = {
            DownloadsPageEnabled: false,
            ShowDownloadsInRequests: true,
        };
        expect(downloadsPageAvailable()).toBe(false);
    });
});
