// Guards for the release/build validators (MB-8, MB-9).
//
// MB-8: validate-manifest verified checksum FORMAT only — a well-formed but
//       WRONG MD5 shipped and bricked in-app updates. verifyChecksums must
//       catch a checksum that doesn't match the actual zip bytes.
// MB-9: check-dotnet-coverage double-counted cobertura lines (each line appears
//       under both <method><lines> and <class><lines>). measurePackage must
//       count each line once (the class-level set).

import * as ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { verifyChecksums } from '../../../scripts/release/validate-manifest.js';
import { measurePackage } from '../../../scripts/check-dotnet-coverage.js';

// Repo-root-relative temp dir. `tmp/` is gitignored, so leftovers never dirty
// the tree; the fixtures are removed in afterAll regardless.
const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const REPO_ROOT = TEST_FILE_PATH.replace(
    /Jellyfin\.Plugin\.JellyfinCanopy\/src\/test\/[^/]+$/,
    '',
);
const TMP_DIR = REPO_ROOT + 'tmp';

// content 'jc-checksum-fixture' → this uppercase MD5 (verified out-of-band).
const FIXTURE_CONTENT = 'jc-checksum-fixture';
const FIXTURE_MD5 = '6B369C7C96C67731E9AEC5E6157D1CF9';
const FIXTURE_ZIP = 'jc-checksum-fixture.zip';
const FIXTURE_PATH = `${TMP_DIR}/${FIXTURE_ZIP}`;

if (!ts.sys.directoryExists(TMP_DIR)) ts.sys.createDirectory(TMP_DIR);
ts.sys.writeFile(FIXTURE_PATH, FIXTURE_CONTENT);

afterAll(() => {
    if (ts.sys.fileExists(FIXTURE_PATH)) ts.sys.deleteFile?.(FIXTURE_PATH);
});

/** A one-entry manifest whose asset resolves to FIXTURE_ZIP via sourceUrl. */
function manifest(checksum: string, zip = FIXTURE_ZIP): unknown {
    return [
        {
            name: 'Jellyfin Canopy',
            guid: '00000000-0000-0000-0000-000000000000',
            versions: [
                {
                    changelog: 'x',
                    targetAbi: '12.0.0.0',
                    version: '12.0.0.0',
                    sourceUrl: `https://github.com/o/r/releases/download/v1/${zip}`,
                    checksum,
                    timestamp: '2026-01-01T00:00:00',
                },
            ],
        },
    ];
}

describe('verifyChecksums (MB-8)', () => {
    it('errors on a well-formed but WRONG checksum', () => {
        const { errors } = verifyChecksums(manifest('F'.repeat(32)), TMP_DIR);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]).toMatch(/checksum/i);
        expect(errors[0]).toContain(FIXTURE_ZIP);
    });

    it('passes when the checksum matches the actual zip bytes', () => {
        const { errors } = verifyChecksums(manifest(FIXTURE_MD5), TMP_DIR);
        expect(errors).toEqual([]);
    });

    it('skips (does not error) an entry whose asset is absent locally (frozen history)', () => {
        const { errors } = verifyChecksums(manifest('F'.repeat(32), 'jc-absent-fixture.zip'), TMP_DIR);
        expect(errors).toEqual([]);
    });
});

describe('measurePackage cobertura line counting (MB-9)', () => {
    it('counts each class-level line once, not the duplicated method lines', () => {
        const xml = [
            '<coverage><packages>',
            '<package name="Jellyfin.Plugin.JellyfinCanopy">',
            '<classes><class name="Foo" filename="Foo.cs">',
            '<methods><method name="M"><lines>',
            '<line number="1" hits="1"/>',
            '<line number="2" hits="0"/>',
            '<line number="3" hits="0"/>',
            '</lines></method></methods>',
            '<lines>',
            '<line number="1" hits="1"/>',
            '<line number="2" hits="0"/>',
            '<line number="3" hits="0"/>',
            '<line number="10" hits="0"/>', // class-only initializer line
            '</lines>',
            '</class></classes>',
            '</package>',
            '</packages></coverage>',
        ].join('');

        // 4 class-level lines, 1 covered. Pre-fix (global count) was 7 / 2.
        expect(measurePackage(xml)).toEqual({ valid: 4, covered: 1 });
    });
});
