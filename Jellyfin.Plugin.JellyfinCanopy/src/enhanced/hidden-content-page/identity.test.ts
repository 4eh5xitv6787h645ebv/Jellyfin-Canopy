import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { IdentityContext } from '../../types/jc';
import {
    handleUnhide,
    handleUnhideMany,
    maybeInitAdminFilter,
    onAdminUserChange,
    onAdminUserPageChange,
    openAdminAddModal,
} from './admin';
import { createGroupCard } from './cards';
import { renderPage, setActiveContainer } from './render';
import { state } from './state';
import { activate } from '../../entries/hidden-content-page';
import { createTestFeatureScope, type TestFeatureScope } from '../../test/feature-scope';

const originalApi = JC.core.api;
const originalSeerrApi = JC.seerrAPI;
let feature: TestFeatureScope;

function startSession(serverId = 'server-a', userId = 'user-a'): IdentityContext {
    JC.identity.transition('', '', 'test-logout');
    return JC.identity.transition(serverId, userId, 'test-login')!;
}

function userPage(
    users: Array<{ userId: string; userName: string; count: number }>,
    nextCursor: string | null = null,
) {
    return {
        users,
        limit: 100,
        scanned: Math.max(users.length, nextCursor ? 100 : users.length),
        truncated: nextCursor !== null,
        nextCursor,
    };
}

describe('hidden-content page identity lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        JC.t = (key: string) => key;
        startSession();
        JC.currentSettings = { isAdmin: true };
        feature = createTestFeatureScope();
        activate(feature.scope);
    });

    afterEach(async () => {
        await feature.dispose();
        JC.identity.transition('', '', 'test-cleanup');
        JC.core.api = originalApi;
        JC.seerrAPI = originalSeerrApi;
        setActiveContainer(null);
        vi.restoreAllMocks();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('does not let a held A admin-list fetch publish or clear B loading state', async () => {
        let resolveA!: (value: ReturnType<typeof userPage>) => void;
        const heldA = new Promise<ReturnType<typeof userPage>>((resolve) => { resolveA = resolve; });
        const fetchUsers = vi.fn()
            .mockReturnValueOnce(heldA)
            .mockResolvedValueOnce(userPage([
                { userId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', userName: 'B child', count: 1 },
            ]));
        JC.hiddenContent = { fetchHiddenContentUsers: fetchUsers } as unknown as NonNullable<typeof JC.hiddenContent>;

        const loadA = maybeInitAdminFilter();
        await Promise.resolve();
        await Promise.resolve();
        expect(fetchUsers).toHaveBeenCalledTimes(1);

        JC.identity.transition('server-b', 'user-b', 'account-switch');
        JC.currentSettings = { isAdmin: true };
        const loadB = maybeInitAdminFilter();
        await loadB;
        expect(state.adminUsers).toEqual([
            { userId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', userName: 'B child', count: 1 },
        ]);

        resolveA(userPage([
            { userId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', userName: 'A child', count: 9 },
        ]));
        await loadA;

        expect(state.adminUsers).toEqual([
            { userId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', userName: 'B child', count: 1 },
        ]);
        expect(state.adminUsersLoading).toBe(false);
    });

    it('keeps the full user-list load live while an exact handoff target loads', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        let resolveUsers!: (value: ReturnType<typeof userPage>) => void;
        const heldUsers = new Promise<ReturnType<typeof userPage>>((resolve) => { resolveUsers = resolve; });
        const fetchUsers = vi.fn().mockReturnValue(heldUsers);
        const fetchTarget = vi.fn().mockResolvedValue({
            userId: target,
            userName: 'Exact target',
            itemsRevision: 0,
            items: [],
        });
        JC.hiddenContent = {
            fetchHiddenContentUsers: fetchUsers,
            fetchUserHiddenItemsForAdmin: fetchTarget,
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        state.adminIsAdmin = true;
        state.adminUsers = null;
        state.adminUsersLoading = false;

        const listLoad = maybeInitAdminFilter();
        await Promise.resolve();
        expect(state.adminUsersLoading).toBe(true);

        await onAdminUserChange(target);
        expect(fetchTarget).toHaveBeenCalledWith(target);
        expect(state.adminItemsUserId).toBe(target);
        expect(state.adminUsersLoading).toBe(true);

        resolveUsers(userPage([
            { userId: 'cccccccccccccccccccccccccccccccc', userName: 'Other user', count: 2 },
        ]));
        await listLoad;

        expect(state.adminUsersLoading).toBe(false);
        expect(state.adminUsers).toEqual([
            { userId: 'cccccccccccccccccccccccccccccccc', userName: 'Other user', count: 2 },
            { userId: target, userName: 'Exact target', count: 0 },
        ]);
    });

    it('replaces bounded user pages by cursor instead of accumulating an unbounded selector', async () => {
        const nextCursor = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const fetchUsers = vi.fn()
            .mockResolvedValueOnce(userPage([
                { userId: '11111111111111111111111111111111', userName: 'Page one', count: 1 },
            ], nextCursor))
            .mockResolvedValueOnce(userPage([
                { userId: '22222222222222222222222222222222', userName: 'Page two', count: 2 },
            ]))
            .mockResolvedValueOnce(userPage([
                { userId: '11111111111111111111111111111111', userName: 'Page one', count: 1 },
            ], nextCursor));
        JC.hiddenContent = {
            fetchHiddenContentUsers: fetchUsers,
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        state.adminIsAdmin = true;
        state.adminUsers = null;
        state.adminUsersLoading = false;
        state.adminUsersCursor = null;
        state.adminUsersNextCursor = null;
        const currentNames = () =>
            (state.adminUsers as Array<{ userName: string }> | null)
                ?.map(user => user.userName);

        await maybeInitAdminFilter();
        expect(currentNames()).toEqual(['Page one']);
        expect(state.adminUsersNextCursor).toBe(nextCursor);

        onAdminUserPageChange(nextCursor);
        await maybeInitAdminFilter();
        expect(fetchUsers).toHaveBeenNthCalledWith(2, nextCursor);
        expect(currentNames()).toEqual(['Page two']);
        expect(state.adminUsers).toHaveLength(1);

        onAdminUserPageChange(null);
        await maybeInitAdminFilter();
        expect(fetchUsers).toHaveBeenNthCalledWith(3, null);
        expect(currentNames()).toEqual(['Page one']);
    });

    it('keeps paging actions out of the user selector and restores focus after loading', async () => {
        const nextCursor = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const fetchUsers = vi.fn().mockResolvedValue(userPage([
            {
                userId: 'cccccccccccccccccccccccccccccccc',
                userName: 'Next user',
                count: 2,
            },
        ]));
        JC.hiddenContent = {
            fetchHiddenContentUsers: fetchUsers,
            getAllHiddenItems: vi.fn(() => []),
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        state.adminIsAdmin = true;
        state.adminUsers = [{
            userId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            userName: 'First user',
            count: 1,
        }];
        state.adminUsersCursor = null;
        state.adminUsersNextCursor = nextCursor;
        const container = document.createElement('div');
        document.body.appendChild(container);
        setActiveContainer(container);

        renderPage();

        const initialSelect = container.querySelector<HTMLSelectElement>(
            '.jc-hidden-admin-user-filter',
        )!;
        expect([...initialSelect.options].map(option => option.value))
            .not.toContain('__jc_hidden_users_next_page__');
        const next = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find(button =>
                button.textContent === 'hidden_content_admin_users_next_page')!;
        next.focus();
        next.click();

        await vi.waitFor(() =>
            expect(fetchUsers).toHaveBeenCalledWith(nextCursor));
        await vi.waitFor(() => {
            const loadedSelect = container.querySelector<HTMLSelectElement>(
                '.jc-hidden-admin-user-filter',
            );
            expect(loadedSelect).not.toBeNull();
            expect(document.activeElement).toBe(loadedSelect);
        });
        expect(container.querySelector('[role="status"]')?.textContent)
            .toBe('hidden_content_admin_users_next_page');
    });

    it('keeps an exact zero-item target selected when the cached list omits it', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const fetchTarget = vi.fn().mockResolvedValue({
            userId: target,
            userName: 'Zero Item Target',
            itemsRevision: 0,
            items: [],
        });
        JC.hiddenContent = {
            fetchHiddenContentUsers: vi.fn(),
            fetchUserHiddenItemsForAdmin: fetchTarget,
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        state.adminIsAdmin = true;
        state.adminUsers = [{
            userId: 'cccccccccccccccccccccccccccccccc',
            userName: 'Existing user',
            count: 2,
        }];
        state.adminUsersLoading = false;

        await onAdminUserChange(target);

        expect(fetchTarget).toHaveBeenCalledWith(target);
        expect(state.selectedAdminUserId).toBe(target);
        expect(state.adminItemsUserId).toBe(target);
        expect(state.adminItems).toEqual([]);
        expect(state.adminUsers).toContainEqual({
            userId: target,
            userName: 'Zero Item Target',
            count: 0,
        });
    });

    it('cancels an A unhide fade and rejects retained A controls after B activates', async () => {
        const unhideItem = vi.fn();
        JC.hiddenContent = { unhideItem } as unknown as NonNullable<typeof JC.hiddenContent>;
        const card = createGroupCard({
            seriesName: 'A show',
            seriesId: 'series-a',
            items: [{ _key: 'series-a', itemId: 'series-a', name: 'A show', type: 'Series' }],
        });
        document.body.appendChild(card);

        const retainedUnhide = card.querySelector<HTMLButtonElement>('.jc-hidden-group-unhide')!;
        retainedUnhide.click();
        const retainedConfirm = document.querySelector<HTMLButtonElement>('.jc-hide-confirm-hide')!;
        retainedConfirm.click();

        JC.identity.transition('server-b', 'user-b', 'account-switch');
        retainedUnhide.click();
        retainedConfirm.click();
        await vi.runAllTimersAsync();

        expect(unhideItem).not.toHaveBeenCalled();
        expect(document.querySelector('.jc-hide-confirm-overlay')).toBeNull();
        expect(state.adminIsAdmin).toBeNull();
    });

    it('keeps target rows and counts unchanged and shows a live retryable error after failed unhide', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const adminUnhideForUser = vi.fn().mockResolvedValue(null);
        JC.hiddenContent = {
            adminUnhideForUser,
            createItemCard: vi.fn(() => {
                const card = document.createElement('div');
                card.innerHTML = [
                    '<div class="jc-hidden-item-meta"></div>',
                    '<button class="jc-hidden-item-unhide"></button>',
                ].join('');
                return card;
            }),
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        state.adminIsAdmin = true;
        state.adminUsers = [{ userId: target, userName: 'Target', count: 1 }];
        state.selectedAdminUserId = target;
        state.adminUserName = 'Target';
        state.adminEditMode = true;
        state.adminItemsUserId = target;
        state.adminItemsRevision = 2;
        state.adminItemsRevisionUserId = target;
        state.adminItems = [{
            _key: 'item-key',
            itemId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            name: 'Still hidden',
            type: 'Movie',
            hideScope: 'global',
        }];
        const container = document.createElement('div');
        document.body.appendChild(container);
        setActiveContainer(container);
        renderPage();

        handleUnhide('item-key');
        await vi.waitFor(() =>
            expect(container.querySelector('.jc-hidden-admin-mutation-status')?.textContent)
                .toBe('panel_admin_target_save_error'));

        expect(adminUnhideForUser).toHaveBeenCalledWith(target, ['item-key'], 2);
        expect(state.adminItems).toHaveLength(1);
        expect(state.adminUsers[0].count).toBe(1);
        expect(container.querySelector('.jc-hidden-admin-mutation-status')?.getAttribute('role'))
            .toBe('alert');
    });

    it('adopts the exact target snapshot after ambiguous unhide evidence succeeds', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const survivor = {
            _key: 'item-b',
            itemId: 'item-b',
            name: 'Still hidden',
            type: 'Movie',
        };
        const adminUnhideForUser = vi.fn().mockResolvedValue({
            userId: target,
            removed: 0,
            itemsRevision: 4,
            outcome: 'recovered',
            authoritative: {
                userId: target,
                userName: 'Renamed Target',
                itemsRevision: 4,
                items: [survivor],
            },
        });
        JC.hiddenContent = {
            adminUnhideForUser,
            createItemCard: vi.fn(() => document.createElement('div')),
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        state.adminIsAdmin = true;
        state.adminUsers = [{ userId: target, userName: 'Target', count: 2 }];
        state.selectedAdminUserId = target;
        state.adminUserName = 'Target';
        state.adminEditMode = true;
        state.adminItemsUserId = target;
        state.adminItemsRevision = 3;
        state.adminItemsRevisionUserId = target;
        state.adminItems = [
            { _key: 'item-a', itemId: 'item-a', name: 'Removed', type: 'Movie' },
            { _key: 'stale', itemId: 'stale', name: 'Stale', type: 'Movie' },
        ];
        const container = document.createElement('div');
        document.body.appendChild(container);
        setActiveContainer(container);

        handleUnhide('item-a');

        await vi.waitFor(() => expect(state.adminItems).toEqual([survivor]));
        expect(state.adminItemsUserId).toBe(target);
        expect(state.adminItemsRevision).toBe(4);
        expect(state.adminItemsRevisionUserId).toBe(target);
        expect(state.adminUserName).toBe('Renamed Target');
        expect(state.adminUsers).toEqual([{
            userId: target,
            userName: 'Renamed Target',
            count: 1,
        }]);
        expect(state.adminMutationError).toBe(false);
    });

    it('adopts authoritative 409 evidence but keeps the mutation visibly conflicted', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const survivor = {
            _key: 'item-b',
            itemId: 'item-b',
            name: 'Authoritative survivor',
            type: 'Movie',
        };
        const adminUnhideForUser = vi.fn().mockResolvedValue({
            userId: target,
            removed: 0,
            itemsRevision: 4,
            outcome: 'conflict',
            authoritative: {
                userId: target,
                userName: 'Target',
                itemsRevision: 4,
                items: [survivor],
            },
        });
        JC.hiddenContent = {
            adminUnhideForUser,
            createItemCard: vi.fn(() => document.createElement('div')),
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        state.adminIsAdmin = true;
        state.adminUsers = [{ userId: target, userName: 'Target', count: 2 }];
        state.selectedAdminUserId = target;
        state.adminUserName = 'Target';
        state.adminEditMode = true;
        state.adminItems = [
            { _key: 'item-a', itemId: 'item-a', name: 'Requested', type: 'Movie' },
            survivor,
        ];
        state.adminItemsUserId = target;
        state.adminItemsRevision = 3;
        state.adminItemsRevisionUserId = target;
        const container = document.createElement('div');
        document.body.appendChild(container);
        setActiveContainer(container);

        handleUnhide('item-a');

        await vi.waitFor(() => expect(state.adminItems).toEqual([survivor]));
        expect(state.adminItemsRevision).toBe(4);
        expect(state.adminMutationError).toBe(true);
        expect(state.adminMutationErrorKind).toBe('conflict');
        expect(container.querySelector('.jc-hidden-admin-mutation-status')?.textContent)
            .toBe('panel_admin_target_conflict_error');
    });

    it('keeps ambiguous transport failure generic while adopting exact target evidence', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const authoritative = {
            _key: 'item-b',
            itemId: 'item-b',
            name: 'Authoritative',
            type: 'Movie',
        };
        const adminUnhideForUser = vi.fn().mockResolvedValue({
            userId: target,
            removed: 0,
            itemsRevision: 5,
            outcome: 'failed',
            authoritative: {
                userId: target,
                userName: 'Target',
                itemsRevision: 5,
                items: [authoritative],
            },
        });
        JC.hiddenContent = {
            adminUnhideForUser,
            createItemCard: vi.fn(() => document.createElement('div')),
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        state.adminIsAdmin = true;
        state.adminUsers = [{ userId: target, userName: 'Target', count: 2 }];
        state.selectedAdminUserId = target;
        state.adminUserName = 'Target';
        state.adminEditMode = true;
        state.adminItems = [
            { _key: 'item-a', itemId: 'item-a', name: 'Requested', type: 'Movie' },
            authoritative,
        ];
        state.adminItemsUserId = target;
        state.adminItemsRevision = 3;
        state.adminItemsRevisionUserId = target;
        const container = document.createElement('div');
        document.body.appendChild(container);
        setActiveContainer(container);

        handleUnhide('item-a');

        await vi.waitFor(() => expect(state.adminItems).toEqual([authoritative]));
        expect(state.adminItemsRevision).toBe(5);
        expect(state.adminMutationErrorKind).toBe('generic');
        expect(container.querySelector('.jc-hidden-admin-mutation-status')?.textContent)
            .toBe('panel_admin_target_save_error');
    });

    it('fences a late admin mutation response after switching targets', async () => {
        const targetA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const targetB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        let resolveMutation!: (value: unknown) => void;
        const heldMutation = new Promise((resolve) => { resolveMutation = resolve; });
        const adminUnhideForUser = vi.fn().mockReturnValue(heldMutation);
        const fetchUserHiddenItemsForAdmin = vi.fn().mockResolvedValue({
            userId: targetB,
            userName: 'Target B',
            itemsRevision: 9,
            items: [{ _key: 'b', itemId: 'b', name: 'B', type: 'Movie' }],
        });
        JC.hiddenContent = {
            adminUnhideForUser,
            fetchUserHiddenItemsForAdmin,
            createItemCard: vi.fn(() => document.createElement('div')),
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        state.adminIsAdmin = true;
        state.adminUsers = [
            { userId: targetA, userName: 'Target A', count: 1 },
            { userId: targetB, userName: 'Target B', count: 1 },
        ];
        state.selectedAdminUserId = targetA;
        state.adminUserName = 'Target A';
        state.adminEditMode = true;
        state.adminItems = [{ _key: 'a', itemId: 'a', name: 'A', type: 'Movie' }];
        state.adminItemsUserId = targetA;
        state.adminItemsRevision = 2;
        state.adminItemsRevisionUserId = targetA;

        handleUnhide('a');
        await vi.waitFor(() =>
            expect(adminUnhideForUser).toHaveBeenCalledWith(targetA, ['a'], 2));
        await onAdminUserChange(targetB);
        resolveMutation({
            userId: targetA,
            removed: 1,
            itemsRevision: 3,
            outcome: 'committed',
        });
        await heldMutation;
        await Promise.resolve();

        expect(state.selectedAdminUserId).toBe(targetB);
        expect(state.adminItemsUserId).toBe(targetB);
        expect(state.adminItemsRevisionUserId).toBe(targetB);
        expect(state.adminItemsRevision).toBe(9);
        expect(state.adminItems).toEqual([
            { _key: 'b', itemId: 'b', name: 'B', type: 'Movie' },
        ]);
    });

    it('keeps every requested row and the old revision on a partial committed count', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const originalItems = [
            { _key: 'item-a', itemId: 'item-a', name: 'A', type: 'Movie' },
            { _key: 'item-b', itemId: 'item-b', name: 'B', type: 'Movie' },
        ];
        const adminUnhideForUser = vi.fn().mockResolvedValue({
            userId: target,
            removed: 1,
            itemsRevision: 3,
            outcome: 'committed',
        });
        JC.hiddenContent = {
            adminUnhideForUser,
            createItemCard: vi.fn(() => {
                const card = document.createElement('div');
                card.innerHTML = [
                    '<div class="jc-hidden-item-meta"></div>',
                    '<button class="jc-hidden-item-unhide"></button>',
                ].join('');
                return card;
            }),
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        state.adminIsAdmin = true;
        state.adminUsers = [{ userId: target, userName: 'Target', count: 2 }];
        state.selectedAdminUserId = target;
        state.adminUserName = 'Target';
        state.adminEditMode = true;
        state.adminItemsUserId = target;
        state.adminItemsRevision = 2;
        state.adminItemsRevisionUserId = target;
        state.adminItems = originalItems;
        const container = document.createElement('div');
        document.body.appendChild(container);
        setActiveContainer(container);

        handleUnhideMany(['item-a', 'item-b']);
        await vi.waitFor(() => expect(state.adminMutationError).toBe(true));

        expect(adminUnhideForUser).toHaveBeenCalledWith(
            target,
            ['item-a', 'item-b'],
            2,
        );
        expect(state.adminItems).toEqual(originalItems);
        expect(state.adminItemsRevision).toBe(2);
        expect(state.adminUsers[0].count).toBe(2);
        expect(state.adminMutationErrorKind).toBe('generic');
        expect(container.querySelector('.jc-hidden-admin-mutation-status')?.textContent)
            .toBe('panel_admin_target_save_error');
    });

    it('keeps the requested row and the old revision on a zero committed count', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const originalItem = {
            _key: 'item-c',
            itemId: 'item-c',
            name: 'C',
            type: 'Movie',
        };
        const adminUnhideForUser = vi.fn().mockResolvedValue({
            userId: target,
            removed: 0,
            itemsRevision: 2,
            outcome: 'committed',
        });
        JC.hiddenContent = {
            adminUnhideForUser,
            createItemCard: vi.fn(() => {
                const card = document.createElement('div');
                card.innerHTML = [
                    '<div class="jc-hidden-item-meta"></div>',
                    '<button class="jc-hidden-item-unhide"></button>',
                ].join('');
                return card;
            }),
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        state.adminIsAdmin = true;
        state.adminUsers = [{ userId: target, userName: 'Target', count: 1 }];
        state.selectedAdminUserId = target;
        state.adminUserName = 'Target';
        state.adminEditMode = true;
        state.adminItemsUserId = target;
        state.adminItemsRevision = 2;
        state.adminItemsRevisionUserId = target;
        state.adminItems = [originalItem];
        const container = document.createElement('div');
        document.body.appendChild(container);
        setActiveContainer(container);

        handleUnhide('item-c');
        await vi.waitFor(() => expect(state.adminMutationError).toBe(true));

        expect(adminUnhideForUser).toHaveBeenCalledWith(
            target,
            ['item-c'],
            2,
        );
        expect(state.adminItems).toEqual([originalItem]);
        expect(state.adminItemsRevision).toBe(2);
        expect(state.adminUsers[0].count).toBe(1);
        expect(state.adminMutationErrorKind).toBe('generic');
        expect(container.querySelector('.jc-hidden-admin-mutation-status')?.textContent)
            .toBe('panel_admin_target_save_error');
    });

    it('closes the admin add modal and discards a held A search response', async () => {
        let resolveSearch!: (value: unknown) => void;
        const heldSearch = new Promise((resolve) => { resolveSearch = resolve; });
        const fetch = vi.fn().mockReturnValue(heldSearch);
        JC.core.api = { fetch } as unknown as NonNullable<typeof JC.core.api>;
        state.selectedAdminUserId = 'target-a';
        state.adminUserName = 'Target A';
        state.adminItems = [];

        openAdminAddModal();
        const retainedInput = document.querySelector<HTMLInputElement>('.jc-hidden-admin-add-overlay input')!;
        retainedInput.value = 'Alien';
        retainedInput.dispatchEvent(new Event('input'));
        await vi.advanceTimersByTimeAsync(300);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(document.body.style.overflow).toBe('hidden');

        JC.identity.transition('server-b', 'user-b', 'account-switch');
        expect(document.querySelector('.jc-hidden-admin-add-overlay')).toBeNull();
        expect(document.body.style.overflow).toBe('');

        resolveSearch({ Items: [{ Id: 'a-item', Name: 'A result', Type: 'Movie' }] });
        await Promise.resolve();
        await Promise.resolve();
        retainedInput.dispatchEvent(new Event('input'));
        await vi.runAllTimersAsync();

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(document.body.textContent).not.toContain('A result');
    });

    it('labels and contains the admin add dialog, then restores opener focus', () => {
        state.selectedAdminUserId = 'target-a';
        state.adminUserName = 'Target A';
        state.adminItems = [];
        const opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();

        openAdminAddModal();

        const panel = document.querySelector<HTMLElement>(
            '.jc-hidden-admin-add-overlay .jc-hidden-management-panel',
        )!;
        const close = panel.querySelector<HTMLButtonElement>(
            '.jc-hidden-management-close',
        )!;
        const input = panel.querySelector<HTMLInputElement>('input')!;
        expect(panel.getAttribute('role')).toBe('dialog');
        expect(panel.getAttribute('aria-modal')).toBe('true');
        expect(panel.getAttribute('aria-labelledby')).toBe(
            'jc-hidden-admin-add-title',
        );
        expect(close.getAttribute('aria-label')).toBe('arr_search_close');
        expect(input.getAttribute('aria-label')).toBe(
            'hidden_content_admin_add_search',
        );
        expect(document.activeElement).toBe(input);

        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Tab',
            bubbles: true,
        }));
        expect(document.activeElement).toBe(close);
        close.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Tab',
            shiftKey: true,
            bubbles: true,
        }));
        expect(document.activeElement).toBe(input);

        close.click();
        expect(document.activeElement).toBe(opener);
    });

    it('keeps movie and TV admin search results with the same TMDB number', async () => {
        JC.core.api = {
            fetch: vi.fn().mockResolvedValue({
                Items: [{
                    Id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    Name: 'Library Movie 550',
                    Type: 'Movie',
                    ProviderIds: { Tmdb: '550' },
                }],
            }),
        } as unknown as NonNullable<typeof JC.core.api>;
        JC.seerrAPI = {
            search: vi.fn().mockResolvedValue({
                results: [
                    { id: 550, mediaType: 'movie', title: 'Movie 550' },
                    { id: 550, mediaType: 'tv', name: 'TV 550' },
                ],
            }),
        } as unknown as NonNullable<typeof JC.seerrAPI>;
        state.selectedAdminUserId = 'target-a';
        state.adminUserName = 'Target A';
        state.adminItems = [];

        openAdminAddModal();
        const input = document.querySelector<HTMLInputElement>('.jc-hidden-admin-add-overlay input')!;
        input.value = '550';
        input.dispatchEvent(new Event('input'));
        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();
        await Promise.resolve();

        const names = [...document.querySelectorAll('.jc-hidden-admin-add-overlay .jc-hidden-item-name')]
            .map((element) => element.textContent);
        expect(names).toEqual(['Library Movie 550', 'TV 550']);
    });

    it('scopes library search to the target and bounds combined retained results', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const libraryItems = Array.from({ length: 20 }, (_, index) => ({
            Id: (index + 1).toString(16).padStart(32, '0'),
            Name: `Library ${index}`,
            Type: 'Movie',
            ProviderIds: { Tmdb: String(index + 1) },
        }));
        const fetch = vi.fn().mockResolvedValue({ Items: libraryItems });
        const getUrl = vi.spyOn(ApiClient, 'getUrl');
        JC.core.api = { fetch } as unknown as NonNullable<typeof JC.core.api>;
        JC.seerrAPI = {
            search: vi.fn().mockResolvedValue({
                results: Array.from({ length: 250 }, (_, index) => ({
                    id: 1000 + index,
                    mediaType: 'movie',
                    title: index === 0 ? 'x'.repeat(1_000) : `Seerr ${index}`,
                    posterPath: `/${'p'.repeat(1_000)}`,
                })),
            }),
        } as unknown as NonNullable<typeof JC.seerrAPI>;
        state.selectedAdminUserId = target;
        state.adminUserName = 'Target';
        state.adminItems = [];
        state.adminItemsUserId = target;
        state.adminItemsRevision = 4;
        state.adminItemsRevisionUserId = target;

        openAdminAddModal();
        const input = document.querySelector<HTMLInputElement>(
            '.jc-hidden-admin-add-overlay input',
        )!;
        input.value = 'bounded';
        input.dispatchEvent(new Event('input'));
        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();
        await Promise.resolve();

        const cards = document.querySelectorAll(
            '.jc-hidden-admin-add-overlay .jc-hidden-item-card',
        );
        const names = Array.from(cards).map(card =>
            card.querySelector('.jc-hidden-item-name')?.textContent || '');
        expect(cards).toHaveLength(24);
        expect(names[20]).toHaveLength(512);
        expect(getUrl).toHaveBeenCalledWith('/Items', expect.objectContaining({
            userId: target,
            Limit: 24,
        }));
    });

    it('shows a live modal error and re-enables retry after a failed target add', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const adminHideForUser = vi.fn().mockResolvedValue(null);
        JC.hiddenContent = {
            adminHideForUser,
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        JC.core.api = {
            fetch: vi.fn().mockResolvedValue({
                Items: [{
                    Id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                    Name: 'Retry title',
                    Type: 'Movie',
                    ProviderIds: { Tmdb: '550' },
                }],
            }),
        } as unknown as NonNullable<typeof JC.core.api>;
        state.selectedAdminUserId = target;
        state.adminUserName = 'Target';
        state.adminItems = [];
        state.adminItemsUserId = target;
        state.adminItemsRevision = 4;
        state.adminItemsRevisionUserId = target;

        openAdminAddModal();
        const input = document.querySelector<HTMLInputElement>('.jc-hidden-admin-add-overlay input')!;
        input.value = 'Retry';
        input.dispatchEvent(new Event('input'));
        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();
        await Promise.resolve();
        const hide = document.querySelector<HTMLButtonElement>(
            '.jc-hidden-admin-add-overlay .jc-hidden-item-unhide',
        )!;
        hide.click();

        await vi.waitFor(() =>
            expect(document.querySelector('.jc-hidden-admin-modal-status')?.textContent)
                .toBe('panel_admin_target_save_error'));
        expect(adminHideForUser).toHaveBeenCalledTimes(1);
        expect(hide.disabled).toBe(false);
        expect(document.querySelector('.jc-hidden-admin-modal-status')?.getAttribute('role'))
            .toBe('alert');
        expect(document.querySelector('.jc-hidden-admin-modal-status')?.getAttribute('aria-live'))
            .toBe('assertive');
        expect(state.adminItems).toEqual([]);
    });

    it('adopts the exact target snapshot after ambiguous hide evidence succeeds', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const itemId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const authoritative = {
            _key: itemId,
            itemId,
            name: 'Evidence title',
            type: 'Movie',
            hideScope: 'global',
        };
        const adminHideForUser = vi.fn().mockResolvedValue({
            userId: target,
            added: 0,
            itemsRevision: 6,
            outcome: 'recovered',
            authoritative: {
                userId: target,
                userName: 'Target',
                itemsRevision: 6,
                items: [authoritative],
            },
        });
        JC.hiddenContent = {
            adminHideForUser,
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        JC.core.api = {
            fetch: vi.fn().mockResolvedValue({
                Items: [{
                    Id: itemId,
                    Name: 'Evidence title',
                    Type: 'Movie',
                    ProviderIds: { Tmdb: '550' },
                }],
            }),
        } as unknown as NonNullable<typeof JC.core.api>;
        state.selectedAdminUserId = target;
        state.adminUserName = 'Target';
        state.adminItems = [];
        state.adminItemsUserId = target;
        state.adminItemsRevision = 5;
        state.adminItemsRevisionUserId = target;
        state.adminUsers = [{ userId: target, userName: 'Target', count: 0 }];

        openAdminAddModal();
        const input = document.querySelector<HTMLInputElement>(
            '.jc-hidden-admin-add-overlay input',
        )!;
        input.value = 'Evidence';
        input.dispatchEvent(new Event('input'));
        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();
        await Promise.resolve();
        document.querySelector<HTMLButtonElement>(
            '.jc-hidden-admin-add-overlay .jc-hidden-item-unhide',
        )!.click();

        await vi.waitFor(() => expect(state.adminItems).toEqual([authoritative]));
        expect(state.adminUsers[0].count).toBe(1);
        expect(adminHideForUser).toHaveBeenCalledWith(
            target,
            [expect.objectContaining({ itemId })],
            5,
        );
        expect(document.querySelector('.jc-hidden-admin-modal-status')?.textContent)
            .toBe('hidden_content_admin_add_added');
        expect(document.querySelector('.jc-hidden-admin-modal-status')?.getAttribute('aria-live'))
            .toBe('polite');
    });

    it('adopts authoritative hide conflict evidence without showing add success', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const itemId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const authoritative = {
            _key: itemId,
            itemId,
            name: 'Concurrent replacement',
            type: 'Movie',
            hideScope: 'global',
        };
        const adminHideForUser = vi.fn().mockResolvedValue({
            userId: target,
            added: 0,
            itemsRevision: 6,
            outcome: 'conflict',
            authoritative: {
                userId: target,
                userName: 'Target',
                itemsRevision: 6,
                items: [authoritative],
            },
        });
        JC.hiddenContent = {
            adminHideForUser,
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        JC.core.api = {
            fetch: vi.fn().mockResolvedValue({
                Items: [{
                    Id: itemId,
                    Name: 'Requested title',
                    Type: 'Movie',
                    ProviderIds: { Tmdb: '550' },
                }],
            }),
        } as unknown as NonNullable<typeof JC.core.api>;
        state.selectedAdminUserId = target;
        state.adminUserName = 'Target';
        state.adminItems = [];
        state.adminItemsUserId = target;
        state.adminItemsRevision = 5;
        state.adminItemsRevisionUserId = target;
        state.adminUsers = [{ userId: target, userName: 'Target', count: 0 }];

        openAdminAddModal();
        const input = document.querySelector<HTMLInputElement>(
            '.jc-hidden-admin-add-overlay input',
        )!;
        input.value = 'Requested';
        input.dispatchEvent(new Event('input'));
        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();
        await Promise.resolve();
        const hide = document.querySelector<HTMLButtonElement>(
            '.jc-hidden-admin-add-overlay .jc-hidden-item-unhide',
        )!;
        hide.click();

        await vi.waitFor(() => expect(state.adminItems).toEqual([authoritative]));
        expect(state.adminItemsRevision).toBe(6);
        expect(state.adminMutationErrorKind).toBe('conflict');
        expect(hide.disabled).toBe(false);
        expect(hide.textContent).toBe('hidden_content_admin_add_hide');
        expect(document.querySelector('.jc-hidden-admin-modal-status')?.textContent)
            .toBe('panel_admin_target_conflict_error');
        expect(document.querySelector('.jc-hidden-admin-modal-status')?.textContent)
            .not.toBe('hidden_content_admin_add_added');
    });

    it('reconciles the exact target after a valid concurrent zero-add acknowledgement', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const authoritative = {
            _key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            itemId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            name: 'Concurrent title',
            type: 'Movie',
            hideScope: 'global',
        };
        const adminHideForUser = vi.fn().mockResolvedValue({
            userId: target,
            added: 0,
            itemsRevision: 4,
            outcome: 'recovered',
            authoritative: {
                userId: target,
                userName: 'Target',
                itemsRevision: 4,
                items: [authoritative],
            },
        });
        JC.hiddenContent = {
            adminHideForUser,
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        JC.core.api = {
            fetch: vi.fn().mockResolvedValue({
                Items: [{
                    Id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                    Name: 'Concurrent title',
                    Type: 'Movie',
                    ProviderIds: { Tmdb: '550' },
                }],
            }),
        } as unknown as NonNullable<typeof JC.core.api>;
        state.selectedAdminUserId = target;
        state.adminUserName = 'Target';
        state.adminItems = [];
        state.adminItemsUserId = target;
        state.adminItemsRevision = 3;
        state.adminItemsRevisionUserId = target;
        state.adminUsers = [{ userId: target, userName: 'Target', count: 0 }];

        openAdminAddModal();
        const input = document.querySelector<HTMLInputElement>('.jc-hidden-admin-add-overlay input')!;
        input.value = 'Concurrent';
        input.dispatchEvent(new Event('input'));
        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();
        await Promise.resolve();
        document.querySelector<HTMLButtonElement>(
            '.jc-hidden-admin-add-overlay .jc-hidden-item-unhide',
        )!.click();

        await vi.waitFor(() => expect(state.adminItems).toEqual([authoritative]));
        expect(state.adminUsers[0].count).toBe(1);
        expect(document.querySelector('.jc-hidden-admin-modal-status')?.textContent)
            .toBe('hidden_content_admin_add_added');
    });

    it('does not claim a zero-add success when exact-target evidence lacks the item', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const adminHideForUser = vi.fn().mockResolvedValue({
            userId: target,
            added: 0,
            itemsRevision: 4,
            outcome: 'committed',
        });
        const fetchUserHiddenItemsForAdmin = vi.fn().mockResolvedValue({
            userId: target,
            userName: 'Target',
            itemsRevision: 4,
            items: [],
        });
        JC.hiddenContent = {
            adminHideForUser,
            fetchUserHiddenItemsForAdmin,
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        JC.core.api = {
            fetch: vi.fn().mockResolvedValue({
                Items: [{
                    Id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                    Name: 'Inaccessible title',
                    Type: 'Movie',
                    ProviderIds: { Tmdb: '550' },
                }],
            }),
        } as unknown as NonNullable<typeof JC.core.api>;
        state.selectedAdminUserId = target;
        state.adminUserName = 'Target';
        state.adminItems = [];
        state.adminItemsUserId = target;
        state.adminItemsRevision = 4;
        state.adminItemsRevisionUserId = target;

        openAdminAddModal();
        const input = document.querySelector<HTMLInputElement>(
            '.jc-hidden-admin-add-overlay input',
        )!;
        input.value = 'Inaccessible';
        input.dispatchEvent(new Event('input'));
        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();
        await Promise.resolve();
        document.querySelector<HTMLButtonElement>(
            '.jc-hidden-admin-add-overlay .jc-hidden-item-unhide',
        )!.click();

        await vi.waitFor(() =>
            expect(document.querySelector('.jc-hidden-admin-modal-status')?.textContent)
                .toBe('panel_admin_target_save_error'));
        expect(state.adminItems).toEqual([]);
        expect(fetchUserHiddenItemsForAdmin).not.toHaveBeenCalled();
    });
});
