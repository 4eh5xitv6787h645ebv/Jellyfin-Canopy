#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const contractPath = path.join(
    root,
    'Jellyfin.Plugin.JellyfinCanopy/src/theme-studio/jellyfin-web-theme.contract.json'
);

function fail(message) {
    throw new Error(`Jellyfin Web theme contract: ${message}`);
}

function git(repo, args) {
    return childProcess.execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
    });
}

function digest(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function assertIncludes(source, fragment, file) {
    if (!source.includes(fragment)) fail(`${file} no longer contains ${JSON.stringify(fragment)}`);
}

function verifySemantics(contract, sources) {
    const themeIndex = sources['src/themes/index.ts'];
    assertIncludes(themeIndex, `cssVarPrefix: '${contract.mui.cssVariablePrefix}'`, 'src/themes/index.ts');
    assertIncludes(
        themeIndex,
        `colorSchemeSelector: '${contract.mui.colorSchemeSelector}'`,
        'src/themes/index.ts'
    );
    assertIncludes(
        themeIndex,
        `defaultColorScheme: '${contract.mui.defaultColorScheme}'`,
        'src/themes/index.ts'
    );
    const importedThemes = [...themeIndex.matchAll(/^import\s+([a-z0-9]+)\s+from\s+'\.\/([a-z0-9]+)';$/gm)]
        .filter(match => match[1] === match[2])
        .map(match => match[1])
        .sort();
    const contractedThemes = Object.keys(contract.builtInThemes).sort();
    if (JSON.stringify(importedThemes) !== JSON.stringify(contractedThemes)) {
        fail(`built-in themes drifted (source ${importedThemes.join(', ')}; contract ${contractedThemes.join(', ')})`);
    }

    const manager = sources['src/scripts/themeManager.js'];
    assertIncludes(
        manager,
        `document.documentElement.setAttribute('${contract.hostOwnership.themeAttribute}', info.id)`,
        'src/scripts/themeManager.js'
    );
    assertIncludes(manager, 'EventType.THEME_CHANGE', 'src/scripts/themeManager.js');

    const themeCss = sources['src/components/ThemeCss.tsx'];
    assertIncludes(themeCss, 'const id = dashboard ? dashboardTheme : theme;', 'src/components/ThemeCss.tsx');
    const automatic = sources['src/scripts/autoThemes.js'];
    assertIncludes(
        automatic,
        `skinManager.setTheme(userSettings.${contract.hostOwnership.dashboardPreference}())`,
        'src/scripts/autoThemes.js'
    );
    assertIncludes(
        automatic,
        `skinManager.setTheme(userSettings.theme())`,
        'src/scripts/autoThemes.js'
    );
}

function verifyRepository(repo, ref) {
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    const origin = git(repo, ['remote', 'get-url', 'origin']).trim().replace(/\.git$/, '');
    if (!/^https:\/\/github\.com\/jellyfin\/jellyfin-web$/i.test(origin)
        && !/^git@github\.com:jellyfin\/jellyfin-web$/i.test(origin)) {
        fail(`source origin is not jellyfin/jellyfin-web: ${origin}`);
    }
    git(repo, ['cat-file', '-e', `${ref}^{commit}`]);
    const sources = {};
    for (const [file, expected] of Object.entries(contract.sources)) {
        const source = git(repo, ['show', `${ref}:${file}`]);
        const actual = digest(source);
        if (ref === contract.commit && actual !== expected) {
            fail(`${file} digest ${actual} does not match pinned ${expected}`);
        }
        sources[file] = source;
    }
    verifySemantics(contract, sources);
    return { contract, ref };
}

if (require.main === module) {
    const repo = process.argv[2] || process.env.JELLYFIN_WEB_SOURCE;
    if (!repo) {
        console.error('Usage: node scripts/check-jellyfin-web-theme-contract.js <jellyfin-web checkout> [ref]');
        process.exitCode = 2;
    } else {
        try {
            const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
            const ref = process.argv[3] || contract.commit;
            const result = verifyRepository(path.resolve(repo), ref);
            console.log(`Jellyfin Web theme contract matches ${result.ref}.`);
        } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    }
}

module.exports = { verifyRepository, verifySemantics };
