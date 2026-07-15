import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const DISCOVERY_MODULES = [
    './tag.ts',
    './person.ts',
    './network.ts',
    './genre.ts',
    './collection.ts',
];

function readRelative(relativePath: string): string {
    const path = decodeURIComponent(new URL(relativePath, import.meta.url).pathname);
    const source = ts.sys.readFile(path);
    expect(source, `missing source: ${path}`).toBeTruthy();
    return source!;
}

describe('discovery response cache ownership', () => {
    it.each(DISCOVERY_MODULES)('%s has no permanent feature-local response map', (modulePath) => {
        const source = readRelative(modulePath);

        expect(source).not.toMatch(/new\s+Map\s*</u);
        expect(source).toContain('fetchWithManagedRequest');
    });

    it('keeps Arr issue-media results in the bounded core request cache', () => {
        const source = readRelative('../../arr/requests/data.ts');

        expect(source).not.toContain('issueMediaCache');
        expect(source).toContain("cacheKey: `arr:issue-media:${path}`");
    });
});
