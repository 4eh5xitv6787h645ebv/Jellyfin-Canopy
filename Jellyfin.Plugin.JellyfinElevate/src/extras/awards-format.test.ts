import { describe, it, expect } from 'vitest';
import { prettifyCategory, groupByCeremony, applyTransient, type AwardEntry, type TransientRetryState } from './awards-format';

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

describe('applyTransient (retry budget)', () => {
    const BASE = 2000, MAXB = 15000, COOL = 30000;
    const fresh = (now: number, windowMs = 180000): TransientRetryState =>
        ({ attempts: 0, windowDeadline: now + windowMs, nextAllowedAt: 0 });

    it('within the window schedules a backoff retry and advances nextAllowedAt', () => {
        const now = 1000;
        const { state, action } = applyTransient(fresh(now), now, BASE, MAXB, COOL);
        expect(action).toEqual({ kind: 'retry', delayMs: 2000 });
        expect(state.attempts).toBe(1);
        expect(state.nextAllowedAt).toBe(now + 2000);
    });

    it('backs off with attempt count and caps at maxBackoff', () => {
        const now = 1000;
        let s = fresh(now);
        for (let i = 0; i < 10; i++) s = applyTransient(s, now, BASE, MAXB, COOL).state;
        // 2000 * 10 = 20000, capped to 15000
        const { action } = applyTransient(s, now, BASE, MAXB, COOL);
        expect(action).toEqual({ kind: 'retry', delayMs: MAXB });
    });

    it('after the window it stops timed retries and cools down instead', () => {
        const start = 1000;
        const state = fresh(start, /*windowMs*/ 500); // deadline = 1500
        const later = start + 1000; // 2000 — past the deadline
        const res = applyTransient(state, later, BASE, MAXB, COOL);
        expect(res.action).toEqual({ kind: 'cooldown' });
        expect(res.state.nextAllowedAt).toBe(later + COOL);
    });

    it('never moves windowDeadline (monotonic budget — mutations cannot reset it)', () => {
        const now = 1000;
        const s0 = fresh(now);
        const s1 = applyTransient(s0, now, BASE, MAXB, COOL).state;
        const s2 = applyTransient(s1, now + 5000, BASE, MAXB, COOL).state;
        expect(s1.windowDeadline).toBe(s0.windowDeadline);
        expect(s2.windowDeadline).toBe(s0.windowDeadline);
    });

    it('does not mutate the input state', () => {
        const now = 1000;
        const s0 = fresh(now);
        applyTransient(s0, now, BASE, MAXB, COOL);
        expect(s0.attempts).toBe(0);
        expect(s0.nextAllowedAt).toBe(0);
    });
});
