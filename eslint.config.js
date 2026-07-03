'use strict';

/**
 * ESLint flat config for the Jellyfin Enhanced client scripts.
 *
 * The js/ tree is plain browser JavaScript served raw by the plugin (no
 * bundler), so every file is a classic script sharing globals — primarily
 * the window.JellyfinEnhanced namespace and the globals jellyfin-web
 * exposes (ApiClient, Emby, ...).
 *
 * Policy: rules that catch real defects (undefined symbols, duplicate keys,
 * unreachable code) are errors and gate CI; stylistic preferences are left
 * to the codebase's existing conventions rather than enforced here.
 */

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

/** Globals provided by the browser + jellyfin-web at runtime. */
const jellyfinWebGlobals = {
    // Jellyfin web client
    ApiClient: 'readonly',
    Emby: 'readonly',
    Dashboard: 'readonly',
    // This plugin's own namespace (created by js/plugin.js before any module loads)
    JellyfinEnhanced: 'writable',
};

module.exports = [
    {
        ignores: ['node_modules/**', 'docs/**', 'site/**', '**/bin/**', '**/obj/**'],
    },
    {
        files: ['Jellyfin.Plugin.JellyfinEnhanced/js/**/*.js', 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                // Browser environment
                window: 'readonly',
                document: 'readonly',
                navigator: 'readonly',
                location: 'readonly',
                history: 'readonly',
                localStorage: 'readonly',
                sessionStorage: 'readonly',
                fetch: 'readonly',
                Headers: 'readonly',
                Request: 'readonly',
                Response: 'readonly',
                AbortController: 'readonly',
                URL: 'readonly',
                URLSearchParams: 'readonly',
                FormData: 'readonly',
                Blob: 'readonly',
                File: 'readonly',
                FileReader: 'readonly',
                Image: 'readonly',
                Audio: 'readonly',
                MutationObserver: 'readonly',
                IntersectionObserver: 'readonly',
                ResizeObserver: 'readonly',
                requestAnimationFrame: 'readonly',
                cancelAnimationFrame: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                console: 'readonly',
                CustomEvent: 'readonly',
                Event: 'readonly',
                KeyboardEvent: 'readonly',
                Node: 'readonly',
                NodeFilter: 'readonly',
                Element: 'readonly',
                HTMLElement: 'readonly',
                DOMParser: 'readonly',
                getComputedStyle: 'readonly',
                matchMedia: 'readonly',
                screen: 'readonly',
                performance: 'readonly',
                crypto: 'readonly',
                atob: 'readonly',
                btoa: 'readonly',
                structuredClone: 'readonly',
                DOMException: 'readonly',
                requestIdleCallback: 'readonly',
                cancelIdleCallback: 'readonly',
                alert: 'readonly',
                confirm: 'readonly',
                CSS: 'readonly',
                PointerEvent: 'readonly',
                MouseEvent: 'readonly',
                HTMLInputElement: 'readonly',
                HTMLAnchorElement: 'readonly',
                HTMLButtonElement: 'readonly',
                ...jellyfinWebGlobals,
            },
        },
        rules: {
            ...js.configs.recommended.rules,
            // Real-defect rules stay errors (the point of linting this codebase).
            'no-undef': 'error',
            'no-dupe-keys': 'error',
            'no-dupe-args': 'error',
            'no-duplicate-case': 'error',
            'no-unreachable': 'error',
            'no-unsafe-negation': 'error',
            'use-isnan': 'error',
            'valid-typeof': 'error',
            'no-cond-assign': ['error', 'except-parens'],
            'no-self-assign': 'error',
            'no-const-assign': 'error',
            'no-class-assign': 'error',
            'no-compare-neg-zero': 'error',
            // Pre-existing patterns in the codebase that are noisy but not defects.
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-prototype-builtins': 'off',
            'no-async-promise-executor': 'warn',
            'no-control-regex': 'off',
            'no-useless-escape': 'warn',
            'no-case-declarations': 'warn',
            'no-fallthrough': 'warn',
            'no-redeclare': 'warn',
            'no-inner-declarations': 'off',
        },
    },
    // TypeScript module tree (Jellyfin.Plugin.JellyfinEnhanced/src/): typed
    // linting over the tsconfig.src.json program. Strict rules from day one —
    // src/ is the post-migration world; the legacy js/ tree keeps the looser
    // classic-script config above.
    ...tseslint.configs.recommendedTypeChecked.map((config) => ({
        ...config,
        files: ['Jellyfin.Plugin.JellyfinEnhanced/src/**/*.ts'],
    })),
    {
        files: ['Jellyfin.Plugin.JellyfinEnhanced/src/**/*.ts'],
        languageOptions: {
            parserOptions: {
                project: './tsconfig.src.json',
                tsconfigRootDir: __dirname,
            },
        },
        rules: {
            // The frozen window.JellyfinEnhanced contract still has untyped
            // corners (legacy feature surfaces); unused args follow the same
            // policy as the js/ tree.
            '@typescript-eslint/no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
            // Module-level wiring (fire-and-forget promises from the host
            // client) is deliberate in a few places; require explicit `void`.
            '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
        },
    },
    {
        // Node-side tooling scripts (translation validation etc.)
        files: ['scripts/**/*.js', 'eslint.config.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly',
                module: 'writable',
                process: 'readonly',
                console: 'readonly',
                __dirname: 'readonly',
                Buffer: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
            },
        },
        rules: {
            ...js.configs.recommended.rules,
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
        },
    },
];
