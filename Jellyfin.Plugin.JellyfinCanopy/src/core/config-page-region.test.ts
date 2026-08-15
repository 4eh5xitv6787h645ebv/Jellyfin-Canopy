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

interface AdminRegionHelpers {
    normalize(value: unknown): string | null;
    parse(value: unknown): Array<{ code: string; name: string }>;
    resolve(value: unknown, entries: Array<{ code: string; name: string }>, loaded: boolean): string;
    setOptions(
        select: HTMLSelectElement,
        entries: Array<{ code: string; name: string }>,
        selected: unknown,
        loaded: boolean,
    ): string;
}

function regionHelpers(source: string): AdminRegionHelpers {
    const constant = source.match(/^ {8}var JC_DEFAULT_STREAMING_REGION = '[A-Z]{2}';/m);
    expect(constant).toBeTruthy();
    // Execute only closed helpers extracted from committed production source.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function([
        constant![0],
        productionFunction(source, 'jcNormalizeStreamingRegion'),
        productionFunction(source, 'jcParseStreamingRegionCatalog'),
        productionFunction(source, 'jcResolveCatalogStreamingRegion'),
        productionFunction(source, 'jcSetDefaultRegionOptions'),
        'return { normalize: jcNormalizeStreamingRegion, parse: jcParseStreamingRegionCatalog, resolve: jcResolveCatalogStreamingRegion, setOptions: jcSetDefaultRegionOptions };',
    ].join('\n')) as () => AdminRegionHelpers;
    return factory();
}

describe('admin default-region binding', () => {
    const html = read(CONFIG_PAGE_HTML);
    const js = read(CONFIG_PAGE_JS);
    const helpers = regionHelpers(js);

    it('uses a bound accessible select instead of accepting free text', () => {
        expect(html).toMatch(/<select id="DEFAULT_REGION"[^>]*data-config-key="DEFAULT_REGION"[^>]*aria-describedby="defaultRegionDescription"/);
        expect(html).not.toMatch(/<input id="DEFAULT_REGION"/);
        expect(html).toContain('mirrored region catalog');
        expect(js).toContain("ApiClient.getUrl('/JellyfinCanopy/assets/elsewhere/regions.txt')");
        expect(js).toContain('config.AssetCacheEnabled === false');
        expect(js).toContain('signal: controller.signal');
        expect(js).toMatch(/DEFAULT_REGION:\s*\{[\s\S]*?load:[\s\S]*?jcSetDefaultRegionOptions[\s\S]*?save:[\s\S]*?jcNormalizeStreamingRegion/);
    });

    it('normalizes legacy persisted syntax and parses the mirrored catalog', () => {
        expect(helpers.normalize(' xk ')).toBe('XK');
        expect(helpers.normalize('United States')).toBeNull();
        expect(helpers.normalize('')).toBeNull();
        expect(helpers.parse('# header\nus\tUnited States\nXK\tKosovo\nUS\tDuplicate'))
            .toEqual([
                { code: 'US', name: 'United States' },
                { code: 'XK', name: 'Kosovo' },
            ]);
    });

    it('rejects unknown codes with a loaded catalog but preserves uncommon syntax on failure', () => {
        const catalog = helpers.parse('US\tUnited States\nXK\tKosovo');
        expect(helpers.resolve('zz', catalog, true)).toBe('US');
        expect(helpers.resolve('xk', catalog, true)).toBe('XK');
        expect(helpers.resolve('xk', [], false)).toBe('XK');
        expect(helpers.resolve('', [], false)).toBe('US');

        const select = document.createElement('select');
        expect(helpers.setOptions(select, catalog, 'zz', true)).toBe('US');
        expect(select.value).toBe('US');
        expect([...select.options].map((option) => option.value)).toEqual(['US', 'XK']);

        expect(helpers.setOptions(select, [], 'xk', false)).toBe('XK');
        expect(select.value).toBe('XK');
        expect([...select.options].map((option) => option.textContent))
            .toContain('Saved region (XK)');
    });
});
