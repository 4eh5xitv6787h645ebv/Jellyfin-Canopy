/**
 * One normalized page from an offset/page collection endpoint.
 *
 * At least one completion signal (`totalPages` or `totalResults`) is required.
 * When an endpoint supplies both, the collector requires both to reach their
 * reported end before publishing the collection.
 */
export interface CollectionPage<T> {
    items: readonly T[];
    page?: number;
    totalPages?: number;
    totalResults?: number;
}

/** The request coordinates passed to a collection page loader. */
export interface CollectionPageRequest {
    page: number;
    skip: number;
    take: number;
    signal?: AbortSignal;
}

export interface CompleteOffsetCollectionOptions<T> {
    pageSize: number;
    fetchPage(request: CollectionPageRequest): Promise<CollectionPage<T>>;
    identity(item: T): string | number | null | undefined;
    signal?: AbortSignal;
    maximumPages?: number;
    maximumItems?: number;
}

export interface CollectionPagination {
    page?: number;
    totalPages?: number;
    totalResults?: number;
}

/** Raised when a paged endpoint cannot prove that its snapshot is complete. */
export class IncompleteCollectionError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'IncompleteCollectionError';
    }
}

const DEFAULT_MAXIMUM_PAGES = 1000;
const DEFAULT_MAXIMUM_ITEMS = 100_000;

function incomplete(message: string): never {
    throw new IncompleteCollectionError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalNonNegativeInteger(
    owner: Record<string, unknown>,
    property: string,
): number | undefined {
    if (!Object.prototype.hasOwnProperty.call(owner, property)) return undefined;

    const value = owner[property];
    if (!Number.isInteger(value) || (value as number) < 0) {
        incomplete(`${property} was not a non-negative integer`);
    }

    return value as number;
}

function mergePaginationValue(
    name: string,
    primary: number | undefined,
    alternate: number | undefined,
): number | undefined {
    if (alternate === undefined) return primary;
    if (primary !== undefined && primary !== alternate) {
        incomplete(`top-level and pageInfo ${name} values disagreed`);
    }
    return alternate;
}

/**
 * Reads either the Seerr `pageInfo.page/pages/results` shape or the equivalent
 * top-level `page/totalPages/totalResults` shape. If both shapes are present,
 * duplicate values must agree.
 */
export function readCollectionPagination(envelope: unknown): CollectionPagination {
    if (!isRecord(envelope)) incomplete('collection response was not an object');

    let page = readOptionalNonNegativeInteger(envelope, 'page');
    let totalPages = readOptionalNonNegativeInteger(envelope, 'totalPages');
    let totalResults = readOptionalNonNegativeInteger(envelope, 'totalResults');

    if (Object.prototype.hasOwnProperty.call(envelope, 'pageInfo')) {
        const pageInfo = envelope.pageInfo;
        if (!isRecord(pageInfo)) incomplete('pageInfo was not an object');

        page = mergePaginationValue(
            'page',
            page,
            readOptionalNonNegativeInteger(pageInfo, 'page'),
        );
        totalPages = mergePaginationValue(
            'total pages',
            totalPages,
            readOptionalNonNegativeInteger(pageInfo, 'pages'),
        );
        totalResults = mergePaginationValue(
            'total results',
            totalResults,
            readOptionalNonNegativeInteger(pageInfo, 'results'),
        );
    }

    if (totalPages === undefined && totalResults === undefined) {
        incomplete('completion metadata was missing');
    }

    return { page, totalPages, totalResults };
}

/** Runtime-safe array extraction for a JSON collection envelope. */
export function readCollectionItems(envelope: unknown, property = 'results'): unknown[] {
    if (!isRecord(envelope)) incomplete('collection response was not an object');
    const items = envelope[property];
    if (!Array.isArray(items)) incomplete(`collection response did not contain a ${property} array`);
    return items;
}

function fingerprint(value: unknown): string {
    try {
        const serialized = JSON.stringify(value);
        return serialized === undefined
            ? `${typeof value}:${String(value)}`
            : serialized;
    } catch {
        return incomplete('collection rows could not be fingerprinted');
    }
}

function normalizedIdentity(value: string | number | null | undefined): string {
    if (value === null
        || value === undefined
        || (typeof value === 'string' && value.trim() === '')) {
        return incomplete('collection row identity was missing or empty');
    }
    return `${typeof value}:${String(value)}`;
}

function requirePositiveInteger(value: number, name: string): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive integer`);
    }
}

/**
 * Fetches and publishes only a proven-complete collection snapshot.
 *
 * The next offset advances by the number of rows actually returned, rather
 * than the requested page size. Repeated source identities invalidate the
 * attempt because an offset snapshot with overlap cannot prove completeness.
 * Any malformed/changing metadata, repeated page, premature empty page, cap,
 * or loader failure rejects the promise; accumulated partial rows never leave
 * this function. Abort errors/reasons propagate unchanged.
 */
export async function fetchCompleteOffsetCollection<T>(
    options: CompleteOffsetCollectionOptions<T>,
): Promise<T[]> {
    const firstPass = await fetchOneCompleteOffsetPass(options);
    const secondPass = await fetchOneCompleteOffsetPass(options);

    if (firstPass.length !== secondPass.length) {
        return incomplete('two consecutive complete collection scans disagreed');
    }
    for (let index = 0; index < firstPass.length; index += 1) {
        const firstIdentity = normalizedIdentity(options.identity(firstPass[index]));
        const secondIdentity = normalizedIdentity(options.identity(secondPass[index]));
        if (firstIdentity !== secondIdentity
            || fingerprint(firstPass[index]) !== fingerprint(secondPass[index])) {
            return incomplete('two consecutive complete collection scans disagreed');
        }
    }

    return secondPass;
}

async function fetchOneCompleteOffsetPass<T>(
    options: CompleteOffsetCollectionOptions<T>,
): Promise<T[]> {
    requirePositiveInteger(options.pageSize, 'pageSize');
    const maximumPages = options.maximumPages ?? DEFAULT_MAXIMUM_PAGES;
    const maximumItems = options.maximumItems ?? DEFAULT_MAXIMUM_ITEMS;
    requirePositiveInteger(maximumPages, 'maximumPages');
    requirePositiveInteger(maximumItems, 'maximumItems');

    const items: T[] = [];
    const identities = new Set<string>();
    const identityRows = new Map<string, string>();
    const pageFingerprints = new Set<string>();
    let requestedPage = 1;
    let skip = 0;
    let rawItemsRead = 0;
    let expectedTotalPages: number | undefined;
    let expectedTotalResults: number | undefined;
    let previousReportedPage: number | undefined;

    while (requestedPage <= maximumPages) {
        options.signal?.throwIfAborted();

        if (expectedTotalPages !== undefined
            && expectedTotalPages > 0
            && requestedPage > expectedTotalPages) {
            incomplete(
                `pagination required page ${requestedPage} beyond totalPages ${expectedTotalPages}`,
            );
        }

        const collectionPage = await options.fetchPage({
            page: requestedPage,
            skip,
            take: options.pageSize,
            signal: options.signal,
        });
        options.signal?.throwIfAborted();

        const runtimePage: unknown = collectionPage;
        if (!isRecord(runtimePage) || !Array.isArray(runtimePage.items)) {
            incomplete(`page ${requestedPage} did not contain an items array`);
        }

        const pagination = readCollectionPagination(collectionPage);
        if (pagination.totalPages !== undefined) {
            if (expectedTotalPages !== undefined
                && expectedTotalPages !== pagination.totalPages) {
                incomplete('pagination totalPages changed during one collection read');
            }
            expectedTotalPages = pagination.totalPages;
        }
        if (pagination.totalResults !== undefined) {
            if (expectedTotalResults !== undefined
                && expectedTotalResults !== pagination.totalResults) {
                incomplete('pagination totalResults changed during one collection read');
            }
            expectedTotalResults = pagination.totalResults;
        }

        if (expectedTotalPages !== undefined && expectedTotalPages > maximumPages) {
            incomplete(`pagination exceeded the ${maximumPages} page safety bound`);
        }
        if (expectedTotalResults !== undefined && expectedTotalResults > maximumItems) {
            incomplete(`pagination exceeded the ${maximumItems} item safety bound`);
        }

        if (pagination.page !== undefined) {
            if (pagination.page !== requestedPage) {
                incomplete(
                    `pagination reported page ${pagination.page} while page ${requestedPage} was requested`,
                );
            }
            if (expectedTotalPages !== undefined
                && expectedTotalPages > 0
                && pagination.page > expectedTotalPages) {
                incomplete(
                    `pagination reported page ${pagination.page} beyond totalPages ${expectedTotalPages}`,
                );
            }
            if (previousReportedPage !== undefined
                && pagination.page <= previousReportedPage) {
                incomplete('pagination page metadata did not advance');
            }
            previousReportedPage = pagination.page;
        }

        const pageRows = collectionPage.items;
        const pageFingerprint = fingerprint(pageRows);
        if (pageRows.length > 0) {
            if (pageFingerprints.has(pageFingerprint)) {
                incomplete('pagination repeated a previously returned page');
            }
            pageFingerprints.add(pageFingerprint);
        }

        if (pageRows.length === 0 && rawItemsRead > 0) {
            incomplete('pagination returned an empty page after collection rows');
        }

        rawItemsRead += pageRows.length;
        if (rawItemsRead > maximumItems) {
            incomplete(`pagination exceeded the ${maximumItems} item safety bound`);
        }
        if (expectedTotalResults !== undefined && rawItemsRead > expectedTotalResults) {
            incomplete('pagination returned more rows than totalResults');
        }
        if (expectedTotalPages === 0 && pageRows.length > 0) {
            incomplete('pagination reported zero pages but returned collection rows');
        }
        if (expectedTotalResults === 0 && pageRows.length > 0) {
            incomplete('pagination reported zero results but returned collection rows');
        }

        const itemCountBeforePage = items.length;
        for (const item of pageRows) {
            const identity = normalizedIdentity(options.identity(item));
            const rowFingerprint = fingerprint(item);
            if (identities.has(identity)) {
                if (identityRows.get(identity) !== rowFingerprint) {
                    incomplete(`pagination identity '${identity}' referred to conflicting rows`);
                }
                // Supported source collections page unique primary-key rows.
                // Repetition means the response is malformed or an offset
                // boundary moved, so de-duplication cannot prove completeness.
                incomplete(`pagination identity '${identity}' was repeated`);
            }
            identities.add(identity);
            identityRows.set(identity, rowFingerprint);
            items.push(item);
        }

        if (requestedPage > 1
            && pageRows.length > 0
            && items.length === itemCountBeforePage) {
            incomplete('pagination continuation page made no identity progress');
        }

        const completeByPages = expectedTotalPages === undefined
            || expectedTotalPages === 0
            || requestedPage >= expectedTotalPages;
        const completeByResults = expectedTotalResults === undefined
            || items.length === expectedTotalResults;
        if (completeByPages && completeByResults) return items;

        if (pageRows.length === 0) {
            incomplete('pagination returned an empty page before the reported end');
        }

        skip += pageRows.length;
        requestedPage += 1;
    }

    return incomplete(`pagination exceeded the ${maximumPages} page safety bound`);
}
