'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const spec = fs.readFileSync(path.join(ROOT, 'e2e', 'discovery.spec.ts'), 'utf8');
const descriptor = fs.readFileSync(
    path.join(ROOT, 'Jellyfin.Plugin.JellyfinCanopy', 'src', 'entries', 'seerr-descriptors.ts'),
    'utf8'
);
const owner = fs.readFileSync(
    path.join(ROOT, 'Jellyfin.Plugin.JellyfinCanopy', 'src', 'globals.ts'),
    'utf8'
);
const surface = fs.readFileSync(
    path.join(ROOT, 'Jellyfin.Plugin.JellyfinCanopy', 'src', 'discovery', 'library-tab.ts'),
    'utf8'
);
const entry = fs.readFileSync(
    path.join(ROOT, 'Jellyfin.Plugin.JellyfinCanopy', 'src', 'discovery', 'index.ts'),
    'utf8'
);
const helperPath = path.join(ROOT, 'e2e', 'helpers', 'discovery-availability.mjs');
const helperSource = fs.readFileSync(helperPath, 'utf8');

test('the real production descriptor and visible surface share one eligibility owner', () => {
    assert.match(owner, /config\?\.DiscoveryEnabled\s*!==\s*false[\s\S]*config\?\.DiscoveryLibraryTab\s*!==\s*false[\s\S]*config\?\.SeerrEnabled\s*===\s*true/);
    assert.match(descriptor, /isEnabled:\s*\(state\)\s*=>\s*Boolean\(state\.identity\)\s*&&\s*isDiscoveryLibraryConfigured\(JC\.pluginConfig\)/);
    assert.match(surface, /return isDiscoveryLibraryConfigured\(JC\.pluginConfig\);/);
    assert.match(entry, /&&\s*isDiscoveryLibraryConfigured\(window\.JellyfinCanopy\?\.pluginConfig\);/);
    assert.doesNotMatch(descriptor, /TmdbEnabled/);
    assert.doesNotMatch(surface, /TmdbEnabled/);
});

test('the exploratory E2E executes the reviewed availability classifier', () => {
    assert.match(spec, /from '\.\/helpers\/discovery-availability\.mjs';/);
    assert.match(spec, /return discoveryLibraryAvailability\(config\);/);
    assert.doesNotMatch(spec, /TmdbEnabled/);
    assert.doesNotMatch(helperSource, /TmdbEnabled/);
});

test('the E2E availability classifier enforces the complete production truth table', async () => {
    const { discoveryLibraryAvailability } = await import(pathToFileURL(helperPath).href);
    const cases = [
        [{ DiscoveryEnabled: false, DiscoveryLibraryTab: true, SeerrEnabled: true }, false, 'Discovery is disabled'],
        [{ DiscoveryEnabled: true, DiscoveryLibraryTab: false, SeerrEnabled: true }, false, 'library placement is disabled'],
        [{ DiscoveryEnabled: true, DiscoveryLibraryTab: true, SeerrEnabled: false, TmdbEnabled: true }, false, 'requires Seerr'],
        [{ SeerrEnabled: true }, true, null],
    ];

    for (const [config, available, reason] of cases) {
        const result = discoveryLibraryAvailability(config);
        assert.equal(result.available, available);
        if (reason === null) assert.equal(result.reason, null);
        else assert.match(result.reason, new RegExp(reason));
    }
});
