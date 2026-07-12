#!/usr/bin/env node
'use strict';

/**
 * Syntax-checks every client script with `node --check`.
 *
 * The plugin serves js/ files raw to the browser — there is no bundler to
 * catch a parse error, and a stray backtick inside the CSS-in-template-literal
 * blocks breaks a module silently at runtime. This script is the CI gate for
 * that class of mistake.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const JS_ROOT = path.join(__dirname, '..', 'Jellyfin.Plugin.JellyfinCanopy', 'js');

/** Recursively collect .js files under a directory. */
function collectJsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return collectJsFiles(full);
        }
        return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
    });
}

const files = collectJsFiles(JS_ROOT);
const failures = [];

for (const file of files) {
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
        failures.push({ file, message: err.stderr ? err.stderr.toString() : String(err) });
    }
}

if (failures.length > 0) {
    for (const { file, message } of failures) {
        console.error(`SYNTAX ERROR: ${path.relative(process.cwd(), file)}\n${message}`);
    }
    console.error(`${failures.length} of ${files.length} files failed syntax check.`);
    process.exit(1);
}

console.log(`Syntax OK: ${files.length} files.`);
