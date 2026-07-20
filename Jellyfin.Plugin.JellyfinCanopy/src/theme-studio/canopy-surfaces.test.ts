import { describe, expect, it } from 'vitest';
import {
    serializeCanopySurfaceAdapters,
    THEME_CANOPY_SURFACE_MODULES,
} from './canopy-surfaces';

describe('Theme Studio Canopy surface contract', () => {
    it('keeps the complete issue #393 component matrix machine-readable', () => {
        expect(THEME_CANOPY_SURFACE_MODULES.map((module) => module.id)).toEqual([
            'canopy-shell-v1',
            'canopy-protection-v1',
            'canopy-card-overlays-v1',
            'canopy-transient-ui-v1',
        ]);
        expect(new Set(THEME_CANOPY_SURFACE_MODULES.map((module) => module.id)).size)
            .toBe(THEME_CANOPY_SURFACE_MODULES.length);

        for (const module of THEME_CANOPY_SURFACE_MODULES) {
            expect(module.outcome, module.id).toBeTruthy();
            expect(module.tokens.length, `${module.id}/tokens`).toBeGreaterThan(0);
            expect(module.modernRoles.length, `${module.id}/roles`).toBeGreaterThan(0);
            const hooks = [...module.modernRoles, ...module.policyHooks, ...module.decorativeHooks];
            expect(new Set(hooks).size, `${module.id}/duplicate hook`).toBe(hooks.length);
        }
    });

    it('gates every adapter to modern phone, desktop and wide browser layouts', () => {
        const css = serializeCanopySurfaceAdapters(':root.jc-modern-layout[data-jc-theme-active="true"]');
        expect(css).toContain('[data-jc-theme-breakpoint="phone"]');
        expect(css).toContain('[data-jc-theme-breakpoint="desktop"]');
        expect(css).toContain('[data-jc-theme-breakpoint="wide"]');
        expect(css).toContain(':not([data-jc-theme-route="dashboard"])');
        expect(css).not.toContain('[data-jc-theme-breakpoint="tablet"]');
        expect(css).not.toContain('.jc-legacy-layout');
        expect(css).not.toContain('.layout-tv');
        expect(css).not.toContain('.skinHeader');
    });

    it('maps shell, protection, overlay and transient states without changing policy', () => {
        const css = serializeCanopySurfaceAdapters(':root[data-jc-theme-preview="true"]');
        for (const marker of [
            'Adapter canopy-shell-v1',
            'Adapter canopy-protection-v1',
            'Adapter canopy-card-overlays-v1',
            'Adapter canopy-transient-ui-v1',
            '#jellyfin-canopy-panel',
            '#jc-native-tabs-group',
            '#randomItemButton.loading',
            '.jc-spoiler-blur-btn[data-jc-spoiler-state="loading"]',
            '.jc-hide-confirm-dialog',
            '.jc-hidden-admin-editing',
            '.jc-tag-lane[data-jc-tag-position]',
            '.jc-anime-filler-marker',
            '.mediaInfoOfficialRating[data-jc-colored-rating="true"]',
            '.jellyfin-canopy-toast',
            '.actionSheetMenuItem[data-id="remove-continue-watching"]',
        ]) expect(css, marker).toContain(marker);

        // The adapter cannot reveal or re-authorize anything. Exact hidden and
        // home-policy hooks stay in the registry but are absent from emitted CSS.
        expect(css).not.toMatch(/(?:^|\s)\.jc-hidden\s*\{/m);
        expect(css).not.toContain('[data-jc-home-removed]');
        expect(css).not.toContain('[data-jc-home-section-hidden]');
        expect(css).not.toMatch(/(?:^|[;{\n])\s*filter:\s*none\s*!important/m);
        expect(css).not.toContain('content:');
    });

    it('covers collision, touch, focus, RTL, low-effects and high-contrast states', () => {
        const css = serializeCanopySurfaceAdapters(':root[data-jc-theme-active="true"]');
        expect(css).toContain('.jc-tag-host > .jc-tag-lane');
        expect(css).toContain('[data-jc-tag-position="top-right"]');
        expect(css).toContain('flex-direction: column-reverse');
        expect(css).toContain(':has(.jc-hide-btn)');
        expect(css).toContain('.card:focus-within .genre-tag .genre-text');
        expect(css).toContain('[data-jc-theme-pointer="coarse"]');
        expect(css).toContain('[dir="rtl"]');
        expect(css).toContain('min-inline-size: max(2.75rem, 44px)');
        expect(css).toContain('[data-jc-theme-transparency="reduced"]');
        expect(css).toContain('[data-jc-theme-effects-level="minimal"]');
        expect(css).toContain('@media (forced-colors: active)');
        expect(css).toContain('@media (orientation: landscape) and (max-height: 599px)');
        expect(css).not.toContain('url(');
        expect(css).not.toContain('@import');
        expect(css).not.toMatch(/(?:^|[;{\n])\s*order\s*:/m);
    });
});
