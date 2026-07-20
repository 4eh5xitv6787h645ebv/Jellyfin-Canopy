import { describe, expect, it } from 'vitest';
import { themeConfiguration } from '../test/theme-studio-fixture';
import { ThemeEditorState } from './editor-state';

describe('ThemeEditorState', () => {
    it('isolates caller data and validates every mutation before publishing it', () => {
        const source = themeConfiguration();
        const state = new ThemeEditorState(source);
        source.Profiles[0].Name = 'Mutated outside';

        expect(state.activeProfile().Name).toBe('Default');
        expect(state.mutate((draft) => { draft.Profiles[0].Name = ''; })).toBe(false);
        expect(state.snapshot()).toMatchObject({ dirty: false, canUndo: false, canRedo: false });

        expect(state.updateActiveProfile((profile) => { profile.BasePreset = 'oled'; })).toBe(true);
        expect(state.activeProfile().BasePreset).toBe('oled');
        expect(state.snapshot()).toMatchObject({ dirty: true, canUndo: true, canRedo: false });
        expect(state.matchesCommitted(themeConfiguration())).toBe(true);
        const newer = themeConfiguration();
        newer.Revision += 1;
        expect(state.matchesCommitted(newer)).toBe(false);
        expect(state.matchesCommitted({ invalid: true })).toBe(false);
    });

    it('keeps a bounded reversible history and clears redo on a divergent edit', () => {
        const state = new ThemeEditorState(themeConfiguration());
        for (let index = 0; index < 70; index += 1) {
            expect(state.updateActiveProfile((profile) => { profile.Name = `Theme ${index}`; })).toBe(true);
        }

        let undoCount = 0;
        while (state.undo()) undoCount += 1;
        expect(undoCount).toBe(50);
        expect(state.snapshot().canRedo).toBe(true);
        expect(state.redo()).toBe(true);
        expect(state.updateActiveProfile((profile) => { profile.Palette = 'neutral'; })).toBe(true);
        expect(state.snapshot().canRedo).toBe(false);
    });

    it('creates, renames, switches and deletes valid profiles without dangling schedules', () => {
        const state = new ThemeEditorState(themeConfiguration());
        expect(state.addProfile('Cinema room')).toBe(true);
        expect(state.activeProfile()).toMatchObject({ Id: 'cinema-room', Name: 'Cinema room' });
        expect(state.addProfile('Cinema room')).toBe(true);
        expect(state.activeProfile().Id).toBe('cinema-room-2');
        expect(state.renameActiveProfile('Projector')).toBe(true);

        expect(state.mutate((draft) => {
            draft.Schedule.push({
                Id: 'projector-season', ProfileId: draft.ActiveProfileId,
                StartMonthDay: '01-01', EndMonthDay: '01-02', Priority: 1, Enabled: true,
            });
        })).toBe(true);
        expect(state.deleteActiveProfile()).toBe(true);
        expect(state.snapshot().configuration.Schedule).toEqual([]);
        expect(state.switchProfile('missing')).toBe(false);
    });

    it('stages an undoable active-profile reset without changing identity, schedules, or other profiles', () => {
        const source = themeConfiguration();
        source.Profiles[0].Name = 'Living room';
        source.Profiles[0].BasePreset = 'cinematic';
        source.Profiles[0].Palette = 'vivid';
        source.Profiles[0].Accent = 'red';
        source.Profiles[0].Mode = 'dark';
        source.Profiles[0].Tokens = { 'shape.border-width': 3 };
        source.Profiles[0].Responsive.Phone = { Tokens: { 'space.page-gutter': 0.7 } };
        source.Profiles[0].Accessibility.UnderlineLinks = true;
        source.Profiles.push({ ...structuredClone(source.Profiles[0]), Id: 'bedroom', Name: 'Bedroom' });
        source.Schedule.push({
            Id: 'winter', ProfileId: 'bedroom', StartMonthDay: '12-01', EndMonthDay: '02-28',
            Priority: 10, Enabled: true,
        });
        const state = new ThemeEditorState(source);

        expect(state.resetActiveProfile('material', 'neutral')).toBe(true);
        expect(state.activeProfile()).toEqual(expect.objectContaining({
            Id: 'default', Name: 'Living room', BasePreset: 'material', PresetVersion: null,
            FreezePresetVersion: false, Palette: 'neutral', Accent: 'palette', Mode: 'system',
            Tokens: {}, Responsive: { Phone: null, Tablet: null, Desktop: null, Wide: null, Tv: null },
            Accessibility: {
                Motion: 'system', Contrast: 'system', Transparency: 'system',
                FocusEmphasis: 'system', UnderlineLinks: false,
            },
        }));
        expect(state.snapshot().configuration).toMatchObject({
            Profiles: [expect.any(Object), { Id: 'bedroom', Name: 'Bedroom' }],
            Schedule: [{ Id: 'winter', ProfileId: 'bedroom' }],
        });
        expect(state.undo()).toBe(true);
        expect(state.activeProfile()).toMatchObject({
            BasePreset: 'cinematic', Palette: 'vivid', Accent: 'red', Mode: 'dark',
            Tokens: { 'shape.border-width': 3 },
        });
    });

    it('previews a validated import as one reversible change and adopts acknowledged state exactly', () => {
        const state = new ThemeEditorState(themeConfiguration());
        const imported = themeConfiguration();
        imported.ActiveProfileId = 'default';
        imported.Profiles[0].Palette = 'catppuccin';

        expect(state.replace(imported)).toBe(true);
        expect(state.activeProfile().Palette).toBe('catppuccin');
        expect(state.undo()).toBe(true);
        expect(state.activeProfile().Palette).toBe('canopy-night');
        expect(state.replace({ nope: true })).toBe(false);

        const acknowledged = themeConfiguration();
        acknowledged.Revision = 8;
        acknowledged.Profiles[0].BasePreset = 'studio';
        expect(state.adoptCommitted(acknowledged)).toBe(true);
        expect(state.snapshot()).toMatchObject({ dirty: false, canUndo: false, canRedo: false });
        expect(state.activeProfile().BasePreset).toBe('studio');
    });
});
