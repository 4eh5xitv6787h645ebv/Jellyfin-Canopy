import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { IdentityContext } from '../../types/jc';
import { addLibraryHideButtons } from './buttons';
import { confirmAndHide, showUndoToast } from './dialogs';
import { getHiddenData, resetFromUserConfig } from './data';
import { showManagementPanel } from './panel';

function startSession(serverId = 'server-a', userId = 'user-a'): IdentityContext {
    JC.identity.transition('', '', 'test-logout');
    return JC.identity.transition(serverId, userId, 'test-login')!;
}

function installHiddenData(
    context: IdentityContext,
    items: Record<string, { itemId?: string; name?: string; type?: string }> = {},
    settings: Record<string, unknown> = {},
): void {
    const hiddenContent = JC.identity.own({ items, settings }, context);
    JC.userConfig = JC.identity.own({ hiddenContent }, context);
    resetFromUserConfig();
}

describe('hidden-content identity-owned UI', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        localStorage.clear();
        JC.t = (key: string) => key;
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('usera');
    });

    afterEach(() => {
        JC.identity.transition('', '', 'test-cleanup');
        vi.restoreAllMocks();
        vi.useRealTimers();
        document.body.innerHTML = '';
        localStorage.clear();
    });

    it('scopes temporary confirmation suppression by both server and user', () => {
        const ownerA = startSession('server-a', 'user-a');
        installHiddenData(ownerA, {}, { showHideConfirmation: true });
        localStorage.setItem('jc_hide_confirm_suppressed_until', new Date(Date.now() + 60_000).toISOString());

        confirmAndHide({ itemId: 'a', name: 'A' });
        const overlayA = document.querySelector<HTMLElement>('.jc-hide-confirm-overlay')!;
        expect(overlayA).toBeTruthy();
        const suppress = overlayA.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        suppress.checked = true;
        overlayA.querySelector<HTMLButtonElement>('.jc-hide-confirm-hide')!.click();

        expect(localStorage.getItem('jc_hide_confirm_suppressed_until')).toBeNull();
        expect(localStorage.getItem('jc_hide_confirm_suppressed_until:servera:usera')).toBeTruthy();

        const ownerB = JC.identity.transition('server-b', 'user-a', 'server-switch')!;
        installHiddenData(ownerB, {}, { showHideConfirmation: true });
        confirmAndHide({ itemId: 'b', name: 'B' });

        // Same normalized user id on another server must not inherit A's 15-minute choice.
        expect(document.querySelector('.jc-hide-confirm-overlay')).toBeTruthy();
    });

    it('synchronously removes A overlays/buttons and makes retained controls inert', async () => {
        const ownerA = startSession();
        installHiddenData(ownerA, { a: { itemId: 'item-a', name: 'A', type: 'Movie' } }, {
            enabled: true,
            showHideButtons: true,
            showButtonLibrary: true,
            showButtonCast: false,
            experimentalHideCollections: true,
        });

        showUndoToast('A', 'item-a');
        showManagementPanel();
        const card = document.createElement('div');
        card.className = 'card';
        card.dataset.id = 'item-a';
        const cardBox = document.createElement('div');
        cardBox.className = 'cardBox';
        cardBox.style.position = 'absolute';
        const text = document.createElement('div');
        text.className = 'cardText';
        text.textContent = 'A';
        cardBox.appendChild(text);
        card.appendChild(cardBox);
        document.body.appendChild(card);
        addLibraryHideButtons();

        const retainedUndo = document.querySelector<HTMLButtonElement>('.jc-undo-btn')!;
        const retainedPanelUnhide = document.querySelector<HTMLButtonElement>('.jc-hidden-management-overlay .jc-hidden-item-unhide')!;
        const retainedCardButton = cardBox.querySelector<HTMLButtonElement>('.jc-hide-btn')!;
        expect(retainedUndo).toBeTruthy();
        expect(retainedPanelUnhide).toBeTruthy();
        expect(retainedCardButton).toBeTruthy();

        const ownerB = JC.identity.transition('server-b', 'user-b', 'account-switch')!;
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('userb');
        installHiddenData(ownerB, { b: { itemId: 'item-b', name: 'B', type: 'Movie' } }, {
            enabled: true,
            showHideButtons: true,
            showButtonLibrary: true,
            showButtonCast: false,
            experimentalHideCollections: true,
        });

        expect(document.querySelector('.jc-undo-toast')).toBeNull();
        expect(document.querySelector('.jc-hidden-management-overlay')).toBeNull();
        expect(document.querySelector('.jc-hide-btn')).toBeNull();
        expect(cardBox.style.position).toBe('absolute');

        retainedUndo.click();
        retainedPanelUnhide.click();
        retainedCardButton.click();
        await vi.runAllTimersAsync();

        expect(getHiddenData().items).toEqual({ b: { itemId: 'item-b', name: 'B', type: 'Movie' } });
        expect(card.classList.contains('jc-hidden')).toBe(false);

        showUndoToast('B', 'item-b');
        showManagementPanel();
        addLibraryHideButtons();
        expect(document.querySelector('.jc-undo-toast')).toBeTruthy();
        expect(document.querySelector('.jc-hidden-management-overlay')?.textContent).toContain('B');
        expect(cardBox.querySelector('.jc-hide-btn')).toBeTruthy();
        expect(cardBox.querySelector('.jc-hide-btn')).not.toBe(retainedCardButton);
    });
});
