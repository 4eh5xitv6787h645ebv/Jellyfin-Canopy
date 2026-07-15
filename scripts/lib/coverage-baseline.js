'use strict';

const fs = require('fs');
const path = require('path');

const BASELINE_PATH = path.join(__dirname, '..', 'coverage-baselines.json');

function requireInteger(value, label, minimum = 0) {
    if (!Number.isInteger(value) || value < minimum) {
        throw new Error(`${label} must be an integer >= ${minimum}`);
    }
}

function validateProfile(name, profile, maximumTolerancePercentagePoints) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        throw new Error(`profiles.${name} must be an object`);
    }
    if (typeof profile.scope !== 'string' || profile.scope.trim() === '') {
        throw new Error(`profiles.${name}.scope must be a non-empty string`);
    }
    const measured = profile.measured;
    const tolerance = profile.tolerance;
    if (!measured || !tolerance) {
        throw new Error(`profiles.${name} must define measured and tolerance`);
    }
    requireInteger(measured.coveredLines, `profiles.${name}.measured.coveredLines`);
    requireInteger(measured.totalLines, `profiles.${name}.measured.totalLines`, 1);
    requireInteger(tolerance.missingCoveredLines, `profiles.${name}.tolerance.missingCoveredLines`);
    if (measured.coveredLines > measured.totalLines) {
        throw new Error(`profiles.${name}.measured.coveredLines exceeds totalLines`);
    }
    if (tolerance.missingCoveredLines > measured.coveredLines) {
        throw new Error(`profiles.${name}.tolerance exceeds measured coverage`);
    }
    if (typeof tolerance.rationale !== 'string' || tolerance.rationale.trim() === '') {
        throw new Error(`profiles.${name}.tolerance.rationale must be a non-empty string`);
    }
    const tolerancePercentagePoints = (100 * tolerance.missingCoveredLines) / measured.totalLines;
    if (tolerancePercentagePoints > maximumTolerancePercentagePoints) {
        throw new Error(
            `profiles.${name}.tolerance is ${tolerancePercentagePoints.toFixed(4)} percentage points, `
            + `above the policy maximum ${maximumTolerancePercentagePoints}`,
        );
    }
}

function validateBaselineDocument(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
        throw new Error('coverage baseline must be an object');
    }
    if (document.schemaVersion !== 1) {
        throw new Error(`unsupported coverage baseline schemaVersion ${document.schemaVersion}`);
    }
    const maximum = document.policy?.maximumTolerancePercentagePoints;
    if (!Number.isFinite(maximum) || maximum < 0 || maximum > 1) {
        throw new Error('policy.maximumTolerancePercentagePoints must be between 0 and 1');
    }
    if (!document.profiles || typeof document.profiles !== 'object') {
        throw new Error('coverage baseline must define profiles');
    }
    for (const name of ['client', 'server']) {
        validateProfile(name, document.profiles[name], maximum);
    }
    return document;
}

function loadBaselines(file = BASELINE_PATH) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`cannot read coverage baseline ${file}: ${error.message}`);
    }
    return validateBaselineDocument(parsed);
}

function minimumCoveredLines(profile) {
    return profile.measured.coveredLines - profile.tolerance.missingCoveredLines;
}

function percentage(covered, total) {
    return (100 * covered) / total;
}

function evaluateCoverage(measured, profile) {
    requireInteger(measured.coveredLines, 'measured.coveredLines');
    requireInteger(measured.totalLines, 'measured.totalLines', 1);
    if (measured.coveredLines > measured.totalLines) {
        throw new Error('measured.coveredLines exceeds measured.totalLines');
    }

    const baseline = profile.measured;
    const minimum = minimumCoveredLines(profile);
    if (measured.totalLines !== baseline.totalLines) {
        return {
            ok: false,
            reason: 'scope-drift',
            message: `instrumented line count changed from ${baseline.totalLines} to ${measured.totalLines}; review the scope and update the baseline artifact`,
        };
    }
    if (measured.coveredLines < minimum) {
        return {
            ok: false,
            reason: 'regression',
            message: `covered lines fell below the maintained floor ${minimum}`,
        };
    }
    if (measured.coveredLines > baseline.coveredLines) {
        return {
            ok: false,
            reason: 'stale-baseline',
            message: `coverage advanced beyond ${baseline.coveredLines} covered lines; raise the reviewed baseline so the gain cannot be lost`,
        };
    }
    return {
        ok: true,
        reason: measured.coveredLines === baseline.coveredLines ? 'exact' : 'within-tolerance',
        message: measured.coveredLines === baseline.coveredLines
            ? 'measurement matches the reviewed baseline'
            : `measurement is within the ${profile.tolerance.missingCoveredLines}-line instrumentation tolerance`,
    };
}

function formatCoverage(name, measured, profile, result) {
    const minimum = minimumCoveredLines(profile);
    const measuredPercent = percentage(measured.coveredLines, measured.totalLines);
    const minimumPercent = percentage(minimum, profile.measured.totalLines);
    const baselinePercent = percentage(profile.measured.coveredLines, profile.measured.totalLines);
    return `${name}: measured ${measured.coveredLines}/${measured.totalLines} lines = ${measuredPercent.toFixed(3)}%; `
        + `required ${minimum}/${profile.measured.totalLines} = ${minimumPercent.toFixed(3)}%; `
        + `reviewed baseline ${profile.measured.coveredLines}/${profile.measured.totalLines} = ${baselinePercent.toFixed(3)}% — ${result.message}`;
}

module.exports = {
    BASELINE_PATH,
    evaluateCoverage,
    formatCoverage,
    loadBaselines,
    minimumCoveredLines,
    percentage,
    validateBaselineDocument,
};
