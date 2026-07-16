import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';

describe('Seerr results identity placement', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        document.body.innerHTML = '<div id="searchPage"></div>';
        JC.identity.transition('server-a', 'user-a', 'seerr-results-test-start');
        JC.t = (key: string) => key;
        JC.seerrStatus = { MEDIA: {} } as NonNullable<typeof JC.seerrStatus>;
        JC.seerrUI = {};
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('cancels A detached placement so it cannot insert into B', async () => {
        const { installSeerrUiFacade } = await import('./internal');
        await import('./results');
        installSeerrUiFacade();
        JC.seerrUI!.renderSeerrResults([], 'account-a', false, true, true);
        expect(document.querySelector('.seerr-section')).toBeNull();

        JC.identity.transition('server-a', 'user-b', 'account-switch');
        const anchor = document.createElement('div');
        anchor.className = 'verticalSection';
        anchor.innerHTML = '<h2 class="sectionTitle">Movies</h2>';
        document.getElementById('searchPage')!.appendChild(anchor);
        await vi.advanceTimersByTimeAsync(1500);

        expect(document.querySelector('.seerr-section')).toBeNull();
    });
});
