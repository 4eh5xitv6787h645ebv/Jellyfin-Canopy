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
        presets: 9,
        evidenceOwners: 13,
    });
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

test('the quality contract rejects a reduced accessibility standard inventory', () => {
    const reduced = clone(contract);
    reduced.accessibilityScan.tags.push('future-required-tag');
    assert.throws(
        () => verifyQualityContract({ root: ROOT, contract: reduced }),
        /lost accessibility tag future-required-tag/,
    );
});
