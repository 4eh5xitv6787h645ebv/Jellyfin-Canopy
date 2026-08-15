import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JC } from '../../globals';
import '../../core/ui-kit';
import { internal } from './internal';
import './data';
import './badges';
import './render';

describe('Seerr More Info effective region', () => {
    beforeEach(() => {
        const context = JC.identity.capture()!;
        JC.pluginConfig = { TmdbEnabled: true, DEFAULT_REGION: 'ZZ' };
        JC.userConfig = JC.identity.own({
            elsewhere: JC.identity.own({ Region: 'zz' }, context),
        }, context);
        JC.t = (key: string) => key;
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('uses US rather than unsupported persisted codes for ratings and providers', () => {
        const data = {
            title: 'Region test',
            releases: {
                results: [
                    { iso_3166_1: 'ZZ', release_dates: [{ type: 3, certification: 'WRONG' }] },
                    { iso_3166_1: 'US', release_dates: [{ type: 3, certification: 'PG' }] },
                ],
            },
            watchProviders: [
                { iso_3166_1: 'ZZ', flatrate: [{ id: 1, name: 'Wrong', logoPath: '/wrong.png' }] },
                { iso_3166_1: 'US', flatrate: [{ id: 2, name: 'Fallback', logoPath: '/us.png' }] },
            ],
        };

        expect(internal.getContentRating(data, 'movie')).toBe('PG');

        const host = document.createElement('div');
        host.innerHTML = internal.buildModalContent(data, 'movie');
        expect(host.querySelector<HTMLImageElement>('.jc-more-info-providers-list img')?.alt)
            .toBe('Fallback');
        expect(host.textContent).not.toContain('Wrong');
    });
});
