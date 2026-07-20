// Unit tests for src/core/ui-kit.ts (escapeHtml + CSS injection).
import { describe, expect, it, vi } from 'vitest';
import {
    escapeHtml,
    expandIn,
    injectCss,
    muiIconButton,
    muiMenuItem,
    removeCss,
    sectionContainer,
    toast
} from './ui-kit';

describe('escapeHtml', () => {
    it('escapes every HTML special character', () => {
        expect(escapeHtml(`<img src="x" onerror='alert(1)'>&`))
            .toBe('&lt;img src=&quot;x&quot; onerror=&#039;alert(1)&#039;&gt;&amp;');
    });

    it('returns plain strings unchanged', () => {
        expect(escapeHtml('The Matrix (1999)')).toBe('The Matrix (1999)');
    });

    it('stringifies non-string values', () => {
        expect(escapeHtml(42)).toBe('42');
        expect(escapeHtml(true)).toBe('true');
    });

    it('turns null and undefined into the empty string', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });

    it('double-escapes already-escaped input (no entity awareness by design)', () => {
        expect(escapeHtml('&amp;')).toBe('&amp;amp;');
    });

    it('escapes ampersands first so later entities are not corrupted', () => {
        expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
    });
});

describe('injectCss / removeCss', () => {
    it('injects a style element with the given id and content', () => {
        injectCss('jc-test-style', '.a { color: red; }');
        const el = document.getElementById('jc-test-style');
        expect(el?.tagName).toBe('STYLE');
        expect(el?.textContent).toBe('.a { color: red; }');
        removeCss('jc-test-style');
    });

    it('replaces (not duplicates) a style injected under the same id', () => {
        injectCss('jc-test-dedupe', '.a { color: red; }');
        injectCss('jc-test-dedupe', '.a { color: blue; }');
        const matches = document.querySelectorAll('#jc-test-dedupe');
        expect(matches.length).toBe(1);
        expect(matches[0].textContent).toBe('.a { color: blue; }');
        removeCss('jc-test-dedupe');
    });

    it('removeCss returns true when a style was removed, false otherwise', () => {
        injectCss('jc-test-remove', '.a {}');
        expect(removeCss('jc-test-remove')).toBe(true);
        expect(document.getElementById('jc-test-remove')).toBeNull();
        expect(removeCss('jc-test-remove')).toBe(false);
    });
});

describe('muiIconButton', () => {
    it('wears the MUI IconButton classes so the running theme styles it', () => {
        const btn = muiIconButton({ icon: 'casino', title: 'Random' });
        expect(btn.tagName).toBe('BUTTON');
        expect(btn.classList.contains('MuiButtonBase-root')).toBe(true);
        expect(btn.classList.contains('MuiIconButton-root')).toBe(true);
        expect(btn.classList.contains('MuiIconButton-sizeLarge')).toBe(true);
        expect(btn.classList.contains('MuiIconButton-colorInherit')).toBe(true);
        expect(btn.title).toBe('Random');
        expect(btn.getAttribute('aria-label')).toBe('Random');
        const glyph = btn.querySelector('.material-icons');
        expect(glyph?.textContent).toBe('casino');
    });

    it('hardcodes no colour (theming comes from MUI classes / tokens)', () => {
        const css = document.getElementById('jc-ui-kit-css')?.textContent || '';
        // The only colour reference is a --jf-palette token, never a literal.
        expect(css).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
        expect(css).not.toMatch(/\brgb\(/);
        expect(css).toContain('var(--jf-palette-text-secondary');
    });

    it('applies size, id, extra classes and click handler', () => {
        const onClick = vi.fn();
        const btn = muiIconButton({ icon: 'tab', size: 'small', id: 'x', className: 'headerButton', onClick });
        expect(btn.id).toBe('x');
        expect(btn.classList.contains('MuiIconButton-sizeSmall')).toBe(true);
        expect(btn.classList.contains('headerButton')).toBe(true);
        btn.dispatchEvent(new MouseEvent('click'));
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});

describe('muiMenuItem', () => {
    it('builds a MuiMenuItem-root li with optional icon and label', () => {
        const onClick = vi.fn();
        const li = muiMenuItem({ label: 'Settings', icon: 'tune', onClick });
        expect(li.tagName).toBe('LI');
        expect(li.classList.contains('MuiMenuItem-root')).toBe(true);
        expect(li.getAttribute('role')).toBe('menuitem');
        expect(li.querySelector('.MuiListItemIcon-root .material-icons')?.textContent).toBe('tune');
        expect(li.querySelector('.MuiTypography-root')?.textContent).toBe('Settings');
        li.dispatchEvent(new MouseEvent('click'));
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('omits the icon wrapper when no icon is given', () => {
        const li = muiMenuItem({ label: 'Plain' });
        expect(li.querySelector('.MuiListItemIcon-root')).toBeNull();
    });
});

describe('sectionContainer', () => {
    it('builds a .verticalSection with a title and accepts appended content', () => {
        const section = sectionContainer({ title: 'Enhanced', id: 'sec' });
        expect(section.classList.contains('verticalSection')).toBe(true);
        expect(section.id).toBe('sec');
        const title = section.querySelector('.sectionTitle');
        expect(title?.textContent).toBe('Enhanced');
        const child = document.createElement('div');
        section.appendChild(child);
        expect(section.lastElementChild).toBe(child);
    });

    it('omits the heading when no title is given', () => {
        const section = sectionContainer();
        expect(section.querySelector('.sectionTitle')).toBeNull();
    });
});

describe('expandIn', () => {
    it('is a no-op when instant is set (pre-paint injection)', () => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        expandIn(el, { instant: true });
        expect(el.style.width).toBe('');
        expect(el.style.overflow).toBe('');
        expect(el.style.transition).toBe('');
        el.remove();
    });

    it('is a no-op for detached or zero-width elements', () => {
        const detached = document.createElement('div');
        expandIn(detached);
        expect(detached.style.width).toBe('');

        // jsdom has no layout, so an attached element measures 0 wide — the
        // guard must leave it untouched rather than pinning width to 0.
        const attached = document.createElement('div');
        document.body.appendChild(attached);
        expandIn(attached);
        expect(attached.style.width).toBe('');
        expect(attached.style.overflow).toBe('');
        attached.remove();
    });

    it('collapses to width 0 then transitions to the measured natural width', () => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        el.getBoundingClientRect = () => ({ width: 48 } as DOMRect);

        expandIn(el);
        expect(el.style.width).toBe('48px');
        expect(el.style.overflow).toBe('hidden');
        expect(el.style.transition).toContain('width 150ms');
        el.remove();
    });

    it('removes every inline style once the transition ends', () => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        el.getBoundingClientRect = () => ({ width: 48 } as DOMRect);

        expandIn(el, { durationMs: 20 });
        el.dispatchEvent(new Event('transitionend'));
        expect(el.style.width).toBe('');
        expect(el.style.overflow).toBe('');
        expect(el.style.transition).toBe('');
        el.remove();
    });

    it('falls back to the timeout when transitionend never fires', async () => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        el.getBoundingClientRect = () => ({ width: 48 } as DOMRect);

        expandIn(el, { durationMs: 10 });
        await new Promise((r) => setTimeout(r, 150));
        expect(el.style.width).toBe('');
        expect(el.style.transition).toBe('');
        el.remove();
    });
});

describe('toast scheduling', () => {
    it('shows, hides, and removes the toast on deterministic timers', () => {
        vi.useFakeTimers();
        try {
            toast('<strong>Saved</strong>', 1_000);

            const node = document.querySelector<HTMLElement>('.jellyfin-canopy-toast');
            expect(node).not.toBeNull();
            expect(node?.innerHTML).toBe('<strong>Saved</strong>');
            expect(node?.style.transform).toBe('translateX(100%)');
            expect(node?.dataset.jcThemeVisibility).toBe('hidden');

            vi.advanceTimersByTime(9);
            expect(node?.style.transform).toBe('translateX(100%)');

            vi.advanceTimersByTime(1);
            expect(node?.style.transform).toBe('translateX(0)');
            expect(node?.dataset.jcThemeVisibility).toBe('visible');

            vi.advanceTimersByTime(990);
            expect(node?.style.transform).toBe('translateX(100%)');
            expect(node?.dataset.jcThemeVisibility).toBe('hidden');
            expect(node?.isConnected).toBe(true);

            vi.advanceTimersByTime(299);
            expect(node?.isConnected).toBe(true);

            vi.advanceTimersByTime(1);
            expect(node?.isConnected).toBe(false);
        } finally {
            vi.runOnlyPendingTimers();
            vi.useRealTimers();
            document.querySelectorAll('.jellyfin-canopy-toast').forEach((node) => node.remove());
        }
    });

    it('retains the stock physical exit transform in unsupported RTL layouts', () => {
        vi.useFakeTimers();
        document.documentElement.dir = 'rtl';
        try {
            toast('Saved', 1_000);
            const node = document.querySelector<HTMLElement>('.jellyfin-canopy-toast');
            expect(node?.style.right).toBe('20px');
            expect(node?.style.transform).toBe('translateX(100%)');

            vi.advanceTimersByTime(10);
            expect(node?.style.transform).toBe('translateX(0)');
            vi.advanceTimersByTime(990);
            expect(node?.style.transform).toBe('translateX(100%)');
        } finally {
            document.documentElement.removeAttribute('dir');
            vi.runOnlyPendingTimers();
            vi.useRealTimers();
            document.querySelectorAll('.jellyfin-canopy-toast').forEach((node) => node.remove());
        }
    });
});
