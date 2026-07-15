#!/usr/bin/env node
'use strict';

/**
 * Blocking syntax inventory for every independently executed source script.
 *
 * Generated dist/ files are deliberately absent: the blocking esbuild bundle
 * owns them. Raw js/ resources, the separately served admin script, and every
 * executable inline admin-page body are parsed directly by Node before build
 * or release packaging can succeed.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JAVASCRIPT_MIME_ESSENCES = new Set([
    'application/ecmascript',
    'application/javascript',
    'application/x-ecmascript',
    'application/x-javascript',
    'text/ecmascript',
    'text/javascript',
    'text/javascript1.0',
    'text/javascript1.1',
    'text/javascript1.2',
    'text/javascript1.3',
    'text/javascript1.4',
    'text/javascript1.5',
    'text/jscript',
    'text/livescript',
    'text/x-ecmascript',
    'text/x-javascript',
]);

function createInventory(root = ROOT) {
    const plugin = path.join(root, 'Jellyfin.Plugin.JellyfinCanopy');
    return {
        pluginRoot: plugin,
        classes: [{
            id: 'raw-served-js',
            label: 'raw served js/**',
            kind: 'directory',
            path: path.join(plugin, 'js'),
            minimumBodies: 1,
        },
        {
            id: 'admin-served-js',
            label: 'served admin JavaScript',
            kind: 'file',
            path: path.join(plugin, 'Configuration', 'config-page.js'),
        },
        {
            id: 'admin-inline-js',
            label: 'executable configPage.html inline JavaScript',
            kind: 'html-inline',
            path: path.join(plugin, 'Configuration', 'configPage.html'),
            expectedBodies: 2,
        }],
    };
}

function collectJsFiles(directory) {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
        throw new Error(`syntax inventory directory is missing: ${directory}`);
    }
    return fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .flatMap((entry) => {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) return collectJsFiles(full);
            return entry.isFile() && /\.[cm]?js$/i.test(entry.name) ? [full] : [];
        });
}

function collectFiles(directory, predicate, excludedDirectories = new Set()) {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .flatMap((entry) => {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                return excludedDirectories.has(entry.name)
                    ? []
                    : collectFiles(full, predicate, excludedDirectories);
            }
            return entry.isFile() && predicate(full) ? [full] : [];
        });
}

function readAttribute(attributes, name) {
    const assigned = attributes.match(new RegExp(
        `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
        'i',
    ));
    if (assigned) {
        return { present: true, value: assigned[1] ?? assigned[2] ?? assigned[3] ?? '' };
    }
    const bare = new RegExp(`(?:^|\\s)${name}(?=\\s|$)`, 'i').test(attributes);
    return { present: bare, value: '' };
}

function executableScriptMode(attributes) {
    if (readAttribute(attributes, 'src').present) return null;
    const type = readAttribute(attributes, 'type');
    if (!type.present || type.value.trim() === '') return 'script';
    const normalized = type.value.trim().toLowerCase();
    if (normalized === 'module') return 'module';
    const essence = normalized.split(';', 1)[0].trim();
    return JAVASCRIPT_MIME_ESSENCES.has(essence) ? 'script' : null;
}

function extractInlineScripts(html, file) {
    const scripts = [];
    const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script(?:\s[^>]*)?>/gi;
    let match;
    let index = 0;
    while ((match = pattern.exec(html)) !== null) {
        index += 1;
        const mode = executableScriptMode(match[1]);
        if (mode) {
            scripts.push({
                name: `${file}#script-${index}`,
                source: match[2],
                mode,
            });
        }
    }
    return scripts;
}

function collectInventory(inventory) {
    const ids = new Set();
    return inventory.map((entry) => {
        if (!entry.id || ids.has(entry.id)) {
            throw new Error(`syntax inventory has a missing or duplicate class id: ${entry.id || '(empty)'}`);
        }
        ids.add(entry.id);
        let bodies;
        if (entry.kind === 'directory') {
            bodies = collectJsFiles(entry.path).map((file) => ({
                name: file,
                source: fs.readFileSync(file, 'utf8'),
                mode: file.toLowerCase().endsWith('.mjs') ? 'module' : 'script',
            }));
            if (bodies.length < entry.minimumBodies) {
                throw new Error(`${entry.id} shrank to ${bodies.length} bodies; expected at least ${entry.minimumBodies}`);
            }
        } else if (entry.kind === 'file') {
            if (!fs.existsSync(entry.path) || !fs.statSync(entry.path).isFile()) {
                throw new Error(`syntax inventory file is missing: ${entry.path}`);
            }
            bodies = [{ name: entry.path, source: fs.readFileSync(entry.path, 'utf8'), mode: 'script' }];
        } else if (entry.kind === 'html-inline') {
            if (!fs.existsSync(entry.path) || !fs.statSync(entry.path).isFile()) {
                throw new Error(`syntax inventory HTML is missing: ${entry.path}`);
            }
            bodies = extractInlineScripts(fs.readFileSync(entry.path, 'utf8'), entry.path);
            if (bodies.length !== entry.expectedBodies) {
                throw new Error(
                    `${entry.id} contains ${bodies.length} executable inline scripts; expected ${entry.expectedBodies}. `
                    + 'Review the shipped-script census and update the explicit inventory.',
                );
            }
        } else {
            throw new Error(`syntax inventory class ${entry.id} has unsupported kind ${entry.kind}`);
        }
        return { id: entry.id, label: entry.label, bodies };
    });
}

function validateSourceCensus(inventory, classes) {
    const normalized = (file) => path.resolve(file);
    const accountedJs = new Set(classes.flatMap((artifactClass) => artifactClass.bodies)
        .filter((body) => !body.name.includes('#script-') && /\.[cm]?js$/i.test(body.name))
        .map((body) => normalized(body.name)));
    const shippedJs = collectFiles(
        inventory.pluginRoot,
        (file) => /\.[cm]?js$/i.test(file),
        new Set(['bin', 'dist', 'obj']),
    ).map(normalized);
    const missingJs = shippedJs.filter((file) => !accountedJs.has(file));
    if (missingJs.length > 0) {
        throw new Error(`shipped source JavaScript is absent from the syntax inventory: ${missingJs.join(', ')}`);
    }

    const inventoriedHtml = new Set(inventory.classes
        .filter((entry) => entry.kind === 'html-inline')
        .map((entry) => normalized(entry.path)));
    const htmlWithInlineScripts = collectFiles(
        inventory.pluginRoot,
        (file) => /\.html?$/i.test(file),
        new Set(['bin', 'dist', 'obj']),
    ).filter((file) => extractInlineScripts(fs.readFileSync(file, 'utf8'), file).length > 0);
    const missingHtml = htmlWithInlineScripts.filter((file) =>
        !inventoriedHtml.has(normalized(file)));
    if (missingHtml.length > 0) {
        throw new Error(`executable inline HTML is absent from the syntax inventory: ${missingHtml.join(', ')}`);
    }
}

function checkClasses(classes, nodePath = process.execPath) {
    const failures = [];
    for (const artifactClass of classes) {
        for (const body of artifactClass.bodies) {
            const args = body.mode === 'module' ? ['--check', '--input-type=module'] : ['--check'];
            const result = spawnSync(nodePath, args, {
                input: body.source,
                encoding: 'utf8',
                maxBuffer: 10 * 1024 * 1024,
            });
            if (result.error) {
                throw new Error(`could not run Node syntax parser for ${body.name}: ${result.error.message}`);
            }
            if (result.status !== 0) {
                failures.push({
                    classId: artifactClass.id,
                    name: body.name,
                    message: result.stderr || result.stdout || `node --check exited ${result.status}`,
                });
            }
        }
    }
    return failures;
}

function formatSummary(classes, cwd = process.cwd()) {
    const lines = classes.map((artifactClass) => {
        const names = artifactClass.bodies.map((body) => path.relative(cwd, body.name)).join(', ');
        return `- ${artifactClass.id}: ${artifactClass.bodies.length} (${artifactClass.label}) — ${names}`;
    });
    const total = classes.reduce((sum, artifactClass) => sum + artifactClass.bodies.length, 0);
    return `Syntax inventory OK:\n${lines.join('\n')}\nTotal: ${total} independently executed JavaScript bodies.`;
}

function main() {
    try {
        const inventory = createInventory();
        const classes = collectInventory(inventory.classes);
        validateSourceCensus(inventory, classes);
        const failures = checkClasses(classes);
        if (failures.length > 0) {
            for (const failure of failures) {
                console.error(`SYNTAX ERROR [${failure.classId}]: ${path.relative(process.cwd(), failure.name)}\n${failure.message}`);
            }
            const total = classes.reduce((sum, artifactClass) => sum + artifactClass.bodies.length, 0);
            console.error(`${failures.length} of ${total} inventoried JavaScript bodies failed syntax check.`);
            process.exit(1);
        }
        console.log(formatSummary(classes));
    } catch (error) {
        console.error(`SYNTAX INVENTORY ERROR: ${error.message}`);
        process.exit(2);
    }
}

if (require.main === module) main();

module.exports = {
    checkClasses,
    collectInventory,
    createInventory,
    executableScriptMode,
    extractInlineScripts,
    formatSummary,
    validateSourceCensus,
};
