// src/core/modal-a11y.ts
//
// Shared accessible-modal helper for JC's custom overlays. Each overlay used to
// hand-roll (or omit) focus management, and the global shortcut listener
// (enhanced/events.ts) fired *through* any open JC modal (INT-1). This is the
// single chokepoint: installModalA11y gives an element dialog semantics, a Tab
// focus-trap, Escape handling, focus capture+restore, and — via a module-level
// open-modal counter + the `jc-modal-open` body class — the signal the global
// key listener reads to suppress shortcuts while any modal is open.

let openModalCount = 0; // the single INT-1 chokepoint

export interface ModalA11yOptions {
    /**
     * Element that owns role/aria dialog semantics when `root` is a full-screen
     * backdrop. Focus trapping and dismissal still remain owned by `root`.
     */
    dialogElement?: HTMLElement;
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
    release(): void;
}

/** True while any JC modal installed via installModalA11y is open. */
export function isAnyModalOpen(): boolean {
    return openModalCount > 0;
}

const FOCUSABLE_SELECTOR =
    'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Make `root` an accessible modal dialog: role/aria-modal, focus capture, Tab
 * trap, Escape, focus restore, and suppression of JC global shortcuts while
 * open. Returns a handle whose release() MUST be called on close.
 */
export function installModalA11y(root: HTMLElement, opts: ModalA11yOptions = {}): ModalA11yHandle {
    const dialog = opts.dialogElement ?? root;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
    if (opts.labelledBy) dialog.setAttribute('aria-labelledby', opts.labelledBy);
    else if (opts.label) dialog.setAttribute('aria-label', opts.label);

    const prevFocused = document.activeElement as HTMLElement | null;

    openModalCount++;
    document.body.classList.add('jc-modal-open'); // read by the global key listener (INT-1)

    const focusables = (): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

    const keydown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            opts.onEscape?.();
            return;
        }
        if (e.key !== 'Tab') return;
        const f = focusables();
        if (!f.length) { e.preventDefault(); dialog.focus(); return; }
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === root || document.activeElement === dialog)) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    };
    // Capture phase: runs before the document-level global shortcut listener.
    document.addEventListener('keydown', keydown, true);

    // Initial focus.
    const target = typeof opts.initialFocus === 'function'
        ? opts.initialFocus()
        : (opts.initialFocus ?? focusables()[0] ?? dialog);
    (target ?? dialog).focus();

    let released = false;
    return {
        release(): void {
            if (released) return;
            released = true;
            document.removeEventListener('keydown', keydown, true);
            openModalCount = Math.max(0, openModalCount - 1);
            if (openModalCount === 0) document.body.classList.remove('jc-modal-open');
            if (prevFocused && document.contains(prevFocused)) prevFocused.focus();
        },
    };
}
