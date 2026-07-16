import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    document.body.replaceChildren();
});

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('shared Seerr sibling installer leases', () => {
    it.each(['older-first', 'newer-first'] as const)(
        'keeps shared handlers owned until the final sibling leaves (%s)',
        async (releaseOrder) => {
            const { installSeerrModal } = await import('./modal');
            const { installSeerrButtons } = await import('./ui/buttons');
            const { installSeerrResults } = await import('./ui/results');
            const { installSeerrSeasonModal } = await import('./ui/season-modal');
            const windowAdd = vi.spyOn(window, 'addEventListener');
            const windowRemove = vi.spyOn(window, 'removeEventListener');
            const documentAdd = vi.spyOn(document, 'addEventListener');
            const documentRemove = vi.spyOn(document, 'removeEventListener');
            const originalRegisterReset = JC.identity.registerReset.bind(JC.identity);
            const resetCleanups: Array<ReturnType<typeof vi.fn<() => void>>> = [];
            vi.spyOn(JC.identity, 'registerReset').mockImplementation((name, handler) => {
                const tracked = vi.fn(originalRegisterReset(name, handler));
                resetCleanups.push(tracked);
                return tracked;
            });
            const acquireSibling = (): Array<() => void> => [
                installSeerrModal(),
                installSeerrButtons(),
                installSeerrResults(),
                installSeerrSeasonModal(),
            ];
            const older = acquireSibling();
            const newer = acquireSibling();

            expect(windowAdd.mock.calls.filter(([type]) => type === 'jc:config-changed')).toHaveLength(2);
            expect(documentAdd.mock.calls.filter(([type]) => type === 'seerr-media-requested')).toHaveLength(1);
            expect(resetCleanups).toHaveLength(3);

            const first = releaseOrder === 'older-first' ? older : newer;
            const last = releaseOrder === 'older-first' ? newer : older;
            for (const cleanup of first.reverse()) cleanup();
            expect(windowRemove.mock.calls.filter(([type]) => type === 'jc:config-changed')).toHaveLength(0);
            expect(documentRemove.mock.calls.filter(([type]) => type === 'seerr-media-requested')).toHaveLength(0);
            for (const cleanup of resetCleanups) expect(cleanup).not.toHaveBeenCalled();

            for (const cleanup of last.reverse()) cleanup();
            expect(windowRemove.mock.calls.filter(([type]) => type === 'jc:config-changed')).toHaveLength(2);
            expect(documentRemove.mock.calls.filter(([type]) => type === 'seerr-media-requested')).toHaveLength(1);
            for (const cleanup of resetCleanups) expect(cleanup).toHaveBeenCalledTimes(1);
        },
    );
});
