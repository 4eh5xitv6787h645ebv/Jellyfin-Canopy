// Unit tests for src/core/modal-a11y.ts (A11Y-1/2/3/5 + INT-1 chokepoint).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installModalA11y, isAnyModalOpen } from './modal-a11y';

function modalWithButtons(): { root: HTMLElement; first: HTMLButtonElement; last: HTMLButtonElement } {
    const root = document.createElement('div');
    const first = document.createElement('button');
    first.textContent = 'first';
    const last = document.createElement('button');
    last.textContent = 'last';
    root.appendChild(first);
    root.appendChild(last);
    document.body.appendChild(root);
    return { root, first, last };
}

describe('installModalA11y', () => {
    beforeEach(() => { document.body.innerHTML = ''; });
    afterEach(() => { document.body.className = ''; });

    it('sets dialog semantics, opens the modal gate, and restores focus on release', () => {
        const trigger = document.createElement('button');
        document.body.appendChild(trigger);
        trigger.focus();
        expect(document.activeElement).toBe(trigger);

        const { root } = modalWithButtons();
        const handle = installModalA11y(root, { labelledBy: 'x-title' });

        expect(root.getAttribute('role')).toBe('dialog');
        expect(root.getAttribute('aria-modal')).toBe('true');
        expect(root.getAttribute('tabindex')).toBe('-1');
        expect(root.getAttribute('aria-labelledby')).toBe('x-title');
        expect(document.body.classList.contains('jc-modal-open')).toBe(true);
        expect(isAnyModalOpen()).toBe(true);

        handle.release();
        expect(document.body.classList.contains('jc-modal-open')).toBe(false);
        expect(isAnyModalOpen()).toBe(false);
        expect(document.activeElement).toBe(trigger); // focus restored
    });

    it('applies aria-label when no labelledBy is given', () => {
        const { root } = modalWithButtons();
        const handle = installModalA11y(root, { label: 'My dialog' });
        expect(root.getAttribute('aria-label')).toBe('My dialog');
        handle.release();
    });

    it('keeps backdrop geometry separate from dialog semantics when a content owner is supplied', () => {
        const { root, first } = modalWithButtons();
        const dialog = document.createElement('div');
        root.insertBefore(dialog, first);
        dialog.append(first);
        const handle = installModalA11y(root, { dialogElement: dialog, labelledBy: 'content-title' });

        expect(root.hasAttribute('role')).toBe(false);
        expect(root.hasAttribute('aria-modal')).toBe(false);
        expect(dialog.getAttribute('role')).toBe('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-labelledby')).toBe('content-title');
        expect(document.activeElement).toBe(first);

        handle.release();
    });

    it('traps Tab focus from last→first and Shift+Tab from first→last', () => {
        const { root, first, last } = modalWithButtons();
        const handle = installModalA11y(root);

        last.focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        expect(document.activeElement).toBe(first);

        first.focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
        expect(document.activeElement).toBe(last);

        handle.release();
    });

    it('invokes onEscape on Escape', () => {
        const { root } = modalWithButtons();
        const onEscape = vi.fn();
        const handle = installModalA11y(root, { onEscape });
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(onEscape).toHaveBeenCalledTimes(1);
        handle.release();
    });

    it('nested modals keep the gate open until both are released', () => {
        const a = installModalA11y(modalWithButtons().root);
        const b = installModalA11y(modalWithButtons().root);
        expect(isAnyModalOpen()).toBe(true);

        a.release();
        expect(isAnyModalOpen()).toBe(true); // one still open
        expect(document.body.classList.contains('jc-modal-open')).toBe(true);

        b.release();
        expect(isAnyModalOpen()).toBe(false);
        expect(document.body.classList.contains('jc-modal-open')).toBe(false);
    });

    it('release() is idempotent', () => {
        const handle = installModalA11y(modalWithButtons().root);
        handle.release();
        handle.release();
        expect(isAnyModalOpen()).toBe(false);
    });
});
