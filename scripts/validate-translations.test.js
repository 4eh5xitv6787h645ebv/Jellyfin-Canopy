#!/usr/bin/env node

/**
 * Unit tests for the hardened translation validator.
 *
 * Uses node:test + node:assert (matches the scripts' CommonJS world — no
 * vitest/TS-interop friction). Run with `npm run test:scripts` or directly with
 * `node scripts/validate-translations.test.js`.
 *
 * Covers the three hardening behaviors:
 *   - icon-token / curly placeholder parity is enforced (a dropped or malformed
 *     token is a missing-placeholder error);
 *   - empty/whitespace values are ERRORS (were warnings);
 *   - non-string values are reported as errors instead of crashing the run.
 * Plus a class guard over the real shipped locales and a presence check for the
 * localized nav/calendar labels.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    extractPlaceholders,
    getAvailableLanguages,
    readLocaleInventory,
    validateEntries,
    validateLocaleInventory,
} = require('./validate-translations.js');
// The require is side-effect-free: main() is guarded by require.main === module.

const LOCALES_DIR = path.join(__dirname, '../Jellyfin.Plugin.JellyfinCanopy/js/locales');
const INVENTORY_PATH = path.join(
    __dirname,
    '../Jellyfin.Plugin.JellyfinCanopy/locale-manifest.json'
);

function inventoryFixture(t, locales = ['en', 'fr']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-locales-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const localeDir = path.join(root, 'locales');
    const inventoryPath = path.join(root, 'locale-manifest.json');
    fs.mkdirSync(localeDir);
    fs.writeFileSync(inventoryPath, `${JSON.stringify({ baseLocale: 'en', locales }, null, 2)}\n`);
    for (const locale of [...new Set(locales)]) {
        fs.writeFileSync(path.join(localeDir, `${locale}.json`), '{}\n');
    }
    return { localeDir, inventoryPath };
}

// --- MB-5: icon-token + curly placeholder parity ---
test('extractPlaceholders captures well-formed icon tokens', () => {
    assert.deepStrictEqual(extractPlaceholders('{{icon:fastForward}} Go'), ['{{icon:fastForward}}']);
});

test('extractPlaceholders ignores a malformed single-brace icon token', () => {
    assert.deepStrictEqual(extractPlaceholders('{{icon:fastForward} Go'), []);
});

test('extractPlaceholders still captures simple params, no icon false-positive', () => {
    assert.deepStrictEqual(extractPlaceholders('Speed {speed}x, {count} items'), ['{count}', '{speed}']);
});

test('MB-5 malformed icon token is a missing-placeholder error', () => {
    const { errors } = validateEntries({ k: '{{icon:fastForward}} x' }, { k: '{{icon:fastForward} x' });
    assert.ok(errors.some(e => /missing placeholders/i.test(e)), errors.join(' | '));
});

test('MB-5 dropped {curly} param is a missing-placeholder error', () => {
    const { errors } = validateEntries({ k: 'Hi {name}' }, { k: 'Hola' });
    assert.ok(errors.some(e => /missing placeholders/i.test(e)), errors.join(' | '));
});

// --- MB-6: empty values are errors, not warnings ---
test('MB-6 empty/whitespace value is an ERROR', () => {
    const { errors } = validateEntries({ k: 'Hello' }, { k: '   ' });
    assert.ok(errors.some(e => /empty/i.test(e)), errors.join(' | '));
});

// --- MB-7: non-string values don't crash ---
test('MB-7 non-string value yields a clean error, no throw', () => {
    let res;
    assert.doesNotThrow(() => { res = validateEntries({ k: 'Hello' }, { k: { nested: true } }); });
    assert.ok(res.errors.some(e => /non-string/i.test(e)), res.errors.join(' | '));
});

// --- A clean locale passes ---
test('a clean matching locale produces no errors', () => {
    const base = { greeting: 'Hello', speed: 'Speed {speed}x', icon: '{{icon:fastForward}} Go' };
    const clean = { greeting: 'Hola', speed: 'Velocidad {speed}x', icon: '{{icon:fastForward}} Ir' };
    assert.deepStrictEqual(validateEntries(base, clean).errors, []);
});

// --- Class guard over the REAL shipped locales ---
test('all shipped locales validate clean against en.json', () => {
    const inventory = validateLocaleInventory();
    assert.deepStrictEqual(inventory.errors, []);
    const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
    for (const locale of inventory.locales.filter(code => code !== inventory.baseLocale)) {
        const translation = JSON.parse(
            fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8')
        );
        const { errors } = validateEntries(en, translation);
        assert.deepStrictEqual(errors, [], `${locale}.json: ${errors.join(' | ')}`);
    }
});

test('canonical inventory is the exact source for all 26 shipped locale files', () => {
    const inventory = readLocaleInventory();
    assert.strictEqual(inventory.baseLocale, 'en');
    assert.strictEqual(inventory.locales.length, 26);
    assert.deepStrictEqual(getAvailableLanguages(), inventory.locales);
    assert.deepStrictEqual(validateLocaleInventory().errors, []);
});

test('deleting a registered locale is a hard inventory failure', t => {
    const fixture = inventoryFixture(t);
    fs.rmSync(path.join(fixture.localeDir, 'fr.json'));
    assert.match(
        validateLocaleInventory(fixture.localeDir, fixture.inventoryPath).errors.join('\n'),
        /Registered locale file is missing: fr\.json/
    );
});

test('adding an unregistered locale is a hard inventory failure', t => {
    const fixture = inventoryFixture(t);
    fs.writeFileSync(path.join(fixture.localeDir, 'it.json'), '{}\n');
    assert.match(
        validateLocaleInventory(fixture.localeDir, fixture.inventoryPath).errors.join('\n'),
        /Unregistered locale file: it\.json/
    );
});

test('case-only locale renames are rejected', t => {
    const fixture = inventoryFixture(t);
    fs.renameSync(
        path.join(fixture.localeDir, 'fr.json'),
        path.join(fixture.localeDir, 'FR.json')
    );
    const errors = validateLocaleInventory(fixture.localeDir, fixture.inventoryPath).errors.join('\n');
    assert.match(errors, /Invalid locale filename: FR\.json/);
    assert.match(errors, /Locale filename case mismatch: expected fr\.json, found FR\.json/);
});

test('locale filename extension casing is rejected', t => {
    const fixture = inventoryFixture(t);
    fs.renameSync(
        path.join(fixture.localeDir, 'fr.json'),
        path.join(fixture.localeDir, 'fr.JSON')
    );
    assert.match(
        validateLocaleInventory(fixture.localeDir, fixture.inventoryPath).errors.join('\n'),
        /Invalid locale filename extension casing: fr\.JSON/
    );
});

test('region casing and case-colliding inventory entries are rejected', t => {
    const fixture = inventoryFixture(t, ['en', 'pt-BR', 'pt-br']);
    const errors = validateLocaleInventory(fixture.localeDir, fixture.inventoryPath).errors.join('\n');
    assert.match(errors, /Invalid locale code in inventory: pt-br/);
    assert.match(errors, /Case-colliding locales in inventory: pt-BR and pt-br/);
});

test('server loader, workflow, and contributor docs consume the canonical inventory', () => {
    const root = path.join(__dirname, '..');
    const controller = fs.readFileSync(
        path.join(root, 'Jellyfin.Plugin.JellyfinCanopy/Controllers/ConfigController.cs'),
        'utf8'
    );
    const catalog = fs.readFileSync(
        path.join(root, 'Jellyfin.Plugin.JellyfinCanopy/Controllers/LocaleResourceCatalog.cs'),
        'utf8'
    );
    const project = fs.readFileSync(
        path.join(root, 'Jellyfin.Plugin.JellyfinCanopy/JellyfinCanopy.csproj'),
        'utf8'
    );
    const loader = fs.readFileSync(
        path.join(root, 'Jellyfin.Plugin.JellyfinCanopy/src/bootstrap/translations.ts'),
        'utf8'
    );
    const workflow = fs.readFileSync(
        path.join(root, '.github/workflows/translation_validation.yml'),
        'utf8'
    );
    assert.match(project, /EmbeddedResource Include="locale-manifest\.json"/);
    assert.match(controller, /LocaleResourceCatalog\.Load\(Assembly\.GetExecutingAssembly\(\)\)/);
    assert.match(controller, /LocaleCatalog\.Resolve\(lang\)/);
    assert.match(controller, /SupportedLocaleCodes =>\s*LocaleCatalog\.SupportedCodes/);
    assert.match(catalog, /Jellyfin\.Plugin\.JellyfinCanopy\.locale-manifest\.json/);
    assert.match(catalog, /registered\.SetEquals\(embeddedCodes\)/);
    assert.match(catalog, /ToFrozenDictionary\(StringComparer\.Ordinal\)/);
    assert.match(loader, /import localeManifest from '\.\.\/\.\.\/locale-manifest\.json'/);
    assert.match(loader, /SUPPORTED_LOCALES\.has\(normalizedLang\)/);
    assert.match(workflow, /locale-manifest\.json/);
    assert.match(workflow, /npm run validate-translations/);

    for (const file of ['README.md', 'CONTRIBUTING.md', 'docs/help.md']) {
        assert.match(
            fs.readFileSync(path.join(root, file), 'utf8'),
            /locale-manifest\.json/,
            `${file} must point to the canonical supported-locale list`
        );
    }
    assert.match(
        fs.readFileSync(path.join(root, 'README.md'), 'utf8'),
        new RegExp(`${readLocaleInventory().locales.length} synchronized language catalogs`)
    );
    assert.ok(fs.existsSync(INVENTORY_PATH));
});

// --- Presence of the localized nav/calendar labels ---
test('en.json defines the localized nav/calendar labels', () => {
    const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
    for (const k of ['bookmarks_library_title', 'calendar_prev', 'calendar_next']) {
        assert.ok(typeof en[k] === 'string' && en[k].trim() !== '', `missing ${k}`);
    }
});
