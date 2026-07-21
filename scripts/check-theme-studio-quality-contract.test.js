'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const contract = require('./theme-studio-quality.contract.json');
const { verifyQualityContract } = require('./check-theme-studio-quality-contract');

const ROOT = path.resolve(__dirname, '..');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

test('the live Theme Studio quality contract owns every release gate', () => {
    assert.deepEqual(verifyQualityContract({ root: ROOT }), {
        layouts: 4,
        noOpLayouts: 3,
        researchFiles: 5,
        researchExternalUrls: 517,
        researchRepositoryRoots: 322,
        forumThreads: 157,
        presets: 9,
        evidenceOwners: 14,
        crossBrowserEngines: 2,
        crossBrowserTests: 28,
    });
});

test('the quality contract fails closed when reviewed research evidence is lost or stale', () => {
    const missingFile = clone(contract);
    missingFile.researchEvidence.files.pop();
    assert.throws(
        () => verifyQualityContract({ root: ROOT, contract: missingFile }),
        /research evidence files must be exactly/,
    );

    const missingAnchor = clone(contract);
    missingAnchor.researchEvidence.files[0].anchors.push('missing reviewed evidence');
    assert.throws(
        () => verifyQualityContract({ root: ROOT, contract: missingAnchor }),
        /lost "missing reviewed evidence"/,
    );

    const reducedInventory = clone(contract);
    reducedInventory.researchEvidence.inventory.repositoryRootCount += 1;
    assert.throws(
        () => verifyQualityContract({ root: ROOT, contract: reducedInventory }),
        /research inventory must contain exactly/,
    );

    const missingForumSnapshot = clone(contract);
    const forumEvidence = missingForumSnapshot.researchEvidence.files
        .find((evidence) => evidence.id === 'forum-snapshot');
    forumEvidence.path = 'research/theme-studio-ecosystem.md';
    forumEvidence.anchors = missingForumSnapshot.researchEvidence.files[0].anchors;
    assert.throws(
        () => verifyQualityContract({ root: ROOT, contract: missingForumSnapshot }),
        /forum thread snapshot must contain exactly 157 unique thread URLs/,
    );
});

test('the quality contract fails closed when a modern layout or preset baseline is lost', () => {
    const missingLayout = clone(contract);
    missingLayout.scope.supportedModernLayouts.pop();
    assert.throws(
        () => verifyQualityContract({ root: ROOT, contract: missingLayout }),
        /supported modern layouts must be exactly/,
    );

    const missingBaseline = clone(contract);
    missingBaseline.primaryPresets[0].evidenceName = 'missing-evidence';
    assert.throws(
        () => verifyQualityContract({ root: ROOT, contract: missingBaseline }),
        /missing .*theme-studio-missing-evidence-desktop-linux\.png/,
    );
});

test('the quality contract rejects incomplete deterministic visual-font ownership', () => {
    const missingSpec = clone(contract);
    missingSpec.visualEvidence.deterministicFont.specs.pop();
    assert.throws(
        () => verifyQualityContract({ root: ROOT, contract: missingSpec }),
        /visual evidence specs must be exactly/,
    );

    const hostDependentFont = clone(contract);
    hostDependentFont.visualEvidence.deterministicFont.family = 'system-ui';
    assert.throws(
        () => verifyQualityContract({ root: ROOT, contract: hostDependentFont }),
        /must use the deterministic DejaVu Sans font/,
    );
});

test('the quality contract rejects a widened media fixture visual tolerance', () => {
    const widened = clone(contract);
    widened.visualEvidence.mediaFixtureMaxDiffPixels = 2501;
    assert.throws(
        () => verifyQualityContract({ root: ROOT, contract: widened }),
        /must remain at the reviewed 2,500-pixel ceiling/,
    );
});

test('the quality contract rejects a reduced accessibility standard inventory', () => {
    const reduced = clone(contract);
    reduced.accessibilityScan.tags.push('future-required-tag');
    assert.throws(
        () => verifyQualityContract({ root: ROOT, contract: reduced }),
        /lost accessibility tag future-required-tag/,
    );
});

test('the quality contract rejects reduced or non-blocking cross-browser ownership', () => {
    const missingBrowser = clone(contract);
    missingBrowser.crossBrowserAudit.browsers.pop();
    assert.throws(
        () => verifyQualityContract({ root: ROOT, contract: missingBrowser }),
        /cross-browser engines must be exactly/,
    );

    const widenedRasterPolicy = clone(contract);
    widenedRasterPolicy.crossBrowserAudit.rasterPolicy = 'compare every engine pixel-for-pixel';
    assert.throws(
        () => verifyQualityContract({ root: ROOT, contract: widenedRasterPolicy }),
        /sole pixel-baseline owner/,
    );
});
