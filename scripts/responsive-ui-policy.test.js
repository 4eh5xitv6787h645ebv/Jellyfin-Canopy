'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const agents = read('AGENTS.md');
const engineering = read('.agents/skills/jellyfin-canopy-engineering/SKILL.md');
const contributing = read('CONTRIBUTING.md');
const developers = read('docs/developers.md');
const pullRequestTemplate = read('.github/pull_request_template.md');
const bugTemplate = read('.github/ISSUE_TEMPLATE/bug.md');
const buildWorkflow = read('.github/workflows/build.yml');
const workflowCode = buildWorkflow
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n');

test('responsive UI policy stays connected across agent, contributor, developer and PR surfaces', () => {
    assert.match(agents, /\.agents\/skills\/jellyfin-canopy-engineering\/SKILL\.md/);
    assert.match(engineering, /CONTRIBUTING\.md#responsive-ui-contract/);
    assert.match(contributing, /^### Responsive UI contract$/m);
    assert.match(contributing, /docs\/developers\.md#responsive-containment/);
    assert.match(developers, /^### Responsive containment$/m);
    assert.match(developers, /Responsive UI contract[\s\S]*`CONTRIBUTING\.md`/);
    assert.match(pullRequestTemplate, /CONTRIBUTING\.md#responsive-ui-contract/);
    assert.match(bugTemplate, /^\*\*Visual\/layout details \(complete when the bug affects rendered UI\):\*\*$/m);
});

test('responsive UI policy retains its required acceptance boundaries', () => {
    assert.match(contributing, /modern MUI layout[\s\S]*user-selectable legacy layout/);
    assert.match(contributing, /below, at, and[\s\S]*above every changed media-query breakpoint/);
    assert.match(contributing, /`320×568`[\s\S]*`568×320`[\s\S]*`800×1280`[\s\S]*`1440×900`/);
    assert.match(contributing, /Select every form-factor family[\s\S]*same owner or CSS rule can reach/);
    assert.match(contributing, /50-device popularity proxy[\s\S]*e2e\/fixtures\/popular-mobile-device-viewports\.ts[\s\S]*distinct portrait CSS viewports/);
    assert.match(contributing, /local change need not run unrelated form[\s\S]*why it bounds the[\s\S]*affected owner/);
    assert.match(contributing, /long spaced and[\s\S]*unbroken titles\/names[\s\S]*largest meaningful count\/badge/);
    assert.match(contributing, /Page\/collection titles and collection\/item counts[\s\S]*must remain fully visible/);
    assert.match(contributing, /document and owned root[\s\S]*horizontal overflow[\s\S]*scrollable region[\s\S]*every clipped edge/);
    assert.match(contributing, /wide → narrow → landscape → wide-back/);
    assert.match(contributing, /e2e\/required-test-inventory\.json/);
    assert.match(contributing, /screenshots for every[\s\S]*affected layout and form factor/);
    assert.match(pullRequestTemplate, /^## Visible UI changes$/m);
    assert.match(pullRequestTemplate, /affected phone, landscape, tablet, desktop, breakpoint-neighbor, long-content\/count, and dynamic-resize boundaries/);
    assert.match(pullRequestTemplate, /containment, overflow, intersection, and action\/close-control reachability/);
    assert.match(bugTemplate, /Client and Version[\s\S]*Jellyfin Layout[\s\S]*CSS Viewport[\s\S]*Orientation[\s\S]*Browser Zoom \/ OS Display Scaling[\s\S]*Content State/);
});

test('responsive UI policy records the actual blocking E2E wiring', () => {
    assert.doesNotMatch(contributing, /advisory while the infrastructure earns trust/);
    assert.match(workflowCode, /^[ ]{2}pull_request:\n[ ]{4}branches: \[main, master\]$/m);
    assert.match(workflowCode, /^[ ]{2}workflow_call:$/m);
    assert.match(workflowCode, /^[ ]{2}e2e:\n[\s\S]*?^[ ]{4}needs: \[e2e_shard, bundle-equivalence\]$/m);
    assert.match(workflowCode, /node scripts\/e2e\/shard-result\.js aggregate[\s\S]*node scripts\/e2e\/required-inventory\.js aggregate/);
    assert.match(workflowCode, /\(\( marker_status == 0 && inventory_status == 0 \)\)/);
});
