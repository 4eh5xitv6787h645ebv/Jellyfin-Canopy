// Guards for js/plugin.js loader correctness (LOADER-1/3/7/8/9).
//
// plugin.js is the classic-script boot loader (outside the bundled src/ tree),
// so it is exercised here by reading its source. Static source guards pin the
// splash-hide alias, the bookmark placeholder shape and the translation
// interpolation; the case-transform and genre-tag helpers are extracted and
// evaluated so their real behaviour is asserted.

import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/test\/[^/]+$/, '/');
const PLUGIN_JS_PATH = SRC_ROOT.replace(/src\/$/, 'js/') + 'plugin.js';
const SRC = ts.sys.readFile(PLUGIN_JS_PATH) ?? '';

/** Extract a top-level `function name(...) { … }` source via brace matching. */
function extractFunctionSource(name: string): string | null {
    const start = SRC.indexOf(`function ${name}(`);
    if (start < 0) return null;
    const braceStart = SRC.indexOf('{', start);
    if (braceStart < 0) return null;
    let depth = 0;
    for (let i = braceStart; i < SRC.length; i++) {
        const ch = SRC[i];
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) return SRC.slice(start, i + 1);
    }
    return null;
}

type CaseFn = (obj: unknown, opts?: { preserveKey?: (key: string) => boolean }) => unknown;
type ResolveFactory = (
    je: { pluginConfig?: Record<string, unknown> },
) => (userSettings: Record<string, unknown>) => boolean;

describe('plugin.js loader guards', () => {
    it('loaded the loader source', () => {
        expect(SRC.length).toBeGreaterThan(0);
    });

    // LOADER-1 — the stale-credential give-up branches called
    // `window.JE?.hideSplashScreen?.()`; `window.JE` is never set, so the splash
    // never hid. Every give-up must use the module-local `JE` alias.
    it('splash-hide give-ups use the local JE alias, not window.JE (LOADER-1)', () => {
        expect(SRC).not.toContain('window.JE?.hideSplashScreen');
        expect(SRC).toContain('JE?.hideSplashScreen?.();');
    });

    // LOADER-7 — the boot placeholder seeded `bookmarks: { Bookmarks: {} }`
    // (plural, PascalCase inner); every consumer reads
    // `userConfig.bookmark.bookmarks`.
    it('boot placeholder uses the bookmark.bookmarks shape (LOADER-7)', () => {
        const bootLine = SRC.match(/userConfig:\s*\{[^\n]*\},/);
        expect(bootLine, 'boot userConfig placeholder not found').toBeTruthy();
        expect(bootLine![0]).toContain('bookmark: { bookmarks: {} }');
        expect(bootLine![0]).not.toContain('bookmarks: { Bookmarks');
    });

    // LOADER-9 — t() interpolation used a raw string replacement (so `$&`, `$1`
    // etc. in a value corrupted output) built from an unescaped param name.
    it('t() interpolation uses a function replacer and an escaped param (LOADER-9)', () => {
        expect(SRC).toContain('() => String(value)');
        expect(SRC).toMatch(/String\(param\)\.replace\(/);
        // The old unescaped, string-replacement form must be gone.
        expect(SRC).not.toMatch(/new RegExp\(`\{\$\{param\}\}`, 'g'\), value\)/);
    });

    // LOADER-8 — a blanket toCamelCase lowercased bookmark ID dictionary keys
    // (`Bm_…` → `bm_…`), diverging client/server id case. The opt-in preserveKey
    // mode must keep matching keys verbatim while still camelCasing fields.
    it('toCamelCase preserveKey keeps ID keys verbatim and still camelCases fields (LOADER-8)', () => {
        const fnSrc = extractFunctionSource('toCamelCase');
        expect(fnSrc, 'toCamelCase not found').toBeTruthy();
        const toCamelCase = eval(`(${fnSrc})`) as CaseFn;

        const out = toCamelCase(
            { Bookmarks: { Bm_1_abc: { ItemId: 'x' } } },
            { preserveKey: (k) => /^bm_/i.test(k) },
        ) as Record<string, unknown>;

        const bookmarks = out.bookmarks as Record<string, unknown>;
        expect(Object.keys(bookmarks)).toContain('Bm_1_abc'); // id key preserved
        const entry = bookmarks.Bm_1_abc as Record<string, unknown>;
        expect(Object.keys(entry)).toContain('itemId'); // field still camelCased

        // Without preserveKey the id key is lowercased (unchanged behaviour).
        const plain = toCamelCase({ Bm_1_abc: { ItemId: 'x' } }) as Record<string, unknown>;
        expect(Object.keys(plain)).toContain('bm_1_abc');
    });

    it('toPascalCase preserveKey keeps ID keys verbatim and still PascalCases fields (LOADER-8)', () => {
        const fnSrc = extractFunctionSource('toPascalCase');
        expect(fnSrc, 'toPascalCase not found').toBeTruthy();
        const toPascalCase = eval(`(${fnSrc})`) as CaseFn;

        // A client-generated id is lowercase (`bm_…`); PascalCasing it WOULD
        // change it to `Bm_…`, so preserveKey is what keeps it byte-stable.
        const out = toPascalCase(
            { bookmarks: { bm_1_abc: { itemId: 'x' } } },
            { preserveKey: (k) => /^bm_/i.test(k) },
        ) as Record<string, unknown>;

        const bookmarks = out.Bookmarks as Record<string, unknown>;
        expect(Object.keys(bookmarks)).toContain('bm_1_abc'); // id key preserved verbatim
        const entry = bookmarks.bm_1_abc as Record<string, unknown>;
        expect(Object.keys(entry)).toContain('ItemId'); // field still PascalCased
    });

    // LOADER-3 — the admin-aware genre-tag resolution is now a single helper so
    // the boot preload and the init gate can't drift.
    it('resolveGenreTagsEnabled prefers the user toggle, else the admin default (LOADER-3)', () => {
        const fnSrc = extractFunctionSource('resolveGenreTagsEnabled');
        expect(fnSrc, 'resolveGenreTagsEnabled not found').toBeTruthy();
        // JE is a closure var in plugin.js — inject it via a factory param.
        const makeResolver = eval(`(function(JE){ ${fnSrc}; return resolveGenreTagsEnabled; })`) as ResolveFactory;

        const adminOn = makeResolver({ pluginConfig: { GenreTagsEnabled: true } });
        const adminOff = makeResolver({ pluginConfig: { GenreTagsEnabled: false } });

        // User toggle wins when set.
        expect(adminOff({ genreTagsEnabled: true })).toBe(true);
        expect(adminOn({ genreTagsEnabled: false })).toBe(false);
        // Unset user falls back to the admin default.
        expect(adminOn({})).toBe(true);
        expect(adminOff({})).toBe(false);
    });
});
