const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');
const pins = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'github-action-runtime-pins.json'),
    'utf8'
));

function auditWorkflowPins(workflows) {
    const counts = Object.fromEntries(Object.keys(pins).map((action) => [action, 0]));
    for (const workflow of workflows) {
        const lines = workflow.source.split('\n');
        for (const [index, line] of lines.entries()) {
            const affectedAction = Object.keys(pins).find((action) => line.includes(`${action}@`));
            if (!affectedAction) continue;

            const match = line.match(/^\s*uses:\s+((?:actions\/setup-node|actions\/setup-dotnet|step-security\/harden-runner|actions\/upload-artifact))@(\S+?)(?:\s+#\s+(\S+))?\s*$/);
            const location = `${workflow.name}:${index + 1}`;
            assert.ok(match, `${location} has an unrecognized ${affectedAction} reference`);

            const [, action, ref, version] = match;
            const pin = pins[action];
            assert.equal(ref, pin.sha, `${location} uses an unreviewed ${action} commit`);
            assert.equal(version, pin.version, `${location} has a stale or missing ${action} version comment`);
            counts[action] += 1;
        }
    }

    for (const [action, count] of Object.entries(counts)) {
        assert.ok(count > 0, `no workflow consumer was inventoried for ${action}`);
    }
}

test('the reviewed action ledger records immutable Node 24 metadata', () => {
    for (const [action, pin] of Object.entries(pins)) {
        assert.match(pin.sha, /^[0-9a-f]{40}$/, `${action} is not pinned to a full commit SHA`);
        assert.match(pin.version, /^v\d+\.\d+\.\d+$/, `${action} lacks an exact release version`);
        assert.equal(pin.runtime, 'node24', `${action} is not reviewed as Node 24-native`);
        assert.equal(
            pin.metadataUrl,
            `https://raw.githubusercontent.com/${action}/${pin.sha}/action.yml`,
            `${action} metadata evidence is not immutable`
        );
    }
});

test('every affected workflow consumer uses the reviewed Node 24-native pin', () => {
    const workflows = fs.readdirSync(WORKFLOW_DIR)
        .filter((name) => /\.ya?ml$/.test(name))
        .sort()
        .map((name) => ({
            name,
            source: fs.readFileSync(path.join(WORKFLOW_DIR, name), 'utf8'),
        }));

    auditWorkflowPins(workflows);
});

test('stale commits and missing version comments fail the inventory guard', () => {
    const setupNode = pins['actions/setup-node'];
    assert.throws(
        () => auditWorkflowPins([{
            name: 'stale.yml',
            source: `uses: actions/setup-node@${'0'.repeat(40)} # ${setupNode.version}`,
        }]),
        /uses an unreviewed actions\/setup-node commit/
    );
    assert.throws(
        () => auditWorkflowPins([{
            name: 'unlabelled.yml',
            source: `uses: actions/setup-node@${setupNode.sha}`,
        }]),
        /has a stale or missing actions\/setup-node version comment/
    );
});
