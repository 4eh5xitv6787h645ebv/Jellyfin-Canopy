// Unit tests for src/core/ui-kit.ts (escapeHtml + CSS injection).
import { describe, expect, it } from 'vitest';
import { escapeHtml, injectCss, removeCss } from './ui-kit';

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
