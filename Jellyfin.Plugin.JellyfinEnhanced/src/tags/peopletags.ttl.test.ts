// src/tags/peopletags.ttl.test.ts
//
// Regression test for XCUT-5: people tags derived their cache TTL from a phantom
// `PeopleTagsCacheTtlDays` config key that is not a PluginConfiguration property
// and is never projected to the client, so the value was always undefined and
// the TTL was pinned at the 30-day default. It must now read the real,
// admin-configurable `TagsCacheTtlDays` — the same setting every other tag
// family uses.
import { describe, expect, it } from 'vitest';
import { peopleTagsCacheTtlMs } from './peopletags';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('peopleTagsCacheTtlMs (XCUT-5)', () => {
    it('derives the TTL from the admin-configurable TagsCacheTtlDays', () => {
        expect(peopleTagsCacheTtlMs({ TagsCacheTtlDays: 7 })).toBe(7 * DAY_MS);
    });

    it('ignores the phantom PeopleTagsCacheTtlDays key and falls back to 30 days', () => {
        // { PeopleTagsCacheTtlDays: 7 } is the OLD (broken) shape — the phantom key
        // must be ignored, leaving the 30-day default.
        expect(peopleTagsCacheTtlMs({ PeopleTagsCacheTtlDays: 7 })).toBe(30 * DAY_MS);
    });

    it('falls back to 30 days when no config is present', () => {
        expect(peopleTagsCacheTtlMs(null)).toBe(30 * DAY_MS);
        expect(peopleTagsCacheTtlMs(undefined)).toBe(30 * DAY_MS);
        expect(peopleTagsCacheTtlMs({})).toBe(30 * DAY_MS);
    });
});
