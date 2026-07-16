'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { parseArgs, scaffoldFeature } = require('./new-feature.js');

const PROJECT = 'Jellyfin.Plugin.JellyfinCanopy';

function write(root, relative, content) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-new-feature-'));
    write(root, 'scripts/build-bundle.js', `const path = require('node:path');
const SRC_ROOT = '/src';
const ESM_ENTRIES = Object.freeze({
    boot: path.join(SRC_ROOT, 'entries', 'boot.ts'),
});
`);
    write(root, `${PROJECT}/src/entries/feature-catalog.ts`, `import type { ClientFeatureDescriptor } from '../core/client-runtime';
export const builtInFeatureDescriptors: readonly ClientFeatureDescriptor[] = Object.freeze([
    {
        id: 'existing',
        entry: 'existing',
        scope: 'identity',
        isEnabled: () => true,
        isApplicable: () => true,
    },
]);
`);
    return root;
}

function read(root, relative) {
    return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('scaffolds an import-pure implementation and wires the lazy entry and descriptor', (t) => {
    const root = fixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const output = scaffoldFeature(parseArgs(['watch-party', '--area', 'extras']), { repoRoot: root });
    const implementation = read(root, `${PROJECT}/src/extras/watch-party.ts`);
    const entry = read(root, `${PROJECT}/src/entries/watch-party.ts`);
    const build = read(root, 'scripts/build-bundle.js');
    const catalog = read(root, `${PROJECT}/src/entries/feature-catalog.ts`);

    assert.match(implementation, /export function installWatchParty\(\): \(\) => void/);
    assert.match(implementation, /Importing this module performs no DOM/);
    assert.doesNotMatch(implementation, /\binitialize\(\);|JC\.watchParty\s*=/);
    assert.match(entry, /import \{ installWatchParty \} from '\.\.\/extras\/watch-party'/);
    assert.match(entry, /activate\(scope: FeatureScope\)/);
    assert.match(entry, /scope\.track\(dispose\)/);
    assert.match(build, /'watch-party': path\.join\(SRC_ROOT, 'entries', 'watch-party\.ts'\)/);
    assert.match(catalog, /id: 'watch-party',[\s\S]*entry: 'watch-party',[\s\S]*scope: 'identity'/);
    assert.match(catalog, /JC\.pluginConfig\?\.WatchPartyEnabled === true/);
    assert.match(output, /Wired lazy client activation/);
    assert.doesNotMatch(`${implementation}\n${entry}\n${output}`, /src\/main\.ts|src\/extras\/index\.ts/);
});

test('dry-run validates both architecture anchors without changing the fixture', (t) => {
    const root = fixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const buildBefore = read(root, 'scripts/build-bundle.js');
    const catalogBefore = read(root, `${PROJECT}/src/entries/feature-catalog.ts`);

    const output = scaffoldFeature(parseArgs(['dry-feature', '--dry-run']), { repoRoot: root });

    assert.match(output, /Would create \(dry run/);
    assert.match(output, /Would wire lazy client activation/);
    assert.equal(fs.existsSync(path.join(root, `${PROJECT}/src/enhanced/dry-feature.ts`)), false);
    assert.equal(read(root, 'scripts/build-bundle.js'), buildBefore);
    assert.equal(read(root, `${PROJECT}/src/entries/feature-catalog.ts`), catalogBefore);
});

test('an unrecognized post-split architecture fails closed before creating files', (t) => {
    const root = fixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    write(root, 'scripts/build-bundle.js', '// architecture changed\n');

    assert.throws(
        () => scaffoldFeature(parseArgs(['safe-failure']), { repoRoot: root }),
        /cannot wire the client manifest entry:[\s\S]*post-#318 client architecture may have changed; no files were written[\s\S]*safe-failure\.ts/
    );
    assert.equal(fs.existsSync(path.join(root, `${PROJECT}/src/enhanced/safe-failure.ts`)), false);
    assert.equal(fs.existsSync(path.join(root, `${PROJECT}/src/entries/safe-failure.ts`)), false);
});

test('existing catalog registration also fails before any scaffold target is written', (t) => {
    const root = fixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const catalog = read(root, `${PROJECT}/src/entries/feature-catalog.ts`)
        .replace("id: 'existing'", "id: 'already-wired'");
    write(root, `${PROJECT}/src/entries/feature-catalog.ts`, catalog);

    assert.throws(
        () => scaffoldFeature(parseArgs(['already-wired']), { repoRoot: root }),
        /feature catalog descriptor: "already-wired" is already registered; no files were written/
    );
    assert.equal(fs.existsSync(path.join(root, `${PROJECT}/src/enhanced/already-wired.ts`)), false);
});
