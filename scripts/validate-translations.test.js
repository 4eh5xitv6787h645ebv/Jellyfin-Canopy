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

test('clear-cache copy reloads the installed locale instead of promising a remote update', () => {
    const inventory = readLocaleInventory();
    const expectedEnglish = 'Removes cached translations and reloads the locale included with the installed plugin.';
    for (const locale of inventory.locales) {
        const translation = JSON.parse(
            fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8')
        );
        const description = translation.panel_settings_language_clear_cache_desc;
        assert.ok(
            typeof description === 'string' && description.trim() !== '',
            `${locale}.json must describe translation cache clearing`
        );
        assert.doesNotMatch(
            description,
            /github|weblate/i,
            `${locale}.json must not present cache clearing as a remote deployment path`
        );
    }
    assert.strictEqual(
        JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'))
            .panel_settings_language_clear_cache_desc,
        expectedEnglish
    );
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

test('translation deployment docs stay aligned with the bundled-first runtime contract', () => {
    const root = path.join(__dirname, '..');
    const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
    const loader = read('Jellyfin.Plugin.JellyfinCanopy/src/bootstrap/translations.ts');
    const validator = read('scripts/validate-translations.js');
    const project = read('Jellyfin.Plugin.JellyfinCanopy/JellyfinCanopy.csproj');
    const controller = read('Jellyfin.Plugin.JellyfinCanopy/Controllers/ConfigController.cs');
    const task = read('Jellyfin.Plugin.JellyfinCanopy/ScheduledTasks/ClearTranslationCacheTask.cs');
    const contributing = read('CONTRIBUTING.md');
    const help = read('docs/help.md');
    const customization = read('docs/customization.md');
    const section = (source, startHeading, endHeading) => {
        const start = source.indexOf(startHeading);
        const end = source.indexOf(endHeading, start + startHeading.length);
        assert.ok(start >= 0 && end > start, `missing section ${startHeading}`);
        return source.slice(start, end);
    };
    const contributingTranslations = section(
        contributing,
        '### 2. Translation Contributions',
        '### Issue triage and inactivity'
    );
    const helpTranslations = section(help, '## Translate Jellyfin Canopy', '## Community and support');
    const customizationTranslations = section(customization, '## Internationalization', '## Server controls');

    const bundledFetch = loader.indexOf('/JellyfinCanopy/locales/${code}.json');
    const fallbackGate = loader.indexOf('AssetCacheEnabled === false', bundledFetch);
    const remoteFetch = loader.indexOf('fetch(`${GITHUB_RAW_BASE}/${code}.json`');
    assert.ok(bundledFetch >= 0, 'runtime must request the installed bundled locale');
    assert.ok(fallbackGate > bundledFetch, 'remote fallback gate must follow bundled loading');
    assert.ok(remoteFetch > fallbackGate, 'GitHub must remain a gated last-resort fallback');
    assert.match(loader, /JC_translation_\$\{code\}_\$\{pluginVersion\}/);
    assert.match(loader, /const CACHE_DURATION = 24 \* 60 \* 60 \* 1000/);
    assert.match(loader, /cleanOldTranslationCache\(pluginVersion\)/);
    assert.match(loader, /Jellyfin-Canopy\/main\/Jellyfin\.Plugin\.JellyfinCanopy\/js\/locales/);
    assert.doesNotMatch(loader, /n00bcodr\/Jellyfin-Enhanced/);

    assert.match(project, /EmbeddedResource Include="js\\\*\*"/);
    assert.match(project, /EmbeddedResource Include="locale-manifest\.json"/);
    assert.match(controller, /HttpGet\("locales"\)/);
    assert.match(controller, /HttpGet\("locales\/\{lang\}\.json"\)/);
    assert.match(task, /public string Name => "Refresh Translation Cache"/);
    assert.match(task, /ClearTranslationCacheTimestamp\s*=/);
    assert.doesNotMatch(task, /HttpClient|WebRequest|Download|File\./);
    assert.match(validator, /npm run validate-translations[\s\S]*open a pull request/i);
    assert.doesNotMatch(
        validator,
        /hosted\.weblate\.org|Translate in Weblate|workflow[^\n]*Weblate|n00bcodr\/Jellyfin-Enhanced/i
    );

    const contributionContract = `${contributingTranslations}\n${helpTranslations}`;
    assert.match(contributionContract, /plain pull request/i);
    assert.match(contributionContract, /both edits[\s\S]*newly registered locales require a subsequent plugin[\s\S]*update/i);
    assert.match(helpTranslations, /merging alone[\s\S]*does not change a running installation/i);
    assert.match(helpTranslations, /asset cache is explicitly disabled[\s\S]*failed bundled-locale request/i);
    assert.match(helpTranslations, /scheduled task[\s\S]*cannot add or update locale files/i);
    assert.match(customizationTranslations, /loads the matching translation from the plugin's bundled locale files/i);
    assert.match(customizationTranslations, /There is no config-page button for clearing translation caches/i);

    const deploymentDocs = `${contributingTranslations}\n${helpTranslations}\n${customizationTranslations}`;
    assert.doesNotMatch(deploymentDocs, /available immediately after merge/i);
    assert.doesNotMatch(deploymentDocs, /no plugin update is needed/i);
    assert.doesNotMatch(deploymentDocs, /hosted\.weblate\.org/i);
    assert.doesNotMatch(deploymentDocs, /n00bcodr\/Jellyfin-Enhanced/i);
});

test('locale contribution fixtures validate content edits and newly registered locales', t => {
    const existing = inventoryFixture(t);
    fs.writeFileSync(path.join(existing.localeDir, 'en.json'), '{"greeting":"Hello {name}"}\n');
    fs.writeFileSync(path.join(existing.localeDir, 'fr.json'), '{"greeting":"Bonjour {name}"}\n');
    assert.deepStrictEqual(
        validateLocaleInventory(existing.localeDir, existing.inventoryPath).errors,
        [],
        'editing a registered locale must not require an inventory change'
    );
    assert.deepStrictEqual(
        validateEntries(
            JSON.parse(fs.readFileSync(path.join(existing.localeDir, 'en.json'), 'utf8')),
            JSON.parse(fs.readFileSync(path.join(existing.localeDir, 'fr.json'), 'utf8'))
        ).errors,
        [],
        'an existing-locale edit must pass full key and placeholder validation'
    );

    fs.writeFileSync(path.join(existing.localeDir, 'it.json'), '{"greeting":"Ciao {name}"}\n');
    assert.match(
        validateLocaleInventory(existing.localeDir, existing.inventoryPath).errors.join('\n'),
        /Unregistered locale file: it\.json/,
        'a new locale must be registered before it can ship'
    );

    fs.writeFileSync(
        existing.inventoryPath,
        `${JSON.stringify({ baseLocale: 'en', locales: ['en', 'fr', 'it'] }, null, 2)}\n`
    );
    assert.deepStrictEqual(
        validateLocaleInventory(existing.localeDir, existing.inventoryPath).errors,
        [],
        'adding the locale file and canonical inventory entry completes the contribution path'
    );
    assert.deepStrictEqual(
        validateEntries(
            JSON.parse(fs.readFileSync(path.join(existing.localeDir, 'en.json'), 'utf8')),
            JSON.parse(fs.readFileSync(path.join(existing.localeDir, 'it.json'), 'utf8'))
        ).errors,
        [],
        'a registered new locale must also pass full key and placeholder validation'
    );
});

// --- Presence of the localized nav/calendar labels ---
test('en.json defines the localized nav/calendar labels', () => {
    const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
    for (const k of ['bookmarks_library_title', 'calendar_prev', 'calendar_next']) {
        assert.ok(typeof en[k] === 'string' && en[k].trim() !== '', `missing ${k}`);
    }
});
