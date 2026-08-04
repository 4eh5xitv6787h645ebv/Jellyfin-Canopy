'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const harness = fs.readFileSync(path.join(__dirname, 'run-provider-conformance.sh'), 'utf8');
const inventory = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'conformance/platform-providers/variants/scenarios.json'),
    'utf8'
));

test('every declared provider scenario has one honest evidence owner', () => {
    assert.equal(inventory.schemaVersion, 1);
    const ids = inventory.scenarios.map((scenario) => scenario.id);
    assert.equal(new Set(ids).size, ids.length, 'provider scenario ids must be unique');

    const consumed = [...harness.matchAll(/^scenario '([^']+)'$/gm)].map((match) => match[1]);
    assert.equal(new Set(consumed).size, consumed.length, 'host scenario markers must be unique');

    for (const scenario of inventory.scenarios) {
        assert.ok(
            scenario.evidence === 'disposable-host' || scenario.evidence === 'component-only',
            `${scenario.id} has no closed evidence classification`
        );
        if (scenario.evidence === 'disposable-host') {
            assert.equal(
                consumed.filter((id) => id === scenario.id).length,
                1,
                `${scenario.id} is declared as disposable-host evidence but is not executed exactly once`
            );
        } else {
            assert.equal(consumed.includes(scenario.id), false, `${scenario.id} has two evidence owners`);
            assert.equal(typeof scenario.reason, 'string');
            assert.ok(scenario.reason.length >= 40, `${scenario.id} needs a concrete component-only reason`);
        }
    }

    assert.deepEqual(
        consumed.filter((id) => !ids.includes(id)),
        [],
        'the host harness executes an undeclared scenario'
    );
});

test('the provider harness proves graceful ownership and exact fixture loading', () => {
    assert.match(harness, /docker stop --time "\$\{STOP_TIMEOUT_SECONDS\}"/);
    assert.match(harness, /docker inspect --format '\{\{\.State\.ExitCode\}\}'/);
    assert.match(harness, /docker rm "\$\{CONTAINER\}"/);
    assert.match(harness, /Loaded plugin: \$\{display_name\} /);
    assert.match(harness, /Skipping disabled plugin/);
    assert.match(harness, /Failed to load assembly/);
    assert.match(harness, /Error creating/);
    assert.match(harness, /canonical_fixture_records/);
    assert.match(harness, /REVERSE_CANONICAL.*FORWARD_CANONICAL/s);
});
