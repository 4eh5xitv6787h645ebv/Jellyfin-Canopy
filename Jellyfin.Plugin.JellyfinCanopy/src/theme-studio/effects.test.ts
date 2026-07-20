import { describe, expect, it } from 'vitest';
import { serializeEffectsAdapters, THEME_EFFECT_MODULES } from './effects';

describe('Theme Studio bounded effects adapters', () => {
    const css = serializeEffectsAdapters(':root.jc-modern-layout[data-jc-theme-active="true"]');

    it('publishes a finite property inventory with no layout animation', () => {
        expect(THEME_EFFECT_MODULES.map((module) => module.id)).toEqual([
            'materials-v12', 'elevation-v12', 'backdrop-treatment-v12', 'motion-v12',
        ]);
        const properties = new Set(THEME_EFFECT_MODULES.flatMap((module) => [...module.properties]));
        for (const forbidden of [
            'width', 'height', 'inset', 'top', 'right', 'bottom', 'left', 'margin', 'padding',
            'display', 'position', 'grid-template-columns',
        ]) expect(properties.has(forbidden), forbidden).toBe(false);
        expect(properties.size).toBeLessThanOrEqual(10);
    });

    it('targets only modern phone, desktop, and wide roots with bounded selectors', () => {
        expect(css).toContain('[data-jc-theme-breakpoint="phone"]');
        expect(css).toContain('[data-jc-theme-breakpoint="desktop"]');
        expect(css).toContain('[data-jc-theme-breakpoint="wide"]');
        expect(css).not.toContain('[data-jc-theme-breakpoint="tablet"]');
        expect(css).not.toContain('[data-jc-theme-breakpoint="tv"]');
        expect(css).not.toContain('jc-legacy-layout');
        expect(css).toContain(':nth-child(-n + 8)');
        expect(css).not.toMatch(/nth-child\((?:9|[1-9]\d+)/);
    });

    it('contains no particles, remote resources, layout transitions, per-card filter, or text blur', () => {
        expect(css).not.toMatch(/particle/i);
        expect(css).not.toContain('url(');
        expect(css).not.toContain('@import');
        expect(css).not.toMatch(/transition-property:[^;]*(?:width|height|margin|padding|inset|top|left)/);
        expect(css).not.toMatch(/(?:\.cardBox|\.visualCardBox|\.jc-card)[^{]*\{[^}]*filter\s*:/s);
        const blurRules = css.split('}').filter((rule) => /(?:^|\n)\s*filter\s*:\s*blur/.test(rule));
        expect(blurRules).toHaveLength(1);
        expect(blurRules[0]).toContain('.backdropImage');
        expect(blurRules[0]).toContain('.backgroundContainer img');
    });

    it('keeps reduced transparency and forced colors as separate fail-safe branches', () => {
        expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\)[\s\S]*background-color: var\(--jc-color-surface\) !important/);
        expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*background-color: Canvas !important/);
        expect(css).toContain('@media (forced-colors: active), (prefers-reduced-motion: reduce)');
    });
});
