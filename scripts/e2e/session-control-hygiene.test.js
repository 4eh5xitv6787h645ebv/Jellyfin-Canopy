'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'e2e/session-control.spec.ts'), 'utf8');

function sliceBetween(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.notEqual(from, -1, `missing source marker: ${start}`);
    assert.notEqual(to, -1, `missing source marker: ${end}`);
    return source.slice(from, to);
}

test('session-control captures the original configuration before enabling its flags', () => {
    const setup = sliceBetween('test.beforeAll(', 'test.afterAll(');
    const read = setup.indexOf('const config = await api<Record<string, unknown>>');
    const capture = setup.indexOf('originalConfig = config!;');
    const write = setup.indexOf('await writePluginConfig(baseURL!, admin, {');

    assert.ok(read >= 0, 'beforeAll must read the plugin configuration');
    assert.ok(capture > read, 'beforeAll must retain the configuration it read');
    assert.ok(write > capture, 'the exact original must be captured before the first write');
    assert.match(setup, /ActiveStreamsEnabled:\s*true/);
    assert.match(setup, /ActiveStreamsAllUsers:\s*false/);
});

test('session-control afterAll restores the exact snapshot and exposes cleanup failures', () => {
    const writer = sliceBetween('async function writePluginConfig(', '// A DISTINCT device');
    const cleanup = sliceBetween('test.afterAll(', "test('admin sees");

    assert.match(writer, /body:\s*JSON\.stringify\(config\)/);
    assert.match(cleanup, /await writePluginConfig\(baseURL!, admin, originalConfig\);/);
    assert.doesNotMatch(writer, /\.catch\s*\(/, 'the configuration write must reject on failure');
    assert.doesNotMatch(cleanup, /\.catch\s*\(/, 'afterAll must not swallow a restore failure');
});

test('session-control has no per-test configuration setup left behind', () => {
    assert.doesNotMatch(source, /enableActiveStreams/);
    assert.equal(
        (source.match(/await writePluginConfig\(/g) ?? []).length,
        2,
        'configuration writes belong only in beforeAll and afterAll'
    );
});
