import { describe, expect, it } from 'vitest';
import type { UserThemeCssConfiguration } from '../types/jc';
import {
    emptyThemeCssConfiguration,
    parseUserThemeCssConfiguration,
    serializeThemeAdvancedCss,
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
});
