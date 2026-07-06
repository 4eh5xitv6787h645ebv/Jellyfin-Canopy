// Guard against re-introducing a legacy auth token header (W2-DOCS-3).
//
// v12 disabled legacy authorization by migration — `X-Emby-Token` and
// `X-MediaBrowser-Token` are ignored; only `Authorization: MediaBrowser
// Token=…` works. The avatar-fetch helper in src/arr/requests/data.ts used to
// send the dead `X-MediaBrowser-Token` alongside Authorization. This guard
// keeps the legacy token headers out of the client fetch helpers.

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/test\/[^/]+$/, '/');
const DATA_TS = ts.sys.readFile(SRC_ROOT + 'arr/requests/data.ts') ?? '';

describe('legacy auth token header (W2-DOCS-3)', () => {
    it('loaded the source', () => {
        expect(DATA_TS.length).toBeGreaterThan(0);
    });

    it('arr/requests/data.ts sends no legacy token header', () => {
        expect(DATA_TS).not.toContain('X-MediaBrowser-Token');
        expect(DATA_TS).not.toContain('X-Emby-Token');
    });

    it('still authenticates via the Authorization header', () => {
        expect(DATA_TS).toContain("'Authorization': 'MediaBrowser Token=\"'");
    });
});
