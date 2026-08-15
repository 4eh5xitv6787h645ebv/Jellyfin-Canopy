import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

const HISTORY_STATE_KEY = '__jellyfinCanopySeerrModal';

describe('Seerr advanced request server defaults', () => {
    beforeAll(async () => {
        JC.t = (key: string) => key;
        const { installSeerrModal } = await import('./modal');
        installSeerrModal();
    });

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.replaceChildren();
        JC.identity.transition('advanced-server', 'advanced-user', 'test setup');
    });

    afterEach(() => {
        JC.seerrModal?.closeAll();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    function openAdvancedOptions(
        servers: unknown[],
        variant: 'standard' | '4k' = 'standard',
        idPrefix = 'movie',
    ) {
        const modal = JC.seerrModal!.create({
            title: 'Request',
            subtitle: 'Fixture',
            bodyHtml: JC.seerrModal!.createAdvancedOptionsHTML(idPrefix),
            onSave: vi.fn(),
        });
        modal.show();
        const handle = JC.seerrModal!.populateAdvancedOptions(
            modal.modalElement,
            { servers, tags: [] },
            idPrefix,
            variant,
        );
        return { modal, handle };
    }

    it('sorts servers and selects exactly one mode-matching default', async () => {
        const { modal, handle } = openAdvancedOptions([
            {
                id: 20,
                name: 'Zulu',
                isDefault: true,
                is4k: false,
                activeProfileId: 201,
                activeDirectory: '/standard-zulu',
                qualityProfiles: [{ id: 201, name: 'Zulu profile' }],
                rootFolders: [{ path: '/standard-zulu' }],
            },
            {
                id: 10,
                name: 'Alpha 10',
                isDefault: true,
                is4k: true,
                activeProfileId: 101,
                activeDirectory: '/four-k',
                qualityProfiles: [{ id: 101, name: '4K profile' }],
                rootFolders: [{ path: '/four-k' }],
            },
            {
                id: 7,
                name: 'Alpha 2',
                isDefault: true,
                is4k: false,
                activeProfileId: 71,
                activeDirectory: '/standard-seven',
                qualityProfiles: [{ id: 71, name: 'Standard seven' }],
                rootFolders: [{ path: '/standard-seven' }],
            },
            {
                id: 2,
                name: 'Alpha 2',
                isDefault: true,
                is4k: false,
                activeProfileId: 21,
                activeDirectory: '/standard-two',
                qualityProfiles: [{ id: 21, name: 'Standard two' }],
                rootFolders: [{ path: '/standard-two' }],
            },
            {
                id: 30,
                name: 'Malformed default',
                isDefault: true,
                qualityProfiles: [{ id: 301, name: 'Wrong profile' }],
                rootFolders: [{ path: '/wrong' }],
            },
        ]);
        const server = modal.modalElement.querySelector<HTMLSelectElement>('#movie-server')!;
        const changed = vi.fn();
        server.addEventListener('change', changed);

        await vi.advanceTimersByTimeAsync(100);

        expect(Array.from(server.options, (option) => option.textContent)).toEqual([
            'Select Server...',
            'Alpha 2',
            'Alpha 2',
            'Alpha 10',
            'Malformed default',
            'Zulu',
        ]);
        expect(Array.from(server.options, (option) => option.value)).toEqual(['', '2', '7', '10', '30', '20']);
        expect(server.value).toBe('2');
        expect(modal.modalElement.querySelector<HTMLSelectElement>('#movie-quality')!.value).toBe('21');
        expect(modal.modalElement.querySelector<HTMLSelectElement>('#movie-folder')!.value).toBe('/standard-two');
        expect(changed).not.toHaveBeenCalled();

        handle.setVariant('4k');

        expect(server.value).toBe('10');
        expect(modal.modalElement.querySelector<HTMLSelectElement>('#movie-quality')!.value).toBe('101');
        expect(modal.modalElement.querySelector<HTMLSelectElement>('#movie-folder')!.value).toBe('/four-k');
        expect(changed).not.toHaveBeenCalled();

        server.value = '7';
        server.dispatchEvent(new Event('change', { bubbles: true }));

        expect(modal.modalElement.querySelector<HTMLSelectElement>('#movie-quality')!.value).toBe('71');
        expect(modal.modalElement.querySelector<HTMLSelectElement>('#movie-folder')!.value).toBe('/standard-seven');
        expect(changed).toHaveBeenCalledTimes(1);
    });

    it.each([
        { onlyVariant: 'standard' as const, initialVariant: 'standard' as const, initialValue: '1', nextVariant: '4k' as const },
        { onlyVariant: '4k' as const, initialVariant: '4k' as const, initialValue: '1', nextVariant: 'standard' as const },
    ])(
        'selects an isolated $onlyVariant default only for its exact mode',
        async ({ onlyVariant, initialVariant, initialValue, nextVariant }) => {
            const { modal, handle } = openAdvancedOptions([{
                id: 1,
                name: `${onlyVariant} only`,
                isDefault: true,
                is4k: onlyVariant === '4k',
                activeProfileId: 11,
                activeDirectory: `/${onlyVariant}`,
                qualityProfiles: [{ id: 11, name: `${onlyVariant} profile` }],
                rootFolders: [{ path: `/${onlyVariant}` }],
            }], initialVariant);

            await vi.advanceTimersByTimeAsync(100);

            const server = modal.modalElement.querySelector<HTMLSelectElement>('#movie-server')!;
            const quality = modal.modalElement.querySelector<HTMLSelectElement>('#movie-quality')!;
            const folder = modal.modalElement.querySelector<HTMLSelectElement>('#movie-folder')!;
            expect(server.value).toBe(initialValue);
            expect(quality.value).toBe('11');
            expect(folder.value).toBe(`/${onlyVariant}`);

            handle.setVariant(nextVariant);

            expect(server.value).toBe('');
            expect(quality.options).toHaveLength(1);
            expect(folder.options).toHaveLength(1);
        },
    );

    it('keeps the placeholder when default mode metadata is absent or malformed', async () => {
        const { modal, handle } = openAdvancedOptions([
            {
                id: 1,
                name: 'Missing mode',
                isDefault: true,
                qualityProfiles: [{ id: 11, name: 'Profile' }],
                rootFolders: [{ path: '/missing' }],
            },
            {
                id: 2,
                name: 'String mode',
                isDefault: true,
                is4k: 'false',
                qualityProfiles: [{ id: 21, name: 'Profile' }],
                rootFolders: [{ path: '/string' }],
            },
        ]);

        await vi.advanceTimersByTimeAsync(100);

        const server = modal.modalElement.querySelector<HTMLSelectElement>('#movie-server')!;
        const quality = modal.modalElement.querySelector<HTMLSelectElement>('#movie-quality')!;
        const folder = modal.modalElement.querySelector<HTMLSelectElement>('#movie-folder')!;
        expect(server.value).toBe('');
        expect(quality.options).toHaveLength(1);
        expect(folder.options).toHaveLength(1);

        handle.setVariant('4k');
        expect(server.value).toBe('');
        expect(quality.options).toHaveLength(1);
        expect(folder.options).toHaveLength(1);
    });

    it('ignores a retained handle after an identity transition', async () => {
        const { modal, handle } = openAdvancedOptions([{
            id: 1,
            name: 'Standard',
            isDefault: true,
            is4k: false,
            qualityProfiles: [],
            rootFolders: [],
        }]);
        const retainedServer = modal.modalElement.querySelector<HTMLSelectElement>('#movie-server')!;

        JC.identity.transition('advanced-server-b', 'advanced-user-b', 'account switch');
        handle.setVariant('4k');
        await vi.advanceTimersByTimeAsync(10_000);

        expect(retainedServer.options).toHaveLength(0);
    });

    it('makes a retained handle inert during same-identity navigation replacement', async () => {
        const stale = openAdvancedOptions([
            {
                id: 1,
                name: 'Old standard',
                isDefault: true,
                is4k: false,
                activeProfileId: 11,
                activeDirectory: '/old-standard',
                qualityProfiles: [{ id: 11, name: 'Old standard profile' }],
                rootFolders: [{ path: '/old-standard' }],
            },
            {
                id: 2,
                name: 'Old 4K',
                isDefault: true,
                is4k: true,
                activeProfileId: 21,
                activeDirectory: '/old-four-k',
                qualityProfiles: [{ id: 21, name: 'Old 4K profile' }],
                rootFolders: [{ path: '/old-four-k' }],
            },
        ]);
        await vi.advanceTimersByTimeAsync(100);

        const staleServer = stale.modal.modalElement.querySelector<HTMLSelectElement>('#movie-server')!;
        const staleQuality = stale.modal.modalElement.querySelector<HTMLSelectElement>('#movie-quality')!;
        const staleFolder = stale.modal.modalElement.querySelector<HTMLSelectElement>('#movie-folder')!;
        const modalState = history.state as Record<string, unknown>;
        const marker = modalState[HISTORY_STATE_KEY] as { hostState: unknown };
        History.prototype.replaceState.call(history, marker.hostState, '', location.href);
        window.dispatchEvent(new PopStateEvent('popstate', { state: marker.hostState }));

        expect(stale.modal.modalElement.isConnected).toBe(true);

        const replacement = openAdvancedOptions([{
            id: 3,
            name: 'Replacement standard',
            isDefault: true,
            is4k: false,
            activeProfileId: 31,
            activeDirectory: '/replacement',
            qualityProfiles: [{ id: 31, name: 'Replacement profile' }],
            rootFolders: [{ path: '/replacement' }],
        }], 'standard', 'tv');
        const replacementServer = replacement.modal.modalElement.querySelector<HTMLSelectElement>('#tv-server')!;
        await vi.advanceTimersByTimeAsync(100);
        expect(replacement.modal.modalElement.isConnected).toBe(true);
        expect(replacementServer.value).toBe('3');

        stale.handle.setVariant('4k');

        expect(staleServer.value).toBe('1');
        expect(staleQuality.value).toBe('11');
        expect(staleFolder.value).toBe('/old-standard');
        expect(replacementServer.value).toBe('3');

        await vi.advanceTimersByTimeAsync(300);
        expect(stale.modal.modalElement.isConnected).toBe(false);
        expect(replacement.modal.modalElement.isConnected).toBe(true);
    });
});
