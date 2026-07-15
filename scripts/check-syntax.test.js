'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
    checkClasses,
    collectInventory,
    createInventory,
    extractInlineScripts,
    formatSummary,
    validateSourceCensus,
} = require('./check-syntax');

function createFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-syntax-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const plugin = path.join(root, 'Jellyfin.Plugin.JellyfinCanopy');
    fs.mkdirSync(path.join(plugin, 'js'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'Configuration'), { recursive: true });
    const paths = {
        raw: path.join(plugin, 'js', 'plugin.js'),
        admin: path.join(plugin, 'Configuration', 'config-page.js'),
        html: path.join(plugin, 'Configuration', 'configPage.html'),
    };
    fs.writeFileSync(paths.raw, 'globalThis.rawLoaded = true;\n');
    fs.writeFileSync(paths.admin, 'globalThis.adminLoaded = true;\n');
    fs.writeFileSync(paths.html, '<script>globalThis.first = true;</script>\n'
        + '<script type="application/json">{ "not": "JavaScript" }</script>\n'
        + '<script>globalThis.second = true;</script>\n');
    return { root, paths };
}

test('current shipped inventory parses two files and both admin inline scripts', () => {
    const inventory = createInventory();
    const classes = collectInventory(inventory.classes);
    assert.doesNotThrow(() => validateSourceCensus(inventory, classes));
    assert.deepEqual(classes.map((entry) => [entry.id, entry.bodies.length]), [
        ['raw-served-js', 1],
        ['admin-served-js', 1],
        ['admin-inline-js', 2],
    ]);
    assert.deepEqual(checkClasses(classes), []);
    const summary = formatSummary(classes, path.join(__dirname, '..'));
    assert.match(summary, /raw-served-js: 1/);
    assert.match(summary, /admin-served-js: 1/);
    assert.match(summary, /admin-inline-js: 2/);
    assert.match(summary, /Total: 4 independently executed JavaScript bodies/);
});

test('valid fixture parses every artifact class and ignores non-executable script data', (t) => {
    const fixture = createFixture(t);
    const inventory = createInventory(fixture.root);
    const classes = collectInventory(inventory.classes);
    assert.doesNotThrow(() => validateSourceCensus(inventory, classes));
    assert.deepEqual(checkClasses(classes), []);
    assert.equal(classes[2].bodies.length, 2);
});

for (const [name, mutate, expectedClass] of [
    ['raw served JavaScript', ({ raw }) => fs.writeFileSync(raw, 'const broken = ;\n'), 'raw-served-js'],
    ['served admin JavaScript', ({ admin }) => fs.writeFileSync(admin, 'const broken = ;\n'), 'admin-served-js'],
    ['inline admin JavaScript', ({ html }) => fs.writeFileSync(html,
        '<script>const broken = ;</script><script>globalThis.second = true;</script>\n'), 'admin-inline-js'],
]) {
    test(`malformed ${name} fixture fails its artifact class`, (t) => {
        const fixture = createFixture(t);
        mutate(fixture.paths);
        const inventory = createInventory(fixture.root);
        const failures = checkClasses(collectInventory(inventory.classes));
        assert.equal(failures.length, 1);
        assert.equal(failures[0].classId, expectedClass);
        assert.match(failures[0].message, /SyntaxError/);
    });
}

test('inline extraction supports classic and module bodies but excludes src and data scripts', () => {
    const scripts = extractInlineScripts(
        '<script>const classic = true;</script>'
        + '<script type="module">export const moduleValue = true;</script>'
        + '<script src="external.js"></script>'
        + '<script type="application/json">{"value": 1}</script>',
        'fixture.html',
    );
    assert.deepEqual(scripts.map((script) => script.mode), ['script', 'module']);
    assert.deepEqual(checkClasses([{ id: 'inline', bodies: scripts }]), []);
});

test('inline extraction covers browser JavaScript MIME essences, parameters, and permissive end tags', () => {
    const scripts = extractInlineScripts(
        '<script type="application/x-javascript">const legacy = true;</script ignored>'
        + '<script type="text/javascript; charset=utf-8">const parameterized = true;</script extra=value>',
        'fixture.htm',
    );
    assert.equal(scripts.length, 2);
    assert.deepEqual(scripts.map((script) => script.mode), ['script', 'script']);
    assert.deepEqual(checkClasses([{ id: 'inline', bodies: scripts }]), []);
});

test('inventory shrink and missing artifacts fail before parsing', (t) => {
    const fixture = createFixture(t);
    fs.writeFileSync(fixture.paths.html, '<script>globalThis.only = true;</script>');
    assert.throws(
        () => collectInventory(createInventory(fixture.root).classes),
        /contains 1 executable inline scripts; expected 2/,
    );
    fs.rmSync(fixture.paths.admin);
    assert.throws(
        () => collectInventory(createInventory(fixture.root).classes),
        /syntax inventory file is missing/,
    );
});

test('generated dist scripts remain outside the source syntax inventory', () => {
    const inventory = createInventory();
    assert.ok(inventory.classes.every((entry) => !entry.path.split(path.sep).includes('dist')));
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.match(packageJson.scripts['build:bundle'], /build-bundle\.js/);
});

test('source census rejects newly shipped raw or inline JavaScript until it has an owner', (t) => {
    const fixture = createFixture(t);
    const inventory = createInventory(fixture.root);
    const classes = collectInventory(inventory.classes);

    const missedJs = path.join(inventory.pluginRoot, 'Configuration', 'new-served.js');
    fs.writeFileSync(missedJs, 'globalThis.newServed = true;');
    assert.throws(
        () => validateSourceCensus(inventory, classes),
        /shipped source JavaScript is absent from the syntax inventory/,
    );
    fs.rmSync(missedJs);

    const missedHtml = path.join(inventory.pluginRoot, 'newPluginPage.html');
    fs.writeFileSync(missedHtml, '<script>globalThis.newInline = true;</script>');
    assert.throws(
        () => validateSourceCensus(inventory, classes),
        /executable inline HTML is absent from the syntax inventory/,
    );
});

test('source census includes module, CommonJS, and htm extensions', (t) => {
    const fixture = createFixture(t);
    const inventory = createInventory(fixture.root);
    const classes = collectInventory(inventory.classes);
    for (const relative of ['new-module.mjs', 'new-common.cjs']) {
        const file = path.join(inventory.pluginRoot, 'js', relative);
        fs.writeFileSync(file, relative.endsWith('.mjs') ? 'export const value = true;' : 'module.exports = true;');
        assert.throws(() => validateSourceCensus(inventory, classes), /shipped source JavaScript/);
        fs.rmSync(file);
    }
    const html = path.join(inventory.pluginRoot, 'new-page.htm');
    fs.writeFileSync(html, '<script>globalThis.htmRuns = true;</script>');
    assert.throws(() => validateSourceCensus(inventory, classes), /executable inline HTML/);
});
