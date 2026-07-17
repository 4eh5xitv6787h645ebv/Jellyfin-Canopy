'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    checkDocumentation,
    classifyProbeAttempts,
    externalLinksInTheme,
    externalUrlProblem,
    isPublicIpAddress,
    loadExternalPolicy,
    probeExternalEntry,
    probeExternalUrl,
    sanitizeExternalUrl,
    validateExamplesInFile,
} = require('./check-docs');

function fixture(files, callback) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-docs-'));
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

test('live documentation passes the deterministic offline content gate', () => {
    const result = checkDocumentation();
    assert.deepEqual(result.problems, []);
    assert.ok(result.files.includes(path.join('docs', 'developers.md')));
    assert.ok(result.externalUrls.size > 10);
});

test('an unreviewed external link fails the offline fixture with file and line', () => {
    fixture({
        'README.md': '[Broken external](https://example.invalid/gone)\n',
        'CONTRIBUTING.md': '# Contributing\n',
        'docs/index.md': '# Home\n',
        'mkdocs.yml': 'site_name: Fixture\n',
        'policy.json': JSON.stringify({ schemaVersion: 1, allowedUrls: [] }),
    }, (root) => {
        const result = checkDocumentation({ root, policyFile: path.join(root, 'policy.json') });
        assert.ok(result.problems.includes(
            'README.md:1: external URL is absent from the reviewed offline inventory: '
            + 'https://example.invalid/gone'
        ));
    });
});

test('published HTML and CSS theme URLs are part of the reviewed inventory', () => {
    fixture({
        'README.md': '# Fixture\n',
        'CONTRIBUTING.md': '# Contributing\n',
        'docs/index.md': '# Home\n',
        'mkdocs.yml': 'site_name: Fixture\n',
        'theme/base.html': [
            '<link href="https://public.example/theme.css?variant=one">',
            '<a href="https://public.example/help">Help</a>',
            '<img srcset="https://public.example/a.png 1x, https://public.example/b.png 2x">',
            '<meta http-equiv="refresh" content="0; URL=https://public.example/next?view=one">',
        ].join('\n'),
        'theme/css/site.css': [
            '@import "https://public.example/print.css";',
            '.icon { background: url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\'%3E"); }',
        ].join('\n'),
        'policy.json': JSON.stringify({
            schemaVersion: 1,
            allowedUrls: [
                { url: 'https://public.example/theme.css?variant=one', reason: 'fixture' },
                { url: 'https://public.example/help', reason: 'fixture' },
                { url: 'https://public.example/a.png', reason: 'fixture' },
                { url: 'https://public.example/b.png', reason: 'fixture' },
                { url: 'https://public.example/next?view=one', reason: 'fixture' },
                { url: 'https://public.example/print.css', reason: 'fixture' },
            ],
        }),
    }, (root) => {
        assert.equal(externalLinksInTheme(root).length, 6);
        assert.deepEqual(checkDocumentation({ root, policyFile: path.join(root, 'policy.json') }).problems, []);
    });
});

test('external inventory print mode redacts every query value', () => {
    const result = spawnSync(process.execPath, ['scripts/check-docs.js', '--print-external-inventory'], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\?|display=swap|repo=n00bcodr|text=Buy/);
    assert.match(result.stdout, /https:\/\/fonts\.googleapis\.com\/css2/);
});

test('theme private, credentialed, and unreviewed URLs fail with source lines and redaction', () => {
    fixture({
        'README.md': '# Fixture\n',
        'CONTRIBUTING.md': '# Contributing\n',
        'docs/index.md': '# Home\n',
        'mkdocs.yml': 'site_name: Fixture\n',
        'theme/base.html': [
            '<a href="https://127.0.0.1/admin">Private</a>',
            '<img src="https://alice:password@example.com/a.png?key=never-print">',
            '<link href="https://unreviewed.example/site.css">',
            '<style>.x{background:url(https://192.0.2.1/beacon)}</style>',
            '<meta content="0; url=https://127.0.0.1/refresh" http-equiv="REFRESH">',
            '<meta http-equiv="refresh" content="5;URL=\'https://alice:password@example.com/a?key=never-print\'">',
            '<meta http-equiv="refresh" content="0;url=https&colon;//127.0.0.1/entity">',
            '<meta http-equiv="refresh" content="0;url=https&#58;//192.0.2.1/numeric">',
            '<meta http-equiv="refresh" content="0;url=https://127.0.0.1/a>b">',
            '<meta http-equiv="refresh" http-equiv="not-refresh" content="0;url=https://127.0.0.1/first-wins">',
            '<meta http-equiv="refresh&Tab;" content="0;url=https&#58;//127.0.0.1/named-discriminator">',
            '<meta http-equiv="ref&#114;esh" content="0;url=https&colon;//192.0.2.1/numeric-discriminator">',
        ].join('\n'),
        'policy.json': JSON.stringify({ schemaVersion: 1, allowedUrls: [] }),
    }, (root) => {
        const result = checkDocumentation({ root, policyFile: path.join(root, 'policy.json') });
        assert.ok(result.problems.some(problem => /^theme\/base\.html:1: private network URL/.test(problem)));
        assert.ok(result.problems.some(problem => /^theme\/base\.html:2: external URL contains credentials/.test(problem)));
        assert.ok(result.problems.some(problem => /^theme\/base\.html:3: external URL is absent/.test(problem)));
        assert.ok(result.problems.some(problem => /^theme\/base\.html:4: private network URL/.test(problem)));
        assert.ok(result.problems.some(problem => /^theme\/base\.html:5: private network URL/.test(problem)));
        assert.ok(result.problems.some(problem => /^theme\/base\.html:6: external URL contains credentials/.test(problem)));
        assert.ok(result.problems.some(problem => /^theme\/base\.html:7: private network URL/.test(problem)));
        assert.ok(result.problems.some(problem => /^theme\/base\.html:8: private network URL/.test(problem)));
        assert.ok(result.problems.some(problem => /^theme\/base\.html:9: private network URL/.test(problem)));
        assert.ok(result.problems.some(problem => /^theme\/base\.html:10: private network URL/.test(problem)));
        assert.ok(result.problems.some(problem => /^theme\/base\.html:11: private network URL/.test(problem)));
        assert.ok(result.problems.some(problem => /^theme\/base\.html:12: private network URL/.test(problem)));
        assert.doesNotMatch(result.problems.join('\n'), /alice|password|never-print/);
    });
});

test('JSON, YAML, shell, and HTTP fences accept representative valid examples', () => {
    fixture({
        'guide.md': [
            '```json',
            '{"enabled": true}',
            '```',
            '```yaml title="config"',
            'enabled: true',
            'items:',
            '  - one',
            '```',
            '```bash',
            'set -eu',
            'printf "%s\\n" "ok"',
            '```',
            '```http',
            'POST /items',
            'Content-Type: application/json',
            '',
            '{"name": "one"}',
            '```',
            '',
        ].join('\n'),
    }, root => assert.deepEqual(validateExamplesInFile('guide.md', root), []));
});

test('invalid fenced examples fail with their file and content line', () => {
    fixture({
        'guide.md': [
            '# Examples',
            '```json',
            '{',
            '  "ok": true,',
            '  "broken":',
            '}',
            '```',
            '```yaml',
            'same: one',
            'same: two',
            '```',
            '```bash',
            'if true; then',
            '```',
            '```http',
            'POST relative-target',
            '```',
            '',
        ].join('\n'),
    }, (root) => {
        const problems = validateExamplesInFile('guide.md', root);
        assert.equal(problems.length, 4);
        assert.match(problems[0], /^guide\.md:6: invalid json example:/);
        assert.match(problems[1], /^guide\.md:10: invalid yaml example:/);
        assert.match(problems[2], /^guide\.md:13: invalid bash example:/);
        assert.match(problems[3], /^guide\.md:16: invalid http example:/);
    });
});

test('HTTP targets and JSON media types are exact and report the failing inner line', () => {
    fixture({
        'guide.md': [
            '```http',
            'POST https://api.example/items?token=hidden HTTP/1.1',
            'Content-Type: application/problem+json; charset=utf-8',
            '',
            '{',
            '  "broken":',
            '}',
            '```',
            '',
        ].join('\n'),
    }, (root) => {
        const problems = validateExamplesInFile('guide.md', root);
        assert.equal(problems.length, 1);
        assert.match(problems[0], /^guide\.md:7: invalid http example: invalid JSON syntax$/);
        assert.doesNotMatch(problems[0], /hidden/);
    });
    for (const source of [
        'GET //example.com/path',
        'GET https:example.com/path',
        'GET https:///path',
        'GET https:////evil.com/path',
        'GET ftp://example.com/path',
        'POST /items\nContent-Type: application/jsonp\n\n{}',
        'POST /items\nContent-Type: text/json\n\n{}',
    ]) {
        assert.throws(() => require('./check-docs').validateHttpExample(source));
    }
    assert.doesNotThrow(() => require('./check-docs').validateHttpExample(
        'POST /items?view=full\nContent-Type: application/vnd.api+json\n\n{"ok":true}'
    ));
});

test('offline inventory rejects an unreviewed external route and copied project owner', () => {
    const known = new Set(['https://example.com/known']);
    assert.equal(externalUrlProblem('https://example.com/known', known), '');
    assert.match(
        externalUrlProblem('https://example.com/gone', known),
        /absent from the reviewed offline inventory: https:\/\/example\.com\/gone/
    );
    assert.match(
        externalUrlProblem('https://github.com/copied/Jellyfin-Canopy/issues', new Set()),
        /points outside the canonical repository/
    );
    for (const raw of ['https:///path', 'https:////evil.com/path']) {
        const problem = externalUrlProblem(raw, new Set([raw]));
        assert.equal(problem, 'malformed external URL: <redacted-malformed-url>');
        assert.equal(sanitizeExternalUrl(raw), '<redacted-malformed-url>');
    }
});

test('sensitive and private URLs fail without printing credentials or query values', () => {
    const credential = 'https://alice:do-not-print@example.com/private?token=also-secret';
    const message = externalUrlProblem(credential, new Set());
    assert.match(message, /contains credentials or sensitive query data: https:\/\/example\.com\/private/);
    assert.doesNotMatch(message, /alice|do-not-print|also-secret/);
    assert.equal(sanitizeExternalUrl(credential), 'https://example.com/private');
    assert.match(
        externalUrlProblem('https://127.0.0.1/admin', new Set()),
        /private network URL cannot be published or probed/
    );
    const plainKey = externalUrlProblem('https://example.com/private?key=never-print', new Set());
    assert.match(plainKey, /sensitive query data/);
    assert.doesNotMatch(plainKey, /never-print/);
    const malformed = externalUrlProblem('https://alice:secret@%zz.invalid/path?token=never', new Set());
    assert.equal(malformed, 'malformed external URL: <redacted-malformed-url>');
    assert.doesNotMatch(malformed, /alice|secret|never/);
});

test('policy parse and duplicate diagnostics never disclose URL query values', () => {
    fixture({
        'duplicate.json': JSON.stringify({
            schemaVersion: 1,
            allowedUrls: [
                { url: 'https://example.com/path?key=first-secret', reason: 'one' },
                { url: 'https://example.com/path?key=first-secret', reason: 'two' },
            ],
        }),
        'malformed.json': '{"allowedUrls":["https://alice:password@example.com/?key=secret",',
    }, (root) => {
        assert.throws(
            () => loadExternalPolicy(path.join(root, 'duplicate.json')),
            error => /duplicate external URL policy entry: https:\/\/example\.com\/path/.test(error.message)
                && !/first-secret/.test(error.message)
        );
        assert.throws(
            () => loadExternalPolicy(path.join(root, 'malformed.json')),
            error => error.message === 'docs external-link policy is not valid JSON'
        );
    });
});

test('IP policy rejects non-public ranges and permits representative public addresses', () => {
    for (const address of [
        '127.0.0.1', '10.0.0.1', '169.254.1.1', '172.16.0.1', '192.168.0.1',
        '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1',
        '::1', 'fe80::1', 'fd00::1', '2001:db8::1', '::ffff:192.168.1.1',
    ]) assert.equal(isPublicIpAddress(address), false, address);
    for (const address of ['23.1.2.3', '2600:1406:5e00:6::17ce:bc12', '::ffff:23.1.2.3']) {
        assert.equal(isPublicIpAddress(address), true, address);
    }
});

test('probe outcomes distinguish confirmed dead routes from transient network failures', () => {
    assert.equal(classifyProbeAttempts([{ status: 204 }]), 'reachable');
    assert.equal(classifyProbeAttempts([{ status: 403 }]), 'transient');
    assert.equal(classifyProbeAttempts([{ status: 404 }, { status: 410 }]), 'confirmed-dead');
    assert.equal(classifyProbeAttempts([{ status: 404 }, { status: 503 }]), 'transient');
    assert.equal(classifyProbeAttempts([{ error: 'TimeoutError' }, { error: 'TypeError' }]), 'transient');
    assert.equal(classifyProbeAttempts([{ blocked: true }]), 'blocked');
});

test('optional reachability probe is bounded and never reclassifies a transient as dead', async () => {
    const statuses = [503, 503];
    let calls = 0;
    const options = [];
    const result = await probeExternalUrl('https://example.com/docs', {
        fetchImpl: async (_url, request) => {
            options.push(request);
            return { status: statuses[calls++] };
        },
        lookupImpl: async () => [{ address: '23.1.2.3', family: 4 }],
        policyUrls: new Set(['https://example.com/docs']),
        maxAttempts: 2,
    });
    assert.equal(calls, 2);
    assert.equal(result.classification, 'transient');
    assert.deepEqual(result.attempts, [{ status: 503 }, { status: 503 }]);
    assert.ok(options.every(request => request.method === 'HEAD' && request.redirect === 'manual'));
});

test('probe fails closed before fetch for unreviewed, malformed, and private resolutions', async () => {
    const scenarios = [
        {
            url: 'https://unreviewed.example/path?key=never-print',
            policyUrls: new Set(),
            lookupImpl: async () => [{ address: '23.1.2.3', family: 4 }],
        },
        {
            url: 'https://alice:secret@%zz.invalid/path?token=never-print',
            policyUrls: new Set(['https://alice:secret@%zz.invalid/path?token=never-print']),
            lookupImpl: async () => [{ address: '23.1.2.3', family: 4 }],
        },
        {
            url: 'https://private-dns.example/path',
            policyUrls: new Set(['https://private-dns.example/path']),
            lookupImpl: async () => [{ address: '169.254.169.254', family: 4 }],
        },
        {
            url: 'https://mapped.example/path',
            policyUrls: new Set(['https://mapped.example/path']),
            lookupImpl: async () => [{ address: '::ffff:127.0.0.1', family: 6 }],
        },
    ];
    for (const scenario of scenarios) {
        let fetches = 0;
        const result = await probeExternalUrl(scenario.url, {
            ...scenario,
            fetchImpl: async () => { fetches += 1; return { status: 204 }; },
        });
        assert.equal(fetches, 0, scenario.url);
        assert.equal(result.classification, 'blocked', scenario.url);
    }
});

test('probe validates all DNS answers and allows a public fdic.gov resolution', async () => {
    let fetches = 0;
    const publicUrl = 'https://www.fdic.gov/resources/';
    const allowed = new Set([publicUrl]);
    const result = await probeExternalUrl(publicUrl, {
        policyUrls: allowed,
        lookupImpl: async hostname => {
            assert.equal(hostname, 'www.fdic.gov');
            return [{ address: '23.1.2.3', family: 4 }, { address: '2600:1406:5e00:6::17ce:bc12', family: 6 }];
        },
        fetchImpl: async () => { fetches += 1; return { status: 204 }; },
    });
    assert.equal(fetches, 1);
    assert.equal(result.classification, 'reachable');

    const mixed = await probeExternalUrl(publicUrl, {
        policyUrls: allowed,
        lookupImpl: async () => [
            { address: '23.1.2.3', family: 4 },
            { address: '10.0.0.2', family: 4 },
        ],
        fetchImpl: async () => { throw new Error('must not fetch'); },
    });
    assert.equal(mixed.classification, 'blocked');
});

test('redirects are bounded and every target is rechecked before fetch', async () => {
    const start = 'https://example.com/start';
    const next = 'https://example.com/next';
    const lookupImpl = async () => [{ address: '23.1.2.3', family: 4 }];
    let calls = 0;
    const unreviewed = await probeExternalUrl(start, {
        policyUrls: new Set([start]),
        lookupImpl,
        fetchImpl: async () => {
            calls += 1;
            return { status: 302, headers: { get: () => next } };
        },
    });
    assert.equal(calls, 1);
    assert.equal(unreviewed.classification, 'blocked');

    const methods = [];
    const reachable = await probeExternalUrl(start, {
        policyUrls: new Set([start, next]),
        lookupImpl,
        fetchImpl: async (url, options) => {
            methods.push([url, options.method, options.redirect]);
            if (url === start) return { status: 302, headers: { get: () => next } };
            return { status: 204 };
        },
    });
    assert.deepEqual(methods, [[start, 'HEAD', 'manual'], [next, 'HEAD', 'manual']]);
    assert.equal(reachable.classification, 'reachable');
});

test('HEAD false negatives use one body-bounded GET fallback', async () => {
    const url = 'https://example.com/preconnect';
    const methods = [];
    let cancellations = 0;
    const result = await probeExternalUrl(url, {
        policyUrls: new Set([url]),
        lookupImpl: async () => [{ address: '23.1.2.3', family: 4 }],
        fetchImpl: async (_url, options) => {
            methods.push(options);
            if (options.method === 'HEAD') return { status: 405 };
            return { status: 200, body: { cancel: async () => { cancellations += 1; } } };
        },
    });
    assert.deepEqual(methods.map(options => options.method), ['HEAD', 'GET']);
    assert.deepEqual(methods[1].headers, { Range: 'bytes=0-0' });
    assert.equal(cancellations, 1);
    assert.equal(result.classification, 'reachable');
});

test('preconnect origins use DNS-only reachability without a misleading route request', async () => {
    const url = 'https://fonts.example';
    let fetches = 0;
    const result = await probeExternalEntry(
        { url, reason: 'preconnect fixture', probe: 'dns-only' },
        new Set([url]),
        {
            lookupImpl: async () => [{ address: '23.1.2.3', family: 4 }],
            fetchImpl: async () => { fetches += 1; return { status: 204 }; },
        }
    );
    assert.equal(fetches, 0);
    assert.equal(result.classification, 'reachable');
    assert.deepEqual(result.attempts, [{ dnsOnly: true }]);
});

test('every DNS lookup is timeout-bounded and retried without reaching fetch', { timeout: 1_000 }, async () => {
    const url = 'https://never-resolves.example/path';
    const policyUrls = new Set([url]);
    let lookupCalls = 0;
    let fetches = 0;
    const lookupImpl = async () => {
        lookupCalls += 1;
        return new Promise(() => {});
    };
    const result = await probeExternalUrl(url, {
        policyUrls,
        lookupImpl,
        fetchImpl: async () => { fetches += 1; return { status: 204 }; },
        maxAttempts: 2,
        timeoutMs: 10,
    });
    assert.equal(lookupCalls, 2);
    assert.equal(fetches, 0);
    assert.deepEqual(result.attempts, [{ error: 'TimeoutError' }, { error: 'TimeoutError' }]);
    assert.equal(result.classification, 'transient');

    lookupCalls = 0;
    const dnsOnly = await probeExternalEntry(
        { url, reason: 'fixture', probe: 'dns-only' },
        policyUrls,
        { lookupImpl, maxAttempts: 2, timeoutMs: 10 }
    );
    assert.equal(lookupCalls, 2);
    assert.deepEqual(dnsOnly.attempts, [{ error: 'TimeoutError' }, { error: 'TimeoutError' }]);
    assert.equal(dnsOnly.classification, 'transient');
});

test('a never-settling redirect DNS lookup is bounded before the next fetch', { timeout: 1_000 }, async () => {
    const start = 'https://start.example/path';
    const next = 'https://never-resolves.example/path';
    let fetches = 0;
    const result = await probeExternalUrl(start, {
        policyUrls: new Set([start, next]),
        lookupImpl: async hostname => (
            hostname === 'start.example'
                ? [{ address: '23.1.2.3', family: 4 }]
                : new Promise(() => {})
        ),
        fetchImpl: async () => {
            fetches += 1;
            return { status: 302, headers: { get: () => next } };
        },
        maxAttempts: 1,
        timeoutMs: 10,
    });
    assert.equal(fetches, 1);
    assert.deepEqual(result.attempts, [{ error: 'TimeoutError' }]);
    assert.equal(result.classification, 'transient');
});

test('a timed-out redirect DNS hop is retried and can recover', { timeout: 1_000 }, async () => {
    const start = 'https://start.example/path';
    const next = 'https://next.example/path';
    let nextLookups = 0;
    let fetches = 0;
    const result = await probeExternalUrl(start, {
        policyUrls: new Set([start, next]),
        lookupImpl: async hostname => {
            if (hostname === 'start.example') return [{ address: '23.1.2.3', family: 4 }];
            nextLookups += 1;
            return nextLookups === 1
                ? new Promise(() => {})
                : [{ address: '23.1.2.4', family: 4 }];
        },
        fetchImpl: async url => {
            fetches += 1;
            return url === start
                ? { status: 302, headers: { get: () => next } }
                : { status: 204 };
        },
        maxAttempts: 2,
        timeoutMs: 10,
    });
    assert.equal(nextLookups, 2);
    assert.equal(fetches, 3);
    assert.deepEqual(result.attempts, [{ error: 'TimeoutError' }, { status: 204 }]);
    assert.equal(result.classification, 'reachable');
});
