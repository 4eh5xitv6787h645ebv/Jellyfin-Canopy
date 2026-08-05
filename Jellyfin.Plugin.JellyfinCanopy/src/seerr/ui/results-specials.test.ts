import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';

describe('Seerr search-card Specials status projection', () => {
    let internal: Record<string, any>;
    let fetchRequestSettings: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
        JC.t = (key: string) => key;
        JC.escapeHtml = (value: unknown) => String(value);
        JC.pluginConfig = {
            SeerrEnable4KRequests: true,
            SeerrEnable4KTvRequests: true,
        };
        const { installSeerrStatus } = await import('../seerr-status');
        installSeerrStatus();
        const uiModule = await import('./internal');
        uiModule.installSeerrUiFacade();
        internal = uiModule.internal;
        internal.icons = new Proxy({}, { get: () => '' });
        internal.addDownloadProgressHover = vi.fn();
        internal.hide4KPopup = vi.fn();
        internal.show4KPopup = vi.fn();
        await import('./results');
        await import('./buttons');
    });

    beforeEach(() => {
        document.body.replaceChildren();
        JC.identity.transition('specials-card-server', `specials-card-user-${Math.random()}`, 'test setup');
        fetchRequestSettings = vi.fn();
        JC.seerrAPI = {
            canRequest4k: () => true,
            fetchRequestSettings,
        } as unknown as NonNullable<typeof JC.seerrAPI>;
    });

    function configure(seasons: Array<{ seasonNumber: number; status: number }>): HTMLButtonElement {
        const button = document.createElement('button');
        document.body.appendChild(button);
        internal.configureRequestButton(button, {
            id: 674,
            mediaType: 'tv',
            name: 'Specials fixture',
            mediaInfo: { status: 5, status4k: 1, seasons },
        }, true, true);
        return button;
    }

    it('keeps an available regular season available when Specials is unknown', () => {
        const analysis = internal.analyzeSeasonStatuses([
            { seasonNumber: 0, status: 1 },
            { seasonNumber: 1, status: 5 },
        ]);

        expect(analysis).toMatchObject({ overallStatus: 5, total: 1, availableCount: 1 });
        expect(analysis.specialsOnly).toBeUndefined();

        const button = configure([
            { seasonNumber: 0, status: 1 },
            { seasonNumber: 1, status: 5 },
        ]);
        expect(button.textContent).toContain('seerr_btn_available');
        expect(button.disabled).toBe(true);
        expect(document.querySelector('.seerr-split-arrow')).not.toBeNull();
        expect(fetchRequestSettings).not.toHaveBeenCalled();
    });

    it('renders unknown Specials-only search data as a disabled detail-owned request', () => {
        const analysis = internal.analyzeSeasonStatuses([{ seasonNumber: 0, status: 1 }]);
        expect(analysis).toEqual({
            overallStatus: 1,
            statusSummary: null,
            total: 0,
            specialsOnly: true,
        });

        const button = configure([{ seasonNumber: 0, status: 1 }]);
        expect(button.textContent).toContain('seerr_btn_request');
        expect(button.disabled).toBe(true);
        expect(button.classList).toContain('seerr-button-request');
        expect(document.querySelector('.seerr-split-arrow')).toBeNull();
        expect(fetchRequestSettings).not.toHaveBeenCalled();
    });

    it('preserves an available Specials-only status without a request or 4K affordance', () => {
        const analysis = internal.analyzeSeasonStatuses([{ seasonNumber: 0, status: 5 }]);
        expect(analysis).toMatchObject({ overallStatus: 5, specialsOnly: true });

        const button = configure([{ seasonNumber: 0, status: 5 }]);
        expect(button.textContent).toContain('seerr_btn_available');
        expect(button.disabled).toBe(true);
        expect(button.classList).toContain('seerr-button-available');
        expect(document.querySelector('.seerr-split-arrow')).toBeNull();
        expect(fetchRequestSettings).not.toHaveBeenCalled();
    });
});
