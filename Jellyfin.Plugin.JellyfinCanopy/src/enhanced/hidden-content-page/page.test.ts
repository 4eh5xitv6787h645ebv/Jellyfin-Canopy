// src/enhanced/hidden-content-page/page.test.ts
//
// Pins the load-bearing pieces of the hidden-content cutover to the pages
// framework: the descriptor shape + live enablement gate, the frozen facade,
// the active-container no-op contract (renderPage paints nothing while the page
// is not adopted or its container left the DOM), and the FULL state reset
// onHide performs so a drained page never leaks admin/search/scoped state into
// the next adoption (formerly the old hidePage teardown).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { setActiveContainer, renderPage } from './render';
import { state } from './state';
import {
    hiddenContentPageDescriptor as descriptor,
    hiddenContentPageFacade,
} from './page';
import { consumeAdminTargetHandoff } from './handoff';
import { PAGE_NAV_ATTR } from '../pages/router-bridge';
import '../pages/facades';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('hidden-content page descriptor', () => {
    it('registers with the expected route/title/icon and is not admin-only', () => {
        expect(descriptor).toBeTruthy();
        expect(descriptor.id).toBe('hidden-content');
        expect(descriptor.route).toBe('/hidden-content');
        expect(descriptor.titleKey).toBe('hidden_content_manage_title');
        expect(descriptor.icon).toBe('visibility_off');
        // Non-admins manage their OWN hidden items; the cross-user filter is
        // gated inside render/admin, not by adoption.
        expect(descriptor.adminOnly).toBeFalsy();
    });

    it('isEnabled tracks HiddenContentEnabled live (never cached)', () => {
        (JC as any).pluginConfig = { HiddenContentEnabled: true };
        expect(descriptor.isEnabled()).toBe(true);
        (JC as any).pluginConfig = { HiddenContentEnabled: false };
        expect(descriptor.isEnabled()).toBe(false);
    });

    it('exposes the frozen facade (showPage / renderPage / injectStyles)', () => {
        expect(typeof JC.hiddenContentPage?.showPage).toBe('function');
        expect(typeof JC.hiddenContentPage?.renderPage).toBe('function');
        expect(typeof JC.hiddenContentPage?.injectStyles).toBe('function');
    });
});

describe('renderPage active-container contract', () => {
    afterEach(() => { setActiveContainer(null); });

    it('is a no-op with no active container', () => {
        setActiveContainer(null);
        expect(() => renderPage()).not.toThrow();
    });

    it('is a no-op when the active container is disconnected from the DOM', () => {
        const detached = document.createElement('div');
        setActiveContainer(detached);
        expect(() => renderPage()).not.toThrow();
        // Never painted into a detached tree.
        expect(detached.childElementCount).toBe(0);
    });
});

describe('admin-target navigation handoff', () => {
    const actor = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const originalGetCurrentUserId = ApiClient.getCurrentUserId.bind(ApiClient);
    const originalPluginConfig = JC.pluginConfig;
    const originalShow = window.Emby?.Page?.show;
    const originalNavigation = JC.core.navigation;

    function ownActorIdentity(): void {
        const context = Object.freeze({
            serverId: 'test-server-id',
            userId: actor,
            epoch: 42,
        });
        vi.spyOn(JC.identity, 'capture').mockReturnValue(context);
        vi.spyOn(JC.identity, 'isCurrent').mockImplementation(
            candidate => candidate === context,
        );
    }

    afterEach(() => {
        descriptor.onHide!();
        ApiClient.getCurrentUserId = originalGetCurrentUserId;
        JC.pluginConfig = originalPluginConfig;
        JC.core.navigation = originalNavigation;
        if (window.Emby?.Page) window.Emby.Page.show = originalShow;
        document.documentElement.removeAttribute(PAGE_NAV_ATTR);
        window.location.hash = '';
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('keeps an accepted exact target until destination adoption owns cleanup', () => {
        ApiClient.getCurrentUserId = () => actor;
        ownActorIdentity();
        JC.pluginConfig = { HiddenContentEnabled: true };
        window.location.hash = '#/home';
        window.Emby!.Page!.show = vi.fn();

        expect(hiddenContentPageFacade.showPage(actor, target, 'epoch:1')).toBe(true);
        expect(window.Emby!.Page!.show).toHaveBeenCalledWith('/hidden-content');
        expect(document.documentElement.dataset.jcHiddenAdminActor).toBe(actor);
        expect(document.documentElement.dataset.jcHiddenAdminTarget).toBe(target);
        expect(document.documentElement.dataset.jcHiddenAdminHandoff).toBe('epoch:1');
    });

    it('bounds an accepted handoff when the host router never adopts it', () => {
        vi.useFakeTimers();
        ApiClient.getCurrentUserId = () => actor;
        ownActorIdentity();
        JC.pluginConfig = { HiddenContentEnabled: true };
        window.location.hash = '#/home';
        window.Emby!.Page!.show = vi.fn();

        expect(hiddenContentPageFacade.showPage(actor, target, 'epoch:2')).toBe(true);
        vi.advanceTimersByTime(15_000);

        expect(document.documentElement.dataset.jcHiddenAdminActor).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminTarget).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminHandoff).toBeUndefined();
    });

    it('does not let a malformed stale launch retire an accepted handoff', () => {
        ApiClient.getCurrentUserId = () => actor;
        ownActorIdentity();
        JC.pluginConfig = { HiddenContentEnabled: true };
        window.location.hash = '#/home';
        window.Emby!.Page!.show = vi.fn();

        expect(hiddenContentPageFacade.showPage(actor, target)).toBe(true);
        const acceptedToken =
            document.documentElement.dataset.jcHiddenAdminHandoff;
        expect(acceptedToken).toMatch(/^page:\d+$/);

        expect(hiddenContentPageFacade.showPage(
            'cccccccccccccccccccccccccccccccc',
            'dddddddddddddddddddddddddddddddd',
            'invalid token with spaces',
        )).toBe(false);
        expect(document.documentElement.dataset.jcHiddenAdminActor).toBe(actor);
        expect(document.documentElement.dataset.jcHiddenAdminTarget).toBe(target);
        expect(document.documentElement.dataset.jcHiddenAdminHandoff).toBe(acceptedToken);
    });

    it('retires the exact handoff when a superseding route wins navigation', async () => {
        ApiClient.getCurrentUserId = () => actor;
        ownActorIdentity();
        JC.pluginConfig = { HiddenContentEnabled: true };
        window.location.hash = '#/home';
        window.Emby!.Page!.show = vi.fn();
        let navigate: (() => void) | null = null;
        JC.core.navigation = {
            onNavigate: (callback: (event?: Event) => void) => {
                navigate = callback;
                return () => undefined;
            },
        } as unknown as NonNullable<typeof JC.core.navigation>;

        expect(hiddenContentPageFacade.showPage(actor, target, 'route:1')).toBe(true);
        // Keep the stale early-mask marker present: a changed non-target hash
        // must still be treated as a superseding route.
        window.location.hash = '#/downloads';
        navigate!();
        await Promise.resolve();

        expect(document.documentElement.dataset.jcHiddenAdminActor).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminTarget).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminHandoff).toBeUndefined();
    });

    it('retires staged cross-user state synchronously on identity reset', () => {
        ApiClient.getCurrentUserId = () => actor;
        ownActorIdentity();
        JC.pluginConfig = { HiddenContentEnabled: true };
        window.location.hash = '#/home';
        window.Emby!.Page!.show = vi.fn();
        let reset: (() => void) | null = null;
        vi.spyOn(JC.identity, 'registerReset').mockImplementation((_name, handler) => {
            reset = () => handler({
                previous: JC.identity.capture(),
                current: null,
                epoch: 43,
                reason: 'test-account-switch',
            });
            return () => undefined;
        });

        expect(hiddenContentPageFacade.showPage(actor, target, 'identity:1')).toBe(true);
        reset!();

        expect(document.documentElement.dataset.jcHiddenAdminActor).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminTarget).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminHandoff).toBeUndefined();
        expect(consumeAdminTargetHandoff()).toBeNull();
    });

    it('consumes a valid pre-activation DOM tuple without page-local state', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-26T12:00:00Z'));
        ApiClient.getCurrentUserId = () => actor;
        ownActorIdentity();
        const root = document.documentElement;
        root.dataset.jcHiddenAdminActor = actor;
        root.dataset.jcHiddenAdminTarget = target;
        root.dataset.jcHiddenAdminHandoff = 'settings:1';
        root.dataset.jcHiddenAdminServer = 'test-server-id';
        root.dataset.jcHiddenAdminEpoch = '42';
        root.dataset.jcHiddenAdminStagedAt = String(Date.now());

        expect(consumeAdminTargetHandoff()).toBe(target);
        expect(root.dataset.jcHiddenAdminActor).toBeUndefined();
        expect(root.dataset.jcHiddenAdminTarget).toBeUndefined();
        expect(root.dataset.jcHiddenAdminHandoff).toBeUndefined();
        expect(root.dataset.jcHiddenAdminServer).toBeUndefined();
        expect(root.dataset.jcHiddenAdminEpoch).toBeUndefined();
        expect(root.dataset.jcHiddenAdminStagedAt).toBeUndefined();
    });

    it.each([
        ['wrong server', { jcHiddenAdminServer: 'other-server' }],
        ['wrong epoch', { jcHiddenAdminEpoch: '43' }],
        ['non-canonical epoch', { jcHiddenAdminEpoch: '042' }],
        ['expired evidence', { jcHiddenAdminStagedAt: '0' }],
        ['future evidence', { jcHiddenAdminStagedAt: '4102444800000' }],
    ])('rejects and clears %s in a pre-activation DOM tuple', (_label, override) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-26T12:00:00Z'));
        ApiClient.getCurrentUserId = () => actor;
        ownActorIdentity();
        const root = document.documentElement;
        Object.assign(root.dataset, {
            jcHiddenAdminActor: actor,
            jcHiddenAdminTarget: target,
            jcHiddenAdminHandoff: 'settings:2',
            jcHiddenAdminServer: 'test-server-id',
            jcHiddenAdminEpoch: '42',
            jcHiddenAdminStagedAt: String(Date.now()),
            ...override,
        });

        expect(consumeAdminTargetHandoff()).toBeNull();
        expect(root.dataset.jcHiddenAdminHandoff).toBeUndefined();
        expect(root.dataset.jcHiddenAdminTarget).toBeUndefined();
    });
});

describe('onHide full state reset', () => {
    it('clears admin/search/scoped state and bumps adminLoadToken', () => {
        state.searchQuery = 'terminator';
        state.scopedOnly = true;
        state.selectedAdminUserId = 'user-1';
        state.adminEditMode = true;
        state.adminItems = [{ _key: 'x' }] as any;
        state.adminItemsUserId = 'user-1';
        state.adminItemsRevision = 4;
        state.adminItemsRevisionUserId = 'user-1';
        state.adminLoadError = true;
        state.adminMutationError = true;
        state.adminMutationErrorKind = 'conflict';
        state.adminUserName = 'Bob';
        state.adminUsers = [{ userId: 'user-1', userName: 'Bob', count: 3 }];
        state.adminUsersLoading = true;
        state.adminUsersCursor = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        state.adminUsersNextCursor = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        state.adminIsAdmin = true;
        document.documentElement.dataset.jcHiddenAdminActor =
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        document.documentElement.dataset.jcHiddenAdminTarget =
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        document.documentElement.dataset.jcHiddenAdminHandoff = 'stale:1';
        const usersTokenBefore = state.adminUsersLoadToken;
        const tokenBefore = state.adminLoadToken;

        descriptor.onHide!();

        expect(state.searchQuery).toBe('');
        expect(state.scopedOnly).toBe(false);
        expect(state.selectedAdminUserId).toBeNull();
        expect(state.adminEditMode).toBe(false);
        expect(state.adminItems).toBeNull();
        expect(state.adminItemsUserId).toBeNull();
        expect(state.adminItemsRevision).toBeNull();
        expect(state.adminItemsRevisionUserId).toBeNull();
        expect(state.adminLoadError).toBe(false);
        expect(state.adminMutationError).toBe(false);
        expect(state.adminMutationErrorKind).toBeNull();
        expect(state.adminUserName).toBe('');
        expect(state.adminUsers).toBeNull();
        expect(state.adminUsersLoading).toBe(false);
        expect(state.adminUsersCursor).toBeNull();
        expect(state.adminUsersNextCursor).toBeNull();
        expect(state.adminIsAdmin).toBeNull();
        expect(document.documentElement.dataset.jcHiddenAdminActor).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminTarget).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminHandoff).toBeUndefined();
        // Invalidates the independently fenced list and exact-item fetches.
        expect(state.adminUsersLoadToken).toBe(usersTokenBefore + 1);
        expect(state.adminLoadToken).toBe(tokenBefore + 1);
    });
});
