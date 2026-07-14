'use strict';

const fs = require('fs');
const path = require('path');
const {
    evaluateCoverage,
    formatCoverage,
    loadBaselines,
} = require('./lib/coverage-baseline');

const ROOT = path.join(__dirname, '..');

function readClientMeasurement(reportFile) {
    let report;
    try {
        report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    } catch (error) {
        throw new Error(`cannot read client coverage summary ${reportFile}: ${error.message}`);
    }
    const lines = report?.total?.lines;
    if (!lines || !Number.isInteger(lines.covered) || !Number.isInteger(lines.total)) {
        throw new Error(`client coverage summary ${reportFile} has no integer total.lines counts`);
    }
    return { coveredLines: lines.covered, totalLines: lines.total };
}

function main() {
    try {
        const baselines = loadBaselines();
        const profile = baselines.profiles.client;
        const reportFile = path.join(ROOT, profile.report);
        const measured = readClientMeasurement(reportFile);
        const result = evaluateCoverage(measured, profile);
        const summary = formatCoverage('client/core', measured, profile, result);
        if (!result.ok) {
            console.error(`check-client-coverage: FAIL (${result.reason}) — ${summary}`);
            process.exit(1);
        }
        console.log(`check-client-coverage: OK — ${summary}`);
    } catch (error) {
        console.error(`check-client-coverage: invalid coverage evidence — ${error.message}`);
        process.exit(2);
    }
}

if (require.main === module) {
    main();
}

module.exports = { readClientMeasurement };
