'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { auditThemeStudioDocs, validateManifestShape } = require('./check-theme-studio-docs');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

test('live Theme Studio guides own every verified release capture', () => {
    const result = auditThemeStudioDocs();
    assert.deepEqual(result.problems, []);
    assert.equal(result.captures, 28);
});

test('capture manifest fails closed when required metadata is removed', () => {
    const manifest = require('../docs/theme-studio-captures.json');
    const incomplete = clone(manifest);
    delete incomplete.captures[0].input;
    incomplete.captures[0].viewport[0].layout = 'tv';
    const problems = validateManifestShape(incomplete);
    assert.ok(problems.some(problem => problem.includes('.input must be a non-empty string')));
    assert.ok(problems.some(problem => problem.includes('must name a supported modern layout and size')));
});

test('capture manifest rejects missing required image states and duplicate paths', () => {
    const manifest = require('../docs/theme-studio-captures.json');
    const reduced = clone(manifest);
    reduced.captures = reduced.captures.filter(capture => capture.state !== 'movie-details');
    reduced.captures[1].path = reduced.captures[0].path;
    const problems = validateManifestShape(reduced);
    assert.ok(problems.includes('capture manifest is missing required state movie-details'));
    assert.ok(problems.some(problem => problem.includes('.path is duplicated')));
});
