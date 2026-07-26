'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PAGE = path.join(
    ROOT,
    'Jellyfin.Plugin.JellyfinCanopy',
    'Configuration',
    'config-page.js'
);

function parserSource() {
    const source = fs.readFileSync(CONFIG_PAGE, 'utf8');
    const start = source.indexOf('function tryParseInstanceList(');
    const end = source.indexOf('function insertCorruptBanner(', start);
    assert.notEqual(start, -1, 'tryParseInstanceList must exist');
    assert.ok(end > start, 'insertCorruptBanner must delimit tryParseInstanceList');
    return source.slice(start, end);
}

test('ARR config parse logging never forwards raw input or exception objects', () => {
    const source = parserSource();
    assert.match(source, /console\.error\('\[JC Config\] Failed to parse '/);
    assert.doesNotMatch(source, /console\.error\([^;]*,\s*(?:e|raw)\b/s);
});

test('ARR config parse failure does not log API keys or private URLs at runtime', () => {
    const secretKey = 'api-key-SUPER-SECRET-sentinel';
    const privateUrl = 'http://10.23.45.67:8989/private-sentinel';
    const corrupt = `[{"Url":"${privateUrl}","ApiKey":"${secretKey}"}`;
    const calls = [];
    const context = {
        _arrParseOK: { sonarr: true, radarr: true },
        console: { error: (...args) => calls.push(args) },
        insertCorruptBanner: () => {},
        raw: corrupt,
        result: null,
    };

    vm.runInNewContext(
        `${parserSource()}; result = tryParseInstanceList(raw, 'sonarr', {});`,
        context
    );

    assert.deepEqual(Array.from(context.result), []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1);
    const serializedLog = calls.flat().map(String).join(' ');
    assert.doesNotMatch(serializedLog, /SUPER-SECRET|10\.23\.45\.67|private-sentinel/);
    assert.match(serializedLog, /SyntaxError/);
});
