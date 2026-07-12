// src/arr/search/format.ts
//
// Small pure formatters for the release rows. Kept separate so they can be unit-tested
// without a DOM.

/** Human-readable byte size (base-1024, one decimal for GB/MB). */
export function formatSize(bytes: number): string {
    if (!bytes || bytes <= 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    const decimals = unit >= 3 ? 2 : (unit === 2 ? 1 : 0);
    return `${value.toFixed(decimals)} ${units[unit]}`;
}

/** Compact age from hours: "5h", "3d", "2w", "4mo", "1y". */
export function formatAge(hours: number): string {
    if (!hours || hours < 0) return '—';
    if (hours < 24) return `${Math.round(hours)}h`;
    const days = hours / 24;
    if (days < 14) return `${Math.round(days)}d`;
    if (days < 60) return `${Math.round(days / 7)}w`;
    if (days < 365) return `${Math.round(days / 30)}mo`;
    return `${(days / 365).toFixed(1)}y`;
}
