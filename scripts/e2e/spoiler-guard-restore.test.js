#!/usr/bin/env node

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGuardRestorePlan } = require('./spoiler-guard-restore');

test('Spoiler Guard restore plans preserve both initially-ON and initially-OFF state', async (t) => {
    await t.test('initially ON restores ON after an OFF-required assertion', () => {
        assert.deepEqual(createGuardRestorePlan(true, false), {
            requiredGuarded: false,
            restoreGuarded: true,
        });
    });

    await t.test('initially OFF restores OFF after an ON-required assertion', () => {
        assert.deepEqual(createGuardRestorePlan(false, true), {
            requiredGuarded: true,
            restoreGuarded: false,
        });
    });
});

test('Spoiler Guard restore plans reject unknown state instead of guessing', () => {
    assert.throws(() => createGuardRestorePlan(undefined, true), /require boolean states/);
    assert.throws(() => createGuardRestorePlan(false, 'true'), /require boolean states/);
});
