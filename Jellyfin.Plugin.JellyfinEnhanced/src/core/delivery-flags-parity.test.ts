// src/core/delivery-flags-parity.test.ts
//
// Class guard for INIT-1: the delivery-plugin flag list exists in TWO places —
// the pre-bundle bootstrap zeroing in js/plugin.js and the shared sanitizer in
// src/core/delivery-flags.ts. They must stay in lockstep, or a new delivery
// surface added to one copy silently escapes sanitization in the other. This
// scans both sources and asserts the extracted flag sets are identical.
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

// vite rewrites new URL(..., import.meta.url); resolve from the plain URL. This
// file lives in src/core/, so strip that to reach the src root.
const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/core\/[^/]+$/, '/');
const PLUGIN_JS = SRC_ROOT.replace(/src\/$/, 'js/plugin.js');
const DELIVERY_FLAGS_TS = `${SRC_ROOT}core/delivery-flags.ts`;

// A flag identifier: some capability name directly followed by UseCustomTabs /
// UsePluginPages (e.g. BookmarksUseCustomTabs). The `*UseCustomTabs` shorthand in
// prose comments has no leading letter, so it is intentionally NOT matched.
const FLAG_RE = /[A-Za-z]+Use(?:CustomTabs|PluginPages)/g;

function flagsIn(path: string): Set<string> {
    const text = ts.sys.readFile(path);
    expect(text, `missing source: ${path}`).toBeTruthy();
    return new Set(text!.match(FLAG_RE) ?? []);
}

describe('delivery-flags parity (INIT-1)', () => {
    it('the shared util and the js/plugin.js boot sanitization list the same flags', () => {
        const bootFlags = flagsIn(PLUGIN_JS);
        const utilFlags = flagsIn(DELIVERY_FLAGS_TS);

        // There are 4 Custom Tabs + 4 Plugin Pages flags today.
        expect(bootFlags.size).toBe(8);
        expect([...utilFlags].sort()).toEqual([...bootFlags].sort());
    });
});
