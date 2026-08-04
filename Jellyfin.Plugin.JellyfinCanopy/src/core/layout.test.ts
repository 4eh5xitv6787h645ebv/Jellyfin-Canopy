// Unit tests for the modern-only layout readiness owner.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    detectModernLayout,
    resetLayoutCacheForTests,
    stampLayoutClass,
    stampResolvedModernLayout,
} from './layout';

function addMuiToolbar(visible: boolean): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'MuiAppBar-root';
    const toolbar = document.createElement('div');
    toolbar.className = 'MuiToolbar-root';
    bar.appendChild(toolbar);
    document.body.appendChild(bar);
    if (visible) {
        const rects = [{ width: 100, height: 48 }] as unknown as DOMRectList;
        toolbar.getClientRects = () => rects;
    }
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

describe('detectModernLayout', () => {
    it('returns true when the MUI toolbar is visible', () => {
        addMuiToolbar(true);
        expect(detectModernLayout()).toBe(true);
    });

    it('returns false until the MUI toolbar renders visibly', () => {
        expect(detectModernLayout()).toBe(false);
        addMuiToolbar(true);
        expect(detectModernLayout()).toBe(true);
    });

    it('caches the first successful resolution for the document', () => {
        addMuiToolbar(true);
        expect(detectModernLayout()).toBe(true);
        document.body.innerHTML = '';
        expect(detectModernLayout()).toBe(true);
    });
});

describe('modern layout stamp', () => {
    it('stamps jc-modern-layout when the toolbar is ready', () => {
        addMuiToolbar(true);
        stampLayoutClass();
        expect(document.documentElement.classList.contains('jc-modern-layout')).toBe(true);
    });

    it('does not stamp before the toolbar is ready', () => {
        stampLayoutClass();
        expect(document.documentElement.classList.contains('jc-modern-layout')).toBe(false);
    });

    it('accepts a resolver-owned modern proof without another DOM probe', () => {
        stampResolvedModernLayout();
        expect(document.documentElement.classList.contains('jc-modern-layout')).toBe(true);
        expect(detectModernLayout()).toBe(true);
    });
});
