import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('season modal refresh lifecycle', () => {
    let fetchTvShowDetails: ReturnType<typeof vi.fn>;
    let fetchTvSeasonDetails: ReturnType<typeof vi.fn>;
    let modalRecords: Array<{ options: any; modalElement: HTMLElement }>;

    function tvDetails(activeRequest = false, includeAirDate = true) {
        return {
            name: 'Example Show',
            seasons: [{
                seasonNumber: 1,
                episodeCount: 8,
                name: 'Season 1',
                ...(includeAirDate ? { airDate: '2026-01-01' } : {}),
            }],
            mediaInfo: {
                status: 1,
                status4k: 1,
                seasons: [{ seasonNumber: 1, status: 1, status4k: 1 }],
                requests: activeRequest ? [{
                    id: 10,
                    is4k: false,
                    status: 2,
                    seasons: [{ seasonNumber: 1, status: 2 }],
                }] : [],
                downloadStatus: [],
                downloadStatus4k: [],
            },
        };
    }

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        document.body.innerHTML = '';
        modalRecords = [];
        fetchTvShowDetails = vi.fn();
        fetchTvSeasonDetails = vi.fn().mockResolvedValue(null);

        const jc = window.JellyfinCanopy as unknown as Record<string, any>;
        jc.seerrUI = {};
        jc.pluginConfig = { SeerrShowAdvanced: false, TmdbEnabled: false };
        jc.t = (key: string) => key;
        jc.toast = vi.fn();

        await import('../../core/ui-kit');
        await import('../seerr-status');
        const { internal } = await import('./internal');
        internal.buildQuotaChip = vi.fn(() => null);
        internal.createInlineProgress = vi.fn(() => null);
        internal.markCardRequested = vi.fn();
        internal.handleRequestError = vi.fn();

        jc.seerrAPI = {
            fetchRequestSettings: vi.fn().mockResolvedValue({
                available: true,
                partialRequestsEnabled: true,
                enableSpecialEpisodes: false,
            }),
            fetchTvShowDetails,
            fetchTvSeasonDetails,
            fetchTmdbTvDetails: vi.fn().mockResolvedValue(null),
            fetchAdvancedRequestData: vi.fn(),
            fetchUserQuota: vi.fn().mockResolvedValue(null),
            requestTvSeasons: vi.fn(),
            requestMedia: vi.fn(),
        };
        jc.seerrModal = {
            createAdvancedOptionsHTML: vi.fn(() => ''),
            populateAdvancedOptions: vi.fn(),
            create: vi.fn((options: any) => {
                const modalElement = document.createElement('div');
                modalElement.innerHTML = `<div class="seerr-modal-body">${options.bodyHtml}</div>`;
                document.body.appendChild(modalElement);
                modalRecords.push({ options, modalElement });
                return { modalElement, show: vi.fn() };
            }),
        };

        await import('./season-modal');
    });

    afterEach(() => {
        for (const record of modalRecords) {
            record.options.onClose?.();
            record.modalElement.remove();
        }
        vi.clearAllTimers();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    async function openModal() {
        const jc = window.JellyfinCanopy as unknown as Record<string, any>;
        await jc.seerrUI.showSeasonSelectionModal(123, 'tv', 'Example Show');
        return modalRecords.at(-1)!;
    }

    async function flushMicrotasks() {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    }

    it('polls through the fresh contract and applies the newer request state', async () => {
        fetchTvShowDetails
            .mockResolvedValueOnce(tvDetails(false))
            .mockResolvedValueOnce(tvDetails(true));
        const modal = await openModal();

        expect(fetchTvShowDetails.mock.calls[0][1]).toEqual(expect.objectContaining({
            signal: expect.any(AbortSignal),
        }));
        await vi.advanceTimersByTimeAsync(10_000);

        expect(fetchTvShowDetails).toHaveBeenCalledTimes(2);
        expect(fetchTvShowDetails.mock.calls[1][1]).toEqual(expect.objectContaining({
            fresh: true,
            signal: expect.any(AbortSignal),
        }));
        const checkbox = modal.modalElement.querySelector<HTMLInputElement>('.seerr-season-item .seerr-season-checkbox')!;
        expect(checkbox.disabled).toBe(true);
        expect(modal.modalElement.querySelector('.seerr-season-status')?.textContent)
            .toBe('seerr_season_status_requested');
    });

    it('serializes polls and ignores an in-flight result after the modal closes', async () => {
        let resolvePoll!: (details: any) => void;
        const pendingPoll = new Promise<any>((resolve) => { resolvePoll = resolve; });
        fetchTvShowDetails
            .mockResolvedValueOnce(tvDetails(false))
            .mockReturnValueOnce(pendingPoll);
        const modal = await openModal();

        await vi.advanceTimersByTimeAsync(10_000);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fetchTvShowDetails).toHaveBeenCalledTimes(2);

        const pollSignal = fetchTvShowDetails.mock.calls[1][1].signal as AbortSignal;
        modal.options.onClose();
        modal.modalElement.remove();
        expect(pollSignal.aborted).toBe(true);
        resolvePoll(tvDetails(true));
        await flushMicrotasks();

        expect(fetchTvShowDetails).toHaveBeenCalledTimes(2);
        expect(modal.modalElement.querySelector<HTMLInputElement>('.seerr-season-item .seerr-season-checkbox')?.disabled)
            .toBe(false);
    });

    it('aborts a superseded modal generation and does not apply its late poll', async () => {
        let resolveOldPoll!: (details: any) => void;
        const oldPoll = new Promise<any>((resolve) => { resolveOldPoll = resolve; });
        fetchTvShowDetails
            .mockResolvedValueOnce(tvDetails(false))
            .mockReturnValueOnce(oldPoll)
            .mockResolvedValueOnce(tvDetails(false));
        const oldModal = await openModal();
        await vi.advanceTimersByTimeAsync(10_000);
        const oldSignal = fetchTvShowDetails.mock.calls[1][1].signal as AbortSignal;

        const newModal = await openModal();
        expect(oldSignal.aborted).toBe(true);
        resolveOldPoll(tvDetails(true));
        await flushMicrotasks();

        expect(oldModal.modalElement.querySelector<HTMLInputElement>('.seerr-season-item .seerr-season-checkbox')?.disabled)
            .toBe(false);
        expect(newModal.modalElement.querySelector<HTMLInputElement>('.seerr-season-item .seerr-season-checkbox')?.disabled)
            .toBe(false);
    });

    it('does not let delayed initial air-date backfill restore stale request state', async () => {
        let resolveSeasonDetail!: (details: any) => void;
        fetchTvSeasonDetails.mockReturnValueOnce(new Promise<any>((resolve) => {
            resolveSeasonDetail = resolve;
        }));
        fetchTvShowDetails
            .mockResolvedValueOnce(tvDetails(false, false))
            .mockResolvedValueOnce(tvDetails(true, false));
        const modal = await openModal();

        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetchTvShowDetails).toHaveBeenCalledTimes(2);
        const seasonList = modal.modalElement.querySelector('.seerr-season-list');
        const initialPollState = {
            disabled: modal.modalElement.querySelector<HTMLInputElement>('.seerr-season-item .seerr-season-checkbox')?.disabled,
            status: modal.modalElement.querySelector('.seerr-season-status')?.textContent,
            valid: seasonList ? Reflect.get(seasonList, '_requestStateValid') : undefined,
        };
        expect(initialPollState).toEqual({
            disabled: true,
            status: 'seerr_season_status_requested',
            valid: true,
        });

        resolveSeasonDetail({ episodes: [{ airDate: '2026-02-02' }] });
        await flushMicrotasks();

        expect(modal.modalElement.querySelector<HTMLInputElement>('.seerr-season-item .seerr-season-checkbox')?.disabled)
            .toBe(true);
        expect(modal.modalElement.querySelector('.seerr-season-status')?.textContent)
            .toBe('seerr_season_status_requested');
    });
});
