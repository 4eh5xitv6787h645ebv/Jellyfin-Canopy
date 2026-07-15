// Executes the small, dependency-injected scan helpers from the shipped admin
// page. config-page.js is one large page-wiring IIFE and cannot be imported as
// a module, so marker extraction lets this test exercise the production code
// without booting the entire Jellyfin dashboard DOM.
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

interface ScanResult {
    domain: string;
    ok: boolean;
    error: unknown;
}

interface ScanDispatch {
    domains: string[];
    results: ScanResult[];
    cancelled: boolean;
}

interface ScanHelpers {
    jcParseSeerrIdentityDomains(rawUrls: unknown): string[];
    jcDispatchSeerrScanDomains(
        rawUrls: unknown,
        send: (domains: string[], signal?: AbortSignal) => Promise<unknown>,
        signal?: AbortSignal,
    ): Promise<ScanDispatch>;
    jcSummarizeSeerrScanDispatch(dispatch: ScanDispatch): {
        total: number;
        succeeded: number;
        failed: number;
        outcome: 'success' | 'partial' | 'failure';
    };
}

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/core\/[^/]+$/, '/');
const CONFIG_PAGE_JS = SRC_ROOT.replace(/src\/$/, 'Configuration/config-page.js');
const HELPERS_START = '/* jc-seerr-scan-helpers:start */';
const HELPERS_END = '/* jc-seerr-scan-helpers:end */';

function loadScanHelpers(): ScanHelpers {
    const source = ts.sys.readFile(CONFIG_PAGE_JS);
    expect(source, `missing source: ${CONFIG_PAGE_JS}`).toBeTruthy();
    const start = source!.indexOf(HELPERS_START);
    const end = source!.indexOf(HELPERS_END, start);
    expect(start, 'scan helper start marker not found').toBeGreaterThanOrEqual(0);
    expect(end, 'scan helper end marker not found').toBeGreaterThan(start);
    const helperSource = source!.slice(start + HELPERS_START.length, end);

    // SAFETY: only the marker-bounded helper declarations from our local source
    // are evaluated. They have no DOM/network globals and accept the sender as
    // an injected function, which is precisely what these contract tests need.
    return eval(`(() => {${helperSource}; return { jcParseSeerrIdentityDomains, jcDispatchSeerrScanDomains, jcSummarizeSeerrScanDispatch }; })()`) as ScanHelpers;
}

describe('config-page Seerr scan identity domains', () => {
    const helpers = loadScanHelpers();

    it('collapses comma/newline/trailing-slash aliases into one POST', async () => {
        const sent: string[] = [];
        let calls = 0;
        const result = await helpers.jcDispatchSeerrScanDomains(
            ' http://seerr:5055/ ,\nhttp://seerr:5055\r\nhttp://seerr:5055/// ',
            (domains) => {
                calls += 1;
                sent.push(...domains);
                return Promise.resolve({ ok: true });
            },
        );

        expect(sent).toEqual(['http://seerr:5055']);
        expect(calls).toBe(1);
        expect(result.domains).toEqual(['http://seerr:5055']);
        expect(result.results.map(row => row.ok)).toEqual([true]);
        expect(result.cancelled).toBe(false);
    });

    it('matches server identity normalization while preserving path case', () => {
        expect(helpers.jcParseSeerrIdentityDomains(
            'HTTP://SEERR.EXAMPLE:80/Tenant/,http://seerr.example/Tenant\nhttp://seerr.example/tenant',
        )).toEqual([
            'http://seerr.example/Tenant',
            'http://seerr.example/tenant',
        ]);
    });

    it('collapses DNS absolute-name trailing-dot aliases', () => {
        expect(helpers.jcParseSeerrIdentityDomains(
            'http://seerr.example.:5055/Tenant,http://seerr.example:5055/Tenant',
        )).toEqual(['http://seerr.example:5055/Tenant']);
    });

    it('normalizes authoritative server result domains before matching rows', async () => {
        const result = await helpers.jcDispatchSeerrScanDomains(
            'http://seerr.example:5055/Tenant',
            () => Promise.resolve({
                ok: false,
                results: [{
                    domain: 'HTTP://SEERR.EXAMPLE:5055/Tenant/',
                    ok: true,
                }],
            }),
        );

        expect(result.results).toEqual([{
            domain: 'http://seerr.example:5055/Tenant',
            ok: true,
            error: '',
        }]);
    });

    it('does not repair malformed non-authority URLs differently from the server', () => {
        expect(helpers.jcParseSeerrIdentityDomains(
            'http:seerr.example,http://seerr.example',
        )).toEqual(['http:seerr.example', 'http://seerr.example']);
    });

    it('does not repair multiple trailing DNS dots into another host', () => {
        expect(helpers.jcParseSeerrIdentityDomains(
            'http://seerr.example..:5055,http://seerr.example:5055',
        )).toEqual(['http://seerr.example..:5055', 'http://seerr.example:5055']);
    });

    it('does not repair a DNS-root-only host into an empty authority', () => {
        expect(helpers.jcParseSeerrIdentityDomains('http://.')).toEqual(['http://.']);
    });

    it('reports every distinct domain from one partial server batch', async () => {
        const sent: string[] = [];
        const result = await helpers.jcDispatchSeerrScanDomains(
            'http://first:5055\nhttp://second:5055/',
            (domains) => {
                sent.push(...domains);
                return Promise.resolve({
                    ok: false,
                    outcome: 'partial',
                    results: [
                        { domain: domains[0], ok: false, message: 'first unavailable' },
                        { domain: domains[1], ok: true },
                    ],
                });
            },
        );

        expect(sent).toEqual(['http://first:5055', 'http://second:5055']);
        expect(result.results.map(row => row.ok)).toEqual([false, true]);
        expect(helpers.jcSummarizeSeerrScanDispatch(result)).toEqual({
            total: 2,
            succeeded: 1,
            failed: 1,
            outcome: 'partial',
        });
        expect(result.cancelled).toBe(false);
    });

    it('marks the one shared batch cancelled after page-lifecycle cancellation', async () => {
        const controller = new AbortController();
        const sent: string[] = [];
        const result = await helpers.jcDispatchSeerrScanDomains(
            'http://first:5055,http://second:5055',
            (domains) => {
                sent.push(...domains);
                controller.abort();
                return Promise.resolve({ ok: true });
            },
            controller.signal,
        );

        expect(sent).toEqual(['http://first:5055', 'http://second:5055']);
        expect(result.cancelled).toBe(true);
    });
});
