import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { IdentityContext } from '../../types/jc';
import { maybeInitAdminFilter, openAdminAddModal } from './admin';
import { createGroupCard } from './cards';
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
        vi.restoreAllMocks();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('does not let a held A admin-list fetch publish or clear B loading state', async () => {
        let resolveA!: (value: unknown[]) => void;
        const heldA = new Promise<unknown[]>((resolve) => { resolveA = resolve; });
        const fetchUsers = vi.fn()
            .mockReturnValueOnce(heldA)
            .mockResolvedValueOnce([{ userId: 'b-child', userName: 'B child', count: 1 }]);
        JC.hiddenContent = { fetchHiddenContentUsers: fetchUsers } as unknown as NonNullable<typeof JC.hiddenContent>;

        const loadA = maybeInitAdminFilter();
        await Promise.resolve();
        await Promise.resolve();
        expect(fetchUsers).toHaveBeenCalledTimes(1);

        JC.identity.transition('server-b', 'user-b', 'account-switch');
        JC.currentSettings = { isAdmin: true };
        const loadB = maybeInitAdminFilter();
        await loadB;
        expect(state.adminUsers).toEqual([{ userId: 'b-child', userName: 'B child', count: 1 }]);

        resolveA([{ userId: 'a-child', userName: 'A child', count: 9 }]);
        await loadA;

        expect(state.adminUsers).toEqual([{ userId: 'b-child', userName: 'B child', count: 1 }]);
        expect(state.adminUsersLoading).toBe(false);
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

    it('keeps movie and TV admin search results with the same TMDB number', async () => {
        JC.core.api = {
            fetch: vi.fn().mockResolvedValue({
                Items: [{
                    Id: 'jf-movie-550',
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
});
