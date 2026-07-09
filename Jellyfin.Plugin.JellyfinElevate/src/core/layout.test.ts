// Unit tests for src/core/layout.ts — modern-vs-legacy detection and the
// <html> class stamp that lets CSS scope rules per layout (v12-platform.md §1:
// the html element itself carries `layout-desktop` on BOTH layouts, so DOM
// visibility is the only discriminator).
//
// jsdom does no layout, so `offsetParent` is always null and
// `getClientRects()` always empty. The tests therefore stub exactly the two
// signals the module reads: `.headerRight`'s offsetParent (legacy visibility)
// and the MUI toolbar's client rects (modern visibility).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectLayoutMode, resetLayoutCacheForTests, stampLayoutClass } from './layout';

/** Give an element a non-null offsetParent (jsdom reports null for everything). */
function markVisibleViaOffsetParent(el: HTMLElement): void {
    Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
}

/** Give an element a non-empty getClientRects() (jsdom returns empty). */
function markVisibleViaClientRects(el: HTMLElement): void {
    const rects = [{ width: 100, height: 48 }] as unknown as DOMRectList;
    el.getClientRects = () => rects;
}

function addLegacyHeader(visible: boolean): HTMLElement {
    const header = document.createElement('div');
    header.className = 'headerRight';
    document.body.appendChild(header);
    if (visible) markVisibleViaOffsetParent(header);
    return header;
}

function addMuiToolbar(visible: boolean): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'MuiAppBar-root';
    const toolbar = document.createElement('div');
    toolbar.className = 'MuiToolbar-root';
    bar.appendChild(toolbar);
    document.body.appendChild(bar);
    if (visible) markVisibleViaClientRects(toolbar);
    return toolbar;
}

beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.className = '';
    resetLayoutCacheForTests();
});

afterEach(() => {
    document.body.innerHTML = '';
    document.documentElement.className = '';
    resetLayoutCacheForTests();
});

describe('detectLayoutMode', () => {
    it('returns legacy when .headerRight is present and visible', () => {
        addLegacyHeader(true);
        expect(detectLayoutMode()).toBe('legacy');
    });

    it('returns modern when the MUI toolbar is visible and .headerRight is not', () => {
        addLegacyHeader(false); // present but hidden (display:none wrapper on modern)
        addMuiToolbar(true);
        expect(detectLayoutMode()).toBe('modern');
    });

    it('prefers legacy when the legacy header is genuinely visible', () => {
        addLegacyHeader(true);
        addMuiToolbar(true); // MUI stylesheet/DOM can coexist on legacy
        expect(detectLayoutMode()).toBe('legacy');
    });

    it('returns null when no header has rendered yet (not cached)', () => {
        expect(detectLayoutMode()).toBeNull();
        // A later render must still resolve — a null result is never cached.
        addMuiToolbar(true);
        expect(detectLayoutMode()).toBe('modern');
    });

    it('caches the first successful resolution', () => {
        addMuiToolbar(true);
        expect(detectLayoutMode()).toBe('modern');
        // Even after the DOM changes to look legacy, the cached value wins
        // (layout is fixed per page load).
        document.body.innerHTML = '';
        addLegacyHeader(true);
        expect(detectLayoutMode()).toBe('modern');
    });
});

describe('stampLayoutClass', () => {
    it('stamps je-modern-layout on <html> for the modern layout', () => {
        addMuiToolbar(true);
        stampLayoutClass();
        expect(document.documentElement.classList.contains('je-modern-layout')).toBe(true);
        expect(document.documentElement.classList.contains('je-legacy-layout')).toBe(false);
    });

    it('stamps je-legacy-layout on <html> for the legacy layout', () => {
        addLegacyHeader(true);
        stampLayoutClass();
        expect(document.documentElement.classList.contains('je-legacy-layout')).toBe(true);
        expect(document.documentElement.classList.contains('je-modern-layout')).toBe(false);
    });

    it('stamps nothing while the layout is undeterminable (safe default holds)', () => {
        stampLayoutClass();
        expect(document.documentElement.classList.contains('je-modern-layout')).toBe(false);
        expect(document.documentElement.classList.contains('je-legacy-layout')).toBe(false);
    });

    it('is idempotent', () => {
        addMuiToolbar(true);
        stampLayoutClass();
        stampLayoutClass();
        expect(document.documentElement.classList.contains('je-modern-layout')).toBe(true);
    });
});
