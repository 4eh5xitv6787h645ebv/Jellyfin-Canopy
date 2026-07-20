import { describe, expect, it } from 'vitest';
import { JC } from '../globals';
import { createTestFeatureScope } from '../test/feature-scope';
import type { ApiApi, UserThemeCssConfiguration } from '../types/jc';
import {
    emptyThemeCssConfiguration,
    parseUserThemeCssConfiguration,
    serializeThemeAdvancedCss,
    THEME_ADVANCED_CSS_STYLE_ID,
    ThemeAdvancedCssRuntime,
    validateThemeCssDeclarations,
} from './advanced-css';

function configured(): UserThemeCssConfiguration {
    return {
        Revision: 2,
        SchemaVersion: 1,
        Enabled: true,
        Snippets: [
            {
                Id: 'card-depth',
                Name: 'Card depth',
                Target: 'cards',
                Enabled: true,
                Declarations: ' border-radius: 18px; box-shadow: 0 10px 30px #0008; ',
            },
        ],
    };
}

describe('Theme Studio advanced CSS boundary', () => {
    it('canonicalizes bounded declaration lists and emits only Canopy-owned modern selectors', () => {
        expect(validateThemeCssDeclarations(' color: #fff; --my-gap: calc(1rem + 2px); ')).toEqual({
            valid: true,
            canonical: 'color:#fff;--my-gap:calc(1rem + 2px);',
            code: 'ok',
        });
        const css = serializeThemeAdvancedCss(configured());
        expect(css).toContain(':root.jc-modern-layout[data-jc-theme-active="true"]');
        expect(css).toContain('[data-jc-theme-route]:not([data-jc-theme-route="dashboard"])');
        expect(css).toContain(':is([data-jc-theme-breakpoint="phone"],[data-jc-theme-breakpoint="desktop"],[data-jc-theme-breakpoint="wide"])');
        expect(css).toContain('[data-jc-theme-forced-colors="none"][data-jc-theme-contrast="standard"]');
        expect(css).toContain(':where(.cardBox,.cardScalable,.cardImageContainer)');
        expect(css).not.toMatch(/tablet|legacy|layout-tv/);
    });

    it.each([
        '@import "https://bad.invalid/theme.css";',
        'background: url(https://bad.invalid/pixel);',
        'background: image-set("//bad.invalid/x" 1x);',
        'color:red} body{display:none;',
        'content:"<script>alert(1)</script>";',
        'width:ex\\70ression(alert(1));',
        '-moz-binding:https://bad.invalid/x;',
        'src:data:text/html,bad;',
    ])('rejects executable, markup, selector, and remote constructs: %s', (declarations) => {
        expect(validateThemeCssDeclarations(declarations).valid).toBe(false);
    });

    it('rejects unknown schema, duplicate IDs, unknown targets, oversized text, and extra fields', () => {
        const value = configured();
        expect(parseUserThemeCssConfiguration(value)).not.toBeNull();
        expect(parseUserThemeCssConfiguration({ ...value, SchemaVersion: 2 })).toBeNull();
        expect(parseUserThemeCssConfiguration({ ...value, ServerId: 'private' })).toBeNull();
        expect(parseUserThemeCssConfiguration({
            ...value,
            Snippets: [value.Snippets[0], { ...value.Snippets[0] }],
        })).toBeNull();
        expect(parseUserThemeCssConfiguration({
            ...value,
            Snippets: [{ ...value.Snippets[0], Target: 'dashboard' }],
        })).toBeNull();
        expect(validateThemeCssDeclarations(`color:${'a'.repeat(4097)}`).code).toBe('too_large');
    });

    it('keeps disabled and empty local state inert', () => {
        expect(serializeThemeAdvancedCss(emptyThemeCssConfiguration())).toBe('');
        expect(serializeThemeAdvancedCss({ ...configured(), Enabled: false })).toBe('');
        expect(serializeThemeAdvancedCss({ ...configured(), SchemaVersion: 9 })).toBeNull();
    });

    it('keeps delayed and refreshed style layers absent outside the exact modern presentation gate', async () => {
        const originalApi = JC.core.api;
        const originalConfig = JC.pluginConfig;
        const harness = createTestFeatureScope();
        const root = document.documentElement;
        const setSupportedRoot = (): void => {
            root.classList.remove('jc-legacy-layout', 'layout-tv');
            root.classList.add('jc-modern-layout');
            document.body.classList.remove('layout-tv');
            root.removeAttribute('data-layout');
            root.setAttribute('data-jc-theme-active', 'true');
            root.setAttribute('data-jc-theme-breakpoint', 'phone');
            root.setAttribute('data-jc-theme-route', 'home');
            root.setAttribute('data-jc-theme-forced-colors', 'none');
            root.setAttribute('data-jc-theme-contrast', 'standard');
        };
        let resolveLoad: (value: unknown) => void = () => undefined;
        const plugin = () => new Promise<unknown>((resolve) => { resolveLoad = resolve; });
        let runtime: ThemeAdvancedCssRuntime | null = null;
        try {
            JC.identity.transition('', '', 'advanced-css-test-logout');
            JC.identity.transition('server-a', 'user-a', 'advanced-css-test-login');
            JC.pluginConfig = { ...JC.pluginConfig, ThemeStudioAllowAdvancedCss: true };
            JC.core.api = { plugin } as unknown as ApiApi;
            setSupportedRoot();
            root.setAttribute('data-jc-theme-breakpoint', 'tablet');
            runtime = new ThemeAdvancedCssRuntime(harness.scope);
            runtime.install();
            const ready = runtime.whenReady();

            resolveLoad(configured());
            await expect(ready).resolves.toBe(true);
            expect(document.getElementById(THEME_ADVANCED_CSS_STYLE_ID)).toBeNull();

            setSupportedRoot();
            runtime.refresh();
            expect(document.getElementById(THEME_ADVANCED_CSS_STYLE_ID)).toBeInstanceOf(HTMLStyleElement);

            const unsupported: Array<readonly [string, () => void]> = [
                ['tablet', () => root.setAttribute('data-jc-theme-breakpoint', 'tablet')],
                ['legacy', () => root.classList.add('jc-legacy-layout')],
                ['root TV', () => root.classList.add('layout-tv')],
                ['body TV', () => document.body.classList.add('layout-tv')],
                ['TV attribute', () => root.setAttribute('data-layout', 'tv')],
                ['dashboard', () => root.setAttribute('data-jc-theme-route', 'dashboard')],
                ['forced colors', () => root.setAttribute('data-jc-theme-forced-colors', 'active')],
                ['increased contrast', () => root.setAttribute('data-jc-theme-contrast', 'more')],
            ];
            for (const [name, makeUnsupported] of unsupported) {
                setSupportedRoot();
                runtime.refresh();
                makeUnsupported();
                runtime.refresh();
                expect(document.getElementById(THEME_ADVANCED_CSS_STYLE_ID), name).toBeNull();
            }
        } finally {
            runtime?.dispose();
            await harness.dispose();
            document.getElementById(THEME_ADVANCED_CSS_STYLE_ID)?.remove();
            for (const name of [...root.attributes].map((attribute) => attribute.name)) {
                if (name.startsWith('data-jc-theme-')) root.removeAttribute(name);
            }
            root.removeAttribute('data-layout');
            root.classList.remove('jc-modern-layout', 'jc-legacy-layout', 'layout-tv');
            document.body.classList.remove('layout-tv');
            JC.core.api = originalApi;
            JC.pluginConfig = originalConfig;
            JC.identity.transition('', '', 'advanced-css-test-cleanup');
        }
    });
});
