import { beforeAll, describe, expect, it } from 'vitest';
import { JC } from '../../globals';

describe('Seerr more-info download bars privacy', () => {
    let internal: Record<string, any>;

    beforeAll(async () => {
        JC.t = (key: string) => key;
        JC.escapeHtml = (value: unknown) => String(value);
        JC.seerrUI = {
            formatEtaText: () => 'Estimated in 5 min',
        };
        const shared = await import('./internal');
        internal = shared.internal;
        await import('./badges');
    });

    it('does not render raw fields outside the normalized projection', () => {
        const bars = internal.buildDownloadBars([{
            lifecycle: 'warning',
            progress: 25,
            timeRemaining: '00:05:00',
            seasonNumber: null,
            title: 'Private.Release.Name-GROUP',
            downloadId: 'private-job',
            path: '/downloads/private/movie.mkv',
            status: 'private status message',
        }], []) as HTMLElement;

        expect(bars).toBeInstanceOf(HTMLElement);
        expect(bars.textContent).toContain('downloads_lifecycle_warning');
        expect(bars.textContent).toContain('25%');
        expect(bars.textContent).toContain('Estimated in 5 min');
        expect(bars.innerHTML).not.toContain('Private.Release.Name-GROUP');
        expect(bars.innerHTML).not.toContain('private-job');
        expect(bars.innerHTML).not.toContain('/downloads/private');
        expect(bars.innerHTML).not.toContain('private status message');
    });
});
