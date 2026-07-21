'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    checkMarkdownLinks,
    collectMarkdownFiles,
    headingSlug,
    htmlAttributes,
    markdownAnchors,
    mkdocsHeadingSlug,
    validateMarkdownFile,
} = require('./check-markdown-links');

function fixture(files, callback) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-markdown-links-'));
    try {
        for (const [name, contents] of Object.entries(files)) {
            const destination = path.join(root, name);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, contents);
        }
        callback(root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('live repository Markdown inventory resolves to files and headings', () => {
    assert.deepEqual(checkMarkdownLinks(), []);
    assert.ok(collectMarkdownFiles().includes('CONTRIBUTING.md'));
    assert.ok(collectMarkdownFiles().includes(path.join('docs', 'developers.md')));
    assert.ok(collectMarkdownFiles().includes(path.join('research', 'theme-studio-ecosystem.md')));
});

test('validates relative files, images, MkDocs headings, and duplicate heading slugs', () => {
    fixture({
        'CONTRIBUTING.md': [
            '[Duplicate](docs/guide.md#details_1)',
            '[Explicit](docs/guide.md#stable-id)',
            '[Setext](docs/guide.md#setext-code)',
            '[Inline markup](docs/guide.md#read-the-guide)',
            '[Inline HTML id](docs/guide.md#inline-id)',
            '[Unquoted HTML id](docs/guide.md#unquoted-id)',
            '![Image](docs/pixel.png)',
            '',
        ].join('\n'),
        'docs/guide.md': [
            '# Visible heading {#stable-id}',
            '',
            'Setext `code`',
            '=============',
            '',
            '## Read the [guide](other.md)',
            '',
            '## Details',
            '',
            '## Details',
            '',
            'Text <span id="inline-id"></span>',
            '',
            'Text <span id=unquoted-id></span>',
            '',
        ].join('\n'),
        'docs/pixel.png': 'fixture',
    }, root => assert.deepEqual(validateMarkdownFile('CONTRIBUTING.md', root), []));
});

test('fails closed for missing files, missing headings, and repository escapes', () => {
    fixture({
        'CONTRIBUTING.md': '[Gone](docs/gone.md)\n[Bad heading](docs/guide.md#gone)\n[Escape](../outside.md)\n',
        'docs/guide.md': '# Guide\n',
    }, (root) => {
        const problems = validateMarkdownFile('CONTRIBUTING.md', root);
        assert.equal(problems.length, 3);
        assert.match(problems[0], /target does not exist: docs\/gone\.md/);
        assert.match(problems[1], /heading does not exist: docs\/guide\.md#gone/);
        assert.match(problems[2], /link escapes repository/);
    });
});

test('token parser catches nested labels, angle destinations, and balanced parentheses', () => {
    fixture({
        'CONTRIBUTING.md': [
            '[outer [inner] label](<docs/missing guide.md>)',
            '[Balanced](docs/guide_(copy).md)',
            '',
        ].join('\n'),
        'docs/guide_(copy).md': '# Copy\n',
    }, (root) => {
        const problems = validateMarkdownFile('CONTRIBUTING.md', root);
        assert.equal(problems.length, 1);
        assert.match(problems[0], /target does not exist: docs\/missing%20guide\.md/);
    });
});

test('ignores external links and links shown as code examples', () => {
    fixture({
        'CONTRIBUTING.md': '[Web](https://example.com/missing)\n`[inline](missing.md)`\n```md\n[fenced](missing.md)\n```\n',
    }, root => assert.deepEqual(validateMarkdownFile('CONTRIBUTING.md', root), []));
});

test('validates quoted and unquoted raw HTML links without reserving heading slugs', () => {
    fixture({
        'CONTRIBUTING.md': '<span id=local-id></span>\n[Local](#local-id)\n<img src=docs/missing.png>\n',
    }, (root) => {
        const problems = validateMarkdownFile('CONTRIBUTING.md', root);
        assert.equal(problems.length, 1);
        assert.match(problems[0], /target does not exist: docs\/missing\.png/);
    });
    const anchors = markdownAnchors('# Foo\n\n<span id="foo"></span>\n', 'mkdocs');
    assert.ok(anchors.has('foo'));
    assert.ok(!anchors.has('foo_1'));
    assert.deepEqual(htmlAttributes('<span data-id="ghost" data-src="missing.png" aria-src="nope">'), []);
});

test('supports angle-bracket reference definitions and fails their missing targets', () => {
    fixture({
        'CONTRIBUTING.md': '[Guide][guide]\n[Bad][bad]\n\n[guide]: <docs/guide file.md#setup>\n[bad]: docs/%ZZ.md\n',
        'docs/guide file.md': '# Setup\n',
    }, (root) => {
        const problems = validateMarkdownFile('CONTRIBUTING.md', root);
        assert.equal(problems.length, 1);
        assert.match(problems[0], /target does not exist: docs\/%25ZZ\.md/);
    });
});

test('heading slugs match repository GitHub-style anchors', () => {
    assert.equal(headingSlug('📁 Project Structure'), '-project-structure');
    assert.equal(headingSlug("S1 — Never block Jellyfin's synchronous threads"), 's1--never-block-jellyfins-synchronous-threads');
    assert.equal(mkdocsHeadingSlug("S1 — Never block Jellyfin's synchronous threads"), 's1-never-block-jellyfins-synchronous-threads');
    assert.equal(mkdocsHeadingSlug('Caching & performance'), 'caching-performance');
    assert.equal(mkdocsHeadingSlug('Café déjà vu'), 'cafe-deja-vu');
    assert.deepEqual(
        [...markdownAnchors('# Foo\n\n# Foo\n\n# Foo_1\n\n# Foo_1\n', 'mkdocs')],
        ['foo', 'foo_1', 'foo_2', 'foo_3'],
    );
    assert.deepEqual(
        [...markdownAnchors('# Foo\n\n# Foo\n\n# Foo-1\n\n# Foo-1\n', 'github')],
        ['foo', 'foo-1', 'foo-1-1', 'foo-1-2'],
    );
    assert.deepEqual([...markdownAnchors('# !!!\n\n# ???\n', 'mkdocs')], ['_1', '_2']);
    const explicit = markdownAnchors([
        '# Automatic',
        '',
        '# Later explicit {#automatic}',
        '',
        '# Dotted {#foo.bar}',
        '',
        '# Assigned {id=assigned}',
        '',
        '# Quoted {id="quoted.id"}',
        '',
    ].join('\n'), 'mkdocs');
    assert.ok(explicit.has('automatic'));
    assert.ok(explicit.has('automatic_1'));
    assert.ok(explicit.has('foo.bar'));
    assert.ok(!explicit.has('foo'));
    assert.ok(explicit.has('assigned'));
    assert.ok(explicit.has('quoted.id'));
    assert.deepEqual(
        [...markdownAnchors('Paragraph.\n{: #paragraph-id}\n\n# Paragraph id\n', 'mkdocs')],
        ['paragraph-id', 'paragraph-id_1'],
    );
    assert.deepEqual(
        [...markdownAnchors('# Heading\n{: #heading-id}\n', 'mkdocs')],
        ['heading'],
    );
    assert.deepEqual(
        [...markdownAnchors('Paragraph.\n{: #not-an-id}\nmore text\n', 'mkdocs')],
        [],
    );
});

test('CI, release, and documentation workflows keep the shared docs gate blocking', () => {
    const root = path.join(__dirname, '..');
    const build = fs.readFileSync(path.join(root, '.github', 'workflows', 'build.yml'), 'utf8');
    const release = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    const docs = fs.readFileSync(path.join(root, '.github', 'workflows', 'docs.yml'), 'utf8');
    const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    assert.match(scripts['check:docs'], /node scripts\/check-docs\.js/);
    assert.match(scripts['check:docs'], /python -m mkdocs build --strict -d site/);
    assert.match(build, /run: npm run check:docs/);
    assert.match(release, /run: npm run check:docs/);
    assert.match(docs, /run: npm run check:docs/);
    const client = build.slice(build.indexOf('  client-scripts:'), build.indexOf('  e2e_shard:'));
    assert.match(client, /run: npm run check:docs/);
    assert.doesNotMatch(docs, /continue-on-error:/);
});
