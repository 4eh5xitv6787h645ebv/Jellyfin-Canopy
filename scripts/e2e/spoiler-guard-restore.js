#!/usr/bin/env node

'use strict';

/**
 * Keep a stateful Spoiler Guard E2E assertion explicit about both the state it
 * needs and the exact state it must restore when the assertion finishes.
 */
function createGuardRestorePlan(initiallyGuarded, requiredGuarded) {
    if (typeof initiallyGuarded !== 'boolean' || typeof requiredGuarded !== 'boolean') {
        throw new TypeError('Spoiler Guard restore plans require boolean states');
    }

    return Object.freeze({
        requiredGuarded,
        restoreGuarded: initiallyGuarded,
    });
}

module.exports = { createGuardRestorePlan };
