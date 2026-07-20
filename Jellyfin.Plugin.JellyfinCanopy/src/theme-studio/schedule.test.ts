import { describe, expect, it } from 'vitest';
import { themeConfiguration } from '../test/theme-studio-fixture';
import { millisecondsUntilScheduleRefresh, selectThemeSchedule } from './schedule';

describe('Theme Studio seasonal schedule', () => {
    it('uses holiday, priority, and stable id precedence without depending on input order', () => {
        const configuration = themeConfiguration();
        configuration.ScheduleTimeZone = 'utc';
        configuration.Schedule = [
            { Id: 'z-season', ProfileId: 'default', Kind: 'season', StartMonthDay: '01-01', EndMonthDay: '12-31', Priority: 100, Enabled: true },
            { Id: 'z-holiday', ProfileId: 'default', Kind: 'holiday', StartMonthDay: '07-20', EndMonthDay: '07-20', Priority: 50, Enabled: true },
            { Id: 'a-holiday', ProfileId: 'default', Kind: 'holiday', StartMonthDay: '07-20', EndMonthDay: '07-20', Priority: 50, Enabled: true },
        ];
        expect(selectThemeSchedule(configuration, new Date('2026-07-20T12:00:00Z'))).toEqual({
            id: 'a-holiday', profileId: 'default', kind: 'holiday',
        });
        expect(configuration.Schedule.map((entry) => entry.Id)).toEqual(['z-season', 'z-holiday', 'a-holiday']);
    });

    it('supports wrapped seasons, disabled entries, and legacy season defaults', () => {
        const configuration = themeConfiguration();
        configuration.Schedule = [
            { Id: 'disabled', ProfileId: 'default', Kind: 'holiday', StartMonthDay: '01-02', EndMonthDay: '01-02', Priority: 100, Enabled: false },
            { Id: 'summer-south', ProfileId: 'default', StartMonthDay: '12-01', EndMonthDay: '02-28', Priority: 20, Enabled: true },
        ];
        expect(selectThemeSchedule(configuration, new Date(2027, 0, 2, 12))).toEqual({
            id: 'summer-south', profileId: 'default', kind: 'season',
        });
        expect(selectThemeSchedule(configuration, new Date(2027, 5, 2, 12))).toBeNull();
    });

    it('returns one bounded civil-midnight delay for local and UTC clocks', () => {
        expect(millisecondsUntilScheduleRefresh(new Date('2026-07-20T23:59:59Z'), 'utc')).toBe(1_100);
        expect(millisecondsUntilScheduleRefresh(new Date('2026-07-20T12:00:00Z'), 'utc'))
            .toBe(6 * 60 * 60 * 1_000);
        const local = millisecondsUntilScheduleRefresh(new Date(2026, 6, 20, 23, 59, 59), 'local');
        expect(local).toBeGreaterThanOrEqual(1_000);
        expect(local).toBeLessThanOrEqual(1_100);
    });
});
