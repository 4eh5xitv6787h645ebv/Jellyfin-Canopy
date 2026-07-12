// src/core/config-page-http-url.test.ts
//
// Drift guard for the THIRD copy of the "safe browser link base?" rule:
// Configuration/config-page.js::jcIsHttpUrl, the config-page save gate that
// drops a malformed external/public URL before it is ever persisted. That file
// is one big IIFE that wires the whole settings page on load, so it cannot be
// imported; instead we read the source, regex-locate the small self-contained
// jcIsHttpUrl function (it references only the global URL and its argument), and
// evaluate just that function — the same read-the-source approach used by
// delivery-flags-parity.test.ts. It is then run against the SAME shared matrix
// as isSafeLinkBase and the C# IsWellFormedHttpUrl, so if this copy drifts from
// the others its rows go red here.
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { LINK_BASE_CASES } from '../test/url-safe-cases';

// vite rewrites new URL(..., import.meta.url); resolve from the plain URL. This
// file lives in src/core/, so strip that to reach the src root, then hop to the
// sibling Configuration/ directory (mirrors delivery-flags-parity.test.ts).
const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/core\/[^/]+$/, '/');
const CONFIG_PAGE_JS = SRC_ROOT.replace(/src\/$/, 'Configuration/config-page.js');

// Capture `function jcIsHttpUrl(value) { ... }` up to its 8-space-indented
// closing brace. The only nested braces (try/catch) are indented deeper, so the
// non-greedy match stops at the real function terminator.
const JC_IS_HTTP_URL_RE = /function jcIsHttpUrl\(value\)\s*\{[\s\S]*?\n {8}\}/;

function loadJeIsHttpUrl(): (value: unknown) => boolean {
    const source = ts.sys.readFile(CONFIG_PAGE_JS);
    expect(source, `missing source: ${CONFIG_PAGE_JS}`).toBeTruthy();
    const match = source!.match(JC_IS_HTTP_URL_RE);
    expect(match, 'jcIsHttpUrl not found in config-page.js').toBeTruthy();
    // Wrap in parens so eval yields the function expression. The extracted body
    // uses only the global URL (provided by jsdom) and its parameter.
    // SAFETY: the evaluated string is our own committed config-page.js source
    // (never user/network input), narrowed to the jcIsHttpUrl function by the
    // regex above; running the real function is the whole point of this drift
    // guard, so no parse/sandbox substitute would serve here.
    return eval(`(${match![0]})`) as (value: unknown) => boolean;
}

describe('config-page.js jcIsHttpUrl (drift guard)', () => {
    const jcIsHttpUrl = loadJeIsHttpUrl();

    it.each(LINK_BASE_CASES.map((c) => [c.input, c.accept, c.note] as const))(
        '%s -> %s (%s)',
        (input, accept) => {
            expect(jcIsHttpUrl(input)).toBe(accept);
        },
    );
});
