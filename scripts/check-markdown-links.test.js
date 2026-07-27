'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    checkMarkdownLinks,
    collectMarkdownFiles,
    extractLinks,
    extractRenderedHtmlLinks,
    headingSlug,
    htmlAttributes,
    isActionableLink,
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

test('ignores Markdown-in-HTML links in comments and code examples', () => {
    const source = [
        '<!-- <div markdown="1">[Comment](missing-comment.md)</div> -->',
        '',
        '```md',
        '<div markdown="1">[Fenced](missing-fenced.md)</div>',
        '```',
        '',
        '`<span markdown="1">[Inline](missing-inline.md)</span>`',
        '',
        '<pre><code><div markdown="1">[HTML code](missing-html-code.md)</div></code></pre>',
        '',
    ].join('\n');
    assert.deepEqual(extractLinks(source), []);
    fixture({ 'CONTRIBUTING.md': source }, root => (
        assert.deepEqual(validateMarkdownFile('CONTRIBUTING.md', root), [])
    ));
});

test('extracts browser-equivalent links without treating images or empty anchors as actions', () => {
    const nonActions = extractLinks([
        '![Image](https://github.com/owner/repository/issues)',
        '[](https://github.com/owner/repository/issues)',
        '',
    ].join('\n'));
    const browserForms = extractLinks([
        'www.github.com/owner/repository/discussions',
        '<a href="https&colon;//github.com/owner/repository/issues/../discussions">Entity</a>',
        '',
    ].join('\n'));

    assert.deepEqual([...nonActions, ...browserForms].map(link => ({
        target: link.target,
        line: link.line,
        type: link.type,
        label: link.label,
        actionable: isActionableLink(link),
    })), [
        {
            target: 'https://github.com/owner/repository/issues',
            line: 1,
            type: 'image',
            label: 'Image',
            actionable: false,
        },
        {
            target: 'https://github.com/owner/repository/issues',
            line: 2,
            type: 'link',
            label: '',
            actionable: false,
        },
        {
            target: 'http://www.github.com/owner/repository/discussions',
            line: 1,
            type: 'link',
            label: 'www.github.com/owner/repository/discussions',
            actionable: true,
        },
        {
            target: 'https://github.com/owner/repository/issues/../discussions',
            line: 2,
            type: 'link',
            label: 'Entity',
            actionable: true,
        },
    ]);
    assert.deepEqual(extractLinks(
        '<!-- [Hidden](https://github.com/owner/repository/issues)'
    ), []);
});

test('decodes raw HTML labels and records each link rendered container text', () => {
    const links = extractLinks([
        'For support, [click here](https://github.com/owner/repository/issues).',
        '',
        '<div><a href="https://github.com/owner/repository/issues">Ask for supp&#111;rt</a></div>',
        '',
    ].join('\n'));
    assert.deepEqual(links.map(link => ({
        label: link.label,
        context: link.context,
    })), [
        {
            label: 'click here',
            context: 'For support, click here.',
        },
        {
            label: 'Ask for support',
            context: 'Ask for support',
        },
    ]);
});

test('records each link position and scans quoted HTML delimiters before href', () => {
    const links = extractLinks([
        '[same](https://example.com/one). For support, [same](https://example.com/two).',
        '',
        '<a title="1 > 0" href="https://example.com/three">Ask for support</a>',
        '',
    ].join('\n'));
    assert.deepEqual(links.map(link => ({
        target: link.target,
        label: link.label,
        before: link.contextBefore,
        after: link.contextAfter,
    })), [
        {
            target: 'https://example.com/one',
            label: 'same',
            before: '',
            after: '. For support, same.',
        },
        {
            target: 'https://example.com/two',
            label: 'same',
            before: 'same. For support,',
            after: '.',
        },
        {
            target: 'https://example.com/three',
            label: 'Ask for support',
            before: '',
            after: '',
        },
    ]);
    assert.equal(isActionableLink(links[2]), true);
});

test('raw HTML link context excludes neighboring link labels but retains prose', () => {
    const source = [
        '<nav><a href="https://example.com/one">GitHub</a>',
        '<a href="https://example.com/two">Discord</a>',
        '<a href="https://example.com/three">Report an issue</a></nav>',
        '<p>Before <a href="https://example.com/four">Four</a> between ',
        '<a href="https://example.com/five">Five</a> after.</p>',
    ].join('');
    for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
        assert.deepEqual(links.map(link => ({
            label: link.label,
            before: link.contextBefore,
            priorBefore: link.contextBeforePrior,
            after: link.contextAfter,
            beforeStartsAtLink: link.contextBeforeStartsAtLink,
            afterEndsAtLink: link.contextAfterEndsAtLink,
        })), [
            {
                label: 'GitHub',
                before: '',
                priorBefore: '',
                after: '',
                beforeStartsAtLink: false,
                afterEndsAtLink: true,
            },
            {
                label: 'Discord',
                before: '',
                priorBefore: '',
                after: '',
                beforeStartsAtLink: true,
                afterEndsAtLink: true,
            },
            {
                label: 'Report an issue',
                before: '',
                priorBefore: '',
                after: '',
                beforeStartsAtLink: true,
                afterEndsAtLink: false,
            },
            {
                label: 'Four',
                before: 'Before',
                priorBefore: '',
                after: 'between',
                beforeStartsAtLink: false,
                afterEndsAtLink: true,
            },
            {
                label: 'Five',
                before: 'between',
                priorBefore: 'Before',
                after: 'after.',
                beforeStartsAtLink: true,
                afterEndsAtLink: false,
            },
        ]);
    }
});

test('hidden raw HTML and Markdown-in-HTML links are not actionable', () => {
    const links = extractLinks([
        '<a hidden href="https://example.com/hidden">Hidden</a>',
        '<a aria-hidden="true" href="https://example.com/aria-hidden">ARIA hidden</a>',
        '<a style="display:none" href="https://example.com/css-hidden">CSS hidden</a>',
        '<div hidden><a href="https://example.com/ancestor-hidden">Ancestor hidden</a></div>',
        '<span hidden>[Markdown hidden](https://example.com/markdown-hidden)</span>',
        '<a href="https://example.com/visible">Visible</a>',
        '',
    ].join('\n'));
    assert.deepEqual(links.filter(isActionableLink).map(link => link.label), ['Visible']);
    assert.ok(links.filter(link => link.label !== 'Visible').every(link => link.hidden));
});

test('extracts every MkDocs markdown-in-HTML mode and image-only accessible names', () => {
    const links = extractLinks([
        '<div markdown="1">',
        '[Ask for support](https://github.com/owner/repository/discussions)',
        '</div>',
        '',
        '<div markdown="block">',
        '[Report a bug](https://github.com/owner/repository/issues/new?template=bug.md)',
        '</div>',
        '',
        '<span markdown="span">',
        '[Request a feature](https://github.com/owner/repository/issues/new?template=feature.md)',
        '</span>',
        '',
        '<section markdown>',
        '[Submit privately](https://github.com/owner/repository/security/advisories/new)',
        '</section>',
        '',
        '<a href="https://discord.gg/example"><img alt="Report bugs" src="pixel.png"></a>',
        '',
    ].join('\n'));
    assert.deepEqual(
        links.filter(link => link.type === 'link')
            .map(link => ({ label: link.label, line: link.line }))
            .sort((left, right) => left.line - right.line),
        [
            { label: 'Ask for support', line: 2 },
            { label: 'Report a bug', line: 6 },
            { label: 'Request a feature', line: 10 },
            { label: 'Submit privately', line: 14 },
            { label: 'Report bugs', line: 17 },
        ]
    );
});

test('resolves aria-labelledby accessible names in source and rendered HTML', () => {
    const source = [
        '<span id="security-route-label">Submit a vulnerability report</span>',
        '<a aria-labelledby="security-route-label" href="https://github.com/owner/repository/issues">',
        '  <svg aria-hidden="true"></svg>',
        '</a>',
        '',
    ].join('\n');
    for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
        const link = links.find(candidate => candidate.type === 'link');
        assert.ok(link);
        assert.equal(link.label, 'Submit a vulnerability report');
        assert.equal(isActionableLink(link), true);
    }
});

test('extracts accessible names from nested SVG and labelled images', () => {
    const source = [
        '<span id="image-security-label">Submit a vulnerability report</span>',
        '<a href="https://github.com/owner/repository/issues">',
        '  <svg role="img" aria-label="Submit a vulnerability report"></svg>',
        '</a>',
        '<a href="https://github.com/owner/repository/issues/new">',
        '  <img src="shield.png" aria-labelledby="image-security-label">',
        '</a>',
        '',
    ].join('\n');
    for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
        const actionable = links.filter(link => link.type === 'link');
        assert.deepEqual(
            actionable.map(link => link.label),
            ['Submit a vulnerability report', 'Submit a vulnerability report']
        );
        assert.ok(actionable.every(isActionableLink));
    }
});

test('extracts accessible names from generic labelled HTML descendants', () => {
    const source = [
        '<a href="https://github.com/owner/repository/issues">',
        '  <span role="img" aria-label="Submit a vulnerability report"></span>',
        '</a>',
        '<a href="https://github.com/owner/repository/issues/new">',
        '  <i aria-label="Submit a vulnerability report"></i>',
        '</a>',
        '',
    ].join('\n');
    for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
        const actionable = links.filter(link => link.type === 'link');
        assert.deepEqual(
            actionable.map(link => link.label),
            ['Submit a vulnerability report', 'Submit a vulnerability report']
        );
        assert.ok(actionable.every(isActionableLink));
    }
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
