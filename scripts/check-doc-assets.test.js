'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { auditAssets } = require('./check-doc-assets');

const NOW = new Date('2026-07-16T00:00:00Z');

function policy(overrides = {}) {
    return {
        assetExtensions: ['.apng', '.avif', '.gif', '.mp4', '.png', '.svg', '.webm', '.webp'],
        docsRoot: 'docs',
        allowedExternalAssetPrefixes: [
            'https://raw.githubusercontent.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/',
        ],
        referenceFiles: ['README.md', 'manifest.json', 'mkdocs.yml'],
        referenceDirectories: ['docs', 'theme'],
        referenceExtensions: ['.css', '.html', '.md', '.yml'],
        budgets: {
            documentation: { maxBytes: 100, maxFileBytes: 80 },
            repository: { maxBytes: 120, maxFileBytes: 80 },
        },
        unreferencedAllowlist: [],
        animatedAllowlist: [],
        ...overrides,
    };
}

function fixture(files, callback) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-doc-assets-'));
    try {
        for (const [name, contents] of Object.entries(files)) {
            const destination = path.join(root, name);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, contents);
        }
        callback(root, Object.keys(files));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('live repository assets are referenced, non-animated, and within ratcheted budgets', () => {
    const result = auditAssets();
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.metrics.documentation, {
        files: 55,
        bytes: 26078145,
        largestBytes: 2941758,
    });
    assert.deepEqual(result.metrics.repository, {
        files: 98,
        bytes: 33067531,
        largestBytes: 2941758,
    });
});

test('finds orphaned documentation assets and accepts real README, MkDocs, theme and manifest owners', () => {
    fixture({
        'README.md': [
            '![Readme](docs/images/readme.png)',
            '![Angle destination](<docs/images/angle image.png>)',
            'A near miss: docs/images/orphan.png.backup',
            'An external namesake: https://third-party.invalid/docs/images/orphan.png',
            '',
        ].join('\n'),
        'mkdocs.yml': 'logo: images/logo.png\n',
        'theme/base.html': '<img src="{{ \'images/theme.png\' | url }}">\n',
        'manifest.json': '{"imageUrl":"https://raw.githubusercontent.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/main/docs/images/icon.png"}',
        'docs/images/readme.png': 'a',
        'docs/images/angle image.png': 'f',
        'docs/images/logo.png': 'b',
        'docs/images/theme.png': 'c',
        'docs/images/icon.png': 'd',
        'docs/images/orphan.png': 'e',
    }, (root, trackedFiles) => {
        const result = auditAssets({ root, trackedFiles, policy: policy(), now: NOW });
        assert.deepEqual(result.problems, [
            'docs/images/orphan.png: documentation asset is unreferenced and has no owned, expiring exception',
        ]);
    });
});

test('requires owned expiring exceptions and rejects stale allowlist entries', () => {
    fixture({
        'README.md': '![Used](docs/images/used.png)\n',
        'docs/images/used.png': 'a',
        'docs/images/orphan.png': 'b',
    }, (root, trackedFiles) => {
        const result = auditAssets({
            root,
            trackedFiles,
            now: NOW,
            policy: policy({
                unreferencedAllowlist: [
                    { path: 'docs/images/orphan.png', owner: 'docs', rationale: 'migration evidence', expires: '2026-08-01' },
                    { path: 'docs/images/used.png', owner: 'docs', rationale: 'stale', expires: '2026-08-01' },
                    { path: 'docs/images/missing.png', owner: '', rationale: '', expires: '2026-07-01' },
                    { path: 'docs/images/bad-date.png', owner: 'docs', rationale: 'invalid date', expires: '2026-99-99' },
                    null,
                ],
            }),
        });
        assert.ok(!result.problems.some(problem => problem.startsWith('docs/images/orphan.png:')));
        assert.ok(result.problems.includes('docs/images/used.png: stale unreferenced exception; the asset has a real owner reference'));
        assert.ok(result.problems.some(problem => problem.includes('owner must be a non-empty string')));
        assert.ok(result.problems.some(problem => problem.includes('exception expired on 2026-07-01')));
        assert.ok(result.problems.some(problem => problem.includes('expires must use YYYY-MM-DD')));
        assert.ok(result.problems.includes('unreferencedAllowlist[4]: entry must be an object'));
    });
});

test('enforces aggregate and per-file budgets for all docs paths and repository visual assets', () => {
    fixture({
        'README.md': '![Large](docs/images/large.png)\n',
        'docs/images/large.png': 'x'.repeat(81),
        'docs/orphan.png': 'z'.repeat(30),
        'research/evidence/extra.png': 'y'.repeat(50),
    }, (root, trackedFiles) => {
        const result = auditAssets({ root, trackedFiles, policy: policy(), now: NOW });
        assert.ok(result.problems.includes('documentation asset bytes 111 exceed budget 100'));
        assert.ok(result.problems.includes('docs/images/large.png: 81 bytes exceed documentation per-file budget 80'));
        assert.ok(result.problems.includes('docs/orphan.png: documentation asset is unreferenced and has no owned, expiring exception'));
        assert.ok(result.problems.includes('repository asset bytes 161 exceed budget 120'));
        assert.ok(result.problems.includes('docs/images/large.png: 81 bytes exceed repository per-file budget 80'));
    });
});

test('rejects GIFs and requires accessible evidence for modern animation', () => {
    fixture({
        'README.md': '![Old](docs/images/old.gif)\n',
        'docs/demo.md': '[Demo](images/demo.webm)\n![Still](images/still.png)\nText description beside the demonstration.\n',
        'theme/reduced-motion.css': '@media (prefers-reduced-motion: reduce) { video { display: none; } }\n',
        'docs/images/old.gif': 'GIF89a',
        'docs/images/demo.webm': 'video',
        'docs/images/still.png': 'still',
    }, (root, trackedFiles) => {
        const result = auditAssets({
            root,
            trackedFiles,
            now: NOW,
            policy: policy({
                animatedAllowlist: [{
                    path: 'docs/images/demo.webm',
                    owner: 'docs',
                    rationale: 'interaction demonstration',
                    expires: '2026-08-01',
                    staticAlternative: 'docs/images/still.png',
                    description: 'Text description beside the demonstration.',
                    descriptionSource: 'docs/demo.md',
                    reducedMotionSource: 'theme/reduced-motion.css',
                    reducedMotionEvidence: 'prefers-reduced-motion: reduce',
                }],
            }),
        });
        assert.ok(result.problems.includes(
            'docs/images/old.gif: GIF assets are forbidden; use an accessible modern format with a static alternative',
        ));
        assert.ok(!result.problems.some(problem => problem.startsWith('docs/images/demo.webm: animated asset lacks')));
    });
});

test('requires a real non-animated visual asset as the animation alternative', () => {
    fixture({
        'README.md': '[Demo](docs/images/demo.webm)\n[Other](docs/images/other.webm)\nText description beside the demonstration.\n',
        'theme/reduced-motion.css': '@media (prefers-reduced-motion: reduce) { video { display: none; } }\n',
        'docs/images/demo.webm': 'video',
        'docs/images/other.webm': 'video',
    }, (root, trackedFiles) => {
        const base = {
            path: 'docs/images/demo.webm',
            owner: 'docs',
            rationale: 'interaction demonstration',
            expires: '2026-08-01',
            description: 'Text description beside the demonstration.',
            descriptionSource: 'README.md',
            reducedMotionSource: 'theme/reduced-motion.css',
            reducedMotionEvidence: 'prefers-reduced-motion: reduce',
        };
        const nonAsset = auditAssets({
            root,
            trackedFiles,
            now: NOW,
            policy: policy({ animatedAllowlist: [{ ...base, staticAlternative: 'README.md' }] }),
        });
        assert.ok(nonAsset.problems.includes(
            'docs/images/demo.webm: static alternative is not a tracked regular visual asset: README.md',
        ));

        const animated = auditAssets({
            root,
            trackedFiles,
            now: NOW,
            policy: policy({ animatedAllowlist: [{ ...base, staticAlternative: 'docs/images/other.webm' }] }),
        });
        assert.ok(animated.problems.includes(
            'docs/images/demo.webm: static alternative must be non-animated: docs/images/other.webm',
        ));
    });
});

test('detects PNG/APNG, WebP, SVG and AVIF animation containers', () => {
    const png = Buffer.concat([
        Buffer.from('89504e470d0a1a0a', 'hex'),
        Buffer.from('000000086163544c000000010000000000000000', 'hex'),
    ]);
    const webp = Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.from([4, 0, 0, 0]),
        Buffer.from('WEBP'),
        Buffer.from('ANIM'),
        Buffer.from([0, 0, 0, 0]),
    ]);
    const avif = Buffer.from('00000018667479706176697300000000617669666d696631', 'hex');
    fixture({
        'README.md': [
            '![PNG](docs/images/a.png)',
            '![APNG](docs/images/a.apng)',
            '![WebP](docs/images/b.webp)',
            '![SVG](docs/images/c.svg)',
            '![AVIF](docs/images/d.avif)',
            '',
        ].join('\n'),
        'docs/images/a.png': png,
        'docs/images/a.apng': png,
        'docs/images/b.webp': webp,
        'docs/images/c.svg': '<svg><animate attributeName="opacity" /></svg>',
        'docs/images/d.avif': avif,
    }, (root, trackedFiles) => {
        const result = auditAssets({ root, trackedFiles, policy: policy(), now: NOW });
        assert.equal(result.problems.filter(problem => problem.includes('animated asset lacks')).length, 5);
    });
});

test('rejects asset and reference-source symlinks instead of following them', () => {
    fixture({
        'outside.png': 'asset',
        'outside.md': 'docs/images/linked.png',
    }, (root) => {
        fs.mkdirSync(path.join(root, 'docs', 'images'), { recursive: true });
        fs.symlinkSync(path.join(root, 'outside.png'), path.join(root, 'docs', 'images', 'linked.png'));
        fs.symlinkSync(path.join(root, 'outside.md'), path.join(root, 'README.md'));
        const trackedFiles = ['README.md', 'docs/images/linked.png'];
        const result = auditAssets({ root, trackedFiles, policy: policy(), now: NOW });
        assert.ok(result.problems.includes('docs/images/linked.png: tracked assets must not be symbolic links'));
        assert.ok(result.problems.includes('README.md: reference sources must be regular files, not links'));
    });
});

test('build, release and docs workflows run the shared docs gate that owns live assets', () => {
    const root = path.join(__dirname, '..');
    const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    assert.match(scripts['check:docs'], /node scripts\/check-doc-assets\.js/);
    for (const workflow of ['build.yml', 'release.yml', 'docs.yml']) {
        const source = fs.readFileSync(path.join(root, '.github', 'workflows', workflow), 'utf8');
        assert.match(source, /run: npm run check:docs/);
        assert.doesNotMatch(source, /check:docs[^\n]*\n\s+continue-on-error:/);
    }
});
