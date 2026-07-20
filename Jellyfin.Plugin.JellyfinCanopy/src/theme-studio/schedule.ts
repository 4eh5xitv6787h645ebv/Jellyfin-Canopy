import type { ThemeScheduleEntry, UserThemeConfiguration } from '../types/jc';

export type ThemeScheduleTimeZone = 'local' | 'utc';

export interface ThemeScheduleSelection {
    readonly id: string;
    readonly profileId: string;
    readonly kind: 'season' | 'holiday';
}

const MAXIMUM_REEVALUATION_DELAY_MS = 6 * 60 * 60 * 1_000;

function timeZone(configuration: UserThemeConfiguration): ThemeScheduleTimeZone {
    return configuration.ScheduleTimeZone === 'utc' ? 'utc' : 'local';
}

function monthDay(now: Date, zone: ThemeScheduleTimeZone): string {
    const month = zone === 'utc' ? now.getUTCMonth() + 1 : now.getMonth() + 1;
    const day = zone === 'utc' ? now.getUTCDate() : now.getDate();
    return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function includesDay(entry: ThemeScheduleEntry, current: string): boolean {
    return entry.StartMonthDay <= entry.EndMonthDay
        ? current >= entry.StartMonthDay && current <= entry.EndMonthDay
        : current >= entry.StartMonthDay || current <= entry.EndMonthDay;
}

function compareIdentifier(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Resolves one deterministic schedule entry. Holidays outrank seasons;
 * priorities break ties within a kind, followed by the stable entry id.
 */
export function selectThemeSchedule(
    configuration: UserThemeConfiguration,
    now: Date,
): ThemeScheduleSelection | null {
    const current = monthDay(now, timeZone(configuration));
    const selected = configuration.Schedule.filter((entry) => entry.Enabled && includesDay(entry, current))
        .sort((left, right) => {
            const kind = Number((right.Kind ?? 'season') === 'holiday')
                - Number((left.Kind ?? 'season') === 'holiday');
            return kind || right.Priority - left.Priority || compareIdentifier(left.Id, right.Id);
        })[0];
    return selected ? Object.freeze({
        id: selected.Id,
        profileId: selected.ProfileId,
        kind: selected.Kind === 'holiday' ? 'holiday' : 'season',
    }) : null;
}

/**
 * Returns a bounded one-shot delay to the next calendar reevaluation. The
 * local branch constructs tomorrow in local civil time, so 23/25-hour DST
 * days remain correct. The six-hour ceiling also detects timezone changes.
 */
export function millisecondsUntilScheduleRefresh(
    now: Date,
    zone: ThemeScheduleTimeZone,
): number {
    const next = zone === 'utc'
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
        : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const untilBoundary = Math.max(1_000, next.getTime() - now.getTime() + 100);
    return Math.min(untilBoundary, MAXIMUM_REEVALUATION_DELAY_MS);
}
