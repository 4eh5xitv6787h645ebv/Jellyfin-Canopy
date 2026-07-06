// src/tags/config-read-guard.test.ts
//
// Class guard for W2-TEST-2 / XCUT-5: nothing on the client may read a
// `JE.pluginConfig.<Key>` that no SettingDescriptor projects — such a key is
// never sent to the browser, so the read is always `undefined` (this is exactly
// how people tags silently pinned their cache TTL at 30 days by reading the
// phantom `PeopleTagsCacheTtlDays`).
//
// The bridge to the C# descriptor registry is the committed golden payload
// snapshots: their top-level keys ARE the projected descriptor set, so this
// cross-language check needs no duplication of the registry. Source-scanning
// guard in the style of src/test/escape-guard.test.ts / locale-guard.test.ts.
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

// vite statically rewrites new URL(..., import.meta.url); resolve from the plain
// URL. This file lives in src/tags/, so strip that to reach the src root, then
// hop to the sibling Tests/Snapshots directory.
const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/tags\/[^/]+$/, '/');
const SNAPSHOTS_DIR = SRC_ROOT.replace(
    /Jellyfin\.Plugin\.JellyfinEnhanced\/src\/$/,
    'Jellyfin.Plugin.JellyfinEnhanced.Tests/Snapshots/',
);

// Keys the client legitimately reads off JE.pluginConfig that are synthesized or
// force-mutated on the client rather than being plain descriptor projections:
// js/plugin.js zeroes the delivery-plugin flags after load when Custom Tabs /
// Plugin Pages are not installed (src/core/delivery-flags.ts) and stamps the
// translation-cache timestamp. Allowed even if a future descriptor refactor
// stops projecting them — this guard tracks the phantom-read class, not churn.
const CLIENT_SYNTHESIZED_KEYS = new Set<string>([
    'BookmarksUseCustomTabs', 'CalendarUseCustomTabs',
    'HiddenContentUseCustomTabs', 'DownloadsUseCustomTabs',
    'BookmarksUsePluginPages', 'HiddenContentUsePluginPages',
    'DownloadsUsePluginPages', 'CalendarUsePluginPages',
    'ClearTranslationCacheTimestamp', 'Shortcuts',
]);

// pluginConfig.Foo / pluginConfig?.Foo / JE.pluginConfig.Foo — the identifier is
// captured. The lookbehind stops `xPluginConfig.Foo` from matching a different
// object that merely ends in "pluginConfig".
const READ_RE = /(?<![A-Za-z0-9_$])pluginConfig\??\.([A-Za-z_$][A-Za-z0-9_$]*)/g;

interface ConfigRead {
    file: string;
    key: string;
}

function projectedKeys(): Set<string> {
    const keys = new Set<string>();
    for (const file of ['public-config.default.authenticated.json', 'private-config.default.json']) {
        const text = ts.sys.readFile(SNAPSHOTS_DIR + file);
        expect(text, `missing golden snapshot: ${SNAPSHOTS_DIR + file}`).toBeTruthy();
        const parsed = JSON.parse(text!) as Record<string, unknown>;
        for (const key of Object.keys(parsed)) keys.add(key);
    }
    return keys;
}

function scanReads(): ConfigRead[] {
    const reads: ConfigRead[] = [];
    const files = ts.sys.readDirectory(SRC_ROOT, ['.ts'], undefined, undefined)
        .filter((filePath) => {
            const rel = filePath.substring(SRC_ROOT.length).replace(/\\/g, '/');
            // Skip the vitest suites (fixtures reference phantom keys on purpose)
            // and ambient declarations — scan only what ships in the bundle.
            return !rel.endsWith('.test.ts') && !rel.endsWith('.d.ts') && !rel.startsWith('test/');
        });
    for (const filePath of files) {
        const text = ts.sys.readFile(filePath) ?? '';
        const rel = filePath.substring(SRC_ROOT.length).replace(/\\/g, '/');
        for (const match of text.matchAll(READ_RE)) {
            reads.push({ file: rel, key: match[1] });
        }
    }
    return reads;
}

describe('config-read-guard (W2-TEST-2): client pluginConfig reads are real projected descriptors', () => {
    const projected = projectedKeys();
    const reads = scanReads();

    it('scans the tree and reads the descriptor projections (sanity floor)', () => {
        expect(projected.size).toBeGreaterThan(100);
        expect(reads.length).toBeGreaterThan(20);
    });

    it('every JE.pluginConfig.<Key> read is projected or a known client-synthesized key', () => {
        const dangling = reads.filter(
            (r) => !projected.has(r.key) && !CLIENT_SYNTHESIZED_KEYS.has(r.key),
        );
        const detail = dangling.map((r) => `  ${r.file}: pluginConfig.${r.key}`).join('\n');
        expect(
            dangling,
            'Client reads a JE.pluginConfig key that no SettingDescriptor projects — the '
            + 'value is always undefined (phantom read):\n' + detail
            + '\n\nFix: read the real projected key (e.g. TagsCacheTtlDays), or register a '
            + 'descriptor for it. If it is genuinely synthesized on the client, add it to '
            + 'CLIENT_SYNTHESIZED_KEYS with justification.',
        ).toEqual([]);
    });
});
