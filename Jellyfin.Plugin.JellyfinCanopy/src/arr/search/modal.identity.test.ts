import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { closeArrSearchModals, createArrModal } from './modal';

describe('arr modal identity ownership', () => {
    let unregisterReset: (() => void) | undefined;

    beforeEach(() => {
        document.body.innerHTML = '';
        unregisterReset = JC.identity.registerReset(
            'arr-modal-identity-test',
            closeArrSearchModals,
        );
        JC.identity.transition('test-server-id', 'test-user-id', 'arr-modal-test-start');
        JC.t = (key: string) => key;
    });

    afterEach(() => {
        JC.identity.transition('test-server-id', 'test-user-id', 'arr-modal-test-cleanup');
        unregisterReset?.();
        unregisterReset = undefined;
        closeArrSearchModals();
        document.body.innerHTML = '';
    });

    it('closes synchronously and rejects stale publication when the account changes', () => {
        const modal = createArrModal({ title: 'Owned by A', subtitle: 'A' });
        const onClose = vi.fn();
        modal.onClose(onClose);

        expect(modal.isActive()).toBe(true);
        expect(document.body.contains(modal.overlay)).toBe(true);

        JC.identity.transition('test-server-id', 'user-b', 'account-switch');

        expect(modal.isActive()).toBe(false);
        expect(document.body.contains(modal.overlay)).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);

        modal.setSubtitle('must-not-publish');
        expect(modal.dialog.textContent).not.toContain('must-not-publish');
        modal.close();
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
