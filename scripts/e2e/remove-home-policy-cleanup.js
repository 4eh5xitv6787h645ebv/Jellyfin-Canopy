'use strict';

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
    let timer;
    try {
        await Promise.race([
            Promise.resolve().then(operation),
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
                    timeoutMs,
                );
            }),
        ]);
        return null;
    } catch (error) {
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
