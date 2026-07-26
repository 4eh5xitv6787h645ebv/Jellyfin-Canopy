import { describe, expect, it } from 'vitest';
import {
    optionalHref,
    parseMaintainerrCollectionContent,
    parseMaintainerrDashboard,
} from './types';
import { parseMaintainerrItemStatus } from './item-status';

function collection(id = 1): Record<string, unknown> {
    return {
        id,
        title: `Collection ${id}`,
        type: 'movie',
        isActive: true,
        mediaCount: 2,
        manualCollection: false,
        handledMediaAmount: 0,
        lastDurationInSeconds: 0,
        handledMediaSizeBytes: 0,
    };
}

function dashboard(collections: unknown[] = [collection()]): Record<string, unknown> {
    return {
        status: {
            ready: true,
            degraded: false,
            version: '3.18.0',
            jellyfinMode: true,
            capable: true,
            identityMatch: true,
        },
        collections,
        storage: {
            state: 'available',
            generatedAt: '2026-07-26T00:00:00.0000000+00:00',
            collectionSummary: {
                reclaimableCount: 3,
                activeSizeBytes: 2048,
                reclaimableSizedCount: 2,
                inactiveCount: 1,
                totalCollectionCount: 2,
                movieSizeBytes: 1,
                showSizeBytes: 2,
                seasonSizeBytes: 3,
                episodeSizeBytes: 4,
                reclaimableMovieCount: 1,
                reclaimableShowCount: 1,
                reclaimableSeasonCount: 1,
                reclaimableEpisodeCount: 1,
                upstreamSecretSentinel: 99,
            },
            cleanupTotals: {
                itemsHandled: 4,
                moviesHandled: 1,
                showsHandled: 1,
                seasonsHandled: 1,
                episodesHandled: 1,
                bytesHandled: 4096,
                movieBytesHandled: 1,
                showBytesHandled: 2,
                seasonBytesHandled: 3,
                episodeBytesHandled: 4,
                unknownCleanupSentinel: 88,
            },
            reclaimableUsingFallback: false,
        },
        rules: {
            state: 'available',
            count: 1,
            processingQueue: false,
            executing: false,
            pendingCount: 0,
            queueCount: 0,
        },
        overlays: {
            state: 'available',
            status: 'idle',
        },
    };
}

describe('Maintainerr dashboard DTO parsing', () => {
    it('keeps only explicitly allowed storage keys', () => {
        const parsed = parseMaintainerrDashboard(dashboard());
        expect(parsed?.storage.collectionSummary?.reclaimableCount).toBe(3);
        expect(parsed?.storage.collectionSummary?.activeSizeBytes).toBe(2048);
        expect(parsed?.storage.cleanupTotals?.itemsHandled).toBe(4);
        expect(parsed?.storage.cleanupTotals?.bytesHandled).toBe(4096);
        expect(JSON.stringify(parsed)).not.toContain('Sentinel');
    });

    it('rejects cap+1 collections and any invalid collection without partial success', () => {
        expect(parseMaintainerrDashboard(dashboard(
            Array.from({ length: 501 }, (_, index) => collection(index + 1)),
        ))).toBeNull();
        expect(parseMaintainerrDashboard(dashboard([
            collection(1),
            { ...collection(2), id: 0 },
            collection(3),
        ]))).toBeNull();
    });

    it('rejects oversized, controlled, and unsafe numeric values', () => {
        expect(parseMaintainerrDashboard(dashboard([
            { ...collection(), title: 'x'.repeat(301) },
        ]))).toBeNull();
        expect(parseMaintainerrDashboard(dashboard([
            { ...collection(), title: 'unsafe\u0000title' },
        ]))).toBeNull();
        expect(parseMaintainerrDashboard(dashboard([
            { ...collection(), totalSizeBytes: Number.MAX_SAFE_INTEGER + 1 },
        ]))).toBeNull();
        expect(parseMaintainerrDashboard(dashboard([
            { ...collection(), type: 'Movie' },
        ]))).toBeNull();
        expect(parseMaintainerrDashboard(dashboard([
            { ...collection(), mediaCount: 1_000_001 },
        ]))).toBeNull();
        expect(parseMaintainerrDashboard(dashboard([
            { ...collection(), deleteAfterDays: 36_501 },
        ]))).toBeNull();
        expect(parseMaintainerrDashboard(dashboard([
            { ...collection(), id: 2_147_483_648 },
        ]))).toBeNull();

        const excessiveRuleCount = dashboard();
        (excessiveRuleCount.rules as Record<string, unknown>).count = 100_001;
        expect(parseMaintainerrDashboard(excessiveRuleCount)).toBeNull();
    });

    it('requires the exact server-published collection counters and identity warning shape', () => {
        for (const key of ['handledMediaAmount', 'lastDurationInSeconds', 'handledMediaSizeBytes']) {
            const candidate = collection();
            delete candidate[key];
            expect(parseMaintainerrDashboard(dashboard([candidate])), key).toBeNull();
        }

        const unknownIdentity = dashboard();
        unknownIdentity.status = {
            ready: true,
            degraded: true,
            version: '3.18.0',
            jellyfinMode: true,
            capable: true,
            identityMatch: false,
            identityWarning: 'identity_unknown',
        };
        expect(parseMaintainerrDashboard(unknownIdentity)?.status.identityWarning).toBe('identity_unknown');

        const missingWarning = dashboard();
        missingWarning.status = {
            ready: true,
            degraded: true,
            version: '3.18.0',
            jellyfinMode: true,
            capable: true,
            identityMatch: false,
        };
        expect(parseMaintainerrDashboard(missingWarning)).toBeNull();

        const contradictoryWarning = dashboard();
        (contradictoryWarning.status as Record<string, unknown>).identityWarning = 'identity_mismatch';
        expect(parseMaintainerrDashboard(contradictoryWarning)).toBeNull();
    });

    it('requires canonical server timestamps and atomic partial rule execution fields', () => {
        const invalidGeneratedAt = dashboard();
        (invalidGeneratedAt.storage as Record<string, unknown>).generatedAt = 'next Thursday';
        expect(parseMaintainerrDashboard(invalidGeneratedAt)).toBeNull();
        for (const timestamp of [
            '2026-02-30T00:00:00.0000000+00:00',
            '2026-07-26T25:00:00.0000000+00:00',
            '2026-07-26T00:00:00.0000000+14:01',
            '2026-07-26T00:00:00Z',
            '2026-07-26T00:00:00.0000000Z',
        ]) {
            const invalid = dashboard();
            (invalid.storage as Record<string, unknown>).generatedAt = timestamp;
            expect(parseMaintainerrDashboard(invalid), timestamp).toBeNull();
        }

        const validLastRun = dashboard();
        validLastRun.overlays = {
            state: 'available',
            status: 'idle',
            lastRun: '2026-07-26T00:00:00.0000000+00:00',
        };
        expect(parseMaintainerrDashboard(validLastRun)?.overlays.lastRun)
            .toBe('2026-07-26T00:00:00.0000000+00:00');
        const invalidLastRun = dashboard();
        invalidLastRun.overlays = {
            state: 'available',
            status: 'idle',
            lastRun: '2026-07-26',
        };
        expect(parseMaintainerrDashboard(invalidLastRun)).toBeNull();

        const executionOnly = dashboard();
        executionOnly.rules = {
            state: 'partial',
            error: 'timeout',
            processingQueue: false,
            executing: false,
            pendingCount: 0,
            queueCount: 0,
        };
        expect(parseMaintainerrDashboard(executionOnly)?.rules).toEqual(executionOnly.rules);

        const splitExecution = dashboard();
        splitExecution.rules = {
            state: 'partial',
            error: 'timeout',
            processingQueue: false,
        };
        expect(parseMaintainerrDashboard(splitExecution)).toBeNull();
    });

    it('requires server-resolved absolute dashboard links when links are present', () => {
        const valid = dashboard();
        valid.links = {
            overview: 'https://maintainerr.example/base/overview',
            rules: 'https://maintainerr.example/base/rules',
            storageMetrics: 'https://maintainerr.example/base/storage-metrics',
        };
        expect(parseMaintainerrDashboard(valid)?.links).toEqual(valid.links);

        const relative = dashboard();
        relative.links = { overview: '/overview' };
        expect(parseMaintainerrDashboard(relative)).toBeNull();
        const relativeCollection = dashboard([{ ...collection(), href: '/collections/1' }]);
        expect(parseMaintainerrDashboard(relativeCollection)).toBeNull();
    });

    it('keeps unavailable, partial, and overlay states distinct from genuine zero data', () => {
        const unavailable = dashboard();
        unavailable.storage = { state: 'unavailable', error: 'timeout' };
        unavailable.rules = {
            state: 'partial',
            error: 'timeout',
            count: 0,
        };
        unavailable.overlays = {
            state: 'unsupported',
            error: 'unsupported',
        };
        const parsed = parseMaintainerrDashboard(unavailable);
        expect(parsed?.storage).toEqual({ state: 'unavailable', error: 'timeout' });
        expect(parsed?.rules).toEqual({ state: 'partial', error: 'timeout', count: 0 });
        expect(parsed?.overlays).toEqual({ state: 'unsupported', error: 'unsupported' });

        const invalidOverlay = dashboard();
        invalidOverlay.overlays = { state: 'available', status: 'busy' };
        expect(parseMaintainerrDashboard(invalidOverlay)).toBeNull();
    });
});

describe('Maintainerr collection-content parsing', () => {
    const item = (id: number): Record<string, unknown> => ({ id, title: `Item ${id}`, type: 'movie' });

    it('uses 1-based bounded pages and rejects cap+1 or one invalid item', () => {
        expect(parseMaintainerrCollectionContent({
            page: 1,
            size: 50,
            totalSize: 50,
            items: Array.from({ length: 50 }, (_, index) => item(index + 1)),
        })?.items).toHaveLength(50);
        expect(parseMaintainerrCollectionContent({
            page: 1,
            size: 50,
            totalSize: 51,
            items: Array.from({ length: 51 }, (_, index) => item(index + 1)),
        })).toBeNull();
        expect(parseMaintainerrCollectionContent({
            page: 1,
            size: 3,
            totalSize: 3,
            items: [item(1), { ...item(2), title: '' }, item(3)],
        })).toBeNull();
        expect(parseMaintainerrCollectionContent({
            page: 0,
            size: 1,
            totalSize: 1,
            items: [item(1)],
        })).toBeNull();
    });

    it('rejects impossible counts, false-empty pages, and offsets', () => {
        expect(parseMaintainerrCollectionContent({
            page: 1,
            size: 2,
            totalSize: 3,
            items: [item(1), item(2), item(3)],
        })).toBeNull();
        expect(parseMaintainerrCollectionContent({
            page: 2,
            size: 2,
            totalSize: 3,
            items: [item(3), item(4)],
        })).toBeNull();
        expect(parseMaintainerrCollectionContent({
            page: 3,
            size: 2,
            totalSize: 3,
            items: [],
        })).toBeNull();
        expect(parseMaintainerrCollectionContent({
            page: 1,
            size: 2,
            totalSize: 1,
            items: [],
        })).toBeNull();
        expect(parseMaintainerrCollectionContent({
            page: 2,
            size: 2,
            totalSize: 3,
            items: [],
        })).toBeNull();
        expect(parseMaintainerrCollectionContent({
            page: 2,
            size: 2,
            totalSize: 0,
            items: [],
        })).toBeNull();
        expect(parseMaintainerrCollectionContent({
            page: 1,
            size: 2,
            totalSize: 1_000_001,
            items: [item(1)],
        })).toBeNull();
        expect(parseMaintainerrCollectionContent({
            page: 1,
            size: 2,
            totalSize: 0,
            items: [],
        })).toEqual({
            page: 1,
            size: 2,
            totalSize: 0,
            items: [],
        });
    });
});

describe('Maintainerr outbound-link allowlist', () => {
    it.each([
        '/overview',
        '/rules',
        '/storage-metrics',
        '/collections/1',
        '/collections/42/exclusions',
        'https://maintainerr.example/overview',
        'https://maintainerr.example/base/collections/9',
    ])('accepts the approved route tail %s', (href) => {
        expect(optionalHref(href)).toBeTruthy();
    });

    it.each([
        'javascript:alert(1)',
        '//maintainerr.example/rules',
        'https://user:pass@maintainerr.example/rules',
        '/rules?token=secret',
        '/rules#fragment',
        '/collections/1\\exclusions',
        '/base/../rules',
        '/base/%2e%2e/rules',
        '/base/%2frules',
        '/base/%5crules',
        '/base/%252frules',
        '/api/rules',
        '/collections/0',
        '/collections/1/delete',
    ])('rejects hostile or unapproved href %s', (href) => {
        expect(optionalHref(href)).toBeUndefined();
    });
});

describe('Maintainerr item-status DTO parsing', () => {
    it('enforces the exact regular-user shape', () => {
        expect(parseMaintainerrItemStatus({
            protectedFromCleanup: true,
            manuallyManaged: false,
        }, false)).toEqual({
            protectedFromCleanup: true,
            manuallyManaged: false,
        });
        expect(parseMaintainerrItemStatus({
            protectedFromCleanup: true,
            manuallyManaged: false,
            excludedFrom: [],
        }, false)).toBeNull();
    });

    it('enforces exact admin keys, reference caps, and label bounds', () => {
        const valid = {
            protectedFromCleanup: true,
            manuallyManaged: false,
            excludedFrom: [{ label: '<img src=x onerror=alert(1)>', href: '/collections/1/exclusions' }],
            manuallyAddedTo: [],
        };
        expect(parseMaintainerrItemStatus(valid, true)).toEqual(valid);
        expect(parseMaintainerrItemStatus({ ...valid, secret: 'over-fetch' }, true)).toBeNull();
        expect(parseMaintainerrItemStatus({
            ...valid,
            excludedFrom: Array.from({ length: 101 }, () => ({ label: 'Rule' })),
        }, true)).toBeNull();
        expect(parseMaintainerrItemStatus({
            ...valid,
            excludedFrom: [{ label: 'x'.repeat(257) }],
        }, true)).toBeNull();
    });
});
