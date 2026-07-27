'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const {
    checkMarkdownLinks,
    collectMarkdownFiles,
    extractLinks,
    extractRenderedHtmlLinks,
    governedHtmlText,
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
            after: '. For support,',
        },
        {
            target: 'https://example.com/two',
            label: 'same',
            before: '. For support,',
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

test('Markdown link context excludes neighboring labels but retains prose', () => {
    const sources = [
        'Before [One](https://example.com/one) between '
            + '[Two](https://example.com/two) after.',
        'Before <a href="https://example.com/one">One</a> between '
            + '<a href="https://example.com/two">Two</a> after.',
    ];
    for (const source of sources) {
        const links = extractLinks(source);
        assert.deepEqual(links.map(link => ({
            label: link.label,
            before: link.contextBefore,
            priorBefore: link.contextBeforePrior,
            after: link.contextAfter,
            beforeStartsAtLink: link.contextBeforeStartsAtLink,
            afterEndsAtLink: link.contextAfterEndsAtLink,
        })), [
            {
                label: 'One',
                before: 'Before',
                priorBefore: '',
                after: 'between',
                beforeStartsAtLink: false,
                afterEndsAtLink: true,
            },
            {
                label: 'Two',
                before: 'between',
                priorBefore: 'Before',
                after: 'after.',
                beforeStartsAtLink: true,
                afterEndsAtLink: false,
            },
        ]);
    }
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

test('visually hidden links are not actionable but aria-hidden links remain clickable', () => {
    const links = extractLinks([
        '<a hidden href="https://example.com/hidden">Hidden</a>',
        '<a aria-hidden="true" href="https://example.com/aria-hidden">ARIA hidden</a>',
        '<a aria-hidden="tr&#117;e" href="https://example.com/entity-aria-hidden">Entity ARIA hidden</a>',
        '<a aria-hidden=tr&#117;e href="https://example.com/unquoted-entity-aria-hidden">Unquoted entity ARIA hidden</a>',
        '<a style="display:none" href="https://example.com/css-hidden">CSS hidden</a>',
        '<a style=display:none href="https://example.com/unquoted-hidden">Unquoted hidden</a>',
        '<a style=visibility:hidden href="https://example.com/unquoted-invisible">Unquoted invisible</a>',
        '<a style="display&#58;none" href="https://example.com/entity-hidden">Entity hidden</a>',
        '<div hidden><a href="https://example.com/ancestor-hidden">Ancestor hidden</a></div>',
        '<span hidden>[Markdown hidden](https://example.com/markdown-hidden)</span>',
        '<div hidden markdown="1">',
        '[Markdown-in-HTML hidden](https://example.com/markdown-in-html-hidden)',
        '</div>',
        '<a href="https://example.com/visible">Visible</a>',
        '',
    ].join('\n'));
    assert.deepEqual(links.filter(isActionableLink).map(link => link.label), [
        'ARIA hidden',
        'Entity ARIA hidden',
        'Unquoted entity ARIA hidden',
        'Visible',
    ]);
    const visuallyHidden = new Set([
        'Hidden',
        'CSS hidden',
        'Unquoted hidden',
        'Unquoted invisible',
        'Entity hidden',
        'Ancestor hidden',
        'Markdown hidden',
        'Markdown-in-HTML hidden',
    ]);
    assert.ok(links.filter(link => visuallyHidden.has(link.label)).every(link => link.hidden));
});

test('retains visually rendered route text inside aria-hidden descendants', () => {
    const source = [
        '<a href="https://example.com/route">',
        '  <span aria-hidden="true">Report a problem</span>',
        '</a>',
        '<a href="https://example.com/icon">',
        '  <svg aria-hidden="true" aria-label="Invisible route label"></svg>',
        '</a>',
        '',
    ].join('\n');
    for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
        const routes = links.filter(link => link.type === 'link');
        assert.equal(routes[0].label, 'Report a problem');
        assert.equal(isActionableLink(routes[0]), true);
        assert.equal(routes[1].label, '');
        assert.equal(isActionableLink(routes[1]), false);
    }

    const paintedSvg = [
        '<a href="https://example.com/painted">',
        '  <svg aria-hidden="true"><text>Report a problem</text></svg>',
        '</a>',
        '',
    ].join('\n');
    for (const links of [extractLinks(paintedSvg), extractRenderedHtmlLinks(paintedSvg)]) {
        const link = links.find(candidate => candidate.type === 'link');
        assert.equal(link.label, 'Report a problem');
        assert.equal(isActionableLink(link), true);
    }

    for (const hiddenMetadata of [
        '<svg aria-hidden="true" aria-label="Report a problem"></svg>',
        '<svg aria-hidden="true"><title>Report a problem</title></svg>',
    ]) {
        const raw = `<a href="https://example.com/metadata">${hiddenMetadata}</a>`;
        const markdownLink = `[${hiddenMetadata}](https://example.com/metadata)`;
        for (const links of [extractLinks(raw), extractRenderedHtmlLinks(raw), extractLinks(markdownLink)]) {
            const link = links.find(candidate => candidate.type === 'link');
            assert.equal(link.label, '');
            assert.equal(isActionableLink(link), false);
        }
    }
});

test('inline style visibility follows declaration order and importance', () => {
    for (const [style, hidden] of [
        ['display:none;display:inline', false],
        ['visibility:hidden;visibility:visible', false],
        ['display:none!important;display:inline', true],
        ['display:none;display:inline!important', false],
        ['display:none!important;display:inline!important', false],
        ['display:none;display:invalid', true],
    ]) {
        const source = `<a style="${style}" href="https://example.com/route">Route</a>`;
        for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
            const link = links.find(candidate => candidate.type === 'link');
            assert.ok(link, style);
            assert.equal(link.hidden, hidden, style);
            assert.equal(isActionableLink(link), !hidden, style);
        }
    }
});

test('repairs malformed nested anchors into independently actionable links', () => {
    for (const ending of ['</a></a>', '']) {
        const source = '<a href="https://example.com/private">'
            + 'Submit a private vulnerability report '
            + `<a href="https://example.com/public">here${ending}`;
        for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
            const actionable = links.filter(isActionableLink);
            assert.deepEqual(
                actionable.map(link => ({ target: link.target, label: link.label })),
                [
                    {
                        target: 'https://example.com/private',
                        label: 'Submit a private vulnerability report',
                    },
                    { target: 'https://example.com/public', label: 'here' },
                ],
                ending || 'unclosed'
            );
            assert.match(actionable[1].contextBefore, /private vulnerability report/i);
        }
    }
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

test('aria-labelledby includes directly referenced hidden nodes but ignores inert IDs', () => {
    const target = 'https://example.com/route';
    for (const referenced of [
        '<svg aria-hidden="true"><title id="route-name">Report a problem</title></svg>',
        '<svg aria-hidden="true"><desc id="route-name">Report a problem</desc></svg>',
        '<svg aria-hidden="true"><g id="route-name" aria-label="Report a problem"></g></svg>',
        '<svg aria-hidden="true"><g id="route-name" title="Report a problem"></g></svg>',
        '<div hidden><svg id="route-name" aria-label="Report a problem"></svg></div>',
        '<div style="display:none"><span id="route-name">'
            + '<svg aria-label="Report a problem"></svg></span></div>',
        '<div hidden><span id="route-name" style="visibility:visible">'
            + 'Report a problem</span></div>',
        '<div style="display:none"><svg style="visibility:visible">'
            + '<text id="route-name">Report a problem</text></svg></div>',
        '<div style="visibility:hidden"><span id="route-name">'
            + 'Report a problem</span></div>',
        '<svg style="visibility:hidden"><text id="route-name">'
            + 'Report a problem</text></svg>',
        '<div style="visibility:hidden"><svg><text id="route-name">'
            + 'Report a problem</text></svg></div>',
        '<svg style="visibility:hidden"><title id="route-name">'
            + 'Report a problem</title></svg>',
        '<svg style="visibility:hidden"><desc id="route-name">'
            + 'Report a problem</desc></svg>',
        '<script>const template = \'<span id="route-name">Report a problem</span>\';'
            + '</script>',
    ]) {
        const source = referenced
            + `<a aria-labelledby="route-name" href="${target}"></a>`;
        const inert = referenced.startsWith('<script>');
        for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
            const link = links.find(candidate => candidate.type === 'link');
            assert.ok(link, referenced);
            assert.equal(link.label, inert ? '' : 'Report a problem', referenced);
            assert.equal(isActionableLink(link), !inert, referenced);
        }
    }

    for (const referenced of [
        '<svg aria-hidden="true"><text id="route-name">Report a problem</text></svg>',
        '<div aria-hidden="true"><span id="route-name">'
            + '<svg><text>Report a problem</text></svg></span></div>',
        '<div style="visibility:hidden"><span id="route-name" '
            + 'style="visibility:visible">Report a problem</span></div>',
        '<div style="visibility:hidden"><svg style="visibility:visible">'
            + '<text id="route-name">Report a problem</text></svg></div>',
        '<div id="route-name" style="visibility:hidden"><span '
            + 'style="visibility:visible">Report a problem</span></div>',
        '<div id="route-name" style="visibility:hidden"><svg '
            + 'style="visibility:visible"><text>Report a problem</text></svg></div>',
        '<div id="route-name" style="visibility:hidden"><img '
            + 'style="visibility:visible" alt="Report a problem"></div>',
        '<div id="route-name" style="visibility:hidden"><button '
            + 'style="visibility:visible" aria-label="Report a problem"></button></div>',
        '<div id="route-name" style="visibility:hidden"><button '
            + 'style="visibility:visible" title="Report a problem"></button></div>',
        '<div id="route-name" style="visibility:hidden"><input '
            + 'style="visibility:visible" type="image" alt="Report a problem"></div>',
        '<div id="route-name" style="visibility:hidden"><input '
            + 'style="visibility:visible" type="button" value="Report a problem"></div>',
        '<div id="route-name" style="visibility:hidden"><input '
            + 'style="visibility:visible" type="text" '
            + 'placeholder="Report a problem"></div>',
        '<div id="route-name" style="visibility:hidden"><textarea '
            + 'style="visibility:visible" placeholder="Report a problem"></textarea></div>',
        '<div id="route-name" style="visibility:hidden"><iframe '
            + 'style="visibility:visible" title="Report a problem"></iframe></div>',
        '<div id="route-name" style="visibility:hidden"><svg '
            + 'style="visibility:visible" aria-label="Report a problem"></svg></div>',
        '<span id="route-name"><span hidden>Decorative text</span>'
            + 'Report a problem</span>',
        '<svg><g id="route-name"><g style="display:none"><text>Decorative text</text>'
            + '</g><text>Report a problem</text></g></svg>',
        '<span id="route-name">Report&#32;a&#32;problem</span>',
    ]) {
        const source = referenced
            + `<a aria-labelledby="route-name" href="${target}"></a>`;
        for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
            const link = links.find(candidate => candidate.type === 'link');
            assert.ok(link, referenced);
            assert.equal(link.label, 'Report a problem', referenced);
            assert.equal(isActionableLink(link), true, referenced);
        }
    }
});

test('extracts HTML form submissions and image-map routes with control names', () => {
    const formTarget = 'https://example.com/form-route';
    const overrideTarget = 'https://example.com/override-route';
    const areaTarget = 'https://example.com/area-route';
    const sources = [
        [
            `<form action="${formTarget}">`
                + '<button>Submit a vulnerability report</button></form>',
            formTarget,
            'Submit a vulnerability report',
        ],
        [
            `<form action="${formTarget}">`
                + `<button type="submit" formaction="${overrideTarget}" `
                + 'aria-label="Report a bug"></button></form>',
            overrideTarget,
            'Report a bug',
        ],
        [
            `<form id="route-form" action="${formTarget}"></form>`
                + '<input form="route-form" type="submit" value="Request a feature">',
            formTarget,
            'Request a feature',
        ],
        [
            `<form method="dialog" action="${formTarget}">`
                + '<button formmethod="post">Report a bug</button></form>',
            formTarget,
            'Report a bug',
        ],
        [
            `<form action="${formTarget}"><form action="${overrideTarget}">`
                + '<button>Report a bug</button></form>',
            formTarget,
            'Report a bug',
        ],
        [
            `<map><area href="${areaTarget}" alt="Report a bug"></map>`,
            areaTarget,
            'Report a bug',
        ],
    ];
    for (const [source, target, label] of sources) {
        for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
            const link = links.find(candidate => candidate.target === target);
            assert.ok(link, source);
            assert.equal(link.label, label, source);
            assert.equal(isActionableLink(link), true, source);
        }
    }

    for (const source of [
        `<form action="${formTarget}"><button type="button" `
            + `formaction="${overrideTarget}">Report a bug</button></form>`,
        `<form action="${formTarget}"><button disabled>`
            + 'Report a bug</button></form>',
        `<form method="dialog" action="${formTarget}">`
            + '<button>Report a bug</button></form>',
        `<form action="${formTarget}"><button formmethod="dialog">`
            + 'Report a bug</button></form>',
    ]) {
        for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
            assert.ok(!links.some(link => (
                [formTarget, overrideTarget].includes(link.target)
                && isActionableLink(link)
            )), source);
        }
    }

    const hidden = `<form hidden action="${formTarget}">`
        + '<button>Report a bug</button></form>';
    for (const links of [extractLinks(hidden), extractRenderedHtmlLinks(hidden)]) {
        const link = links.find(candidate => candidate.target === formTarget);
        assert.ok(link);
        assert.equal(link.hidden, true);
        assert.equal(isActionableLink(link), false);
    }
});

test('ignores anchors and ID labels inside inert or raw-text HTML content', () => {
    const inertTarget = 'https://example.com/inert-route';
    const visibleTarget = 'https://example.com/visible-route';
    for (const [opening, closing] of [
        ['<script>', '</script>'],
        ['<style>', '</style>'],
        ['<template>', '</template>'],
        ['<textarea>', '</textarea>'],
    ]) {
        const source = `${opening}<a href="${inertTarget}">Report a bug</a>${closing}`
            + `<a href="${visibleTarget}">Documentation</a>`;
        for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
            assert.ok(!links.some(link => link.target === inertTarget), opening);
            const visible = links.find(link => link.target === visibleTarget);
            assert.ok(visible, opening);
            assert.equal(isActionableLink(visible), true, opening);
        }
    }

    const templateLabel = '<template><span id="route-name">'
        + 'Submit a vulnerability report</span></template>'
        + `<a aria-labelledby="route-name" href="${visibleTarget}"></a>`;
    for (const links of [extractLinks(templateLabel), extractRenderedHtmlLinks(templateLabel)]) {
        const link = links.find(candidate => candidate.target === visibleTarget);
        assert.ok(link);
        assert.equal(link.label, '');
        assert.equal(isActionableLink(link), false);
    }
});

test('preserves accessible-name precedence for referenced ID elements', () => {
    const target = 'https://example.com/route';
    for (const referenced of [
        '<span id="name">Report a problem</span>'
            + '<span id="route-name" aria-labelledby="name" '
            + 'aria-label="Need help" title="Documentation">Body</span>',
        '<span id="name">Report a problem</span>'
            + '<img id="route-name" aria-labelledby="name" '
            + 'aria-label="Need help" alt="Other" title="Documentation">',
        '<img id="route-name" alt="Report a problem" title="Documentation">',
    ]) {
        const source = referenced
            + `<a aria-labelledby="route-name" href="${target}"></a>`;
        for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
            const link = links.find(candidate => candidate.type === 'link');
            assert.ok(link);
            assert.equal(link.label, 'Report a problem');
            assert.equal(isActionableLink(link), true);
        }
    }
});

test('preserves native accessible-name precedence for restored controls', () => {
    const target = 'https://example.com/route';
    for (const referenced of [
        '<div id="route-name" style="visibility:hidden"><button '
            + 'style="visibility:visible" title="Documentation">'
            + 'Report a problem</button></div>',
        '<div id="route-name" style="visibility:hidden"><input '
            + 'style="visibility:visible" type="image" '
            + 'alt="Report a problem" title="Documentation"></div>',
        '<div id="route-name" style="visibility:hidden"><input '
            + 'style="visibility:visible" type="button" '
            + 'value="Report a problem" title="Documentation"></div>',
        '<div id="route-name" style="visibility:hidden"><input '
            + 'style="visibility:visible" type="text" title="Report a problem" '
            + 'placeholder="Documentation"></div>',
    ]) {
        const source = referenced
            + `<a aria-labelledby="route-name" href="${target}"></a>`;
        for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
            const link = links.find(candidate => candidate.type === 'link');
            assert.ok(link);
            assert.equal(link.label, 'Report a problem');
            assert.equal(isActionableLink(link), true);
        }
    }
});

test('resolves associated labels before native control fallbacks', () => {
    const target = 'https://example.com/route';
    for (const referenced of [
        '<label hidden for="route-name">Report a problem</label>'
            + '<input id="route-name" type="image" alt="Documentation">',
        '<label style="visibility:hidden">Report a problem'
            + '<span><input id="route-name" style="visibility:visible" '
            + 'type="image" alt="Documentation"></span>'
            + '</label>',
    ]) {
        const source = referenced
            + `<a aria-labelledby="route-name" href="${target}"></a>`;
        for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
            const link = links.find(candidate => candidate.type === 'link');
            assert.ok(link);
            assert.equal(link.label, 'Report a problem');
            assert.equal(isActionableLink(link), true);
        }
    }
});

test('resolves many associated labels with bounded traversal work', () => {
    const target = 'https://example.com/route';
    const count = 500;
    const controls = Array.from({ length: count }, (_, index) => (
        `<label for="control-${index}">${index === count - 1 ? 'Report a problem' : 'Filler'}</label>`
        + `<input id="control-${index}" type="image" alt="Documentation">`
    )).join('');
    const source = controls
        + `<a aria-labelledby="control-${count - 1}" href="${target}"></a>`;
    const started = performance.now();
    for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
        const link = links.find(candidate => candidate.type === 'link');
        assert.ok(link);
        assert.equal(link.label, 'Report a problem');
    }
    assert.ok(
        performance.now() - started < 4_000,
        'associated labels must not trigger quadratic control searches'
    );
});

test('normalizes native fallbacks and resolves embedded control values', () => {
    const target = 'https://example.com/route';
    for (const referenced of [
        '<input id="route-name" type="image" alt="   " title="Report a problem">',
        '<input id="route-name" type="text" title="   " placeholder="Report a problem">',
        '<input id="route-name" type="not-a-real-state" placeholder="Report a problem">',
        '<input id="route-name" type="text" value="Report a problem">',
        '<input id="route-name" type="image" alt="Report a problem" title="Documentation">',
        '<input id="route-name" type="text" value="Report a problem" title="Documentation">',
        '<input id="route-name" type="text" value="Report a problem" aria-label="Documentation">',
        '<input id="route-name" type="range" aria-valuetext="Report a problem" '
            + 'aria-valuenow="7" value="3" aria-label="Documentation">',
        '<textarea id="route-name">Report a problem</textarea>',
        '<select id="route-name" aria-label="Documentation">'
            + '<option selected>Report a problem</option>'
            + '<option>Documentation</option></select>',
    ]) {
        const source = referenced
            + `<a aria-labelledby="route-name" href="${target}"></a>`;
        for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
            const link = links.find(candidate => candidate.type === 'link');
            assert.ok(link, referenced);
            assert.equal(link.label, 'Report a problem', referenced);
            assert.equal(isActionableLink(link), true, referenced);
        }
    }
});

test('uses only the selected option as an embedded select value', () => {
    const target = 'https://example.com/route';
    const referenced = '<select id="route-name" aria-label="Need help">'
        + '<option selected>Documentation</option>'
        + '<option>Report a problem</option></select>';
    const source = referenced
        + `<a aria-labelledby="route-name" href="${target}"></a>`;
    for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
        const link = links.find(candidate => candidate.type === 'link');
        assert.ok(link);
        assert.equal(link.label, 'Documentation');
    }
});

test('preserves long id and for keys when resolving associated labels', () => {
    const target = 'https://example.com/route';
    const id = `route-${'x'.repeat(9_000)}`;
    const source = `<label for="${id}">Report a problem</label>`
        + `<input id="${id}" type="image" alt="Documentation">`
        + `<a aria-labelledby="${id}" href="${target}"></a>`;
    for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
        const link = links.find(candidate => candidate.type === 'link');
        assert.ok(link);
        assert.equal(link.label, 'Report a problem');
        assert.equal(isActionableLink(link), true);
    }
});

test('resolves native names in direct anchor descendants', () => {
    const target = 'https://example.com/route';
    for (const descendant of [
        '<button title="Report a problem"></button>',
        '<input type="image" alt="Report a problem">',
        '<abbr title="Report a problem"></abbr>',
    ]) {
        const source = `<a href="${target}">${descendant}</a>`;
        for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
            const link = links.find(candidate => candidate.type === 'link');
            assert.ok(link, descendant);
            assert.equal(link.label, 'Report a problem', descendant);
            assert.equal(isActionableLink(link), true, descendant);
        }
    }
});

test('preserves inline text adjacency while retaining block boundaries', () => {
    const target = 'https://example.com/route';
    for (const [body, expected] of [
        ['Report a vulnera<span>bil</span>ity', 'Report a vulnerability'],
        ['Report a vulnera<wbr>bility', 'Report a vulnerability'],
        [
            'Report a vulnera<search style="display:contents">bil</search>ity',
            'Report a vulnerability',
        ],
        [
            'Report a vulnera<dialog style="display:inline">bil</dialog>ity',
            'Report a vulnerability',
        ],
        [
            'Report a vulnera<marquee style="display:inline">bil</marquee>ity',
            'Report a vulnerability',
        ],
        [
            'Report a vulnera<marquee style="display:contents">bil</marquee>ity',
            'Report a vulnerability',
        ],
        [
            '<output>Report a vulnera<span style="display:inherit">bil</span>ity</output>',
            'Report a vulnerability',
        ],
        ['Report a vulnera<body></body>bility', 'Report a vulnerability'],
        ['Report a vulnera<html></html>bility', 'Report a vulnerability'],
        ['Report a vulnera<caption></caption>bility', 'Report a vulnerability'],
        ['Report a vulnera<audio></audio>bility', 'Report a vulnerability'],
        ['Report a vulnera<dialog></dialog>bility', 'Report a vulnerability'],
        ['<div>Report a</div><div>vulnerability</div>', 'Report a vulnerability'],
        ['<span style="display:block">Need</span>help', 'Need help'],
        ['<dialog open>Need</dialog>help', 'Need help'],
        ['<legend>Need</legend>help', 'Need help'],
        ['<search>Need</search>help', 'Need help'],
        ['Need</br>help', 'Need help'],
        ['Need</p>help', 'Need help'],
    ]) {
        const source = `<a href="${target}">${body}</a>`;
        for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
            const link = links.find(candidate => candidate.type === 'link');
            assert.ok(link, body);
            assert.equal(link.label, expected, body);
        }
    }
});

test('uses browser select repair and caller-provided document context', () => {
    const target = 'https://example.com/route';
    const selected = '<select id="route-name"><option selected>'
        + 'Report a vulnera<search>bil</search>ity</option></select>'
        + `<a aria-labelledby="route-name" href="${target}"></a>`;
    for (const links of [extractLinks(selected), extractRenderedHtmlLinks(selected)]) {
        const link = links.find(candidate => candidate.type === 'link');
        assert.ok(link);
        assert.equal(link.label, 'Report a vulnerability');
    }

    for (const terminator of [
        '<input>',
        '<textarea></textarea>',
        '<select>',
    ]) {
        const repaired = `<select>${terminator}<div id="route-name">Need help</div>`
            + `<a aria-labelledby="route-name" href="${target}"></a>`;
        for (const links of [extractLinks(repaired), extractRenderedHtmlLinks(repaired)]) {
            const link = links.find(candidate => candidate.type === 'link');
            assert.ok(link, terminator);
            assert.equal(link.label, 'Need help', terminator);
            assert.equal(isActionableLink(link), true, terminator);
        }
    }

    for (const [source, hidden] of [
        [
            '<select hidden></select>'
                + `<a href="${target}">Submit a vulnerability report</a>`,
            false,
        ],
        [
            '<select></select><div hidden>'
                + `<a href="${target}">Submit a vulnerability report</a></div>`,
            true,
        ],
    ]) {
        for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
            const link = links.find(candidate => candidate.type === 'link');
            assert.ok(link);
            assert.equal(link.hidden, hidden, source);
            assert.equal(isActionableLink(link), !hidden, source);
        }
    }

    const hiddenDocument = '<!doctype html><html><head><title>Hidden</title></head>'
        + '<body hidden>Submit a vulnerability report</body></html>';
    assert.doesNotMatch(
        governedHtmlText(hiddenDocument, new Map(), {}, { documentMode: true }),
        /vulnerability/i
    );

    const omittedHeadClose = '<!doctype html><html><head><title>Support</title>'
        + '<body>Submit a vulnerability report</body></html>';
    assert.match(
        governedHtmlText(omittedHeadClose, new Map(), {}, { documentMode: true }),
        /vulnerability/i
    );

    const textClosesHead = '<!doctype html><html><head>'
        + `Need help <a href="${target}">here</a></html>`;
    const documentLinks = extractRenderedHtmlLinks(
        textClosesHead,
        { documentMode: true }
    );
    assert.equal(documentLinks[0].label, 'here');
    assert.equal(documentLinks[0].hidden, false);
    assert.match(
        governedHtmlText(textClosesHead, new Map(), {}, { documentMode: true }),
        /Need help/i
    );

    const fragmentWithDoctype =
        '<!doctype html><head>Submit a vulnerability report via Discord.</head>';
    assert.match(governedHtmlText(fragmentWithDoctype), /vulnerability/i);
});

test('bounds malformed table-context boundary parsing', () => {
    const source = '<caption>'.repeat(6_000) + 'Report a vulnerability';
    const started = performance.now();
    assert.match(governedHtmlText(source), /\[label truncated:/);
    assert.ok(
        performance.now() - started < 4_000,
        'malformed table-context fragments must be depth-bounded'
    );

    const malformedDocument = '<!doctype html><html><head></head><body>'
        + '<div>'.repeat(16_000)
        + 'Report a vulnerability';
    const documentStarted = performance.now();
    assert.match(
        governedHtmlText(malformedDocument, new Map(), {}, { documentMode: true }),
        /\[label truncated:/
    );
    assert.ok(
        performance.now() - documentStarted < 1_000,
        'malformed complete documents must be depth-bounded before stack searches grow'
    );
});

test('resolves nested same-tag ID labels with bounded traversal work', () => {
    const target = 'https://example.com/route';
    const depth = 500;
    const referenced = Array.from(
        { length: depth },
        (_, index) => `<span id="route-name-${index}">`
    ).join('')
        + 'Report a problem'
        + '</span>'.repeat(depth);
    const source = referenced
        + `<a aria-labelledby="route-name-0" href="${target}"></a>`;
    const started = performance.now();
    for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
        const link = links.find(candidate => candidate.type === 'link');
        assert.ok(link);
        assert.equal(link.label, 'Report a problem');
        assert.equal(isActionableLink(link), true);
    }
    assert.ok(
        performance.now() - started < 4_000,
        '500 nested ID labels must not trigger quadratic subtree rescanning'
    );
});

test('fails closed quickly for malformed nested label trees', () => {
    const target = 'https://example.com/route';
    const source = '<label>'.repeat(6_000)
        + '<input id="route-name" type="image" alt="Documentation">'
        + '</label>'.repeat(6_000)
        + `<a aria-labelledby="route-name" href="${target}"></a>`;
    const started = performance.now();
    for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
        const link = links.find(candidate => candidate.type === 'link');
        assert.ok(link);
        assert.match(link.label, /\[label truncated:/);
    }
    assert.ok(
        performance.now() - started < 4_000,
        'malformed nested labels must be depth-bounded'
    );
});

test('fails closed quickly for unclosed native descendants', () => {
    const target = 'https://example.com/route';
    const source = `<a href="${target}">`
        + '<button title="Documentation">'.repeat(8_000)
        + 'Report a problem</a>';
    const started = performance.now();
    for (const links of [extractLinks(source), extractRenderedHtmlLinks(source)]) {
        const link = links.find(candidate => candidate.type === 'link');
        assert.ok(link);
        assert.match(link.label, /\[label truncated:/);
    }
    assert.ok(
        performance.now() - started < 4_000,
        'unclosed native descendants must be depth-bounded'
    );
});

test('bounds cyclic and deep aria-labelledby dependency graphs', () => {
    const target = 'https://example.com/route';
    const extractors = [extractLinks, extractRenderedHtmlLinks];
    const chainDepth = 80;
    const chain = Array.from({ length: chainDepth }, (_, index) => (
        index === chainDepth - 1
            ? `<span id="chain-${index}">Report a problem</span>`
            : `<span id="chain-${index}" aria-labelledby="chain-${index + 1}"></span>`
    )).join('')
        + `<a aria-labelledby="chain-0" href="${target}"></a>`;
    for (const extract of extractors) {
        const link = extract(chain).find(candidate => candidate.type === 'link');
        assert.ok(link);
        assert.equal(link.label, 'Report a problem');
        assert.equal(isActionableLink(link), true);
    }

    const filler = Array.from(
        { length: 24 },
        (_, index) => `<i id="filler-${index}"></i>`
    ).join('');
    const selfCycle = filler
        + '<span id="route-name" aria-labelledby="route-name route-name">'
        + 'Report a problem</span>'
        + `<a aria-labelledby="route-name" href="${target}"></a>`;
    for (const extract of extractors) {
        const started = performance.now();
        const link = extract(selfCycle).find(candidate => candidate.type === 'link');
        assert.ok(link);
        assert.equal(link.label, 'Report a problem');
        assert.equal(isActionableLink(link), true);
        assert.ok(performance.now() - started < 1_000);
    }

    const duplicateReferences = '<span id="route-name">Report a problem</span>'
        + `<a aria-labelledby="route-name route-name route-name" href="${target}"></a>`;
    for (const extract of extractors) {
        const link = extract(duplicateReferences).find(candidate => candidate.type === 'link');
        assert.ok(link);
        assert.equal(link.label, 'Report a problem');
    }

    const fanOut = [
        '<span id="fan-0">Report a problem</span>',
        '<span id="fan-1">Need help</span>',
        ...Array.from(
            { length: 28 },
            (_, index) => `<span id="fan-${index + 2}" `
                + `aria-labelledby="fan-${index} fan-${index + 1}"></span>`
        ),
        `<a aria-labelledby="fan-29" href="${target}"></a>`,
    ].join('');
    for (const extract of extractors) {
        const started = performance.now();
        const link = extract(fanOut).find(candidate => candidate.type === 'link');
        assert.ok(link);
        assert.ok(link.label.length <= 8_192);
        assert.match(link.label, /\[label truncated:/);
        assert.equal(isActionableLink(link), true);
        assert.ok(performance.now() - started < 1_000);
    }

    const splitInlineTitle = `Before <a href="${target}" title="${'x'.repeat(9_000)}">\n`
        + '</a> after';
    for (const extract of extractors) {
        const link = extract(splitInlineTitle).find(candidate => candidate.type === 'link');
        assert.ok(link);
        assert.equal(link.label.length, 8_192);
        assert.match(link.label, /\[label truncated:/);
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
