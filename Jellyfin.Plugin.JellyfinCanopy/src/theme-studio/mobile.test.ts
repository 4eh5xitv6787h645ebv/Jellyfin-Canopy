import { describe, expect, it } from 'vitest';
import {
    resolveMobileEnvironment,
    serializeMobileAdapters,
    serializeMobileEnvironmentStyle,
} from './mobile';

describe('Theme Studio modern-phone environment', () => {
    it('distinguishes browser chrome from a material virtual-keyboard inset', () => {
        expect(resolveMobileEnvironment({
            phone: true,
            layoutWidth: 390,
            layoutHeight: 844,
            visualHeight: 790,
            visualOffsetTop: 0,
            visualScale: 1,
            editableFocused: false,
            reducedTransparency: false,
            backdropFilterSupported: true,
            deviceMemory: 8,
            hardwareConcurrency: 8,
        })).toEqual({
            orientation: 'portrait',
            keyboard: 'closed',
            performance: 'full',
            visualHeight: 790,
            visualOffsetTop: 0,
            keyboardInset: 0,
        });

        expect(resolveMobileEnvironment({
            phone: true,
            layoutWidth: 844,
            layoutHeight: 390,
            visualHeight: 220,
            visualOffsetTop: 0,
            visualScale: 1,
            editableFocused: true,
            reducedTransparency: false,
            backdropFilterSupported: true,
            deviceMemory: 8,
            hardwareConcurrency: 8,
        })).toMatchObject({
            orientation: 'landscape', keyboard: 'open', keyboardInset: 170,
        });
    });

    it('reduces unsupported effects only on phones, never coarse-pointer desktop by implication', () => {
        const input = {
            layoutWidth: 1366,
            layoutHeight: 768,
            visualHeight: 420,
            visualOffsetTop: 0,
            visualScale: 1,
            editableFocused: true,
            reducedTransparency: false,
            backdropFilterSupported: false,
            deviceMemory: 1,
            hardwareConcurrency: 2,
        } as const;
        expect(resolveMobileEnvironment({ ...input, phone: true })).toMatchObject({
            keyboard: 'open', performance: 'reduced',
        });
        expect(resolveMobileEnvironment({ ...input, phone: false })).toMatchObject({
            keyboard: 'closed', performance: 'full',
        });
    });

    it('bounds viewport values before CSS serialization', () => {
        const environment = resolveMobileEnvironment({
            phone: true,
            layoutWidth: Number.POSITIVE_INFINITY,
            layoutHeight: 844,
            visualHeight: 999_999,
            visualOffsetTop: -90,
            visualScale: 1,
            editableFocused: false,
            reducedTransparency: false,
            backdropFilterSupported: true,
            deviceMemory: null,
            hardwareConcurrency: null,
        });
        expect(serializeMobileEnvironmentStyle(':root', environment)).toBe(`:root {
  --jc-visual-viewport-height: 10000px;
  --jc-visual-viewport-top: 0px;
  --jc-keyboard-inset: 0px;
}`);
    });

    it('serializes a phone-only, logical, non-reordering adapter', () => {
        const css = serializeMobileAdapters(':root.jc-modern-layout[data-jc-theme-active="true"]');
        expect(css).toContain('Adapter mobile-safe-area-v12');
        expect(css).toContain('[data-jc-theme-breakpoint="phone"]');
        expect(css).toContain('var(--jc-safe-area-bottom)');
        expect(css).toContain('var(--jc-visual-viewport-height)');
        expect(css).toContain('var(--jc-keyboard-inset)');
        expect(css).toContain('inset-block-end: calc(var(--jc-keyboard-inset)');
        expect(css).toContain('inset-block-end: var(--jc-keyboard-inset) !important');
        expect(css).toContain('.actionSheetScroller');
        expect(css).toContain('.videoOsdBottom');
        expect(css).toContain('.jc-discovery-customize-overlay');
        expect(css).toContain('.jc-remove-confirm-overlay');
        expect(css).toContain('#pause-screen-content');
        expect(css).toContain('.arr-dropdown-menu');
        expect(css).toContain('.jc-elsewhere-blur-surface');
        expect(css).toContain('[data-jc-theme-performance="reduced"] .seerr-season-header::before');
        expect(css).not.toMatch(/:where\([^)]*::before/s);
        expect(css).toContain('min-block-size: max(2.75rem, 44px)');
        expect(css).not.toContain('[data-jc-theme-breakpoint="tablet"]');
        expect(css).not.toContain('[data-jc-theme-breakpoint="tv"]');
        expect(css).not.toContain('.jc-legacy-layout');
        expect(css).not.toMatch(/(?:^|[;{\n])\s*order\s*:/m);
    });

    it('never treats pinch zoom or an unfocused viewport reduction as a keyboard', () => {
        const input = {
            phone: true,
            layoutWidth: 390,
            layoutHeight: 844,
            visualHeight: 422,
            visualOffsetTop: 0,
            reducedTransparency: false,
            backdropFilterSupported: true,
            deviceMemory: 8,
            hardwareConcurrency: 8,
        } as const;
        expect(resolveMobileEnvironment({
            ...input, visualScale: 2, editableFocused: true,
        })).toMatchObject({ keyboard: 'closed', keyboardInset: 0 });
        expect(resolveMobileEnvironment({
            ...input, visualScale: 1, editableFocused: false,
        })).toMatchObject({ keyboard: 'closed', keyboardInset: 0 });
        expect(resolveMobileEnvironment({
            ...input, visualScale: 1, editableFocused: true,
        })).toMatchObject({ keyboard: 'open', keyboardInset: 422 });
    });
});
