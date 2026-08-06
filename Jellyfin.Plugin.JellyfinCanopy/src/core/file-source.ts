/** Canonical file-source values shared by poster badges and item details. */
export const FILE_SOURCE_VALUES = [
    'BluRay',
    'HD DVD',
    'DVD',
    'VHS',
    'HDTV',
    'Physical',
] as const;

export type FileSource = typeof FILE_SOURCE_VALUES[number];

/**
 * Bump when detection semantics change so persisted quality-tag results cannot
 * disagree with the details surface after an upgrade.
 */
export const FILE_SOURCE_DETECTION_VERSION = 3;

interface FileSourceRecord {
    Name?: unknown;
    Path?: unknown;
}

interface FileSourceItem extends FileSourceRecord {
    MediaSources?: unknown;
}

const SPECIFIC_PATTERNS: ReadonlyArray<readonly [FileSource, RegExp]> = [
    ['BluRay', /(?:^|[^a-z0-9])(?:blu[ ._-]?ray(?:[ ._-]?(?:rip|remux))?|bd[ ._-]?(?:rip|remux))(?=$|[^a-z0-9])/],
    ['HD DVD', /(?:^|[^a-z0-9])hd[ ._-]?dvd(?=$|[^a-z0-9])/],
    ['DVD', /(?:^|[^a-z0-9])dvd(?:[ ._-]?(?:rip|remux))?(?=$|[^a-z0-9])/],
    ['VHS', /(?:^|[^a-z0-9])vhs(?=$|[^a-z0-9])/],
    ['HDTV', /(?:^|[^a-z0-9])hdtv(?=$|[^a-z0-9])/],
];

function asSignal(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function hasUsableSignal(record: FileSourceRecord): boolean {
    return Boolean(asSignal(record.Name) || asSignal(record.Path));
}

/** Resolve one item/version record without inspecting any other version. */
function detectRecord(record: FileSourceRecord): FileSource | null {
    const context = [asSignal(record.Name), asSignal(record.Path)]
        .filter(Boolean)
        .join(' | ')
        .toLowerCase();
    if (!context.includes('.disc')) return null;

    for (const [source, pattern] of SPECIFIC_PATTERNS) {
        if (pattern.test(context)) return source;
    }
    return 'Physical';
}

/**
 * Detect a Jellyfin media-stub source without guessing across versions.
 *
 * Every usable MediaSource must resolve to the same canonical value. A mix of
 * ordinary/unknown and recognized versions, or conflicting recognized values,
 * is ambiguous and therefore silent. When Jellyfin supplies no usable source
 * records, the item's own Name/Path is the fallback used by legacy poster data.
 */
export function detectFileSource(value: unknown): FileSource | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as FileSourceItem;
    const sources = Array.isArray(item.MediaSources)
        ? item.MediaSources.filter((source): source is FileSourceRecord =>
            Boolean(source) && typeof source === 'object' && !Array.isArray(source)
                && hasUsableSignal(source as FileSourceRecord))
        : [];

    if (sources.length === 0) return detectRecord(item);

    const detected = sources.map(detectRecord);
    if (detected.some((source) => source === null)) return null;
    const distinct = new Set(detected as FileSource[]);
    if (distinct.size !== 1) return null;

    const source = detected[0] as FileSource;
    // Item and source DTOs are two fidelity views of the same version. Generic
    // Physical evidence on either side yields to a specific signal; only two
    // different specific values are genuinely ambiguous.
    const itemSource = detectRecord(item);
    if (!itemSource || itemSource === source || itemSource === 'Physical') return source;
    if (source === 'Physical') return itemSource;
    return null;
}
