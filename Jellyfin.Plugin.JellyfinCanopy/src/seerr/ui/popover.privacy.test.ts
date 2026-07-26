import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JC } from '../../globals';

interface PopoverInternal {
    state: {
        seerrHoverPopover: HTMLElement | null;
    };
    fillHoverPopover(item: unknown): HTMLElement | null;
}

describe('Seerr download popover privacy', () => {
    let internal: PopoverInternal;

    beforeAll(async () => {
        JC.t = (key: string, params?: Record<string, unknown>) => {
            if (key === 'downloads_eta_minutes') {
                return `localized ETA ${String(params?.count)} minutes`;
            }
            return key;
        };
        JC.escapeHtml = (value: unknown) => String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;');
        const shared = await import('./internal');
        internal = shared.internal as unknown as PopoverInternal;
        await import('./popover');
    });

    beforeEach(() => {
        document.body.replaceChildren();
        internal.state.seerrHoverPopover = null;
    });

    it('renders only normalized lifecycle data even if extra raw fields are present', () => {
        const popover = internal.fillHoverPopover({
            mediaInfo: {
                downloadStatus: [{
                    lifecycle: 'downloading',
                    progress: 75,
                    timeRemaining: '00:15:00',
                    seasonNumber: null,
                    title: 'Private.Release.Name-GROUP',
                    downloadId: 'private-job',
                    path: '/downloads/private/movie.mkv',
                    status: 'private status message',
                }],
                downloadStatus4k: [],
            },
        });

        expect(popover).toBeInstanceOf(HTMLElement);
        expect(popover?.textContent).toContain('downloads_lifecycle_downloading');
        expect(popover?.textContent).toContain('75%');
        expect(popover?.textContent).toContain('localized ETA 15 minutes');
        expect(popover?.innerHTML).not.toContain('Private.Release.Name-GROUP');
        expect(popover?.innerHTML).not.toContain('private-job');
        expect(popover?.innerHTML).not.toContain('/downloads/private');
        expect(popover?.innerHTML).not.toContain('private status message');
    });
});
