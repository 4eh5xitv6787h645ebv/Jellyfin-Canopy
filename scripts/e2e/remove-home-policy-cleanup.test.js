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

test('timed-out restoration aborts and settles without any touch after return', async () => {
    const calls = [];
    const failures = await runIndependentRestorations({
        pageCleanup: async () => {
            calls.push('page cleanup');
        },
        restoreDurableUserState: async (signal) => {
            calls.push('user cleanup started');
            await new Promise((resolve, reject) => {
                const lateTouch = setTimeout(() => {
                    calls.push('late user touch');
                    resolve();
                }, 30);
                signal.addEventListener('abort', () => {
                    clearTimeout(lateTouch);
                    calls.push('user cleanup aborted');
                    reject(signal.reason);
                }, { once: true });
            });
        },
        restoreAdministratorConfig: async () => {
            calls.push('restore administrator configuration');
        },
        timeoutMs: 5,
    });

    assert.deepEqual(calls, [
        'page cleanup',
        'user cleanup started',
        'user cleanup aborted',
        'restore administrator configuration',
    ]);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /restore durable user state exceeded 5ms/);
    calls.push('helper returned');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(calls, [
        'page cleanup',
        'user cleanup started',
        'user cleanup aborted',
        'restore administrator configuration',
        'helper returned',
    ]);
});

test('rejected acknowledgement never journals or schedules a scoped DELETE', async () => {
    const calls = [];
    const rejection = new Error('POST was not acknowledged');
    let journaled = false;

    await assert.rejects(completeAcknowledgedMutation({
        verifyAcknowledgement: () => {
            calls.push('acknowledgement rejected');
            throw rejection;
        },
        journalMutation: () => {
            journaled = true;
            calls.push('journal scoped POST');
        },
        verifyProductState: async () => calls.push('product assertion'),
    }), (error) => error === rejection);

    await runIndependentRestorations({
        pageCleanup: async () => calls.push('page cleanup'),
        restoreDurableUserState: async () => {
            if (journaled) calls.push('DELETE scoped item');
        },
        restoreAdministratorConfig: async () => calls.push('restore administrator configuration'),
        timeoutMs: 100,
    });

    assert.deepEqual(calls, [
        'acknowledgement rejected',
        'page cleanup',
        'restore administrator configuration',
    ]);
});
