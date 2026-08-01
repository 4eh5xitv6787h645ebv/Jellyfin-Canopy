import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { getRefreshSafetyHoldCount } from '../../core/lifecycle';
import type { IdentityContext } from '../../types/jc';
import { addLibraryHideButtons } from './buttons';
import { confirmAndHide, showUndoToast } from './dialogs';
import { getHiddenData, resetFromUserConfig } from './data';
import { showManagementPanel } from './panel';
import { hiddenContentRuntimeFeature } from '../../entries/hidden-content-runtime';
import { createTestFeatureScope, type TestFeatureScope } from '../../test/feature-scope';

let featureScope: TestFeatureScope | null = null;

async function drainMicrotasks(turns = 12): Promise<void> {
    for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

function activateFeature(): void {
    featureScope = createTestFeatureScope();
    void hiddenContentRuntimeFeature.activate(featureScope.scope);
}

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

    afterEach(async () => {
        await featureScope?.dispose();
        featureScope = null;
        JC.identity.transition('', '', 'test-cleanup');
        vi.restoreAllMocks();
        vi.useRealTimers();
        document.body.innerHTML = '';
        localStorage.clear();
    });

    it('scopes temporary confirmation suppression by both server and user', () => {
        const ownerA = startSession('server-a', 'user-a');
        installHiddenData(ownerA, {}, { showHideConfirmation: true });
        activateFeature();
        localStorage.setItem('jc_hide_confirm_suppressed_until', new Date(Date.now() + 60_000).toISOString());

        confirmAndHide({ itemId: 'a', name: 'A' });
        const overlayA = document.querySelector<HTMLElement>('.jc-hide-confirm-overlay')!;
        expect(overlayA).toBeTruthy();
        expect(getRefreshSafetyHoldCount('modal')).toBe(1);
        const suppress = overlayA.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        suppress.checked = true;
        overlayA.querySelector<HTMLButtonElement>('.jc-hide-confirm-hide')!.click();
        expect(getRefreshSafetyHoldCount('modal')).toBe(0);

        expect(localStorage.getItem('jc_hide_confirm_suppressed_until')).toBeNull();
        expect(localStorage.getItem('jc_hide_confirm_suppressed_until:servera:usera')).toBeTruthy();

        const ownerB = JC.identity.transition('server-b', 'user-a', 'server-switch')!;
        installHiddenData(ownerB, {}, { showHideConfirmation: true });
        confirmAndHide({ itemId: 'b', name: 'B' });

        // Same normalized user id on another server must not inherit A's 15-minute choice.
        expect(document.querySelector('.jc-hide-confirm-overlay')).toBeTruthy();
        expect(getRefreshSafetyHoldCount('modal')).toBe(1);
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
        activateFeature();

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

    it('keeps two rapid Undo actions distinct and independently actionable', () => {
        const owner = startSession();
        installHiddenData(owner, {
            a: { itemId: 'item-a', name: 'A', type: 'Movie' },
            b: { itemId: 'item-b', name: 'B', type: 'Movie' },
        });
        activateFeature();
        JC.t = (key: string, values?: Record<string, unknown>) => key === 'hidden_content_item_hidden'
            ? `"${String(values?.name)}" hidden`
            : key;

        showUndoToast('A', 'a');
        showUndoToast('B', 'b');

        const undoButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.jc-undo-btn'));
        expect(undoButtons).toHaveLength(2);
        expect(undoButtons.map((button) => button.parentElement?.textContent)).toEqual([
            '"A" hiddenhidden_content_undo',
            '"B" hiddenhidden_content_undo',
        ]);

        undoButtons[1].click();
        undoButtons[1].click();
        expect(Object.keys(getHiddenData().items)).toEqual(['a']);
        undoButtons[0].click();
        expect(getHiddenData().items).toEqual({});
    });

    it('restores same-page focus after config-restart teardown owns the Undo exit', async () => {
        const owner = startSession();
        installHiddenData(owner, { a: { itemId: 'item-a', name: 'A', type: 'Movie' } });
        activateFeature();
        const prior = document.createElement('button');
        document.body.appendChild(prior);
        prior.focus();

        showUndoToast('A', 'a');
        const notification = document.querySelector<HTMLElement>('.jc-undo-toast')!;
        const undo = notification.querySelector<HTMLButtonElement>('.jc-undo-btn')!;
        undo.focus();
        expect(document.activeElement).toBe(undo);

        await featureScope!.dispose();
        featureScope = null;

        // The shared owner, not Hidden Content's cleanup query, owns the exit.
        expect(notification.isConnected).toBe(true);
        vi.advanceTimersByTime(299);
        expect(notification.isConnected).toBe(true);
        vi.advanceTimersByTime(1);
        expect(notification.isConnected).toBe(false);
        expect(document.activeElement).toBe(prior);
        prior.remove();
    });

    it('rolls a hide back instead of losing its Undo when notification capacity is saturated', async () => {
        const owner = startSession();
        installHiddenData(owner, { a: { itemId: 'item-a', name: 'A', type: 'Movie' } });
        activateFeature();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        for (let index = 0; index < 32; index += 1) {
            JC.core.ui!.notify({
                message: `Retained ${index}`,
                persistent: true,
                dedupeKey: 'saturation-seed',
            });
        }

        showUndoToast('A', 'a');
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.jc-undo-toast')).toBeNull();
        expect(getHiddenData().items).toEqual({});
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('reverting hidden item'),
            expect.objectContaining({ name: 'NotificationBackpressureError' })
        );
    });

    it('uses localized completed-state copy after Undo succeeds', async () => {
        const owner = startSession();
        installHiddenData(owner, { a: { itemId: 'item-a', name: 'A', type: 'Movie' } });
        activateFeature();
        const keys: string[] = [];
        JC.t = (key: string, values?: Record<string, unknown>) => {
            keys.push(key);
            return key === 'hidden_content_item_restored'
                ? `"${String(values?.name)}" restored`
                : key;
        };

        showUndoToast('A', 'a');
        document.querySelector<HTMLButtonElement>('.jc-undo-btn')!.click();
        await Promise.resolve();

        expect(keys).toContain('hidden_content_item_restored');
        expect(keys).not.toContain('hidden_content_unhide');
    });

    it('does not announce or dismiss Undo completion before persistence acknowledges it', async () => {
        const owner = startSession();
        installHiddenData(owner, { a: { itemId: 'item-a', name: 'A', type: 'Movie' } });
        activateFeature();
        JC.t = (key: string, values?: Record<string, unknown>) => key === 'hidden_content_item_hidden'
            ? `"${String(values?.name)}" hidden`
            : key === 'hidden_content_item_restored'
                ? `"${String(values?.name)}" restored`
                : key;
        let acknowledge!: (value: unknown) => void;
        const ajax = vi.spyOn(ApiClient, 'ajax').mockImplementation(() => new Promise((resolve) => {
            acknowledge = resolve;
        }));

        showUndoToast('A', 'a');
        const notification = document.querySelector<HTMLElement>('.jc-undo-toast')!;
        const button = notification.querySelector<HTMLButtonElement>('.jc-undo-btn')!;
        button.click();
        await Promise.resolve();

        expect(ajax).toHaveBeenCalledOnce();
        expect(getHiddenData().items).toEqual({});
        expect(button.disabled).toBe(true);
        expect(notification.isConnected).toBe(true);
        vi.advanceTimersByTime(550);
        expect(document.querySelector('[data-jc-announcer="polite"]')?.textContent).toBe('');

        acknowledge({});
        await drainMicrotasks();

        expect(document.querySelector('[data-jc-announcer="polite"]')?.textContent).toBe('"A" restored');
        expect(notification.style.transform).toBe('translateX(0)');
        vi.advanceTimersByTime(2_999);
        expect(notification.style.transform).toBe('translateX(0)');
        vi.advanceTimersByTime(1);
        expect(notification.style.transform).toBe('translateX(100%)');
    });

    it('keeps a failed persisted Undo visibly retryable and sends a fresh write on retry', async () => {
        const owner = startSession();
        installHiddenData(owner, { a: { itemId: 'item-a', name: 'A', type: 'Movie' } });
        activateFeature();
        JC.t = (key: string) => key;
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce({});

        showUndoToast('A', 'a');
        const notification = document.querySelector<HTMLElement>('.jc-undo-toast')!;
        const button = notification.querySelector<HTMLButtonElement>('.jc-undo-btn')!;
        button.click();
        await drainMicrotasks();

        expect(ajax).toHaveBeenCalledOnce();
        expect(notification.isConnected).toBe(true);
        expect(button.disabled).toBe(false);
        expect(notification.querySelector('.jc-notification-action-status')?.textContent)
            .toBe('hidden_content_save_failed_persistent');

        button.click();
        await drainMicrotasks();

        expect(ajax).toHaveBeenCalledTimes(2);
        expect(notification.isConnected).toBe(true);
        vi.advanceTimersByTime(550);
        expect(notification.style.transform).toBe('translateX(0)');
        vi.advanceTimersByTime(2_999);
        expect(notification.style.transform).toBe('translateX(0)');
        vi.advanceTimersByTime(1);
        expect(notification.style.transform).toBe('translateX(100%)');
    });
});
