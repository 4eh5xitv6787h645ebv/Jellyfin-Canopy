import { describe, it, expect } from 'vitest';
import { prettifyCategory, groupByCeremony, type AwardEntry } from './awards-format';

describe('prettifyCategory', () => {
    it('strips "<X> Award for" prefixes', () => {
        expect(prettifyCategory('Academy Award for Best Picture', 'Academy Awards')).toBe('Best Picture');
        expect(prettifyCategory('Primetime Emmy Award for Outstanding Drama Series', 'Primetime Emmy Awards'))
            .toBe('Outstanding Drama Series');
        expect(prettifyCategory('Golden Globe Award for Best Motion Picture – Drama', 'Golden Globe Awards'))
            .toBe('Best Motion Picture – Drama');
    });

    it('strips a leading festival ceremony name for prize-style labels', () => {
        expect(prettifyCategory('Cannes Film Festival Grand Prix', 'Cannes Film Festival')).toBe('Grand Prix');
    });

    it('leaves bare prize names untouched', () => {
        expect(prettifyCategory("Palme d'Or", 'Cannes Film Festival')).toBe("Palme d'Or");
        expect(prettifyCategory('Golden Lion', 'Venice Film Festival')).toBe('Golden Lion');
    });

    it('never returns an empty string', () => {
        expect(prettifyCategory('Academy Awards', 'Academy Awards')).toBe('Academy Awards');
        expect(prettifyCategory('', 'Academy Awards')).toBe('');
    });
});

describe('groupByCeremony', () => {
    const a = (ceremony: string, category: string, won = true): AwardEntry => ({ ceremony, category, won, year: 2024 });

    it('groups by ceremony preserving first-seen order', () => {
        const groups = groupByCeremony([
            a('Academy Awards', 'Best Picture'),
            a('BAFTA Awards', 'Best Film'),
            a('Academy Awards', 'Best Director'),
        ]);
        expect(groups.map(g => g.ceremony)).toEqual(['Academy Awards', 'BAFTA Awards']);
        expect(groups[0].entries.map(e => e.category)).toEqual(['Best Picture', 'Best Director']);
        expect(groups[1].entries).toHaveLength(1);
    });

    it('falls back to "Awards" for a blank ceremony', () => {
        const groups = groupByCeremony([a('', 'Some Prize')]);
        expect(groups[0].ceremony).toBe('Awards');
    });

    it('returns an empty array for no awards', () => {
        expect(groupByCeremony([])).toEqual([]);
    });
});
