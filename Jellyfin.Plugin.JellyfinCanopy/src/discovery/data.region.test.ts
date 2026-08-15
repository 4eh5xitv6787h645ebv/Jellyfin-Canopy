import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import type { ApiApi } from '../types/jc';
import { fetchRow } from './data';

describe('discovery effective streaming region', () => {
    beforeEach(() => {
        const context = JC.identity.capture()!;
        JC.pluginConfig = { SeerrEnabled: true, DEFAULT_REGION: 'ZZ' };
        JC.userConfig = JC.identity.own({
            elsewhere: JC.identity.own({ Region: 'zz' }, context),
        }, context);
    });

    afterEach(() => {
        JC.core.api = undefined;
        vi.restoreAllMocks();
    });

    it('never sends unsupported persisted codes as Seerr watchRegion', async () => {
        const plugin = vi.fn().mockResolvedValue({ results: [] });
        JC.core.api = { plugin } as unknown as ApiApi;

        await fetchRow({ id: 'streaming:8', kind: 'streaming', param: 8 }, 'movie');

        expect(plugin).toHaveBeenCalledWith(
            '/seerr/discover/movies?page=1&watchProviders=8&watchRegion=US',
            expect.objectContaining({
                cacheKey: 'seerr:/discover/movies?page=1&watchProviders=8&watchRegion=US',
            }),
        );
        expect(JSON.stringify(plugin.mock.calls)).not.toContain('ZZ');
    });
});
