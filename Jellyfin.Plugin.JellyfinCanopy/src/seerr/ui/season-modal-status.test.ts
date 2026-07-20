import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('season modal status domains', () => {
    let internal: Record<string, any>;

    beforeEach(async () => {
        vi.resetModules();
        const client = ApiClient as unknown as Record<string, any>;
        client.getCurrentUserId = vi.fn(() => 'jellyfin-user');
        client.getUrl = vi.fn((path: string, query: Record<string, unknown>) =>
            `${path}?ParentId=${String(query.ParentId)}`);
        client.ajax = vi.fn().mockResolvedValue({ Items: [] });

        await import('../../core/ui-kit');
        const { installSeerrStatus } = await import('../seerr-status');
        installSeerrStatus();
        const module = await import('./internal');
        internal = module.internal;
        await import('./season-modal');
        const jc = window.JellyfinCanopy as unknown as Record<string, any>;
        jc.t = (key: string) => key;
    });

    function renderSeason(options: {
        host?: HTMLElement;
        requestStatus?: number;
        requestIs4k?: boolean;
        mediaStatus?: number;
        mediaStatus4k?: number;
        is4kMode?: boolean;
        downloads?: boolean;
        jellyfinMediaId?: string;
        rawMediaInfo?: any;
        rootSeasons?: any;
    } = {}) {
        const host = options.host ?? document.createElement('div');
        const requests = options.requestStatus == null ? [] : [{
            id: 1,
            type: 'tv',
            is4k: options.requestIs4k ?? false,
            status: options.requestStatus,
            seasons: [{ seasonNumber: 1, status: options.requestStatus }],
        }];
        const tvDetails = {
            seasons: options.rootSeasons ?? [{ seasonNumber: 1, episodeCount: 8, name: 'Season 1' }],
            mediaInfo: options.rawMediaInfo ?? {
                status: 1,
                status4k: 1,
                seasons: [{
                    seasonNumber: 1,
                    status: options.mediaStatus ?? 1,
                    status4k: options.mediaStatus4k ?? 1,
                }],
                requests,
                jellyfinMediaId: options.is4kMode ? null : options.jellyfinMediaId,
                jellyfinMediaId4k: options.is4kMode ? options.jellyfinMediaId : null,
                downloadStatus: options.downloads && !options.is4kMode
                    ? [{ episode: { seasonNumber: 1 } }]
                    : [],
                downloadStatus4k: options.downloads && options.is4kMode
                    ? [{ episode: { seasonNumber: 1 } }]
                    : [],
            },
        };

        internal.updateSeasonList(
            host,
            tvDetails,
            true,
            false,
            options.is4kMode ?? false,
        );

        return {
            host,
            checkbox: host.querySelector<HTMLInputElement>('.seerr-season-checkbox')!,
            status: host.querySelector<HTMLElement>('.seerr-season-status')!,
            requestState: host.querySelector<HTMLElement>('.seerr-request-state'),
        };
    }

    it('blocks a pending normal request without interpreting request status 1 as unknown media', () => {
        const row = renderSeason({ requestStatus: 1 });

        expect(row.checkbox.disabled).toBe(true);
        expect(row.status.textContent).toBe('seerr_season_status_requested');
        expect(row.status.classList).toContain('seerr-season-status-processing');
        expect(row.requestState?.classList).toContain('seerr-request-state-pending');
        expect(row.requestState?.textContent).toBe('◷seerr_btn_pending');
    });

    it.each([
        { requestStatus: 3, name: 'declined', stateClass: 'declined', label: '✕seerr_btn_declined' },
        { requestStatus: 5, name: 'completed', stateClass: 'completed', label: '✓downloads_status_completed' },
    ])('keeps $name request history requestable and visible', ({ requestStatus, stateClass, label }) => {
        const row = renderSeason({ requestStatus });

        expect(row.checkbox.disabled).toBe(false);
        expect(row.status.textContent).toBe('seerr_season_status_not_requested');
        expect(row.requestState?.classList).toContain(`seerr-request-state-${stateClass}`);
        expect(row.requestState?.textContent).toBe(label);
    });

    it('blocks a failed parent request without displaying request status 4 as partial media', () => {
        const row = renderSeason({ requestStatus: 4 });

        expect(row.checkbox.disabled).toBe(true);
        expect(row.status.textContent).toBe('seerr_season_status_requested');
        expect(row.status.classList).not.toContain('seerr-season-status-partially-available');
        expect(row.requestState?.classList).toContain('seerr-request-state-failed');
        expect(row.requestState?.textContent).toBe('!downloads_status_failed');
    });

    it('separates normal and 4K active requests', () => {
        const normalRow = renderSeason({ requestStatus: 1, requestIs4k: true, is4kMode: false });
        const fourKRow = renderSeason({ requestStatus: 1, requestIs4k: true, is4kMode: true });

        expect(normalRow.checkbox.disabled).toBe(false);
        expect(fourKRow.checkbox.disabled).toBe(true);
        expect(fourKRow.status.textContent).toBe('seerr_season_status_requested');
    });

    it('preserves canonical media availability regardless of request relation order', () => {
        const partial = renderSeason({ requestStatus: 1, mediaStatus: 4 });
        const available = renderSeason({ requestStatus: 1, mediaStatus: 5, jellyfinMediaId: 'normal-series' });

        expect(partial.checkbox.disabled).toBe(true);
        expect(partial.status.textContent).toBe('seerr_season_status_partial');
        expect(available.checkbox.disabled).toBe(true);
        expect(available.status.textContent).toBe('seerr_season_status_available');
    });

    it('uses active downloads only for the selected mode display', () => {
        const row = renderSeason({ requestStatus: 2, requestIs4k: true, is4kMode: true, downloads: true });

        expect(row.checkbox.disabled).toBe(true);
        expect(row.status.textContent).toBe('seerr_season_status_processing');
        expect(row.requestState?.classList).toContain('seerr-request-state-approved');
        expect(row.requestState?.textContent).toBe('✓requests_approved_toast');
    });

    it('keeps raw AVAILABLE fail-closed even when Jellyfin link metadata is missing', () => {
        const row = renderSeason({ mediaStatus: 5 });

        expect(row.checkbox.disabled).toBe(true);
        expect(row.status.textContent).toBe('seerr_season_status_available');
    });

    it('keeps a new root season requestable when the stale TV aggregate is AVAILABLE', () => {
        const row = renderSeason({
            rawMediaInfo: {
                status: 5,
                status4k: 1,
                seasons: [],
                requests: [],
            },
        });

        expect(row.checkbox.disabled).toBe(false);
        expect(row.status.textContent).toBe('seerr_season_status_not_requested');
        expect((row.host as any)._requestStateValid).toBe(true);
        expect((row.host as any)._validatedRegularSeasonNumbers).toEqual([1]);
    });

    it('clears a selected season when refreshed request state disables it', () => {
        const initial = renderSeason();
        initial.checkbox.checked = true;

        const refreshed = renderSeason({ host: initial.host, requestStatus: 2 });

        expect(refreshed.checkbox.disabled).toBe(true);
        expect(refreshed.checkbox.checked).toBe(false);
        expect(refreshed.host.querySelectorAll('.seerr-season-checkbox:checked:not(:disabled)')).toHaveLength(0);
    });

    it('removes rows that disappear from a refreshed root season snapshot', () => {
        const initial = renderSeason();
        initial.checkbox.checked = true;

        internal.updateSeasonList(
            initial.host,
            {
                seasons: [{ seasonNumber: 2, episodeCount: 8, name: 'Season 2' }],
                mediaInfo: {
                    status: 1,
                    status4k: 1,
                    seasons: [{ seasonNumber: 2, status: 1, status4k: 1 }],
                    requests: [],
                },
            },
            true,
            false,
            false,
        );

        expect(initial.host.querySelector('[data-season-number="1"]')).toBeNull();
        expect(initial.host.querySelector('[data-season-number="2"]')).not.toBeNull();
        expect(initial.host.querySelectorAll('.seerr-season-checkbox:checked')).toHaveLength(0);
        expect((initial.host as any)._validatedRegularSeasonNumbers).toEqual([2]);
    });

    it.each([
        { name: 'string episode count', episodeCount: '8' },
        { name: 'fractional episode count', episodeCount: 1.5 },
        { name: 'negative episode count', episodeCount: -1 },
        { name: 'missing episode count', episodeCount: undefined },
    ])('fails closed for a root season with $name', ({ episodeCount }) => {
        const rootSeason: Record<string, unknown> = { seasonNumber: 1, name: 'Season 1' };
        if (episodeCount !== undefined) rootSeason.episodeCount = episodeCount;
        const row = renderSeason({ rootSeasons: [rootSeason] });

        expect((row.host as any)._requestStateValid).toBe(false);
        expect((row.host as any)._validatedRegularSeasonNumbers).toEqual([]);
        expect(row.checkbox?.disabled ?? true).toBe(true);
        expect(row.host.querySelectorAll('.seerr-season-checkbox:checked:not(:disabled)')).toHaveLength(0);
    });

    it.each([
        { name: 'object season name', field: 'name', value: {} },
        { name: 'numeric air date', field: 'airDate', value: 20260101 },
    ])('invalidates a previously selectable row for a malformed $name', ({ field, value }) => {
        const initial = renderSeason();
        initial.checkbox.checked = true;

        const malformedSeason = {
            seasonNumber: 1,
            episodeCount: 8,
            name: 'Season 1',
            airDate: '2026-01-01',
            [field]: value,
        };
        expect(() => renderSeason({
            host: initial.host,
            rootSeasons: [malformedSeason],
        })).not.toThrow();

        const checkbox = initial.host.querySelector<HTMLInputElement>('.seerr-season-checkbox')!;
        expect((initial.host as any)._requestStateValid).toBe(false);
        expect((initial.host as any)._validatedRegularSeasonNumbers).toEqual([]);
        expect(checkbox.disabled).toBe(true);
        expect(checkbox.checked).toBe(false);
    });

    it.each([
        {
            name: 'duplicate media season rows',
            mediaInfo: {
                status: 1,
                status4k: 1,
                seasons: [
                    { seasonNumber: 1, status: 1, status4k: 1 },
                    { seasonNumber: 1, status: 5, status4k: 1 },
                ],
                requests: [],
            },
        },
        {
            name: 'missing request relation',
            mediaInfo: {
                status: 1,
                status4k: 1,
                seasons: [{ seasonNumber: 1, status: 1, status4k: 1 }],
            },
        },
        {
            name: 'request missing quality flag',
            mediaInfo: {
                status: 1,
                status4k: 1,
                seasons: [{ seasonNumber: 1, status: 1, status4k: 1 }],
                requests: [{
                    id: 1,
                    status: 1,
                    seasons: [{ seasonNumber: 1, status: 1 }],
                }],
            },
        },
        {
            name: 'request missing season relation',
            mediaInfo: {
                status: 1,
                status4k: 1,
                seasons: [{ seasonNumber: 1, status: 1, status4k: 1 }],
                requests: [{ id: 1, status: 1, is4k: false }],
            },
        },
    ])('fails closed for $name', ({ mediaInfo }) => {
        const row = renderSeason({ rawMediaInfo: mediaInfo });

        expect(row.checkbox.disabled).toBe(true);
        expect(row.checkbox.checked).toBe(false);
        expect(row.status.textContent).toBe('seerr_status_blocked');
    });
});
