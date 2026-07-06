// src/test/locale-guard.test.ts
//
// Class guard for CRIT-3: every translated surface must format dates through
// core/locale (getDisplayLocale / formatDate / formatTime), never a direct
// toLocale{Date,Time}String call nor a hardcoded 'en-GB' / 'default' locale
// literal — otherwise a single session drifts back into a mix of locales.
// Source-scanning guard in the style of src/test/escape-guard.test.ts.
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

// NOTE: vite statically rewrites new URL(import.meta.url); resolve the src root
// from this test file's own path (it lives in src/test/).
const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/test\/[^/]+$/, '/');

const TRANSLATED_SURFACES = [
    'arr/requests/render-helpers.ts',
    'arr/calendar/render-events.ts',
    'arr/calendar/render-views.ts',
    'arr/calendar/event-date.ts',
];

describe('locale-guard', () => {
    for (const rel of TRANSLATED_SURFACES) {
        it(`${rel} routes date formatting through core/locale`, () => {
            const src = ts.sys.readFile(SRC_ROOT + rel) ?? '';
            // No direct toLocaleString / toLocaleDateString / toLocaleTimeString.
            expect(/\.toLocale(Date|Time)?String\s*\(/.test(src)).toBe(false);
            // No hardcoded locale literals — they must come from getDisplayLocale().
            expect(src.includes("'en-GB'")).toBe(false);
            expect(src.includes("'default'")).toBe(false);
        });
    }
});
