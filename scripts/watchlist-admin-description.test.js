'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PAGE = path.join(
    ROOT,
    'Jellyfin.Plugin.JellyfinCanopy',
    'Configuration',
    'configPage.html'
);
const DISCOVER_DOCS = path.join(ROOT, 'docs', 'discover.md');

test('watchlist auto-add copy covers requests created outside Canopy', () => {
    const configPage = fs.readFileSync(CONFIG_PAGE, 'utf8');
    const docs = fs.readFileSync(DISCOVER_DOCS, 'utf8');

    assert.match(configPage, /media requested in any configured Seerr instance/);
    assert.match(configPage, /This includes requests created outside Jellyfin Canopy\./);
    assert.doesNotMatch(configPage, /requested through Seerr Search via Jellyfin Canopy/);
    assert.match(docs, /including requests created outside Canopy/);
});
