#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    IMAGE_REFERENCE,
    PINNED_FILES,
    applyRefresh,
    assertDigest,
    planRefresh,
    readPinnedFiles,
} = require('./refresh-jellyfin-digest.js');

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/refresh-jellyfin-image.yml');
const workflow = fs.readFileSync(WORKFLOW, 'utf8');

// Built rather than written out so this file never carries a concrete digest of
// its own; the repository-wide inventory below treats any literal occurrence as
// a pin the refresher must own.
const OLD_DIGEST = `sha256:${'a1b2c3d4'.repeat(8)}`;
const NEW_DIGEST = `sha256:${'0f1e2d3c'.repeat(8)}`;

function fixture(digest = OLD_DIGEST) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-refresh-'));
    for (const file of PINNED_FILES) {
        const absolute = path.join(root, file);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, `before\n${IMAGE_REFERENCE}@${digest}\nafter\n`);
    }
    return root;
}

test('only an immutable lowercase sha256 digest may be pinned', () => {
    assert.equal(assertDigest(NEW_DIGEST), NEW_DIGEST);
    for (const rejected of [
        IMAGE_REFERENCE,
        'unstable',
        'sha256:',
        `sha256:${'a'.repeat(63)}`,
        `sha256:${'a'.repeat(65)}`,
        `sha256:${'A'.repeat(64)}`,
        `md5:${'a'.repeat(64)}`,
        '',
        undefined,
    ]) {
        assert.throws(
            () => assertDigest(/** @type {string} */ (rejected)),
            /not an immutable sha256 digest/,
            `${String(rejected)} must be refused`
        );
    }
});

test('a refresh rewrites every pinned reference in one step', () => {
    const root = fixture();
    const plan = applyRefresh(root, NEW_DIGEST);

    assert.equal(plan.changed, true);
    assert.equal(plan.previousDigest, OLD_DIGEST);
    assert.equal(plan.digest, NEW_DIGEST);

    const written = readPinnedFiles(root);
    assert.deepEqual(written.map((file) => file.file), [...PINNED_FILES]);
    for (const file of written) {
        assert.equal(file.digest, NEW_DIGEST, file.file);
    }
    // Surrounding content is preserved: the refresher edits the reference only.
    for (const file of PINNED_FILES) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        assert.equal(source, `before\n${IMAGE_REFERENCE}@${NEW_DIGEST}\nafter\n`);
    }
});

test('an already-current digest is a no-op rather than an empty commit', () => {
    const root = fixture(NEW_DIGEST);
    const before = PINNED_FILES.map((file) => fs.statSync(path.join(root, file)).mtimeMs);

    const plan = applyRefresh(root, NEW_DIGEST);

    assert.equal(plan.changed, false);
    assert.equal(plan.previousDigest, NEW_DIGEST);
    assert.deepEqual(
        PINNED_FILES.map((file) => fs.statSync(path.join(root, file)).mtimeMs),
        before,
        'an unchanged refresh must not rewrite the pinned files'
    );
});

test('a pinned file that lost its digest reference blocks the refresh', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, PINNED_FILES[1]), `image: ${IMAGE_REFERENCE}\n`);

    assert.throws(
        () => planRefresh(root, NEW_DIGEST),
        new RegExp(`${PINNED_FILES[1]} no longer pins`)
    );
});

test('pre-existing drift between the pinned files blocks the refresh', () => {
    const root = fixture();
    fs.writeFileSync(
        path.join(root, PINNED_FILES[2]),
        `export JF_IMAGE="${IMAGE_REFERENCE}@${NEW_DIGEST}"\n`
    );

    assert.throws(() => planRefresh(root, NEW_DIGEST), /already pin different Jellyfin digests/);
    // The tree is left exactly as found so the drift is repaired deliberately.
    assert.match(fs.readFileSync(path.join(root, PINNED_FILES[0]), 'utf8'), /a1b2c3d4/);
});

test('the refresher owns every concrete Jellyfin pin in the repository', () => {
    const listed = spawnSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { cwd: ROOT, encoding: 'buffer' }
    );
    assert.equal(listed.status, 0, listed.stderr.toString('utf8'));

    const pinned = listed.stdout
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .filter((relative) => {
            const absolute = path.join(ROOT, relative);
            try {
                if (!fs.statSync(absolute).isFile()) return false;
                return /jellyfin\/jellyfin:unstable@sha256:[0-9a-f]{64}/
                    .test(fs.readFileSync(absolute, 'utf8'));
            } catch {
                return false;
            }
        })
        .sort();

    assert.deepEqual(
        pinned,
        [...PINNED_FILES].sort(),
        'a Jellyfin digest pin exists that the nightly refresher would leave behind'
    );

    // Every repository pin currently agrees, which is the state the drift guard
    // in workflow-sharding.test.js requires and the refresher preserves.
    const digests = new Set(readPinnedFiles(ROOT).map((file) => file.digest));
    assert.equal(digests.size, 1, 'the committed Jellyfin pins disagree');
});

test('the scheduled workflow refreshes daily and can be dispatched', () => {
    assert.match(workflow, /^ {2}schedule:\n {4}- cron: "0 6 \* \* \*"$/m);
    assert.match(workflow, /^ {2}workflow_dispatch:$/m);
    assert.match(workflow, /^permissions:\n {2}contents: read$/m);
    // Two runs must never race to publish competing refresh branches.
    assert.match(workflow, /^concurrency:\n {2}group: refresh-jellyfin-nightly$/m);
});

test('the workflow resolves the unstable channel and validates it before writing', () => {
    assert.match(workflow, /docker buildx imagetools inspect "\$\{IMAGE\}"/);
    assert.match(workflow, /IMAGE: jellyfin\/jellyfin:unstable$/m);
    assert.doesNotMatch(workflow, /jellyfin\/jellyfin:[^\s"]*rc[0-9]/i);
    assert.match(workflow, /\^sha256:\[0-9a-f\]\{64\}\$/);
    assert.match(workflow, /node scripts\/e2e\/refresh-jellyfin-digest\.js "\$\{DIGEST\}"/);
    // The refresher reads the mutable tag only to learn its digest; it never
    // assigns JF_IMAGE and so never boots a server from a floating tag. That
    // keeps the "mutable probing stays in one advisory workflow" isolation
    // asserted by workflow-sharding.test.js intact.
    assert.doesNotMatch(workflow, /JF_IMAGE:/);
});

test('the workflow refuses to run without the dedicated automation token', () => {
    // A pull request opened with the default GITHUB_TOKEN never triggers Build &
    // Test, so auto-merge would wait on checks that can never report. Failing
    // loudly beats publishing a pull request that can never merge.
    assert.match(workflow, /secrets\.CANOPY_AUTOMATION_TOKEN/);
    assert.match(workflow, /if \[\[ -z "\$\{AUTOMATION_TOKEN\}" \]\]; then\n\s+echo/);
    assert.doesNotMatch(workflow, /secrets\.REPOSITORY_POLICY_TOKEN/);
    assert.doesNotMatch(workflow, /GH_TOKEN: \$\{\{ (?:secrets\.GITHUB_TOKEN|github\.token) \}\}/);
});

test('the workflow merges only through the required checks', () => {
    // --auto hands the decision to the branch ruleset, which has no bypass
    // actors and requires the E2E aggregate, so the nightly still faces the full
    // six-shard gate before it can become the CI baseline.
    assert.match(workflow, /gh pr merge "\$\{BRANCH\}" --auto --squash/);
    assert.doesNotMatch(workflow, /--admin|--merge\b|gh api[^\n]*merges/);
    assert.doesNotMatch(workflow, /workflow run|gh run rerun/);
});

test('staged rewrites are cleaned up rather than left carrying a digest', () => {
    const root = fixture();
    // Make the second staging write fail by turning its target's directory into
    // an unwritable path component.
    const blocked = path.join(root, `${PINNED_FILES[1]}.refresh-jellyfin-digest.tmp`);
    fs.mkdirSync(blocked, { recursive: true });

    assert.throws(() => applyRefresh(root, NEW_DIGEST));

    const leftovers = PINNED_FILES
        .map((file) => path.join(root, `${file}.refresh-jellyfin-digest.tmp`))
        .filter((temporary) => fs.existsSync(temporary) && fs.statSync(temporary).isFile());
    assert.deepEqual(leftovers, [], 'a staged rewrite was left behind');
    // The targets are untouched, so the tree still agrees on the old digest.
    assert.equal(new Set(readPinnedFiles(root).map((file) => file.digest)).size, 1);
});

test('the workflow reconciles the open refresh pull request instead of piling them up', () => {
    // Auto-merge does not update a branch when main advances, and the ruleset
    // requires an up-to-date branch, so an unattended refresh pull request would
    // otherwise wait forever.
    assert.match(workflow, /gh pr update-branch/);
    assert.match(workflow, /BEHIND/);
    assert.match(workflow, /gh pr close/);
    assert.match(workflow, /--label "dependencies" --label "docker"/);

    // Order matters as much as presence: superseded branches are reconciled
    // before the unchanged-digest exit, the merge is enabled after the pull
    // request exists, and the behind-branch recovery runs last so it also covers
    // a pull request published moments earlier.
    const at = (pattern) => {
        const index = workflow.search(pattern);
        assert.notEqual(index, -1, `${pattern} is missing`);
        return index;
    };
    assert.ok(at(/gh pr close/) < at(/nothing to publish/));
    assert.ok(at(/nothing to publish/) < at(/gh pr create/));
    assert.ok(at(/gh pr create/) < at(/gh pr merge/));
    assert.ok(at(/gh pr merge/) < at(/gh pr update-branch/));

    // Best-effort cleanup: a superseded pull request that someone already closed
    // must not abort the run before the refresh itself is published.
    assert.match(workflow, /gh pr close[\s\S]{0,200}?\|\| echo/);
});
