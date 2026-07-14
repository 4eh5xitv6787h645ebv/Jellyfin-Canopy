#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const RequiredInventoryReporter = require('./required-inventory-reporter');

test('invalid reporter coordinates return a failed Playwright status instead of failing open', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-required-reporter-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const names = [
        'JF_E2E_INVENTORY_FILE', 'JF_E2E_SHARD', 'JF_E2E_SHARD_TOTAL',
        'JF_E2E_HEAD_SHA', 'JF_E2E_RUN_ID', 'JF_E2E_RUN_ATTEMPT',
    ];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    t.after(() => {
        for (const name of names) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    });

    process.env.JF_E2E_INVENTORY_FILE = path.join(directory, 'shard.inventory');
    process.env.JF_E2E_SHARD = '1';
    process.env.JF_E2E_SHARD_TOTAL = '1';
    process.env.JF_E2E_HEAD_SHA = 'a'.repeat(40);
    process.env.JF_E2E_RUN_ID = 'not-a-run-id';
    process.env.JF_E2E_RUN_ATTEMPT = '1';

    const reporter = new RequiredInventoryReporter();
    reporter.expected = { tests: ['e2e/example.spec.ts › suite › test'] };
    reporter.tests = [];
    const originalError = console.error;
    const messages = [];
    console.error = (message) => messages.push(String(message));
    t.after(() => { console.error = originalError; });

    const result = await reporter.onEnd();
    assert.deepEqual(result, { status: 'failed' });
    assert.match(messages.join('\n'), /runId must be a positive decimal integer/);
    assert.equal(fs.existsSync(process.env.JF_E2E_INVENTORY_FILE), false);
});
