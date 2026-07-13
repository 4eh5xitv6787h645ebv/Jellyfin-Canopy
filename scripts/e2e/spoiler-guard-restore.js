#!/usr/bin/env node

'use strict';

/** @param {unknown} value @param {string} label */
function jsonObject(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be a JSON object`);
    }
    return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} value */
function cloneJsonObject(value) {
    return /** @type {Record<string, unknown>} */ (JSON.parse(JSON.stringify(value)));
}

/** @param {unknown} value */
function normalizeSeriesId(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError('Spoiler Guard restore plans require a series id');
    }
    return value.replace(/-/g, '').toLowerCase();
}

/** @param {Record<string, unknown>} state */
function seriesEntries(state) {
    if (state.Series == null) return {};
    return jsonObject(state.Series, 'Spoiler Guard Series');
}

/**
 * Snapshot the target's complete entry before an E2E assertion changes it.
 * A boolean is not enough: deleting and re-adding an existing entry replaces
 * its EnabledAt timestamp and may discard future metadata fields.
 *
 * @param {Record<string, unknown>} initialState
 * @param {string} seriesId
 * @param {boolean} requiredGuarded
 */
function createGuardRestorePlan(initialState, seriesId, requiredGuarded) {
    const state = jsonObject(initialState, 'Spoiler Guard state');
    if (typeof requiredGuarded !== 'boolean') {
        throw new TypeError('Spoiler Guard restore plans require a boolean target state');
    }

    const normalizedSeriesId = normalizeSeriesId(seriesId);
    const matches = Object.entries(seriesEntries(state))
        .filter(([key]) => normalizeSeriesId(key) === normalizedSeriesId);
    if (matches.length > 1) {
        throw new Error(`Spoiler Guard state has duplicate entries for series ${seriesId}`);
    }

    const [match] = matches;
    const originalKey = match?.[0] ?? null;
    const originalEntry = match
        ? cloneJsonObject(jsonObject(match[1], `Spoiler Guard entry ${match[0]}`))
        : null;

    return Object.freeze({
        requiredGuarded,
        normalizedSeriesId,
        originalKey,
        originalEntry: originalEntry ? Object.freeze(originalEntry) : null,
    });
}

/**
 * Merge the snapshotted target entry into the latest server state. Unrelated
 * series and every non-Series field come from the latest read, so cleanup does
 * not roll back changes outside the E2E target.
 *
 * @param {Record<string, unknown>} currentState
 * @param {{
 *   normalizedSeriesId: string,
 *   originalKey: string | null,
 *   originalEntry: Readonly<Record<string, unknown>> | null
 * }} plan
 */
function applyGuardRestorePlan(currentState, plan) {
    const state = cloneJsonObject(jsonObject(currentState, 'current Spoiler Guard state'));
    const normalizedSeriesId = normalizeSeriesId(plan?.normalizedSeriesId);
    if ((plan.originalKey === null) !== (plan.originalEntry === null)) {
        throw new TypeError('Spoiler Guard restore plan entry and key must both be present or absent');
    }

    const restoredSeries = { ...seriesEntries(state) };
    for (const key of Object.keys(restoredSeries)) {
        if (normalizeSeriesId(key) === normalizedSeriesId) delete restoredSeries[key];
    }
    if (plan.originalKey !== null && plan.originalEntry !== null) {
        if (normalizeSeriesId(plan.originalKey) !== normalizedSeriesId) {
            throw new TypeError('Spoiler Guard restore plan key does not match its series id');
        }
        restoredSeries[plan.originalKey] = cloneJsonObject(
            jsonObject(plan.originalEntry, `Spoiler Guard entry ${plan.originalKey}`)
        );
    }
    state.Series = restoredSeries;
    return state;
}

module.exports = { applyGuardRestorePlan, createGuardRestorePlan };
