// Real-server data-integrity regression for the revisioned bookmark API.
//
// Proves the failure that motivated issue #82 against the dockerized Jellyfin
// plugin surface: an acknowledged atomic add survives a stale full snapshot,
// and two same-revision writers converge by rebasing the conflict loser.
import { test, expect } from '@playwright/test';
import { authenticate, apiRaw, type Session } from './fixtures/api';

const BASE = process.env.JF_BASE_URL || 'http://localhost:8099';

interface BookmarkItem {
    ItemId: string;
    Timestamp: number;
    Label?: string;
}

interface BookmarkState {
    Revision: number;
    Bookmarks: Record<string, BookmarkItem>;
}

function pathFor(session: Session, suffix = ''): string {
    return `/JellyfinCanopy/user-settings/${encodeURIComponent(session.userId)}/bookmark.json${suffix}`;
}

async function readState(session: Session): Promise<BookmarkState> {
    const response = await apiRaw(BASE, pathFor(session), session.token);
    expect(response.status, 'bookmark GET status').toBe(200);
    const state = (await response.json()) as BookmarkState;
    expect(Number.isSafeInteger(state.Revision)).toBe(true);
    expect(state.Revision).toBeGreaterThanOrEqual(0);
    expect(state.Bookmarks).toBeTruthy();
    expect(response.headers.get('etag')).toBe(`"${state.Revision}"`);
    return state;
}

async function batch(
    session: Session,
    revision: number,
    operations: Array<Record<string, unknown>>
): Promise<Response> {
    return apiRaw(BASE, pathFor(session, '/batch'), session.token, {
        method: 'POST',
        body: JSON.stringify({ Revision: revision, Operations: operations }),
    });
}

async function removeTestBookmarks(session: Session, ids: string[]): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
        const current = await readState(session);
        const operations = ids
            .filter((id) => Object.hasOwn(current.Bookmarks, id))
            .map((id) => ({ Type: 'delete', BookmarkId: id }));
        if (operations.length === 0) return;
        const response = await batch(session, current.Revision, operations);
        if (response.status === 200) return;
        if (response.status !== 409) {
            throw new Error(`bookmark cleanup batch -> ${response.status}`);
        }
    }
    throw new Error('bookmark cleanup could not acquire a stable revision');
}

test.describe('bookmark revision data integrity', () => {
    test('stale replacement conflicts and same-revision tabs converge without lost bookmarks', async () => {
        const session = await authenticate(BASE, process.env.JF_USER_NAME || 'jc_arruser', process.env.JF_USER_PASS || 'Test669Pw!x');
        const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const ids = {
            a: `bm_e2e_${nonce}_a`,
            b: `bm_e2e_${nonce}_b`,
            c: `bm_e2e_${nonce}_c`,
            tab1: `bm_e2e_${nonce}_tab1`,
            tab2: `bm_e2e_${nonce}_tab2`,
        };
        const allIds = Object.values(ids);

        try {
            const initial = await readState(session);
            const addA = await batch(session, initial.Revision, [{
                Type: 'add',
                BookmarkId: ids.a,
                Bookmark: { ItemId: 'jc-e2e-item-a', Timestamp: 10, Label: 'A' },
            }]);
            expect(addA.status).toBe(200);
            const afterA = (await addA.json()) as BookmarkState;

            const addB = await batch(session, afterA.Revision, [{
                Type: 'add',
                BookmarkId: ids.b,
                Bookmark: { ItemId: 'jc-e2e-item-b', Timestamp: 20, Label: 'B' },
            }]);
            expect(addB.status).toBe(200);

            // This caller owns the state observed after A, then locally adds C.
            // B was acknowledged after its observation and must never be erased.
            const staleSnapshot: BookmarkState = {
                Revision: afterA.Revision,
                Bookmarks: {
                    ...afterA.Bookmarks,
                    [ids.c]: { ItemId: 'jc-e2e-item-c', Timestamp: 30, Label: 'C' },
                },
            };
            const staleReplace = await apiRaw(BASE, pathFor(session), session.token, {
                method: 'POST',
                headers: { 'If-Match': `"${afterA.Revision}"` },
                body: JSON.stringify(staleSnapshot),
            });
            expect(staleReplace.status).toBe(409);
            const conflict = (await staleReplace.json()) as BookmarkState & { Conflict: boolean };
            expect(conflict.Conflict).toBe(true);
            expect(conflict.Bookmarks[ids.b]?.Label).toBe('B');

            const shared = await readState(session);
            const [tab1, tab2] = await Promise.all([
                batch(session, shared.Revision, [{
                    Type: 'add', BookmarkId: ids.tab1, Bookmark: { ItemId: 'jc-tab-1', Timestamp: 41 },
                }]),
                batch(session, shared.Revision, [{
                    Type: 'add', BookmarkId: ids.tab2, Bookmark: { ItemId: 'jc-tab-2', Timestamp: 42 },
                }]),
            ]);
            expect([tab1.status, tab2.status].sort()).toEqual([200, 409]);

            const loserId = tab1.status === 409 ? ids.tab1 : ids.tab2;
            const loser = tab1.status === 409 ? tab1 : tab2;
            const latest = (await loser.json()) as BookmarkState;
            const retry = await batch(session, latest.Revision, [{
                Type: 'add',
                BookmarkId: loserId,
                Bookmark: { ItemId: loserId === ids.tab1 ? 'jc-tab-1' : 'jc-tab-2', Timestamp: loserId === ids.tab1 ? 41 : 42 },
            }]);
            expect(retry.status).toBe(200);

            const final = await readState(session);
            expect(final.Bookmarks[ids.a]?.Label).toBe('A');
            expect(final.Bookmarks[ids.b]?.Label).toBe('B');
            expect(final.Bookmarks[ids.c]).toBeUndefined();
            expect(final.Bookmarks[ids.tab1]?.ItemId).toBe('jc-tab-1');
            expect(final.Bookmarks[ids.tab2]?.ItemId).toBe('jc-tab-2');
        } finally {
            await removeTestBookmarks(session, allIds);
        }
    });
});
