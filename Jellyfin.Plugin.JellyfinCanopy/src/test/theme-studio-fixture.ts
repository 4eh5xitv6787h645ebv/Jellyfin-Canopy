import type { UserThemeConfiguration } from '../types/jc';

export function themeConfiguration(): UserThemeConfiguration {
    return {
        Revision: 3,
        SchemaVersion: 2,
        ActiveProfileId: 'default',
        Profiles: [{
            Id: 'default',
            Name: 'Default',
            BasePreset: 'canopy',
            PresetVersion: null,
            FreezePresetVersion: false,
            Palette: 'canopy-night',
            Accent: 'violet',
            Mode: 'system',
            Tokens: {},
            Responsive: { Phone: null, Tablet: null, Desktop: null, Wide: null, Tv: null },
            Accessibility: {
                Motion: 'system',
                Contrast: 'system',
                Transparency: 'system',
                FocusEmphasis: 'system',
                UnderlineLinks: false,
            },
        }],
        ScheduleTimeZone: 'local',
        Schedule: [],
        LegacyMigration: { JellyfishTheme: '', Completed: false },
    };
}
