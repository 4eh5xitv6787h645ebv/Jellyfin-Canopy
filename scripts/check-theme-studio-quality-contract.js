#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONTRACT = path.join(__dirname, 'theme-studio-quality.contract.json');
const REQUIRED_SUPPORTED_LAYOUTS = ['desktop', 'wide', 'phone-portrait', 'phone-landscape'];
const REQUIRED_UNSUPPORTED_LAYOUTS = ['tablet-only', 'legacy', 'tv'];
const REQUIRED_PRIMARY_PRESETS = [
    'canopy', 'minimal', 'cinematic', 'glass', 'material', 'studio', 'tv-focus', 'oled', 'high-contrast',
];
const REQUIRED_VISUAL_SPECS = [
    'e2e/theme-studio-accessibility.spec.ts',
    'e2e/theme-studio-canopy-surfaces.spec.ts',
    'e2e/theme-studio-editor-mobile.spec.ts',
    'e2e/theme-studio-effects.spec.ts',
    'e2e/theme-studio-integration-surfaces.spec.ts',
    'e2e/theme-studio-jellyfish-migration.spec.ts',
    'e2e/theme-studio-media-surfaces.spec.ts',
    'e2e/theme-studio-operational-surfaces.spec.ts',
    'e2e/theme-studio-runtime.spec.ts',
    'e2e/theme-studio-sharing.spec.ts',
];

function fail(message) {
    throw new Error(`Theme Studio quality contract: ${message}`);
}

function requireRegularFile(root, relativePath) {
    const absolute = path.join(root, relativePath);
    let stats;
    try {
        stats = fs.lstatSync(absolute);
    } catch {
        fail(`missing ${relativePath}`);
    }
    if (!stats.isFile() || stats.isSymbolicLink()) fail(`${relativePath} must be a regular file`);
    return absolute;
}

function readText(root, relativePath) {
    return fs.readFileSync(requireRegularFile(root, relativePath), 'utf8');
}

function exactIds(items, expected, label) {
    if (!Array.isArray(items)) fail(`${label} must be an array`);
    const ids = items.map((item) => typeof item === 'string' ? item : item?.id);
    if (new Set(ids).size !== ids.length) fail(`${label} contains duplicate IDs`);
    if (JSON.stringify([...ids].sort()) !== JSON.stringify([...expected].sort())) {
        fail(`${label} must be exactly ${expected.join(', ')}`);
    }
}

function verifyPullRequestWorkflow(root, relativePath) {
    const source = readText(root, relativePath);
    if (!/^ {2}pull_request:\s*$/m.test(source)) fail(`${relativePath} does not run for pull requests`);
    if (/^ {2}pull_request:\s*\n\s+branches:/m.test(source)) {
        fail(`${relativePath} excludes stacked pull-request base branches`);
    }
}

function verifyQualityContract({ root = DEFAULT_ROOT, contract } = {}) {
    const resolved = contract ?? JSON.parse(fs.readFileSync(DEFAULT_CONTRACT, 'utf8'));
    if (resolved?.schemaVersion !== 1) fail('unsupported schemaVersion');

    exactIds(resolved.scope?.supportedModernLayouts, REQUIRED_SUPPORTED_LAYOUTS, 'supported modern layouts');
    exactIds(resolved.scope?.unsupportedNoOpLayouts, REQUIRED_UNSUPPORTED_LAYOUTS, 'unsupported no-op layouts');

    const presets = resolved.primaryPresets;
    if (!Array.isArray(presets) || presets.length !== 9) fail('exactly nine primary presets are required');
    exactIds(presets, REQUIRED_PRIMARY_PRESETS, 'primary presets');
    const evidenceNames = presets.map((preset) => preset.evidenceName);
    if (new Set(evidenceNames).size !== evidenceNames.length) fail('primary preset evidence names must be unique');

    const visual = resolved.visualEvidence;
    const runtimeSource = readText(root, visual.spec);
    for (const preset of presets) {
        const tuple = `['${preset.id}', '${preset.palette}']`;
        if (!runtimeSource.includes(tuple)) fail(`${visual.spec} lost primary preset ${tuple}`);
        for (const view of visual.requiredViews) {
            const snapshot = path.join(
                visual.snapshotDirectory,
                `theme-studio-${preset.evidenceName}-${view}-${visual.platform}.png`,
            );
            requireRegularFile(root, snapshot);
        }
    }
    if (!runtimeSource.includes("viewport.name === 'desktop' || viewport.name === 'phone portrait'")) {
        fail(`${visual.spec} must capture both desktop and phone primary-preset baselines`);
    }
    const visualFont = visual.deterministicFont;
    if (visualFont?.family !== 'DejaVu Sans') fail('visual evidence must use the deterministic DejaVu Sans font');
    exactIds(visualFont?.specs, REQUIRED_VISUAL_SPECS, 'visual evidence specs');
    const visualHelper = readText(root, visualFont.helper);
    for (const anchor of [
        'installThemeStudioVisualFont',
        `--jc-type-family-ui: "${visualFont.family}"`,
        'data-jc-e2e-visual-font="deterministic"',
    ]) {
        if (!visualHelper.includes(anchor)) fail(`${visualFont.helper} lost ${anchor}`);
    }
    for (const spec of visualFont.specs) {
        const source = readText(root, spec);
        if (!source.includes("from './helpers/theme-studio-visual'")) {
            fail(`${spec} does not import the deterministic visual-font helper`);
        }
        if (!source.includes('await installThemeStudioVisualFont(page);')) {
            fail(`${spec} does not install the deterministic visual font before navigation`);
        }
    }

    const accessibility = resolved.accessibilityScan;
    const packageJson = JSON.parse(readText(root, 'package.json'));
    if (packageJson.devDependencies?.[accessibility.package] !== accessibility.version) {
        fail(`${accessibility.package} must be pinned exactly to ${accessibility.version}`);
    }
    const accessibilitySource = readText(root, accessibility.spec);
    for (const anchor of [
        `from '${accessibility.package}'`,
        `const ACCESSIBILITY_SCAN_SCOPE = '${accessibility.scope}'`,
        'new AxeBuilder({ page })',
        '.include(ACCESSIBILITY_SCAN_SCOPE)',
        '.withTags(ACCESSIBILITY_STANDARD_TAGS)',
    ]) {
        if (!accessibilitySource.includes(anchor)) fail(`${accessibility.spec} lost ${anchor}`);
    }
    for (const tag of accessibility.tags) {
        if (!accessibilitySource.includes(`'${tag}'`)) fail(`${accessibility.spec} lost accessibility tag ${tag}`);
    }

    if (!Array.isArray(resolved.evidenceOwners) || resolved.evidenceOwners.length < 12) {
        fail('the cross-cutting evidence inventory is incomplete');
    }
    for (const owner of resolved.evidenceOwners) {
        const source = readText(root, owner.path);
        for (const anchor of owner.anchors) {
            if (!source.includes(anchor)) fail(`${owner.gate}: ${owner.path} lost ${JSON.stringify(anchor)}`);
        }
    }

    for (const workflow of resolved.ci.pullRequestWorkflows) verifyPullRequestWorkflow(root, workflow);
    const playwright = readText(root, resolved.ci.playwrightConfig);
    if (!playwright.includes("const trace = required || ci || process.env.JF_E2E_TRACE === 'off'")) {
        fail('Playwright tracing must be off for required and CI runs');
    }
    readText(root, resolved.ci.safeArtifactCollector);
    for (const workflow of resolved.ci.artifactWorkflows) {
        const source = readText(root, workflow);
        if (!source.includes(resolved.ci.safeArtifactCollector)) {
            fail(`${workflow} does not collect privacy-safe failure evidence`);
        }
        if (!source.includes('e2e/docker/seed-result.json')) {
            fail(`${workflow} does not bind screenshot evidence to the disposable seed manifest`);
        }
        if (/^\s+path:\s+e2e\/test-results\/?\s*$/m.test(source)) {
            fail(`${workflow} uploads raw Playwright results`);
        }
    }

    return {
        layouts: resolved.scope.supportedModernLayouts.length,
        noOpLayouts: resolved.scope.unsupportedNoOpLayouts.length,
        presets: presets.length,
        evidenceOwners: resolved.evidenceOwners.length,
    };
}

if (require.main === module) {
    try {
        const result = verifyQualityContract();
        console.log(
            `Theme Studio quality contract passed: ${result.layouts} modern layouts, `
            + `${result.noOpLayouts} no-op layouts, ${result.presets} presets, `
            + `${result.evidenceOwners} cross-cutting gate owners.`,
        );
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

module.exports = { verifyQualityContract };
