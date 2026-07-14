// src/arr/search/modal.ts
//
// A small themed modal (overlay + dialog) for the Interactive Search and Manage dialogs.
// Built from document.createElement + textContent (no HTML sink) and routed through the shared
// modal-a11y helper (role=dialog, focus trap, Escape, focus restore, shortcut suppression), the
// same skeleton spoiler-guard/dialog.ts uses. Styling is injected by ./styles and rides the
// running MUI theme tokens — zero hardcoded colors.

import { JC } from '../../globals';
import { installModalA11y, type ModalA11yHandle } from '../../core/modal-a11y';
import type { IdentityContext } from '../../types/jc';

export interface ArrModalHandle {
    overlay: HTMLElement;
    dialog: HTMLElement;
    body: HTMLElement;
    footer: HTMLElement;
    /** Immutable account/server epoch that owns this modal. */
    identity: IdentityContext;
    /** False after close or as soon as the authenticated identity changes. */
    isActive(): boolean;
    /** Sets the header subtitle text (injection-safe). */
    setSubtitle(text: string): void;
    close(): void;
    /** Registers a callback run exactly once when the modal closes. */
    onClose(cb: () => void): void;
}

const openModals = new Set<ArrModalHandle>();

/**
 * Builds and shows an arr modal. Closes on Escape (a11y), backdrop click and the header close
 * button. Returns handles for the caller to render into `body` and place buttons in `footer`.
 */
export function createArrModal(opts: { title: string; subtitle?: string; icon?: string }): ArrModalHandle {
    const identity = JC.identity.capture();
    if (!identity) throw new Error('Cannot open an arr modal without an authenticated identity');
    const overlay = document.createElement('div');
    overlay.className = 'jc-arr-modal-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'jc-arr-modal';

    const header = document.createElement('div');
    header.className = 'jc-arr-modal-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'jc-arr-modal-titles';

    const titleId = `jc-arr-modal-title-${Math.round(performance.now())}`;
    const titleEl = document.createElement('h2');
    titleEl.className = 'jc-arr-modal-title';
    titleEl.id = titleId;
    if (opts.icon) {
        const icon = document.createElement('span');
        icon.className = `material-icons jc-arr-modal-title-icon ${opts.icon}`;
        icon.setAttribute('aria-hidden', 'true');
        titleEl.appendChild(icon);
    }
    titleEl.appendChild(document.createTextNode(opts.title));

    const subtitleEl = document.createElement('div');
    subtitleEl.className = 'jc-arr-modal-subtitle';
    subtitleEl.textContent = opts.subtitle || '';

    titleWrap.appendChild(titleEl);
    titleWrap.appendChild(subtitleEl);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'jc-arr-modal-close';
    closeBtn.setAttribute('aria-label', JC.t!('arr_search_close'));
    const closeIcon = document.createElement('span');
    closeIcon.className = 'material-icons close';
    closeIcon.setAttribute('aria-hidden', 'true');
    closeBtn.appendChild(closeIcon);

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'jc-arr-modal-body';

    const footer = document.createElement('div');
    footer.className = 'jc-arr-modal-footer';

    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    let closed = false;
    const closeCbs: Array<() => void> = [];
    let a11y: ModalA11yHandle | null = null;

    const close = (): void => {
        if (closed) return;
        closed = true;
        openModals.delete(handle);
        try { a11y?.release(); } catch { /* already released */ }
        overlay.remove();
        for (const cb of closeCbs) { try { cb(); } catch (e) { console.warn('🪼 Jellyfin Canopy: arr modal close cb failed', e); } }
    };

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    a11y = installModalA11y(dialog, {
        labelledBy: titleId,
        initialFocus: closeBtn,
        onEscape: close,
    });

    const handle: ArrModalHandle = {
        overlay,
        dialog,
        body,
        footer,
        identity,
        isActive: () => !closed && JC.identity.isCurrent(identity),
        setSubtitle: (text: string) => {
            if (!closed && JC.identity.isCurrent(identity)) subtitleEl.textContent = text;
        },
        close,
        onClose: (cb: () => void) => { closeCbs.push(cb); },
    };
    openModals.add(handle);
    return handle;
}

JC.identity.registerReset('arr-search-modals', () => {
    for (const modal of Array.from(openModals)) modal.close();
});
