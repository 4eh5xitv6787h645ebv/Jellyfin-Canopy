// src/enhanced/hidden-content-page/page.test.ts
//
// Pins the load-bearing pieces of the hidden-content cutover to the pages
// framework: the descriptor shape + live enablement gate, the frozen facade,
// the active-container no-op contract (renderPage paints nothing while the page
// is not adopted or its container left the DOM), and the FULL state reset
// onHide performs so a drained page never leaks admin/search/scoped state into
// the next adoption (formerly the old hidePage teardown).
import { afterEach, describe, expect, it } from 'vitest';
import { JC } from '../../globals';
import { getPage } from '../pages/registry';
import { setActiveContainer, renderPage } from './render';
import { state } from './state';
import './page';

/* eslint-disable @typescript-eslint/no-explicit-any */

const descriptor = getPage('hidden-content')!;

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

describe('onHide full state reset', () => {
    it('clears admin/search/scoped state and bumps adminLoadToken', () => {
        state.searchQuery = 'terminator';
        state.scopedOnly = true;
        state.selectedAdminUserId = 'user-1';
        state.adminEditMode = true;
        state.adminItems = [{ _key: 'x' }] as any;
        state.adminItemsUserId = 'user-1';
        state.adminLoadError = true;
        state.adminUserName = 'Bob';
        state.adminUsers = [{ userId: 'user-1', userName: 'Bob', count: 3 }];
        state.adminUsersLoading = true;
        const tokenBefore = state.adminLoadToken;

        descriptor.onHide!();

        expect(state.searchQuery).toBe('');
        expect(state.scopedOnly).toBe(false);
        expect(state.selectedAdminUserId).toBeNull();
        expect(state.adminEditMode).toBe(false);
        expect(state.adminItems).toBeNull();
        expect(state.adminItemsUserId).toBeNull();
        expect(state.adminLoadError).toBe(false);
        expect(state.adminUserName).toBe('');
        expect(state.adminUsers).toBeNull();
        expect(state.adminUsersLoading).toBe(false);
        // Invalidates any in-flight cross-user fetch.
        expect(state.adminLoadToken).toBe(tokenBefore + 1);
    });
});
