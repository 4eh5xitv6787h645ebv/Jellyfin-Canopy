// Unit tests for src/core/ui-kit.ts (escapeHtml + CSS injection).
import { describe, expect, it, vi } from 'vitest';
import {
    escapeHtml,
    injectCss,
    muiIconButton,
    muiMenuItem,
    removeCss,
    sectionContainer
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
        injectCss('je-test-style', '.a { color: red; }');
        const el = document.getElementById('je-test-style');
        expect(el?.tagName).toBe('STYLE');
        expect(el?.textContent).toBe('.a { color: red; }');
        removeCss('je-test-style');
    });

    it('replaces (not duplicates) a style injected under the same id', () => {
        injectCss('je-test-dedupe', '.a { color: red; }');
        injectCss('je-test-dedupe', '.a { color: blue; }');
        const matches = document.querySelectorAll('#je-test-dedupe');
        expect(matches.length).toBe(1);
        expect(matches[0].textContent).toBe('.a { color: blue; }');
        removeCss('je-test-dedupe');
    });

    it('removeCss returns true when a style was removed, false otherwise', () => {
        injectCss('je-test-remove', '.a {}');
        expect(removeCss('je-test-remove')).toBe(true);
        expect(document.getElementById('je-test-remove')).toBeNull();
        expect(removeCss('je-test-remove')).toBe(false);
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
        const css = document.getElementById('je-ui-kit-css')?.textContent || '';
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
