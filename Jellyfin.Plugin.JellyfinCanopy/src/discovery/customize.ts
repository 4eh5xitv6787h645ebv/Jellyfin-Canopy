// src/discovery/customize.ts
//
// The per-user "Customize" modal for a Discovery feed: one reorderable list of every candidate row
// (built-ins + the media type's genres). A checkbox includes/excludes a row; up/down reorder it.
// Saving persists the checked rows in list order as the user's row set (prefs.ts) and re-renders.
// Reorder is up/down buttons rather than drag so it works with a remote/touch too. Inline-styled so
// it stands alone; accessibility (focus trap, Escape, aria) comes from the shared installModalA11y.

import { JC } from '../globals';
import { installModalA11y, type ModalA11yHandle } from '../core/modal-a11y';
import type { DiscoveryMediaType, DiscoveryRowSpec } from './rows';
import { specFromId, defaultRowIds, BUILTIN_ORDER } from './rows';
import { getUserRowIds, setUserRowIds, clearUserRowIds } from './prefs';

interface Item { id: string; label: string; checked: boolean }

let activeClose: (() => void) | null = null;

function labelFor(spec: DiscoveryRowSpec): string {
    return spec.title || (spec.titleKey ? JC.t!(spec.titleKey) : spec.id);
}

/** Builds the initial ordered item list: the user's current rows first (checked), then the rest. */
function buildItems(mt: DiscoveryMediaType, genres: Map<number, string>): Item[] {
    const candidates: string[] = [...BUILTIN_ORDER];
    for (const gid of genres.keys()) candidates.push(`genre:${gid}`);

    const current = getUserRowIds(mt) ?? defaultRowIds(genres);
    const seen = new Set<string>();
    const items: Item[] = [];
    for (const id of current) {
        const spec = specFromId(id, genres);
        if (spec && !seen.has(id)) { items.push({ id, label: labelFor(spec), checked: true }); seen.add(id); }
    }
    for (const id of candidates) {
        if (seen.has(id)) continue;
        const spec = specFromId(id, genres);
        if (spec) { items.push({ id, label: labelFor(spec), checked: false }); seen.add(id); }
    }
    return items;
}

/**
 * Opens the customize modal. `genres` names/offers genre rows; `onSave(ids | null)` fires with the
 * new row-id list (or null when reset to defaults) so the caller can re-render the feed.
 */
export function openCustomize(mt: DiscoveryMediaType, genres: Map<number, string>, onSave: (ids: string[] | null) => void): void {
    if (activeClose) activeClose();
    const context = JC.identity.capture();
    if (!context) return;
    const items = buildItems(mt, genres);

    const overlay = document.createElement('div');
    overlay.className = 'jc-discovery-customize-overlay';
    overlay.setAttribute('data-jc-identity-owned', 'true');
    JC.identity.own(overlay, context);
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1000001;background:rgba(0,0,0,0.75);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:linear-gradient(135deg,rgba(30,30,35,0.98),rgba(20,20,25,0.98));border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:22px;max-width:480px;width:100%;color:#fff;max-height:82vh;display:flex;flex-direction:column;';

    const title = document.createElement('h3');
    title.id = 'jc-discovery-customize-title';
    title.textContent = JC.t!('discovery_customize_title');
    title.style.cssText = 'margin:0 0 4px 0;font-size:18px;font-weight:600;';
    const hint = document.createElement('div');
    hint.textContent = JC.t!('discovery_customize_hint');
    hint.style.cssText = 'font-size:12px;opacity:0.65;margin-bottom:14px;';
    dialog.appendChild(title);
    dialog.appendChild(hint);

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px;overflow-y:auto;margin-bottom:16px;';
    dialog.appendChild(list);

    function render(): void {
        list.textContent = '';
        items.forEach((item, i) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;background:rgba(255,255,255,0.05);border-radius:6px;';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = item.checked;
            cb.setAttribute('aria-label', item.label);
            cb.addEventListener('change', () => {
                if (JC.identity.isCurrent(context)) item.checked = cb.checked;
            });

            const name = document.createElement('span');
            name.textContent = item.label;
            name.style.cssText = 'flex:1 1 auto;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

            const up = mkArrow('▲', JC.t!('discovery_customize_move_up'), i === 0, () => { swap(i, i - 1); });
            const down = mkArrow('▼', JC.t!('discovery_customize_move_down'), i === items.length - 1, () => { swap(i, i + 1); });

            row.append(cb, name, up, down);
            list.appendChild(row);
        });
    }

    function mkArrow(glyph: string, label: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
        const b = document.createElement('button');
        b.setAttribute('is', 'emby-button');
        b.type = 'button';
        b.textContent = glyph;
        b.setAttribute('aria-label', label);
        b.disabled = disabled;
        b.style.cssText = `background:rgba(255,255,255,0.08);border:none;color:#fff;border-radius:4px;width:30px;height:30px;cursor:${disabled ? 'default' : 'pointer'};opacity:${disabled ? 0.3 : 1};font-size:11px;`;
        if (!disabled) b.addEventListener('click', () => {
            if (JC.identity.isCurrent(context)) onClick();
        });
        return b;
    }

    function swap(a: number, b: number): void {
        if (!JC.identity.isCurrent(context)) return;
        if (b < 0 || b >= items.length) return;
        [items[a], items[b]] = [items[b], items[a]];
        render();
    }

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;justify-content:space-between;gap:10px;align-items:center;';
    const reset = mkTextButton(JC.t!('discovery_customize_reset'), 'rgba(255,255,255,0.1)');
    const right = document.createElement('div');
    right.style.cssText = 'display:flex;gap:10px;';
    const cancel = mkTextButton(JC.t!('discovery_customize_cancel'), 'rgba(255,255,255,0.1)');
    const save = mkTextButton(JC.t!('discovery_customize_save'), 'rgba(0,164,220,0.75)');
    right.append(cancel, save);
    buttons.append(reset, right);
    dialog.appendChild(buttons);

    let a11y: ModalA11yHandle | null = null;
    const close = (): void => {
        if (activeClose === close) activeClose = null;
        a11y?.release();
        overlay.remove();
    };
    activeClose = close;
    cancel.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    reset.addEventListener('click', () => {
        if (!JC.identity.isCurrent(context)) return;
        clearUserRowIds(mt);
        close();
        if (JC.identity.isCurrent(context)) onSave(null);
    });
    save.addEventListener('click', () => {
        if (!JC.identity.isCurrent(context)) return;
        const ids = items.filter((it) => it.checked).map((it) => it.id);
        setUserRowIds(mt, ids);
        close();
        if (JC.identity.isCurrent(context)) onSave(ids);
    });

    render();
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    a11y = installModalA11y(dialog, { labelledBy: 'jc-discovery-customize-title', initialFocus: save, onEscape: close });
}

/** Close the activation-owned customization surface, if present. */
export function resetDiscoveryCustomize(): void {
    activeClose?.();
}

function mkTextButton(text: string, bg: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.setAttribute('is', 'emby-button');
    b.type = 'button';
    b.textContent = text;
    b.style.cssText = `background:${bg};border:1px solid rgba(255,255,255,0.15);color:#fff;padding:8px 18px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;`;
    return b;
}
