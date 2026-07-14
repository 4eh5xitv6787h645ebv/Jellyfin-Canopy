import { describe, expect, it, vi } from 'vitest';
import {
    fetchCompleteOffsetCollection,
    IncompleteCollectionError,
    readCollectionItems,
    readCollectionPagination,
    type CollectionPage,
    type CollectionPageRequest,
} from './paged-collection';

/* eslint-disable @typescript-eslint/require-await -- async page-loader fakes mirror the production contract */

interface Row {
    id: string;
    value?: string;
}

function collect(
    fetchPage: (request: CollectionPageRequest) => Promise<CollectionPage<Row>>,
    overrides: Partial<Parameters<typeof fetchCompleteOffsetCollection<Row>>[0]> = {},
): Promise<Row[]> {
    return fetchCompleteOffsetCollection({
        pageSize: 500,
        fetchPage,
        identity: (row) => row.id,
        ...overrides,
    });
}

describe('readCollectionPagination', () => {
    it('accepts and merges matching top-level and Seerr pageInfo metadata', () => {
        expect(readCollectionPagination({
            page: 2,
            totalPages: 3,
            totalResults: 7,
            pageInfo: { page: 2, pages: 3, results: 7 },
        })).toEqual({ page: 2, totalPages: 3, totalResults: 7 });
    });

    it('rejects missing, malformed, and contradictory metadata', () => {
        expect(() => readCollectionPagination({})).toThrow('completion metadata was missing');
        expect(() => readCollectionPagination({ totalPages: '2' })).toThrow(
            'totalPages was not a non-negative integer',
        );
        expect(() => readCollectionPagination({
            totalPages: 2,
            pageInfo: { pages: 3 },
        })).toThrow('top-level and pageInfo total pages values disagreed');
        expect(() => readCollectionPagination({ totalPages: 1, pageInfo: null })).toThrow(
            'pageInfo was not an object',
        );
    });

    it('requires the configured collection property to be an array', () => {
        expect(readCollectionItems({ requests: [{ id: 1 }] }, 'requests')).toEqual([{ id: 1 }]);
        expect(() => readCollectionItems({ requests: null }, 'requests')).toThrow(
            'did not contain a requests array',
        );
    });
});

describe('fetchCompleteOffsetCollection', () => {
    it('advances skip by actual rows when the server caps the requested take', async () => {
        const fetchPage = vi.fn(async ({ page, skip }: CollectionPageRequest) => {
            const pages: Record<number, Row[]> = {
                1: [{ id: 'a' }, { id: 'b' }],
                2: [{ id: 'c' }],
                3: [{ id: 'd' }, { id: 'e' }],
            };
            return {
                items: pages[page] ?? [],
                page,
                totalPages: 3,
                totalResults: 5,
                requestedSkip: skip,
            };
        });

        await expect(collect(fetchPage)).resolves.toEqual([
            { id: 'a' },
            { id: 'b' },
            { id: 'c' },
            { id: 'd' },
            { id: 'e' },
        ]);
        expect(fetchPage.mock.calls.map(([request]) => request.skip)).toEqual([0, 2, 3, 0, 2, 3]);
        expect(fetchPage.mock.calls.every(([request]) => request.take === 500)).toBe(true);
    });

    it('rejects duplicate source identities within one response', async () => {
        const fetchPage = vi.fn(async ({ page }: CollectionPageRequest) => ({
            items: page === 1
                ? [{ id: 'a', value: 'first' }, { id: 'a', value: 'first' }]
                : [{ id: 'b' }, { id: 'c' }],
            page,
            totalPages: 2,
            totalResults: 4,
        }));

        await expect(collect(fetchPage)).rejects.toThrow('was repeated');
    });

    it.each([
        { name: 'missing', identity: undefined },
        { name: 'empty', identity: '' },
        { name: 'blank', identity: '   ' },
    ])('rejects a $name source identity instead of using the row fingerprint', async ({ identity }) => {
        await expect(fetchCompleteOffsetCollection({
            pageSize: 1,
            fetchPage: async () => ({
                items: [{ value: 'malformed-source-row' }],
                page: 1,
                totalPages: 1,
                totalResults: 1,
            }),
            identity: () => identity,
        })).rejects.toThrow('identity was missing or empty');
    });

    it('rejects one identity referring to conflicting rows', async () => {
        await expect(collect(async ({ page }) => ({
            items: [{ id: 'a', value: page === 1 ? 'approved' : 'processing' }],
            page,
            totalPages: 2,
            totalResults: 2,
        }))).rejects.toThrow('referred to conflicting rows');
    });

    it('rejects a partial identity overlap across offset pages', async () => {
        await expect(collect(async ({ page }) => ({
            items: page === 1
                ? [{ id: 'a' }, { id: 'b' }]
                : [{ id: 'b' }, { id: 'c' }],
            page,
            totalPages: 2,
            totalResults: 4,
        }))).rejects.toThrow('was repeated');
    });

    it('rejects shift-left churn that preserves total and has no duplicate identities', async () => {
        let scan = 0;
        await expect(collect(async ({ page }) => {
            if (page === 1) scan += 1;
            const rows = scan === 1
                ? (page === 1 ? [{ id: '1' }, { id: '2' }] : [{ id: '4' }, { id: '5' }])
                : (page === 1 ? [{ id: '2' }, { id: '3' }] : [{ id: '4' }, { id: '5' }]);
            return {
                items: rows,
                page,
                totalPages: 2,
                totalResults: 4,
            };
        }, { pageSize: 2 })).rejects.toThrow('consecutive complete collection scans disagreed');
    });

    it('rejects a continuation page containing only previously seen identities', async () => {
        await expect(collect(async ({ page }) => ({
            items: page === 1
                ? [{ id: 'a' }, { id: 'b' }]
                : [{ id: 'b' }, { id: 'a' }],
            page,
            totalPages: 2,
            totalResults: 4,
        }))).rejects.toThrow('was repeated');
    });

    it('requires every supplied completion signal to agree', async () => {
        const fetchPage = vi.fn(async () => ({
            items: [{ id: 'a' }, { id: 'b' }],
            page: 1,
            totalPages: 1,
            totalResults: 3,
        }));

        await expect(collect(fetchPage)).rejects.toThrow(
            'required page 2 beyond totalPages 1',
        );
        expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('rejects totals that change during a snapshot read', async () => {
        const fetchPage = vi.fn(async ({ page }: CollectionPageRequest) => ({
            items: [{ id: String(page) }],
            page,
            totalPages: 2,
            totalResults: page === 1 ? 2 : 3,
        }));

        await expect(collect(fetchPage)).rejects.toThrow(
            'totalResults changed during one collection read',
        );
    });

    it('rejects a non-advancing reported page and a repeated page body', async () => {
        await expect(collect(async ({ page }) => ({
            items: [{ id: String(page) }],
            page: 1,
            totalPages: 2,
        }))).rejects.toThrow('reported page 1 while page 2 was requested');

        await expect(collect(async () => ({
            items: [{ id: 'same' }],
            totalPages: 2,
        }))).rejects.toThrow('repeated a previously returned page');
    });

    it('rejects premature empty pages without exposing the accumulated prefix', async () => {
        const fetchPage = vi.fn(async ({ page }: CollectionPageRequest) => ({
            items: page === 1 ? [{ id: 'prefix' }] : [],
            page,
            totalPages: 3,
            totalResults: 3,
        }));

        const result = collect(fetchPage);
        await expect(result).rejects.toBeInstanceOf(IncompleteCollectionError);
        await expect(result).rejects.toThrow('empty page after collection rows');
    });

    it('rejects advertised or observed page/item cap overruns', async () => {
        await expect(collect(async () => ({
            items: [{ id: 'a' }],
            totalPages: 3,
        }), { maximumPages: 2 })).rejects.toThrow('2 page safety bound');

        await expect(collect(async () => ({
            items: [{ id: 'a' }],
            totalResults: 3,
        }), { maximumItems: 2 })).rejects.toThrow('2 item safety bound');

        await expect(collect(async () => ({
            items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
            totalPages: 1,
        }), { maximumItems: 2 })).rejects.toThrow('2 item safety bound');
    });

    it('propagates loader failures and cancellation without returning partial rows', async () => {
        const failure = new Error('page two is unavailable');
        await expect(collect(async ({ page }) => {
            if (page === 2) throw failure;
            return { items: [{ id: 'prefix' }], totalPages: 2 };
        })).rejects.toBe(failure);

        const controller = new AbortController();
        const reason = new DOMException('navigation', 'AbortError');
        await expect(collect(async () => {
            controller.abort(reason);
            return { items: [{ id: 'never-published' }], totalPages: 1 };
        }, { signal: controller.signal })).rejects.toBe(reason);
    });

    it('accepts a proven empty collection', async () => {
        await expect(collect(async () => ({
            items: [],
            page: 1,
            totalPages: 0,
            totalResults: 0,
        }))).resolves.toEqual([]);
    });
});
