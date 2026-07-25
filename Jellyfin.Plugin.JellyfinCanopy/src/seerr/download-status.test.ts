import { describe, expect, it, vi } from 'vitest';
import {
    formatSeerrDownloadTimeRemaining,
    readSeerrDownloadStatuses,
    seerrDownloadLifecycleLabel,
} from './download-status';

describe('Seerr download status projection', () => {
    it('accepts only the server-owned allowlist and degrades future lifecycle values', () => {
        const statuses = readSeerrDownloadStatuses([
            {
                lifecycle: 'downloading',
                progress: 42.5,
                timeRemaining: '00:10:00',
                seasonNumber: 2,
                title: 'must not be consumed',
                downloadId: 'must not be consumed',
                path: '/must/not/be/consumed',
            },
            {
                lifecycle: 'future-state',
                progress: 101,
                timeRemaining: 'arbitrary upstream text',
                seasonNumber: -1,
            },
            'malformed',
        ]);

        expect(statuses).toEqual([
            {
                lifecycle: 'downloading',
                progress: 42.5,
                timeRemaining: '00:10:00',
                seasonNumber: 2,
            },
            {
                lifecycle: 'unknown',
                progress: null,
                timeRemaining: null,
                seasonNumber: null,
            },
        ]);
        expect(JSON.stringify(statuses)).not.toContain('must not be consumed');
    });

    it('uses translated allowlisted lifecycle labels without reflecting a raw status', () => {
        const translate = vi.fn((key: string) => `translated:${key}`);

        expect(seerrDownloadLifecycleLabel('warning', translate))
            .toBe('translated:downloads_lifecycle_warning');
        expect(translate).toHaveBeenCalledWith('downloads_lifecycle_warning');
    });

    it.each([
        ['00:00:30', 'downloads_eta_soon', null, 'bientôt'],
        ['00:15:00', 'downloads_eta_minutes', 15, 'dans 15 minutes'],
        ['01:00:00', 'downloads_eta_hour', 1, 'dans 1 heure'],
        ['02:00:00', 'downloads_eta_hours', 2, 'dans 2 heures'],
        ['1.00:00:00', 'downloads_eta_day', 1, 'dans 1 jour'],
        ['2.00:00:00', 'downloads_eta_days', 2, 'dans 2 jours'],
    ])('localizes validated duration %s with plural/interpolation key %s', (
        duration,
        expectedKey,
        expectedCount,
        expected
    ) => {
        const templates: Record<string, string> = {
            downloads_eta_soon: 'bientôt',
            downloads_eta_minutes: 'dans {count} minutes',
            downloads_eta_hour: 'dans {count} heure',
            downloads_eta_hours: 'dans {count} heures',
            downloads_eta_day: 'dans {count} jour',
            downloads_eta_days: 'dans {count} jours',
        };
        const translate = vi.fn((key: string, params?: Record<string, unknown>) => (
            templates[key]?.replace('{count}', String(params?.count)) || key
        ));

        expect(formatSeerrDownloadTimeRemaining(duration, translate)).toBe(expected);
        expect(translate).toHaveBeenCalledWith(
            expectedKey,
            expectedCount == null ? undefined : { count: expectedCount }
        );
    });

    it.each([
        '99:99:99',
        '999.00:00:00',
        'private status message',
    ])('rejects invalid or private duration text %s without translating it', (duration) => {
        const translate = vi.fn((key: string) => key);
        expect(formatSeerrDownloadTimeRemaining(duration, translate)).toBeNull();
        expect(translate).not.toHaveBeenCalled();
    });
});
