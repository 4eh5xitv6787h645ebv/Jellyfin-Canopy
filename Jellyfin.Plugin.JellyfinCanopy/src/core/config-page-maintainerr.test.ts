import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/core\/[^/]+$/, '/');
const CONFIG_PAGE_JS = SRC_ROOT.replace(/src\/$/, 'Configuration/config-page.js');
const CONFIG_PAGE_HTML = SRC_ROOT.replace(/src\/$/, 'Configuration/configPage.html');

function read(path: string): string {
    const source = ts.sys.readFile(path);
    expect(source, `missing source: ${path}`).toBeTruthy();
    return source!;
}

function productionFunction(source: string, name: string): string {
    const match = source.match(new RegExp(
        `^ {8}(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^ {8}\\}`,
        'm',
    ));
    expect(match, `missing production helper: ${name}`).toBeTruthy();
    return match![0];
}

function maintainerrUrlHelpers(source: string): {
    normalize: (value: unknown) => string;
    validate: (value: unknown) => {
        value: string;
        validCount: number;
        invalidCount: number;
        issues: string[];
    };
} {
    const constants = [
        'JC_MAINTAINERR_MAX_URL_LENGTH',
        'JC_MAINTAINERR_MAX_MAPPINGS_LENGTH',
        'JC_MAINTAINERR_MAX_MAPPING_ROWS',
    ].map((name) => {
        const match = source.match(new RegExp(`^ {8}var ${name} = [^;]+;`, 'm'));
        expect(match, `missing production constant: ${name}`).toBeTruthy();
        return match![0];
    });
    // Execute only the three closed, production helper declarations read from
    // this checked-in source file; no runtime/user input reaches this test.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(
        [
            ...constants,
            productionFunction(source, 'jcIsSafeMaintainerrPathSegment'),
            productionFunction(source, 'jcNormalizeMaintainerrBaseUrl'),
            productionFunction(source, 'jcValidateMaintainerrMappings'),
            'return { normalize: jcNormalizeMaintainerrBaseUrl, validate: jcValidateMaintainerrMappings };',
        ].join('\n'),
    ) as () => {
        normalize: (value: unknown) => string;
        validate: (value: unknown) => {
            value: string;
            validCount: number;
            invalidCount: number;
            issues: string[];
        };
    };
    return factory();
}

function maintainerrTestResponse(
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        ok: true,
        ready: true,
        version: '3.18.0',
        jellyfinMode: true,
        capable: true,
        identityMatch: true,
        capabilities: {
            collections: true,
            collectionContent: true,
            itemStatus: true,
            rules: true,
            storageMetrics: true,
            overlays: true,
        },
        ...overrides,
    };
}

function pureProductionHelper<T>(source: string, name: string): T {
    // Execute only the named production helper extracted from this checked-in
    // source file; no runtime/user input reaches this test.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(
        `${productionFunction(source, name)}\nreturn ${name};`,
    ) as () => T;
    return factory();
}

describe('Maintainerr admin configuration contract', () => {
    const html = read(CONFIG_PAGE_HTML);
    const js = read(CONFIG_PAGE_JS);

    it('binds every reviewed setting and no credential field', () => {
        const keys = [
            'MaintainerrEnabled',
            'MaintainerrUrl',
            'MaintainerrExternalUrl',
            'MaintainerrUrlMappings',
            'MaintainerrPageEnabled',
            'MaintainerrItemStatusEnabled',
            'MaintainerrItemStatusForUsers',
        ];
        for (const key of keys) {
            expect(html).toContain(`data-config-key="${key}"`);
        }
        expect(html).not.toMatch(/MaintainerrApiKey|maintainerrApiKey|X-Api-Key/i);
        expect(html).toContain('Maintainerr 3.18 has no API authentication');
        expect(html).toContain('trusted private network');
        expect(html).toMatch(/id="maintainerrUrl"[^>]*maxlength="2048"/);
        expect(html).toMatch(/id="maintainerrExternalUrl"[^>]*maxlength="2048"/);
        expect(html).toMatch(/id="maintainerrUrlMappings"[^>]*maxlength="65536"[^>]*data-max-rows="32"/);
    });

    it('uses a URL-only JSON POST to the elevated Canopy test endpoint', () => {
        const match = js.match(
            /async function testMaintainerrConnection\(\)\s*\{[\s\S]*?\n {8}\}\n\n {8}async function testTmdbConnection/,
        );
        expect(match, 'Maintainerr test function not found').toBeTruthy();
        const source = match![0];

        expect(source).toContain("type: 'POST'");
        expect(source).toContain("ApiClient.getUrl('/JellyfinCanopy/maintainerr/test')");
        expect(source).toContain("contentType: 'application/json'");
        expect(source).toContain('JSON.stringify({ url: url })');
        expect(source).toContain('signal: controller.signal');
        expect(source).toContain('jcNormalizeMaintainerrBaseUrl(');
        expect(source).not.toMatch(/headers\s*:|Authorization|ApiKey|X-Api-Key/i);
        expect(source).not.toMatch(/console\.(?:log|warn|error)[^\n]*\burl\b/i);
        expect(source).not.toMatch(/getUrl\([^)]*,\s*\{\s*url\s*:/);
        expect(source).toContain("malformed_body: 'Maintainerr returned an invalid response'");
        expect(source).toContain("response_too_large: 'Maintainerr returned an oversized response'");
    });

    it('distinguishes an unknown Jellyfin identity from a confirmed mismatch', () => {
        const source = productionFunction(js, 'testMaintainerrConnection');
        expect(source).toContain("identityWarning === 'identity_mismatch'");
        expect(source).toContain("identityWarning === 'identity_unknown'");
        expect(source).toContain("identityState === 'mismatch'");
        expect(source).toContain("identityState === 'unknown'");
        expect(source).toContain('connected to a different Jellyfin server');
        expect(source).toContain('identity could not be confirmed');
    });

    it('parses the exact typed test DTO and fails closed on malformed identity state', () => {
        const parse = pureProductionHelper<
            (value: unknown) => Record<string, unknown> | null
        >(js, 'jcParseMaintainerrTestStatus');
        expect(parse(maintainerrTestResponse())).toMatchObject({
            identityMatch: true,
            version: '3.18.0',
        });
        expect(parse(maintainerrTestResponse({
            ok: false,
            identityMatch: false,
            identityWarning: 'identity_unknown',
            capabilities: {
                collections: true,
                collectionContent: true,
                itemStatus: false,
                rules: true,
                storageMetrics: true,
                overlays: true,
            },
        }))).toMatchObject({
            identityMatch: false,
            identityWarning: 'identity_unknown',
        });
        expect(parse(maintainerrTestResponse({
            ok: false,
            capable: false,
            error: 'not_ready',
            capabilities: {
                collections: false,
                collectionContent: false,
                itemStatus: false,
                rules: false,
                storageMetrics: false,
                overlays: false,
            },
        }))).toMatchObject({
            ready: true,
            capable: false,
        });

        const malformed = [
            { identityMatch: undefined },
            { identityMatch: null },
            { identityMatch: 'true' },
            { identityMatch: false },
            { identityMatch: false, identityWarning: null },
            { identityMatch: false, identityWarning: 'other_warning' },
            { identityMatch: true, identityWarning: 'identity_unknown' },
            { error: 'unsupported' },
            {
                ok: false,
                capable: false,
                error: 'wrong_service',
                capabilities: {
                    collections: false,
                    collectionContent: false,
                    itemStatus: false,
                    rules: false,
                    storageMetrics: false,
                    overlays: false,
                },
            },
        ];
        for (const overrides of malformed) {
            expect(parse(maintainerrTestResponse(overrides)), JSON.stringify(overrides))
                .toBeNull();
        }
    });

    it('aborts and fences an in-flight URL A test when the editable URL becomes B', async () => {
        document.body.innerHTML = [
            '<input id="maintainerrUrl" value="http://maintainerr-a:6246">',
            '<span id="maintainerrStatusIndicator"></span>',
            '<span id="maintainerrStatusText"></span>',
            '<button id="testMaintainerrBtn"></button>',
        ].join('');

        let resolveRequest!: (value: unknown) => void;
        const request = new Promise<unknown>((resolve) => {
            resolveRequest = resolve;
        });
        let requestOptions: { signal?: AbortSignal } | undefined;
        const cacheWrites: unknown[][] = [];
        const alerts: unknown[] = [];
        const normalize = maintainerrUrlHelpers(js).normalize;

        const names = [
            'jcSetMaintainerrTestStatus',
            'cancelActiveMaintainerrTest',
            'jcIsCurrentMaintainerrTest',
            'jcParseMaintainerrTestStatus',
            'jcFingerprintConnectionValue',
            'testMaintainerrConnection',
        ];
        // Execute the production connection-test state machine with a deferred
        // request and inert dashboard/cache adapters.
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const factory = new Function(
            'document',
            'ApiClient',
            'Dashboard',
            'setConnectionTestResult',
            'beginConnectionTest',
            'jcTestAlert',
            'jcNormalizeMaintainerrBaseUrl',
            'AbortController',
            [
                "const testMaintainerrBtn = document.getElementById('testMaintainerrBtn');",
                "const maintainerrStatusIndicator = document.getElementById('maintainerrStatusIndicator');",
                "const maintainerrStatusText = document.getElementById('maintainerrStatusText');",
                'let maintainerrTestGeneration = 0;',
                'let activeMaintainerrTestController = null;',
                ...names.map((name) => productionFunction(js, name)),
                "document.querySelector('#maintainerrUrl').addEventListener('input', function() {",
                '    cancelActiveMaintainerrTest(true);',
                '});',
                'return { testMaintainerrConnection };',
            ].join('\n'),
        ) as (...args: unknown[]) => {
            testMaintainerrConnection(): Promise<void>;
        };
        const harness = factory(
            document,
            {
                getUrl: (path: string) => path,
                ajax: (options: { signal?: AbortSignal }) => {
                    requestOptions = options;
                    return request;
                },
            },
            { alert: (value: unknown) => alerts.push(value) },
            (...args: unknown[]) => cacheWrites.push(args),
            () => 0,
            (value: unknown) => alerts.push(value),
            normalize,
            AbortController,
        );

        const pending = harness.testMaintainerrConnection();
        expect(requestOptions?.signal?.aborted).toBe(false);
        const input = document.querySelector<HTMLInputElement>('#maintainerrUrl')!;
        input.value = 'http://maintainerr-b:6246';
        input.dispatchEvent(new Event('input'));
        expect(requestOptions?.signal?.aborted).toBe(true);

        resolveRequest(maintainerrTestResponse());
        await pending;
        expect(cacheWrites).toEqual([]);
        expect(alerts).toEqual([]);
        expect(document.querySelector('#maintainerrStatusText')?.textContent).toBe('');
        expect(document.querySelector<HTMLButtonElement>('#testMaintainerrBtn')?.disabled)
            .toBe(false);
        expect(js).toContain("page.addEventListener('pagehide', function() {\n            cancelActiveMaintainerrTest(true);");
        expect(js).toContain("page.addEventListener('viewhide', function() {\n            cancelActiveMaintainerrTest(true);");
    });

    it('announces textual status while keeping Material ligature names hidden', () => {
        expect(html).toMatch(
            /id="maintainerrStatusIndicator"[^>]*aria-hidden="true"/,
        );
        expect(html).not.toMatch(
            /id="maintainerrStatusIndicator"[^>]*aria-live=/,
        );
        expect(html).toMatch(
            /id="maintainerrStatusText"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/,
        );
        const source = productionFunction(js, 'testMaintainerrConnection');
        expect(source).toContain("'Testing\\u2026'");
        expect(source).toContain("'Connected with warning'");
        expect(source).toContain("'Connected'");
        expect(source).toContain("'Failed'");
    });

    it('binds cached status to a non-URL fingerprint of the normalized target', () => {
        const fingerprint = pureProductionHelper<(value: unknown) => string>(
            js,
            'jcFingerprintConnectionValue',
        );
        const urlA = 'http://maintainerr-a.internal:6246/base';
        const urlB = 'http://maintainerr-b.internal:6246/base';
        const bindingA = fingerprint(urlA);
        expect(bindingA).not.toContain('maintainerr');
        expect(bindingA).not.toContain(urlA);
        expect(bindingA).not.toBe(fingerprint(urlB));

        const cacheFunctions = [
            'setConnectionTestResult',
            'getPersistedTestResult',
            'getConnectionTestResult',
        ];
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const factory = new Function(
            'localStorage',
            [
                'var _jeConnectionTestCache = new Map();',
                'var _jeCacheGeneration = 0;',
                'var CONNECTION_TEST_CACHE_TTL_MS = 5 * 60 * 1000;',
                'function renderChecklist() {}',
                ...cacheFunctions.map((name) => productionFunction(js, name)),
                'return { setConnectionTestResult, getPersistedTestResult, getConnectionTestResult };',
            ].join('\n'),
        ) as (storage: Storage) => {
            setConnectionTestResult(
                key: string,
                status: string,
                detail: string,
                token: number,
                binding: string,
            ): void;
            getPersistedTestResult(key: string, binding: string): unknown;
            getConnectionTestResult(key: string, binding: string): unknown;
        };
        localStorage.removeItem('jc_conn_test_maintainerr');
        const cache = factory(localStorage);
        cache.setConnectionTestResult('maintainerr', 'ok', 'Connected', 0, bindingA);
        const serialized = localStorage.getItem('jc_conn_test_maintainerr')!;
        expect(serialized).not.toContain(urlA);
        expect(cache.getPersistedTestResult('maintainerr', bindingA)).not.toBeNull();
        expect(cache.getConnectionTestResult('maintainerr', bindingA)).not.toBeNull();
        expect(cache.getPersistedTestResult('maintainerr', fingerprint(urlB))).toBeNull();
        expect(cache.getConnectionTestResult('maintainerr', fingerprint(urlB))).toBeNull();
        localStorage.removeItem('jc_conn_test_maintainerr');

        expect(js).toContain('jcFingerprintConnectionValue(normalizedMaintainerrUrl)');
        expect(js).toContain('jcFingerprintConnectionValue(url)');
    });

    it('cancels an overlapping Maintainerr test before re-test-all clears and restarts', () => {
        const handlerStart = js.indexOf("retestAllConnectionsBtn.addEventListener('click'");
        const cancel = js.indexOf('cancelActiveMaintainerrTest(true);', handlerStart);
        const clear = js.indexOf('clearConnectionTestCache();', handlerStart);
        const restart = js.indexOf('testMaintainerrBtn.click();', clear);
        expect(handlerStart).toBeGreaterThanOrEqual(0);
        expect(cancel).toBeGreaterThan(handlerStart);
        expect(clear).toBeGreaterThan(cancel);
        expect(restart).toBeGreaterThan(clear);
        // The deferred A→B test above executes the same cancellation primitive
        // and proves an aborted completion cannot publish cache, icon, or alert.
    });

    it('normalizes and bounds Maintainerr base URLs with traversal defenses', () => {
        const helpers = maintainerrUrlHelpers(js);
        expect(helpers.normalize(' HTTP://Maintainerr.Example:6246/base/path/ '))
            .toBe('http://maintainerr.example:6246/base/path');
        expect(helpers.normalize('http://[fd00::1]:6246/maintainerr/'))
            .toBe('http://[fd00::1]:6246/maintainerr');
        const prefix = 'http://maintainerr.example/';
        const atLimit = prefix + 'a'.repeat(2048 - prefix.length);
        expect(atLimit).toHaveLength(2048);
        expect(helpers.normalize(atLimit)).toBe(atLimit);
        expect(helpers.normalize(`${atLimit}a`)).toBe('');
        // URL parsing can percent-encode Unicode and expand the normalized
        // result, so the post-normalization value is bounded as well.
        expect(helpers.normalize(`${prefix}${'é'.repeat(400)}`)).toBe('');
        for (const invalid of [
            'ftp://maintainerr.example',
            '//maintainerr.example',
            'http://user:secret@maintainerr.example',
            'http://maintainerr.example/base?token=secret',
            'http://maintainerr.example/base#fragment',
            'http://maintainerr.example/base\\rules',
            'http://maintainerr.example/base/../rules',
            'http://maintainerr.example/base/%2e%2e/rules',
            'http://maintainerr.example/base/%252e%252e/rules',
            'http://maintainerr.example/base/%C2%85/rules',
            'http://maintainerr.example/base/\u0085/rules',
        ]) {
            expect(helpers.normalize(invalid), invalid.slice(0, 80)).toBe('');
        }
    });

    it('uses one strict bounded, non-leaking mapping parser for Validate and Save', () => {
        const helpers = maintainerrUrlHelpers(js);
        expect(helpers.validate(
            'https://jellyfin.example/base/|https://maintainerr.example/app/\n',
        )).toEqual({
            value: 'https://jellyfin.example/base|https://maintainerr.example/app',
            validCount: 1,
            invalidCount: 0,
            issues: [],
        });

        const secret = 'do-not-echo-this-secret';
        const rejected = helpers.validate(
            `https://user:${secret}@jellyfin.example|https://maintainerr.example/rules?token=${secret}`,
        );
        expect(rejected.value).toBe('');
        expect(rejected.invalidCount).toBe(1);
        expect(JSON.stringify(rejected)).not.toContain(secret);
        expect(JSON.stringify(rejected)).not.toContain('jellyfin.example');

        const duplicated = helpers.validate([
            'https://jellyfin.example|https://maintainerr-a.example',
            'https://jellyfin.example/|https://maintainerr-b.example',
        ].join('\n'));
        expect(duplicated.validCount).toBe(1);
        expect(duplicated.invalidCount).toBe(1);

        const oneMapping = 'https://jellyfin.example|https://maintainerr.example';
        const exactMappingLimit = oneMapping + ' '.repeat((64 * 1024) - oneMapping.length);
        expect(exactMappingLimit).toHaveLength(64 * 1024);
        expect(helpers.validate(exactMappingLimit).value).toBe(oneMapping);

        const capPlusOne = helpers.validate(Array.from(
            { length: 33 },
            (_, index) => `https://jellyfin-${index}.example|https://maintainerr.example`,
        ).join('\n'));
        expect(capPlusOne.validCount).toBe(32);
        expect(capPlusOne.invalidCount).toBe(1);
        expect(capPlusOne.value.split('\n')).toHaveLength(32);

        const expandedMappings = helpers.validate(Array.from(
            { length: 32 },
            (_, index) => `https://jellyfin-${index}.example/${'é'.repeat(300)}`
                + `|https://maintainerr-${index}.example/${'é'.repeat(300)}`,
        ).join('\n'));
        expect(expandedMappings.value).toBe('');
        expect(expandedMappings.issues).toContain(
            'Normalized Maintainerr mappings exceed the 64 KiB limit.',
        );

        const oversize = helpers.validate('x'.repeat((64 * 1024) + 1));
        expect(oversize).toEqual({
            value: '',
            validCount: 0,
            invalidCount: 1,
            issues: ['Maintainerr mappings exceed the 64 KiB limit.'],
        });

        const validationSource = productionFunction(js, 'validateMaintainerrMappingSet');
        expect(validationSource).toContain('jcValidateMaintainerrMappings(input.value)');
        expect(validationSource).not.toMatch(/parts\[|new URL|p\.left|p\.right/);
        expect(js).toContain('var mappingResult = jcValidateMaintainerrMappings(');
        expect(js).toContain('config.MaintainerrUrlMappings = mappingResult.value;');
    });

    it('participates in status, invalidation, re-test-all, and page ordering', () => {
        expect(js).toMatch(/checklistRowState\(\s*'maintainerr'/);
        expect(js).toContain("_wireInvalidate('#maintainerrUrl',  'maintainerr')");
        expect(js).toContain('testMaintainerrBtn.click()');
        expect(html).toContain('data-page-id="maintainerr"');
        expect(html).toContain('data-tab="maintainerr"');
    });
});
