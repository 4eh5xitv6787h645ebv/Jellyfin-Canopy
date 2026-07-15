'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    ALLOW_GITHUB,
    buildIndexFromSources,
    formatViolations,
    runGuard,
    validateIndex,
} = require('./check-performance-rules');

const ROOT = path.join(__dirname, '..');

function cleanIndex(files = 101) {
    return {
        files,
        parses: files,
        traversals: files,
        r3: [],
        r5: [],
        github: [],
        assets: [],
    };
}

function cpuTimer(cpuMs) {
    let started = false;
    return (previous) => {
        if (!started) {
            assert.equal(previous, undefined);
            started = true;
            return { user: 0, system: 0 };
        }
        assert.deepEqual(previous, { user: 0, system: 0 });
        return { user: cpuMs * 1_000, system: 0 };
    };
}

test('one AST traversal records precise R3, R5, and R6 diagnostics', () => {
    const index = buildIndexFromSources([
        {
            rel: 'r3.ts',
            source: [
                'const observer = new MutationObserver(() => {});',
                'observer.observe(document.body, { attributes: true });',
            ].join('\n'),
        },
        {
            rel: 'enhanced/hidden-content-page/nav.ts',
            source: 'window.setInterval(() => {}, 1000);',
        },
        {
            rel: 'r6.ts',
            source: [
                "const github = 'https://api.github.com/repos/example/project';",
                'const asset = `url(assets/img/icon.png)`;',
            ].join('\n'),
        },
    ]);

    assert.equal(index.files, 3);
    assert.equal(index.parses, 3);
    assert.equal(index.traversals, 3);
    assert.match(formatViolations(index.r3), /r3\.ts:2 {2}body-wide MutationObserver/);
    assert.match(
        formatViolations(index.r5),
        /enhanced\/hidden-content-page\/nav\.ts:1 {2}setInterval nav-polling/
    );
    assert.match(formatViolations(index.github), /r6\.ts:1 {2}api\.github\.com/);
    assert.match(formatViolations(index.assets), /r6\.ts:2 {2}url\(assets\/img\//);

    const problems = validateIndex(index, {
        allowGithub: [],
        allowAssets: [],
        minSourceFiles: 0,
    }).join('\n');
    assert.match(problems, /Body-wide attribute MutationObserver \(R3\)/);
    assert.match(problems, /setInterval nav-polling \(R5\)/);
    assert.match(problems, /api\.github\.com literal \(R6\)/);
    assert.match(problems, /url\(assets\/img\/ literal \(R6\)/);
});

test('allowlist freshness remains part of the guard contract', () => {
    const index = cleanIndex();
    assert.match(
        validateIndex(index).join('\n'),
        /stale ALLOW_GITHUB: enhanced\/settings-panel\/release-notes\.ts/
    );

    index.github.push({
        file: ALLOW_GITHUB[0].file,
        line: 1,
        detail: 'api.github.com',
    });
    assert.deepEqual(validateIndex(index), []);
});

test('the reviewed CPU threshold is strict without sleeping or widening the budget', () => {
    const options = {
        budgetMs: 5_000,
        indexBuilder: () => cleanIndex(),
        validation: { allowGithub: [], allowAssets: [] },
    };
    assert.deepEqual(
        runGuard({ ...options, threadCpuUsage: cpuTimer(4_999) }).problems,
        []
    );
    assert.match(
        runGuard({ ...options, threadCpuUsage: cpuTimer(5_000) }).problems.join('\n'),
        /used 5000ms CPU; budget is strictly below 5000ms/
    );
});

test('CI and release invoke the isolated performance guard as a blocking gate', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(
        packageJson.scripts?.['check:performance-rules'],
        'node scripts/check-performance-rules.js'
    );
    for (const workflow of ['build.yml', 'release.yml']) {
        const source = fs.readFileSync(path.join(ROOT, '.github', 'workflows', workflow), 'utf8');
        assert.match(
            source,
            /- name: Client performance architecture guard \(isolated CPU budget\)\n\s+run: npm run check:performance-rules/
        );
    }
});
