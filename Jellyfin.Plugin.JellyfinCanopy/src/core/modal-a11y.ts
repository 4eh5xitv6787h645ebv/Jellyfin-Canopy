// src/core/modal-a11y.ts
//
// Shared accessible-modal helper for JC's custom overlays. Each overlay used to
// hand-roll (or omit) focus management, and the global shortcut listener
// (enhanced/events.ts) fired *through* any open JC modal (INT-1). This is the
// single chokepoint: installModalA11y gives an element dialog semantics, a Tab
// focus-trap, Escape handling, focus capture+restore, and — via a document-global
// modal stack + the `jc-modal-open` body class — the signal the global
// key listener reads to suppress shortcuts while any modal is open. The owner
// lives on `window` so loader retry namespaces share one topmost-modal stack.

import { JC } from '../globals';

const MODAL_OWNER_KEY = '__jellyfinCanopyModalA11yOwnerV2';

export interface ModalA11yOptions {
    /** id of the title element → aria-labelledby. */
    labelledBy?: string;
    /** literal/translated aria-label (when there is no title node). */
    label?: string;
    /** Element (or resolver) to focus on open; defaults to the first focusable. */
    initialFocus?: HTMLElement | (() => HTMLElement | null) | null;
    /** Called on Escape (default: nothing). */
    onEscape?: () => void;
}

export interface ModalA11yHandle {
    /**
     * Release this modal's keyboard/shortcut ownership. A buried modal can
     * suppress focus restoration while a newer modal still owns focus.
     */
    release(restoreFocus?: boolean): void;
}

interface ModalA11yEntry {
    root: HTMLElement;
    onEscape?: () => void;
}

interface ModalA11yOwner {
    version: 2;
    entries: ModalA11yEntry[];
    listener: ((event: KeyboardEvent) => void) | null;
}

type ModalA11yWindow = Window & {
    [MODAL_OWNER_KEY]?: ModalA11yOwner;
};

function getModalOwner(): ModalA11yOwner {
    const globalWindow = window as ModalA11yWindow;
    const current = globalWindow[MODAL_OWNER_KEY];
    if (current?.version === 2 && Array.isArray(current.entries)) return current;
    const owner: ModalA11yOwner = { version: 2, entries: [], listener: null };
    globalWindow[MODAL_OWNER_KEY] = owner;
    return owner;
}

/** True while any JC modal installed via installModalA11y is open. */
export function isAnyModalOpen(): boolean {
    return typeof window !== 'undefined' && getModalOwner().entries.length > 0;
}

const FOCUSABLE_SELECTOR =
    'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

function handleModalKeydown(event: KeyboardEvent): void {
    const owner = getModalOwner();
    const top = owner.entries[owner.entries.length - 1];
    if (!top) return;

    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        top.onEscape?.();
        return;
    }
    if (event.key !== 'Tab') return;
    const available = focusables(top.root);
    if (!available.length) {
        event.preventDefault();
        top.root.focus();
        return;
    }
    const first = available[0];
    const last = available[available.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === top.root)) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function claimModalKeyboardOwner(owner: ModalA11yOwner): void {
    if (owner.listener !== handleModalKeydown) {
        if (owner.listener) document.removeEventListener('keydown', owner.listener, true);
        document.addEventListener('keydown', handleModalKeydown, true);
        owner.listener = handleModalKeydown;
    }
    document.body.classList.add('jc-modal-open');
}

function removeModalEntry(owner: ModalA11yOwner, entry: ModalA11yEntry): boolean {
    const index = owner.entries.indexOf(entry);
    if (index < 0) return false;
    const wasTop = index === owner.entries.length - 1;
    owner.entries.splice(index, 1);
    if (owner.entries.length === 0) {
        if (owner.listener) document.removeEventListener('keydown', owner.listener, true);
        owner.listener = null;
        document.body.classList.remove('jc-modal-open');
    } else {
        document.body.classList.add('jc-modal-open');
    }
    return wasTop;
}

/**
 * Make `root` an accessible modal dialog: role/aria-modal, focus capture, Tab
 * trap, Escape, focus restore, and suppression of JC global shortcuts while
 * open. Returns a handle whose release() MUST be called on close.
 */
export function installModalA11y(root: HTMLElement, opts: ModalA11yOptions = {}): ModalA11yHandle {
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
    if (opts.labelledBy) root.setAttribute('aria-labelledby', opts.labelledBy);
    else if (opts.label) root.setAttribute('aria-label', opts.label);

    const prevFocused = document.activeElement as HTMLElement | null;
    const releaseRefreshSafety = JC.core.refreshSafety!.holdElement(root, 'modal');
    const owner = getModalOwner();
    const entry: ModalA11yEntry = { root, onEscape: opts.onEscape };
    owner.entries.push(entry);
    claimModalKeyboardOwner(owner);

    try {
        const target = typeof opts.initialFocus === 'function'
            ? opts.initialFocus()
            : (opts.initialFocus ?? focusables(root)[0] ?? root);
        (target ?? root).focus();
    } catch (error) {
        removeModalEntry(owner, entry);
        releaseRefreshSafety();
        if (prevFocused && document.contains(prevFocused)) prevFocused.focus();
        throw error;
    }

    let released = false;
    return {
        release(restoreFocus = true): void {
            if (released) return;
            released = true;
            const wasTop = removeModalEntry(owner, entry);
            releaseRefreshSafety();
            if (restoreFocus
                && wasTop
                && prevFocused
                && document.contains(prevFocused)) prevFocused.focus();
        },
    };
}
