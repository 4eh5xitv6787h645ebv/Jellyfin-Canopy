import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

describe('Seerr request modal identity ownership', () => {
    beforeAll(async () => {
        JC.t = (key: string) => key;
        const { installSeerrModal } = await import('./modal');
        installSeerrModal();
    });

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.replaceChildren();
        JC.identity.transition('modal-server-a', 'modal-user-a', 'test setup');
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('synchronously removes A and makes a retained A primary control inert', () => {
        const onSave = vi.fn();
        const handle = JC.seerrModal!.create({
            title: 'A title',
            subtitle: 'A subtitle',
            bodyHtml: '<div>body</div>',
            onSave,
        });
        handle.show();

        const retainedPrimary = handle.modalElement.querySelector<HTMLButtonElement>('.seerr-modal-button-primary')!;
        expect(handle.modalElement.isConnected).toBe(true);

        JC.identity.transition('modal-server-b', 'modal-user-b', 'account switch');

        expect(handle.modalElement.isConnected).toBe(false);
        expect(document.body.classList.contains('seerr-modal-is-open')).toBe(false);
        retainedPrimary.click();
        vi.runAllTimers();
        expect(onSave).not.toHaveBeenCalled();
        expect(handle.modalElement.classList.contains('show')).toBe(false);
    });

    it('cancels advanced-option polling before it can publish A data under B', () => {
        const handle = JC.seerrModal!.create({
            title: 'A title',
            subtitle: 'A subtitle',
            bodyHtml: JC.seerrModal!.createAdvancedOptionsHTML('movie'),
            onSave: vi.fn(),
        });
        handle.show();
        JC.seerrModal!.populateAdvancedOptions(handle.modalElement, {
            servers: [{ id: 1, name: 'A server', qualityProfiles: [], rootFolders: [] }],
            tags: [],
        }, 'movie');

        const retainedSelect = handle.modalElement.querySelector<HTMLSelectElement>('#movie-server')!;
        JC.identity.transition('modal-server-b2', 'modal-user-b2', 'account switch');
        vi.advanceTimersByTime(10_000);

        expect(retainedSelect.options).toHaveLength(0);
    });
});
