import { describe, expect, it } from 'vitest';
import { serializePresentationAdapters, THEME_PRESENTATION_MODULES } from './presentation';

describe('Theme Studio Jellyfin presentation modules', () => {
    it('keeps the complete issue #388 modern surface matrix machine-readable', () => {
        expect(THEME_PRESENTATION_MODULES.map((module) => module.id)).toEqual([
            'shell-navigation-v12',
            'home-hero-v12',
            'media-cards-v12',
            'details-cast-v12',
            'seasons-v12',
            'progress-indicators-v12',
            'dialogs-forms-v12',
        ]);
        expect(new Set(THEME_PRESENTATION_MODULES.map((module) => module.id)).size)
            .toBe(THEME_PRESENTATION_MODULES.length);
        for (const module of THEME_PRESENTATION_MODULES) {
            expect(module.outcome, module.id).toBeTruthy();
            expect(module.tokens.length, `${module.id}/tokens`).toBeGreaterThan(0);
            expect(module.modernRoles.length, `${module.id}/modern`).toBeGreaterThan(0);
        }
    });

    it('serializes only route-scoped presentation and leaves dashboard recovery untouched', () => {
        const css = serializePresentationAdapters(':root[data-jc-theme-active="true"]');
        expect(css).toContain(
            ':root[data-jc-theme-active="true"][data-jc-theme-route]'
            + ':not([data-jc-theme-route="dashboard"])',
        );
        expect(css).not.toContain('body:not([data-jc-theme-route="dashboard"])');
        expect(css).not.toContain('url(');
        expect(css).not.toContain('@import');
    });

    it('never uses CSS reordering or generated MUI class hashes', () => {
        const css = serializePresentationAdapters(':root[data-jc-theme-preview="true"]');
        expect(css).not.toMatch(/(?:^|[;{\n])\s*order\s*:/m);
        expect(css).not.toMatch(/(?:^|[;{\n])\s*grid-area\s*:/m);
        expect(css).not.toContain('display: contents');
        expect(css).not.toMatch(/\.css-[a-z0-9]+/i);
        expect(css).toContain('.MuiAppBar-root');
        expect(css).not.toContain('.skinHeader');
        expect(css).not.toContain('.mainDrawer');
        expect(css).toContain('#childrenCollapsible');
        expect(css).toContain('#castCollapsible');
    });

    it('keeps interactive targets at 44 CSS pixels even when Jellyfin scales rem units', () => {
        const css = serializePresentationAdapters(':root[data-jc-theme-active="true"]');
        expect(css).toContain('min-block-size: max(2.75rem, 44px)');
        expect(css).toContain('min-inline-size: max(2.75rem, 44px)');
        expect(css).not.toMatch(/min-block-size:\s*2\.75rem/);
    });

    it('bounds the cinematic lead card below the desktop viewport budget', () => {
        const css = serializePresentationAdapters(':root[data-jc-theme-active="true"]');
        expect(css).toContain('inline-size: clamp(20rem, 52vw, 48rem) !important');
        expect(css).not.toContain('inline-size: clamp(20rem, 72vw, 58rem)');
    });
});
