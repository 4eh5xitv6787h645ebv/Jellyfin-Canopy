'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'stale.yml'), 'utf8');
const contributing = fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8');

function scalar(name) {
    const match = workflow.match(new RegExp(`^\\s+${name}: ["']?([^\\n"']+)["']?\\s*$`, 'm'));
    assert.ok(match, `missing scalar stale input ${name}`);
    return match[1].trim();
}

function exemptLabels() {
    const match = workflow.match(/exempt-issue-labels: >-\n((?:\s{12}.+\n?)+)/);
    assert.ok(match, 'missing folded exempt-issue-labels input');
    return new Set(match[1]
        .replace(/^\s+/gm, '')
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean));
}

function classifyIssue(fixture) {
    const exemptions = exemptLabels();
    const exempt = fixture.labels.some((label) => exemptions.has(label))
        || (fixture.milestone && scalar('exempt-all-issue-milestones') === 'true')
        || (fixture.assigned && scalar('exempt-all-issue-assignees') === 'true');
    return {
        reminderAfterDays: exempt ? null : Number(scalar('days-before-issue-stale')),
        autoCloses: !exempt && Number(scalar('days-before-issue-close')) !== -1,
    };
}

test('accepted, priority, milestone, Project and owned issues cannot become stale or auto-close', () => {
    const fixtures = [
        { name: 'confirmed bug', labels: ['bug'], milestone: false, assigned: false },
        { name: 'security report', labels: ['security'], milestone: false, assigned: false },
        { name: 'confirmed report', labels: ['confirmed'], milestone: false, assigned: false },
        { name: 'P0 priority', labels: ['P0'], milestone: false, assigned: false },
        { name: 'P1 priority', labels: ['P1'], milestone: false, assigned: false },
        { name: 'milestone backlog', labels: [], milestone: true, assigned: false },
        { name: 'Project-tracked', labels: ['no-stale'], milestone: false, assigned: false },
        { name: 'assigned roadmap work', labels: [], milestone: false, assigned: true },
    ];

    for (const fixture of fixtures) {
        assert.deepEqual(classifyIssue(fixture), {
            reminderAfterDays: null,
            autoCloses: false,
        }, fixture.name);
    }
});

test('untriaged and awaiting-reporter issues have a reminder timer but no close timer', () => {
    const fixtures = [
        { name: 'untriaged', labels: [], milestone: false, assigned: false },
        { name: 'awaiting reporter', labels: ['awaiting-reporter'], milestone: false, assigned: false },
        { name: 'support question', labels: ['question'], milestone: false, assigned: false },
    ];

    for (const fixture of fixtures) {
        assert.deepEqual(classifyIssue(fixture), {
            reminderAfterDays: 30,
            autoCloses: false,
        }, fixture.name);
    }
    assert.match(workflow, /triage reminder only:[\s\S]+issue automation never closes issues/);
    assert.match(contributing, /They are never closed by stale automation/);
    assert.match(contributing, /maintainer may close an issue only after leaving a triage reason/);
});

test('pull-request cleanup retains explicit timers and records its inactivity reason', () => {
    assert.equal(scalar('days-before-pr-stale'), '15');
    assert.equal(scalar('days-before-pr-close'), '3');
    assert.match(workflow, /close-pr-message: >[\s\S]+Closing this pull request because/);
    assert.match(workflow, /exempt-draft-pr: true/);
});

test('manual policy runs default to a non-mutating audit', () => {
    assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+dry_run:/);
    assert.match(workflow, /dry_run:[\s\S]+default: true/);
    assert.match(
        workflow,
        /debug-only: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.dry_run \}\}/
    );
    assert.match(contributing, /Manual runs default to the workflow's `dry_run` audit mode/);
});
