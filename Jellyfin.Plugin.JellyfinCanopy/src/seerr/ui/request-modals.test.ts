import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('collection request modal rich cards', () => {
    let createOptions!: Record<string, any>;
    let modalElement!: HTMLElement;
    let requestMedia: ReturnType<typeof vi.fn>;
    const searchResultItem = { id: 10, mediaType: 'collection' };

    const collectionDetails = {
        name: 'Fixture Collection',
        parts: [
            {
                id: 101,
                title: 'A <b>Very Long</b> Movie Title',
                releaseDate: '1995-01-01',
                posterPath: null,
                mediaInfo: {
                    status: 1,
                    status4k: 1,
                    downloadStatus: [],
                    downloadStatus4k: [],
                },
            },
            {
                id: 202,
                title: 'Already in the Library',
                releaseDate: '1996-01-01',
                posterPath: null,
                mediaInfo: {
                    status: 5,
                    status4k: 1,
                    downloadStatus: [],
                    downloadStatus4k: [],
                },
            },
            {
                id: 303,
                title: 'Standard Only',
                posterPath: null,
                mediaInfo: {
                    status: 1,
                    status4k: 5,
                    downloadStatus: [],
                    downloadStatus4k: [],
                },
            },
        ],
    };

    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = '';
        document.head.querySelector('#seerr-season-styles')?.remove();

        const jc = window.JellyfinCanopy as unknown as Record<string, any>;
        jc.seerrUI = {};
        jc.pluginConfig = { SeerrShowAdvanced: false };
        jc.t = (key: string, params: Record<string, unknown> = {}) => {
            const template = ({
                seerr_season_status_not_requested: 'Not Requested',
                seerr_btn_available: 'Available',
                seerr_modal_request_collection: 'Request Collection',
                seerr_modal_request_selected_movies: 'Request Selected Movies',
                seerr_select_all_movies: 'Select All',
                seerr_collection_movie_count: 'Movies in collection: {count}',
                seerr_btn_request_4k: 'Request in 4K',
                seerr_modal_requesting: 'Requesting',
                seerr_toast_collection_requested: 'Requested',
                seerr_toast_movies: 'movies',
            } as Record<string, string>)[key] ?? key;
            return Object.entries(params).reduce(
                (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
                template,
            );
        };
        jc.escapeHtml = (value: unknown) => {
            const text = typeof value === 'string' || typeof value === 'number'
                ? String(value)
                : '';
            return text
                .replaceAll('&', '&amp;')
                .replaceAll('<', '&lt;')
                .replaceAll('>', '&gt;')
                .replaceAll('"', '&quot;')
                .replaceAll("'", '&#039;');
        };
        jc.toast = vi.fn();

        await import('../../core/ui-kit');
        const { installSeerrStatus } = await import('../seerr-status');
        installSeerrStatus();
        const { installSeerrUiFacade, internal } = await import('./internal');
        installSeerrUiFacade();
        internal.icons = {};

        requestMedia = vi.fn().mockResolvedValue({});
        jc.seerrAPI = {
            fetchCollectionDetails: vi.fn().mockResolvedValue(collectionDetails),
            requestMedia,
            fetchAdvancedRequestData: vi.fn(),
            canRequest4k: vi.fn(() => true),
        };
        jc.seerrModal = {
            createAdvancedOptionsHTML: vi.fn(() => ''),
            populateAdvancedOptions: vi.fn(),
            create: vi.fn((options: Record<string, any>) => {
                createOptions = options;
                modalElement = document.createElement('div');
                modalElement.innerHTML = `
                    <div class="seerr-season-content">
                        <div class="seerr-modal-body">${options.bodyHtml}</div>
                        <div class="seerr-modal-footer"></div>
                    </div>
                `;
                document.body.appendChild(modalElement);
                return { modalElement, show: vi.fn() };
            }),
        };

        await import('./request-modals');
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    async function openModal(): Promise<HTMLElement> {
        const jc = window.JellyfinCanopy as unknown as Record<string, any>;
        await jc.seerrUI.showCollectionRequestModal(
            10,
            'Fixture Collection',
            searchResultItem,
        );
        return modalElement;
    }

    it('renders labeled rich cards with inline metadata and preserves row data contracts', async () => {
        const modal = await openModal();
        const rows = modal.querySelectorAll<HTMLLabelElement>('.seerr-collection-movie-row');
        const firstRow = rows[0];
        const firstCheckbox = firstRow.querySelector<HTMLInputElement>('.seerr-collection-checkbox')!;
        const meta = firstRow.querySelector<HTMLElement>('.seerr-collection-movie-meta')!;

        expect(rows).toHaveLength(3);
        const selectAll = modal.querySelector<HTMLInputElement>('#seerr-select-all-movies')!;
        const collectionCount = modal.querySelector<HTMLElement>('#seerr-collection-movie-count')!;
        expect(collectionCount.textContent).toBe('Movies in collection: 3');
        expect(selectAll.getAttribute('aria-describedby')).toBe(collectionCount.id);
        expect(firstRow.tagName).toBe('LABEL');
        expect(firstCheckbox.labels?.[0]).toBe(firstRow);
        expect(firstRow.querySelector('.title')?.textContent).toBe('A <b>Very Long</b> Movie Title');
        expect(firstRow.querySelector('b')).toBeNull();
        expect(firstRow.querySelector<HTMLImageElement>('.seerr-collection-movie-poster')?.alt).toBe('');
        expect(meta.querySelector('.year')?.textContent).toBe('1995');
        expect(meta.querySelector('.seerr-collection-meta-separator')?.textContent).toBe('·');
        expect(meta.querySelector('.seerr-season-status')?.textContent).toBe('Not Requested');

        expect(firstRow.dataset).toMatchObject({
            status: '1',
            status4k: '1',
            hasDownloads: '0',
            hasDownloads4k: '0',
        });
        expect(firstCheckbox.dataset.tmdbId).toBe('101');
        expect(firstCheckbox.checked).toBe(true);
        expect(firstCheckbox.disabled).toBe(false);

        const availableCheckbox = rows[1].querySelector<HTMLInputElement>('.seerr-collection-checkbox')!;
        expect(availableCheckbox.dataset.tmdbId).toBe('202');
        expect(availableCheckbox.checked).toBe(false);
        expect(availableCheckbox.disabled).toBe(true);
        expect(rows[1].querySelector('.seerr-season-status')?.classList
            .contains('seerr-season-status-available')).toBe(true);
        expect(rows[2].querySelector('.year')).toBeNull();
        expect(rows[2].querySelector('.seerr-collection-meta-separator')).toBeNull();
    });

    it('uses the whole enabled card as the tap target while disabled cards stay inert', async () => {
        const modal = await openModal();
        const rows = modal.querySelectorAll<HTMLLabelElement>('.seerr-collection-movie-row');
        const selectAll = modal.querySelector<HTMLInputElement>('#seerr-select-all-movies')!;
        const enabledCheckbox = rows[0].querySelector<HTMLInputElement>('.seerr-collection-checkbox')!;
        const disabledCheckbox = rows[1].querySelector<HTMLInputElement>('.seerr-collection-checkbox')!;

        expect(selectAll.checked).toBe(true);
        rows[0].querySelector<HTMLElement>('.title')!.click();
        expect(enabledCheckbox.checked).toBe(false);
        expect(selectAll.checked).toBe(false);
        expect(selectAll.indeterminate).toBe(true);

        rows[0].querySelector<HTMLElement>('.seerr-season-status')!.click();
        expect(enabledCheckbox.checked).toBe(true);
        expect(selectAll.checked).toBe(true);
        expect(selectAll.indeterminate).toBe(false);

        rows[1].querySelector<HTMLElement>('.seerr-collection-movie-poster')!.click();
        expect(disabledCheckbox.checked).toBe(false);
    });

    it('uses an existing localized movie label when a cached locale predates the count key', async () => {
        const jc = window.JellyfinCanopy as unknown as Record<string, any>;
        const translate = jc.t as (key: string, params?: Record<string, unknown>) => string;
        jc.t = (key: string, params: Record<string, unknown> = {}) => (
            key === 'seerr_collection_movie_count' ? key : translate(key, params)
        );

        const modal = await openModal();
        const selectAll = modal.querySelector<HTMLInputElement>('#seerr-select-all-movies')!;
        const collectionCount = modal.querySelector<HTMLElement>('#seerr-collection-movie-count')!;

        expect(collectionCount.textContent).toBe('3 movies');
        expect(collectionCount.textContent).not.toContain('seerr_collection_movie_count');
        expect(selectAll.getAttribute('aria-describedby')).toBe(collectionCount.id);
    });

    it('re-evaluates 4K state from the existing datasets without restoring manual deselections', async () => {
        const modal = await openModal();
        const rows = modal.querySelectorAll<HTMLLabelElement>('.seerr-collection-movie-row');
        const collectionCount = modal.querySelector<HTMLElement>('#seerr-collection-movie-count')!;
        const alwaysSelectable = rows[0].querySelector<HTMLInputElement>('.seerr-collection-checkbox')!;
        const enabledOnlyIn4k = rows[1].querySelector<HTMLInputElement>('.seerr-collection-checkbox')!;
        const disabledIn4k = rows[2].querySelector<HTMLInputElement>('.seerr-collection-checkbox')!;

        rows[0].querySelector<HTMLElement>('.title')!.click();
        expect(alwaysSelectable.checked).toBe(false);

        modal.querySelector<HTMLInputElement>('#seerr-collection-4k')!.click();

        expect(collectionCount.textContent).toBe('Movies in collection: 3');
        expect(alwaysSelectable.disabled).toBe(false);
        expect(alwaysSelectable.checked).toBe(false);
        expect(enabledOnlyIn4k.disabled).toBe(false);
        expect(enabledOnlyIn4k.checked).toBe(true);
        expect(rows[1].querySelector('.seerr-season-status')?.classList
            .contains('seerr-season-status-not-requested')).toBe(true);
        expect(disabledIn4k.disabled).toBe(true);
        expect(disabledIn4k.checked).toBe(false);
        expect(rows[2].querySelector('.seerr-season-status')?.classList
            .contains('seerr-season-status-available')).toBe(true);
    });

    it('submits only checked enabled movie ids and preserves the 4K request contract', async () => {
        const modal = await openModal();
        const rows = modal.querySelectorAll<HTMLLabelElement>('.seerr-collection-movie-row');
        const requestButton = document.createElement('button');
        const close = vi.fn();

        modal.querySelector<HTMLInputElement>('#seerr-collection-4k')!.click();
        rows[0].querySelector<HTMLElement>('.title')!.click();

        await createOptions.onSave(modal, requestButton, close);

        expect(requestMedia).toHaveBeenCalledTimes(1);
        expect(requestMedia).toHaveBeenCalledWith(
            202,
            'movie',
            {},
            true,
            searchResultItem,
        );
        expect(close).toHaveBeenCalledOnce();
    });
});
