import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { ApiApi } from '../../types/jc';
import { internal } from './internal';
import './badges';

describe('Seerr provider icon effective region', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        const context = JC.identity.transition('region-test-server', 'region-test-user', 'region-test')!;
        JC.pluginConfig = {
            TmdbEnabled: true,
            DEFAULT_REGION: 'US',
            DEFAULT_PROVIDERS: '',
            IGNORE_PROVIDERS: '',
        };
        JC.userConfig = JC.identity.own({
            elsewhere: JC.identity.own({ Region: 'ca' }, context),
        }, context);
    });

    afterEach(() => {
        JC.identity.transition('', '', 'region-test-cleanup');
        JC.core.api = undefined;
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('reads provider icons from the viewer override rather than the admin default', async () => {
        const card = document.createElement('div');
        card.className = 'seerr-card';
        const container = document.createElement('div');
        card.appendChild(container);
        document.body.appendChild(card);
        JC.identity.own(card, JC.identity.capture());
        JC.core.api = {
            plugin: vi.fn().mockResolvedValue({
                results: {
                    US: { flatrate: [{ provider_name: 'Wrong', logo_path: '/us.png' }] },
                    CA: { flatrate: [{ provider_name: 'Right', logo_path: '/ca.png' }] },
                },
            }),
        } as unknown as ApiApi;

        await internal.fetchProviderIcons!(container, 42, 'movie');

        expect(container.querySelector('img')?.title).toBe('Right');
        expect(container.querySelector('img')?.src).toContain('/ca.png');
    });
});
