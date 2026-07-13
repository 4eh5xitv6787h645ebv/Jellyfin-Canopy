#!/usr/bin/env node

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyGuardRestorePlan, createGuardRestorePlan } = require('./spoiler-guard-restore');

const TARGET_DASHED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TARGET_N = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';

test('Spoiler Guard restore plans preserve an initially-ON entry byte-for-byte', () => {
    const original = {
        Series: {
            [TARGET_N]: {
                SeriesId: TARGET_N,
                SeriesName: 'Original Name',
                EnabledAt: '2024-01-02T03:04:05.0000000Z',
                FutureMetadata: { source: 'pre-existing' },
            },
            untouched: { SeriesId: 'untouched', EnabledAt: 'old' },
        },
        Movies: { movie: { MovieId: 'movie' } },
        Prefs: { HideTags: false },
    };
    const plan = createGuardRestorePlan(original, TARGET_DASHED, false);
    assert.deepEqual(plan, {
        requiredGuarded: false,
        normalizedSeriesId: TARGET_N,
        originalKey: TARGET_N,
        originalEntry: original.Series[TARGET_N],
    });

    const current = {
        Series: {
            [TARGET_N]: {
                SeriesId: TARGET_N,
                SeriesName: 'Recreated Name',
                EnabledAt: '2026-07-14T00:00:00.0000000Z',
            },
            untouched: { SeriesId: 'untouched', EnabledAt: 'new' },
        },
        Movies: { addedDuringTest: { MovieId: 'addedDuringTest' } },
        Prefs: { HideTags: true },
    };
    assert.deepEqual(applyGuardRestorePlan(current, plan), {
        Series: {
            [TARGET_N]: original.Series[TARGET_N],
            untouched: { SeriesId: 'untouched', EnabledAt: 'new' },
        },
        Movies: current.Movies,
        Prefs: current.Prefs,
    });
});

test('Spoiler Guard restore plans remove a test-created initially-OFF entry', () => {
    const plan = createGuardRestorePlan({ Series: {} }, TARGET_DASHED, true);
    assert.deepEqual(plan, {
        requiredGuarded: true,
        normalizedSeriesId: TARGET_N,
        originalKey: null,
        originalEntry: null,
    });
    assert.deepEqual(
        applyGuardRestorePlan({
            Series: {
                [TARGET_N.toUpperCase()]: { SeriesId: TARGET_N, EnabledAt: 'test' },
                other: { SeriesId: 'other' },
            },
            PendingTmdb: { 'tv:42': { TmdbId: '42' } },
        }, plan),
        {
            Series: { other: { SeriesId: 'other' } },
            PendingTmdb: { 'tv:42': { TmdbId: '42' } },
        }
    );
});

test('Spoiler Guard restore plans reject ambiguous or malformed state', () => {
    assert.throws(() => createGuardRestorePlan(undefined, TARGET_N, true), /state must be a JSON object/);
    assert.throws(() => createGuardRestorePlan({}, '', true), /require a series id/);
    assert.throws(() => createGuardRestorePlan({}, TARGET_N, 'true'), /boolean target state/);
    assert.throws(
        () => createGuardRestorePlan({
            Series: {
                [TARGET_N]: {},
                [TARGET_N.toUpperCase()]: {},
            },
        }, TARGET_N, true),
        /duplicate entries/
    );
    assert.throws(
        () => applyGuardRestorePlan({}, {
            requiredGuarded: false,
            normalizedSeriesId: TARGET_N,
            originalKey: TARGET_N,
            originalEntry: null,
        }),
        /entry and key must both/
    );
});
