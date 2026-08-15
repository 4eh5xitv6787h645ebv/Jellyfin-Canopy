'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    completeAcknowledgedMutation,
    runIndependentRestorations,
    throwAfterRestoration,
} = require('./remove-home-policy-cleanup');

test('acknowledged scoped mutation is journaled before a product failure and every cleanup domain runs', async () => {
    const calls = [];
    const primary = new Error('post-commit product assertion failed');
    const pageCleanupFailure = new Error('page cleanup rejected');
    let scopedMutationCommitted = false;

    await assert.rejects(
        completeAcknowledgedMutation({
            verifyAcknowledgement: () => calls.push('POST acknowledged'),
            journalMutation: () => {
                scopedMutationCommitted = true;
                calls.push('journal scoped POST');
            },
            verifyProductState: async () => {
                calls.push('product assertion');
                throw primary;
            },
        }),
        (error) => error === primary,
    );

    const failures = await runIndependentRestorations({
        pageCleanup: async () => {
            throw pageCleanupFailure;
        },
        restoreDurableUserState: async () => {
            if (scopedMutationCommitted) calls.push('DELETE acknowledged scoped item');
        },
        restoreAdministratorConfig: async () => {
            calls.push('restore administrator configuration');
        },
        timeoutMs: 100,
    });

    assert.deepEqual(calls, [
        'POST acknowledged',
        'journal scoped POST',
        'product assertion',
        'DELETE acknowledged scoped item',
        'restore administrator configuration',
    ]);
    assert.deepEqual(failures, ['restore page-owned state: page cleanup rejected']);
    let combined;
    try {
        throwAfterRestoration(primary, failures);
        assert.fail('combined primary/restoration failure was not thrown');
    } catch (error) {
        combined = error;
    }
    assert.ok(combined instanceof AggregateError);
    assert.equal(combined.cause, primary);
    assert.equal(combined.errors[0], primary);
    assert.match(combined.message, /page cleanup rejected/);
});

test('timed-out page cleanup cannot bypass the independently bounded administrator restore', async () => {
    const calls = [];
    const failures = await runIndependentRestorations({
        pageCleanup: async () => {
            calls.push('page cleanup started');
            await new Promise(() => {});
        },
        restoreDurableUserState: async () => {
            calls.push('restore durable user state');
        },
        restoreAdministratorConfig: async () => {
            calls.push('restore administrator configuration');
        },
        timeoutMs: 5,
    });

    assert.deepEqual(calls, [
        'page cleanup started',
        'restore durable user state',
        'restore administrator configuration',
    ]);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /restore page-owned state exceeded 5ms/);
});
