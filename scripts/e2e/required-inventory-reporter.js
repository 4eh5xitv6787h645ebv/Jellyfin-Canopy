'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
    INVENTORY_VERSION,
    digestTests,
    readExpected,
    validateRecord,
} = require('./required-inventory');

const ROOT = path.resolve(__dirname, '..', '..');
const EXPECTED_FILE = path.join(ROOT, 'e2e', 'required-test-inventory.json');

function stableTestId(test) {
    const file = path.relative(ROOT, test.location.file).split(path.sep).join('/');
    const titles = test.titlePath()
        .filter((title) => title && !title.endsWith('.spec.ts'));
    return `${file} › ${titles.join(' › ')}`;
}

function finalOutcome(test) {
    const outcome = test.outcome();
    if (outcome === 'expected') return 'passed';
    if (outcome === 'flaky') return 'flaky';
    if (outcome === 'skipped') return 'skipped';
    const status = test.results.at(-1)?.status;
    return ['interrupted', 'timedOut'].includes(status) ? status : 'failed';
}

class RequiredInventoryReporter {
    onBegin(_config, suite) {
        try {
            this.expected = readExpected(EXPECTED_FILE);
            this.tests = suite.allTests();
        } catch (error) {
            this.beginError = error;
        }
    }

    async onEnd() {
        try {
            if (this.beginError) throw this.beginError;
            const output = process.env.JF_E2E_INVENTORY_FILE?.trim();
            if (!output) throw new Error('JF_E2E_INVENTORY_FILE is required for the required E2E reporter');
            const tests = this.tests.map((test) => ({
                id: stableTestId(test),
                outcome: finalOutcome(test),
            })).sort((left, right) => left.id.localeCompare(right.id));
            const record = validateRecord({
                version: INVENTORY_VERSION,
                shard: Number(process.env.JF_E2E_SHARD),
                total: Number(process.env.JF_E2E_SHARD_TOTAL),
                headSha: process.env.JF_E2E_HEAD_SHA,
                runId: process.env.JF_E2E_RUN_ID,
                runAttempt: Number(process.env.JF_E2E_RUN_ATTEMPT),
                expectedDigest: digestTests(this.expected.tests),
                tests,
            });
            const destination = path.resolve(output);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });

            const expectedSet = new Set(this.expected.tests);
            const errors = [];
            for (const test of tests) {
                if (!expectedSet.has(test.id)) errors.push(`unexpected test ${JSON.stringify(test.id)}`);
                if (test.outcome !== 'passed') errors.push(`${test.outcome} test ${JSON.stringify(test.id)}`);
            }
            if (errors.length > 0) {
                console.error(`Required E2E inventory rejected:\n- ${errors.join('\n- ')}`);
                return { status: 'failed' };
            }
            console.log(`Required E2E shard inventory: ${tests.length} passed, 0 skipped`);
            return undefined;
        } catch (error) {
            console.error(`Required E2E inventory reporter failed: ${error instanceof Error ? error.message : String(error)}`);
            return { status: 'failed' };
        }
    }
}

module.exports = RequiredInventoryReporter;
module.exports.finalOutcome = finalOutcome;
module.exports.stableTestId = stableTestId;
