'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const CLIENT_ROOT = path.join(ROOT, 'Jellyfin.Plugin.JellyfinCanopy');

function filesBelow(directory, predicate) {
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...filesBelow(file, predicate));
        else if (predicate(file)) files.push(file);
    }
    return files;
}

function assertFilesExclude(files, forbidden) {
    const failures = [];
    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8');
        for (const token of forbidden) {
            if (source.includes(token)) {
                failures.push(`${path.relative(ROOT, file)} contains ${JSON.stringify(token)}`);
            }
        }
    }
    assert.deepEqual(failures, []);
}

test('production client source has no classic-layout feature branches', () => {
    const production = filesBelow(path.join(CLIENT_ROOT, 'src'), (file) => (
        file.endsWith('.ts') && !file.endsWith('.test.ts')
    ));
    production.push(path.join(CLIENT_ROOT, 'js', 'plugin.js'));

    assertFilesExclude(production, [
        'jc-legacy-layout',
        '.mainDrawer-scrollContainer',
        '.layout-mobile',
        'detectLayoutMode',
        'stampResolvedLayout',
    ]);
});

test('positive E2E inventory is modern-only', () => {
    const specs = filesBelow(path.join(ROOT, 'e2e'), (file) => (
        file.endsWith('.spec.ts') && path.basename(file) !== 'layout-enforcement.spec.ts'
    ));
    assertFilesExclude(specs, [
        'jc-legacy-layout',
        'desktop-legacy',
        'mobile-legacy',
    ]);
});

test('admin layout selector exposes only preserve-choice and force-modern', () => {
    const source = fs.readFileSync(
        path.join(CLIENT_ROOT, 'Configuration', 'configPage.html'),
        'utf8'
    );
    const options = [...source.matchAll(/<option value="([^"]+)">/g)]
        .map((match) => match[1]);
    const enforcementOptions = options.filter((value) => (
        value === 'None' || value.startsWith('Force') || value.startsWith('Default')
    ));

    assert.deepEqual(enforcementOptions, ['None', 'ForceExperimental']);
});

test('repository guidance declares the modern-only support boundary', () => {
    const required = new Map([
        ['CONTRIBUTING.md', /supported modern React\/MUI layout/],
        ['docs/customization.md', /supports the Jellyfin 12 \*\*modern React\/MUI layout only\*\*/],
        ['.agents/skills/jellyfin-canopy-engineering/SKILL.md', /modern React\/MUI web layout is Canopy's only supported client surface/],
    ]);
    for (const [relative, pattern] of required) {
        assert.match(fs.readFileSync(path.join(ROOT, relative), 'utf8'), pattern, relative);
    }
});
