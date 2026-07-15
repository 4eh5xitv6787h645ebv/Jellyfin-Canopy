#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    SUMMARY_END,
    SUMMARY_START,
    prepareReleaseNotes,
} = require('./prepare-release-notes.js');
const { MAX_CHANGELOG_BYTES, MAX_CHANGELOG_LINES } = require('./validate-manifest.js');

const REPO = '4eh5xitv6787h645ebv/Jellyfin-Canopy';
const TAG = '2.0.1.0';

test('first release requires deliberately curated pre-draft notes', () => {
    assert.throws(() => prepareReleaseNotes({
        repo: REPO,
        tag: '1.0.0.0',
        firstRelease: true,
        commitSubjects: ['initial import', 'another internal commit'],
    }), /first release requires a curated pre-draft body/);
});

test('marked pre-draft summary owns the catalog while the complete body remains release notes', () => {
    const body = [
        '# Complete release notes',
        'Long-form background and contributor detail.',
        SUMMARY_START,
        '- Security: harden the request boundary.',
        '- Breaking: custom scripts must use the new facade.',
        '- Migration: existing settings are adopted automatically.',
        SUMMARY_END,
        '## Full detail',
        'Everything else remains on the GitHub release.',
    ].join('\n');
    const result = prepareReleaseNotes({
        repo: REPO,
        tag: TAG,
        draftBody: body,
        commitSubjects: ['ignored fallback'],
        firstRelease: true,
    });
    assert.equal(result.fullNotes, body);
    assert.match(result.catalog, /Security: harden/);
    assert.match(result.catalog, /Breaking: custom scripts/);
    assert.match(result.catalog, /Migration: existing settings/);
    assert.doesNotMatch(result.catalog, /Long-form background|ignored fallback/);
    assert.match(result.catalog, /releases\/tag\/2\.0\.1\.0$/);
});

test('normal delta fallback preserves every security, breaking, migration, and upgrade subject', () => {
    const priority = [
        'security: reject cross-user cache entries',
        'feat!: breaking migration for custom scripts',
        'upgrade: preserve settings during schema migration',
        'The database was migrated safely.',
        'Upgraded the image pipeline.',
        'Schema migrations now preserve legacy values.',
        'Dependency upgrades close a vulnerability.',
        'fix: patch known CVEs',
        'chore: patch dependency vulnerabilities',
    ];
    const ordinary = Array.from({ length: 200 }, (_, index) => `internal refactor ${index} ${'x'.repeat(80)}`);
    const result = prepareReleaseNotes({
        repo: REPO,
        tag: TAG,
        commitSubjects: [...priority, ...ordinary],
    });
    for (const subject of priority) assert.match(result.catalog, new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(result.catalog, /internal refactor/);
    assert.ok(Buffer.byteLength(result.catalog, 'utf8') <= MAX_CHANGELOG_BYTES);
    assert.ok(result.catalog.split('\n').length <= MAX_CHANGELOG_LINES);
    assert.ok(result.fullNotes.length > result.catalog.length);
});

test('a concise pre-draft body wins without requiring markers', () => {
    const result = prepareReleaseNotes({
        repo: REPO,
        tag: TAG,
        draftBody: '- Fixed playback.\n- Security: tightened authorization.',
        commitSubjects: ['ignored commit'],
    });
    assert.match(result.catalog, /Fixed playback/);
    assert.doesNotMatch(result.catalog, /ignored commit/);
});

test('a marked draft cannot omit priority categories present in the full notes', () => {
    const body = [
        'Known CVEs and dependency vulnerabilities were patched.',
        'Existing data was migrated and upgraded automatically.',
        SUMMARY_START,
        '- General playback fixes.',
        SUMMARY_END,
    ].join('\n');
    assert.throws(() => prepareReleaseNotes({
        repo: REPO,
        tag: TAG,
        draftBody: body,
    }), /omits priority categories.*security.*migration\/upgrade/);
});

test('commit-generated drafts round-trip idempotently through release discovery', () => {
    const commits = Array.from({ length: 100 }, (_, index) =>
        `fix: user-facing change ${index} ${'x'.repeat(60)}`);
    const first = prepareReleaseNotes({ repo: REPO, tag: TAG, commitSubjects: commits });
    const rerun = prepareReleaseNotes({
        repo: REPO,
        tag: TAG,
        draftBody: first.fullNotes,
        commitSubjects: commits,
    });
    assert.deepEqual(rerun, first);

    const internal = ['ci: rotate cache', 'test: update fixture', 'internal refactor only'];
    const firstInternal = prepareReleaseNotes({ repo: REPO, tag: TAG, commitSubjects: internal });
    const rerunInternal = prepareReleaseNotes({
        repo: REPO,
        tag: TAG,
        draftBody: firstInternal.fullNotes,
        commitSubjects: internal,
    });
    assert.deepEqual(rerunInternal, firstInternal);
    assert.match(rerunInternal.catalog, /Maintenance release/);
    assert.doesNotMatch(rerunInternal.catalog, /rotate cache|update fixture|internal refactor/);
});

test('edited or cross-release generated notes fail instead of silently changing ownership', () => {
    const commits = ['fix: visible playback repair'];
    const first = prepareReleaseNotes({ repo: REPO, tag: TAG, commitSubjects: commits });
    assert.throws(() => prepareReleaseNotes({
        repo: REPO,
        tag: TAG,
        draftBody: `${first.fullNotes}\nmanual edit`,
        commitSubjects: commits,
    }), /generated release notes were edited/);
    assert.throws(() => prepareReleaseNotes({
        repo: REPO,
        tag: '2.0.2.0',
        draftBody: first.fullNotes,
        commitSubjects: commits,
    }), /belong to another release/);
});

test('oversized unmarked drafts and empty releases fail closed', () => {
    assert.throws(() => prepareReleaseNotes({
        repo: REPO,
        tag: TAG,
        draftBody: 'detail '.repeat(MAX_CHANGELOG_BYTES),
    }), /need .*catalog-summary:start/);
    assert.throws(() => prepareReleaseNotes({ repo: REPO, tag: TAG }), /release notes are empty/);
});

test('mention-shaped release text is neutralized in generated notes', () => {
    const result = prepareReleaseNotes({
        repo: REPO,
        tag: TAG,
        commitSubjects: ['fix @font-face handling without pinging @person'],
    });
    assert.match(result.catalog, /`@font-face`/);
    assert.match(result.catalog, /`@person`/);
});

test('internal-only deltas produce a concise maintenance summary without commit noise', () => {
    const result = prepareReleaseNotes({
        repo: REPO,
        tag: TAG,
        commitSubjects: ['ci: rotate workflow cache', 'test: expand fixture', 'internal refactor only'],
    });
    assert.match(result.catalog, /Maintenance release/);
    assert.doesNotMatch(result.catalog, /rotate workflow|expand fixture|internal refactor/);
    assert.match(result.fullNotes, /rotate workflow/);
});

test('workflow keeps full GitHub notes separate from the bounded manifest payload', () => {
    const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8');
    assert.match(workflow, /prepare-release-notes\.js/);
    assert.match(workflow, /--full-output release-notes\.md/);
    assert.match(workflow, /--catalog-output changelog\.txt/);
    assert.match(workflow, /--notes-file release-notes\.md/);
    assert.match(workflow, /--changelog-file changelog\.txt/);
    assert.match(workflow, /gh release edit "\$GITHUB_REF_NAME" --notes-file release-notes\.md/);
});
