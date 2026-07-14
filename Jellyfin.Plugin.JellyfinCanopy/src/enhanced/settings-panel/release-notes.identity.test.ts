import { describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { showReleaseNotesNotification } from './release-notes';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('release notes identity ownership', () => {
    it('does not mount a held A release response after B becomes current', async () => {
        document.body.innerHTML = '';
        JC.identity.transition('server-a', 'user-a', 'release-notes-test-start');
        const held = deferred<Response>();
        const fetchMock = vi.fn(() => held.promise);
        vi.stubGlobal('fetch', fetchMock);

        const result = showReleaseNotesNotification();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        JC.identity.transition('server-a', 'user-b', 'account-switch');
        held.resolve({
            ok: true,
            json: () => Promise.resolve({ body: 'A notes', tag_name: 'A', published_at: '', html_url: '#' }),
        } as Response);
        await result;

        expect(document.getElementById('jellyfin-release-notes-notification')).toBeNull();
        vi.unstubAllGlobals();
    });
});
