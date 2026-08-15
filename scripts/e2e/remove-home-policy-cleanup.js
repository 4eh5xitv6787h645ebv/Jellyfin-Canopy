'use strict';

const { AbortController: NodeAbortController } = globalThis;

function toError(value) {
    return value instanceof Error ? value : new Error(String(value));
}

async function completeAcknowledgedMutation({
    verifyAcknowledgement,
    journalMutation,
    verifyProductState,
}) {
    verifyAcknowledgement();
    journalMutation();
    await verifyProductState();
}

async function boundedRestoration(label, operation, timeoutMs) {
    const controller = new NodeAbortController();
    const timeoutError = new Error(`${label} exceeded ${timeoutMs}ms`);
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(timeoutError);
    }, timeoutMs);
    try {
        // A timeout transfers ownership to AbortController, but does not let
        // this domain go. The operation must observe the signal and settle
        // before the next state owner is allowed to run.
        await operation(controller.signal);
        if (timedOut) return `${label}: ${timeoutError.message}`;
        return null;
    } catch (error) {
        if (timedOut) return `${label}: ${timeoutError.message}`;
        return `${label}: ${toError(error).message}`;
    } finally {
        clearTimeout(timer);
    }
}

async function runIndependentRestorations({
    pageCleanup,
    restoreDurableUserState,
    restoreAdministratorConfig,
    timeoutMs = 30_000,
}) {
    const failures = [];
    const pageFailure = await boundedRestoration('restore page-owned state', pageCleanup, timeoutMs);
    if (pageFailure) failures.push(pageFailure);

    const userStateFailure = await boundedRestoration(
        'restore durable user state',
        restoreDurableUserState,
        timeoutMs,
    );
    if (userStateFailure) failures.push(userStateFailure);

    const administratorFailure = await boundedRestoration(
        'restore administrator configuration',
        restoreAdministratorConfig,
        timeoutMs,
    );
    if (administratorFailure) failures.push(administratorFailure);
    return failures;
}

function throwAfterRestoration(primaryError, restorationFailures) {
    if (primaryError == null && restorationFailures.length === 0) return;
    if (primaryError != null && restorationFailures.length === 0) throw primaryError;

    const errors = restorationFailures.map((failure) => new Error(failure));
    if (primaryError != null) {
        const primary = toError(primaryError);
        throw new AggregateError(
            [primary, ...errors],
            `Primary test failure; restoration also failed: ${restorationFailures.join('; ')}`,
            { cause: primary },
        );
    }

    throw new AggregateError(
        errors,
        `Test-state restoration failed: ${restorationFailures.join('; ')}`,
    );
}

module.exports = {
    completeAcknowledgedMutation,
    runIndependentRestorations,
    throwAfterRestoration,
};
