'use strict';

// Regression coverage for the agentic-loop Workflow script
// (.agents/skills/jellyfin-canopy-agentic-loop/workflows/canopy-loop.js).
//
// That file is executed by the Claude Code Workflow tool with injected globals
// (`args`, `agent`, `parallel`, `phase`, `log`) and returns a structured result.
// It is not otherwise reachable by the repo's Vitest/xUnit suites, so this test
// loads the REAL file through a minimal Workflow-shaped harness and drives the
// failure paths the confirmed review findings are about: fail-open reviews,
// fixers aborting the whole loop, verifier failures read as refutations, and
// readyForPR ignoring implementation failure.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WORKFLOW = path.join(
    __dirname,
    '..',
    '.agents',
    'skills',
    'jellyfin-canopy-agentic-loop',
    'workflows',
    'canopy-loop.js',
);

// Strip the single ESM `export` so the body is valid inside a function wrapper;
// the Workflow runtime provides the same globals as function parameters.
const SOURCE = fs.readFileSync(WORKFLOW, 'utf8').replace('export const meta', 'const meta');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const runWorkflow = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', SOURCE);

// parallel() must NULL OUT throwers, exactly like the real runtime (the script
// relies on `.filter(Boolean)` to drop failed slots).
const parallel = (thunks) =>
    Promise.all(thunks.map((t) => Promise.resolve().then(t).then((x) => x, () => null)));
const phase = () => {};

function baseArgs(extra) {
    // server surface + runtime:false → no e2e; quick depth → roundCap 2.
    return Object.assign(
        { worktree: '/tmp/wt', branch: 'test/x', surface: 'server', runtime: false, depth: 'quick', solVia: 'agent', modelSplit: true },
        extra,
    );
}

// Canonical "everything succeeds" response for each labelled agent call.
function happy(opts, prompt) {
    const label = (opts && opts.label) || '';
    const ph = (opts && opts.phase) || '';
    if (label.startsWith('explore')) return { owningLayer: 'x', files: [{ path: 'a', role: 'r' }], consumers: [], contracts: [], testSeams: [] };
    if (label.startsWith('plan')) return { summary: 's', owningLayer: 'x', steps: ['s'], tests: ['t'], stateModel: 'm' };
    if (label.startsWith('implement')) return { changedFiles: ['f'], commits: ['c'], selfConfidence: 'high', openTodos: [] };
    if (ph === 'Review') {
        if (label.startsWith('verify-r')) return { real: false, reason: 'refuted' };
        if (label.startsWith('fix-r')) {
            // A fully-resolving fixer: echo back every confirmed finding id in the
            // prompt as applied (the loop now trusts applied/unresolved by id).
            const ids = [...String(prompt || '').matchAll(/"id":\s*"(r\d+f\d+)"/g)].map((m) => m[1]);
            return { applied: ids, unresolved: [], commits: ['c'] };
        }
        return { findings: [] }; // reviewers: review-r*, sol-r*, sol-cli-r*
    }
    if (ph === 'Verify') {
        if (label.startsWith('verify-fix')) return { applied: ['a'], commits: ['c'] };
        return { gates: [{ name: 'g', pass: true }], allBlockingPassed: true, e2e: { run: false, pass: true } };
    }
    return {};
}

// Build an `agent` mock. `override(prompt, opts)` may return a value, `null`,
// `{ __throw: 'msg' }`, or `undefined` to defer to the happy default. Records
// every call for assertions.
function makeAgent(override) {
    const calls = [];
    const agent = async (prompt, opts) => {
        calls.push({ prompt: String(prompt), opts: opts || {} });
        if (override) {
            const r = override(prompt, opts || {}, calls);
            if (r !== undefined) {
                if (r && r.__throw) throw new Error(r.__throw);
                return r;
            }
        }
        return happy(opts, prompt);
    };
    return { agent, calls };
}

const finding = (summary) => ({ findings: [{ file: 'a.js', line: 1, severity: 'major', summary, failureScenario: 'x' }] });

test('happy path returns readyForPR', async () => {
    const { agent } = makeAgent(null);
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.loopClean, true);
    assert.equal(r.readyForPR, true);
    assert.equal(r.reviewIncomplete, false);
    assert.equal(r.status, 'complete');
    assert.equal(r.pauseReason, null);
    assert.equal(r.resumeFrom, null);
});

test('a terminal session-limit failure pauses the run instead of spawning more agents', async () => {
    // Every review-phase agent dies on the Anthropic session limit (run #454).
    // The loop must classify that as TERMINAL and stop spawning: no Claude
    // fallbacks, no second round, no Localize, no Verify, no fixers — return a
    // paused result pointing at the phase to resume from.
    const { agent, calls } = makeAgent((_p, opts) => {
        if (opts.phase === 'Review') return { __throw: "You've hit your session limit · resets 3am" };
        return undefined;
    });
    const r = await runWorkflow(baseArgs({ surface: 'client' }), agent, parallel, phase, () => {});
    assert.equal(r.status, 'paused');
    assert.match(r.pauseReason, /session limit/i);
    assert.equal(r.resumeFrom.phase, 'review');
    assert.equal(r.readyForPR, false);
    assert.equal(r.reviewIncomplete, true);
    assert.equal(r.reviewRounds, 1, 'no second review round is attempted during an outage');
    assert.ok(!calls.some((c) => c.opts.phase === 'Localize'), 'no Localize agent after terminal failure');
    assert.ok(!calls.some((c) => c.opts.phase === 'Verify'), 'no Verify agent after terminal failure');
    assert.ok(!calls.some((c) => (c.opts.label || '').startsWith('fix-r')), 'no fixer after terminal failure');
    assert.ok(r.residualRisks.some((s) => /PAUSED .*resume/i.test(s)), 'the pause residual carries resume instructions');
});

test('a terminal quota error on the Sol route falls back to Claude instead of pausing the run', async () => {
    // A codex/Sol quota is a SEPARATE provider from the Claude session — it must
    // open the Sol breaker and fall back to Claude, NOT pause the whole run.
    const { agent, calls } = makeAgent((_p, opts) => {
        if (opts.model === 'gpt-5.6-sol') return { __throw: 'You have exceeded your current quota' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.status, 'complete', 'a Sol-route quota error does not pause the Claude run');
    assert.equal(r.resumeFrom, null, 'the run is not paused for resume');
    assert.ok(calls.some((c) => c.opts.phase === 'Verify'), 'the run proceeds through verify on Claude');
});

test('a terminal quota on the primary implementer falls back to Opus instead of pausing', async () => {
    const { agent, calls } = makeAgent((_p, opts) => {
        if ((opts.label || '').startsWith('implement:fable')) return { __throw: 'You have exceeded your current quota' };
        return undefined; // the Opus fallback and everything else succeed
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.ok(calls.some((c) => (c.opts.label || '').includes('opus-fallback')), 'Opus fallback attempted after a Fable quota');
    assert.equal(r.status, 'complete', 'a primary-implementer quota does not pause the run');
    assert.equal(r.readyForPR, true, 'the Opus fallback produced a certifiable implementation');
});

test('a terminal quota on BOTH implementers pauses the run (session provider exhausted)', async () => {
    const { agent } = makeAgent((_p, opts) => {
        if ((opts.label || '').startsWith('implement')) return { __throw: 'You have exceeded your current quota' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.status, 'paused', 'both implementers exhausted → pause');
    assert.equal(r.resumeFrom.phase, 'explore');
});

test('an all-null explore batch is treated as a provider outage and pauses before implement', async () => {
    // Nulls carry no error message, but EVERY agent in a batch failing is an
    // infrastructure outage, not N coincidences — pause instead of burning the
    // plan/implement/review/verify phases on a dead provider.
    const { agent, calls } = makeAgent((_p, opts) => {
        if ((opts.label || '').startsWith('explore')) return null;
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.status, 'paused');
    assert.equal(r.resumeFrom.phase, 'explore');
    assert.equal(r.readyForPR, false);
    assert.ok(!calls.some((c) => (c.opts.label || '').startsWith('plan')), 'no planner spawned during an outage');
    assert.ok(!calls.some((c) => (c.opts.label || '').startsWith('implement')), 'no implementer spawned during an outage');
    assert.ok(!calls.some((c) => c.opts.phase === 'Verify'), 'no verify spawned during an outage');
});

test('startPhase:"review" skips explore/plan/implement and can still certify readyForPR', async () => {
    const { agent, calls } = makeAgent(null);
    const r = await runWorkflow(baseArgs({ startPhase: 'review' }), agent, parallel, phase, () => {});
    assert.ok(!calls.some((c) => (c.opts.label || '').startsWith('explore')), 'no explorers on resume');
    assert.ok(!calls.some((c) => (c.opts.label || '').startsWith('plan')), 'no planners on resume');
    assert.ok(!calls.some((c) => (c.opts.label || '').startsWith('implement')), 'no implementer on resume');
    assert.ok(calls.some((c) => c.opts.phase === 'Review'), 'review loop runs');
    assert.ok(calls.some((c) => c.opts.phase === 'Verify'), 'verify runs');
    assert.equal(r.implement.resumed, true, 'implementation is a synthesized resume placeholder');
    assert.equal(r.loopClean, true);
    assert.equal(r.readyForPR, true, 'a full review + green gates on resume can certify the branch');
});

test('startPhase:"verify" runs gates only and can NEVER certify readyForPR (fail closed)', async () => {
    const { agent, calls } = makeAgent(null);
    const r = await runWorkflow(baseArgs({ startPhase: 'verify' }), agent, parallel, phase, () => {});
    assert.ok(!calls.some((c) => c.opts.phase === 'Review'), 'no review agents on a verify-only resume');
    assert.ok(calls.some((c) => c.opts.phase === 'Verify'), 'verify runs');
    assert.equal(r.loopClean, false);
    assert.equal(r.reviewIncomplete, true);
    assert.equal(r.readyForPR, false, 'green gates without review must not certify');
    assert.ok(r.residualRisks.some((s) => /review loop was SKIPPED/i.test(s)));
});

test('startPhase:"verify" + reviewedHead matching the verified HEAD certifies the prior clean review', async () => {
    // The #454 window: a run died AFTER a clean review round, during Verify. On
    // resume the launcher passes back the sha it was clean at; the verify agent
    // independently reports the SAME HEAD → the prior clean review still covers
    // this exact range, so the run certifies without re-reviewing.
    const { agent, calls } = makeAgent((_p, opts) => {
        if (opts.phase === 'Verify' && (opts.label || '').startsWith('verify'))
            return { gates: [{ name: 'g', pass: true }], allBlockingPassed: true, e2e: { run: false, pass: true }, headSha: 'deadbeefcafe' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs({ startPhase: 'verify', reviewedHead: 'deadbeefcafe' }), agent, parallel, phase, () => {});
    assert.ok(!calls.some((c) => c.opts.phase === 'Review'), 'no review agents on a verify-only resume');
    assert.equal(r.loopClean, true, 'prior clean review certified via reviewedHead match');
    assert.equal(r.reviewIncomplete, false);
    assert.equal(r.readyForPR, true, 'a verified HEAD == reviewedHead certifies without re-running review');
    assert.ok(!r.residualRisks.some((s) => /review loop was SKIPPED/i.test(s)), 'no skipped-review residual when certified');
});

test('startPhase:"verify" + reviewedHead that does NOT match the verified HEAD stays fail-closed', async () => {
    // A commit changed since the clean review (or the sha is stale): the prior
    // review no longer covers this range, so the run must NOT certify.
    const { agent } = makeAgent((_p, opts) => {
        if (opts.phase === 'Verify' && (opts.label || '').startsWith('verify'))
            return { gates: [{ name: 'g', pass: true }], allBlockingPassed: true, e2e: { run: false, pass: true }, headSha: 'aaaa1111' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs({ startPhase: 'verify', reviewedHead: 'bbbb2222' }), agent, parallel, phase, () => {});
    assert.equal(r.loopClean, false, 'a HEAD mismatch does not certify');
    assert.equal(r.reviewIncomplete, true);
    assert.equal(r.readyForPR, false);
    assert.ok(r.residualRisks.some((s) => /review loop was SKIPPED/i.test(s)));
});

test('startPhase:"verify" resume still runs Localize on a client surface (parity fan-out)', async () => {
    // A run can pause between the clean review round and Localize. Skipping
    // Localize on the verify-resume would leave new en.json keys un-fanned-out and
    // fail validate-translations forever, so the cheap parity fan-out must run.
    const { agent, calls } = makeAgent(null);
    const r = await runWorkflow(baseArgs({ surface: 'client', runtime: false, startPhase: 'verify' }), agent, parallel, phase, () => {});
    assert.ok(!calls.some((c) => c.opts.phase === 'Review'), 'no review agents on a verify-only resume');
    assert.ok(calls.some((c) => c.opts.phase === 'Localize'), 'Localize still fans out locale keys on a verify-resume');
    assert.ok(calls.some((c) => c.opts.phase === 'Verify'), 'verify runs');
    assert.equal(r.readyForPR, false, 'still fail-closed without a reviewedHead match');
});

test('an unknown startPhase falls back to a full run', async () => {
    const { agent, calls } = makeAgent(null);
    const r = await runWorkflow(baseArgs({ startPhase: 'implment' }), agent, parallel, phase, () => {});
    assert.ok(calls.some((c) => (c.opts.label || '').startsWith('explore')), 'explorers run');
    assert.equal(r.startPhase, 'explore');
    assert.equal(r.readyForPR, true);
});

test('a singleton non-terminal agent failure does NOT trip systemic-failure mode', async () => {
    // One explorer dying for its own reasons is the existing, expected fallback
    // path — the run must complete normally (fail-closed semantics unchanged).
    const { agent } = makeAgent((_p, opts) => {
        if ((opts.label || '') === 'explore:1') return { __throw: 'transient tool crash' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.status, 'complete');
    assert.equal(r.readyForPR, true);
});

test('an unroutable Sol lens slot is reviewed by the Claude fallback, not lost', async () => {
    // ONE Sol lens slot throws (its lens scope must not be dropped); the whole-diff
    // Sol reviewer still runs, so the round keeps real cross-family coverage. The
    // Claude fallback for the downed lens reports a real defect — proof the scope
    // was covered rather than lost.
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l === 'sol-r1:2') return { __throw: 'sol lens slot unroutable' }; // one lens slot down
        if (l === 'review-r1:2') return finding('defect on a Sol-owned lens'); // its Claude fallback catches it
        if (l.startsWith('verify-r1')) return { real: true, reason: 'confirmed' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.ok(r.confirmedFindingsResolved >= 1, 'Sol lens defect surfaced via Claude fallback');
    assert.equal(r.readyForPR, true, 'the whole-diff Sol reviewer kept real cross-family coverage');
});

test('a fully-failed reviewer slot does not certify a clean round (fail closed)', async () => {
    // Both the Sol attempt AND its Claude fallback fail for one slot → that scope
    // is unreviewed; an empty findings set must NOT be read as clean.
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l.startsWith('sol-r')) return { __throw: 'sol unroutable' };
        if (l === 'review-r1:2') return { __throw: 'claude fallback also down' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.loopClean, false);
    assert.equal(r.reviewIncomplete, true);
    assert.equal(r.readyForPR, false);
    assert.ok(r.residualRisks.some((s) => /incomplete coverage/i.test(s)));
});

test('a single confirmed finding whose lone verifier flakes does NOT pause the run as an outage', async () => {
    // Late review rounds routinely carry exactly ONE finding. Its verifier batch
    // has a single element; a lone null verdict there is a per-agent flake, not a
    // provider outage. It must NOT trip batchOutage (which would pause the whole
    // run, skipping the fixer/Localize/Verify). The finding stays unresolved
    // (reviewIncomplete), the run COMPLETES, and Verify still runs.
    const { agent, calls } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l === 'review-r1:1') return finding('lone late-round defect');
        if (l.startsWith('verify-r')) return null; // the single verifier returns null
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.status, 'complete', 'a 1-finding/1-null-verifier round is NOT a provider outage');
    assert.notEqual(r.resumeFrom && r.resumeFrom.phase, 'review', 'the run is not paused for resume');
    assert.equal(r.reviewIncomplete, true, 'the unverified finding leaves coverage incomplete');
    assert.equal(r.readyForPR, false);
    assert.ok(calls.some((c) => c.opts.phase === 'Verify'), 'verify still runs after a lone verifier flake');
});

test('a finding whose verifier fails is treated as unresolved, not refuted', async () => {
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l === 'review-r1:1') return finding('real defect');
        if (l.startsWith('verify-r')) return { __throw: 'verifier down' }; // every verifier fails
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.loopClean, false, 'unverified finding must not clear the round');
    assert.equal(r.reviewIncomplete, true);
    assert.equal(r.readyForPR, false);
});

test('readyForPR is false when both implementers fail', async () => {
    const { agent } = makeAgent((_p, opts) => {
        if ((opts.label || '').startsWith('implement')) return null; // fable + opus both null
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.implement, null);
    assert.equal(r.readyForPR, false);
    assert.ok(r.residualRisks.some((s) => /implementation did not complete/i.test(s)));
});

test('readyForPR is false when the implementer leaves open acceptance-criteria TODOs', async () => {
    const { agent } = makeAgent((_p, opts) => {
        if ((opts.label || '').startsWith('implement')) {
            return { changedFiles: ['f'], commits: ['c'], selfConfidence: 'medium', openTodos: ['finish AC-3'] };
        }
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.readyForPR, false);
    assert.ok(r.residualRisks.includes('finish AC-3'));
    assert.ok(r.residualRisks.some((s) => /open acceptance-criteria TODOs/i.test(s)));
});

test('a throwing review fixer exhausts the round cap and is never ready-for-PR', async () => {
    // EVERY round surfaces the same real, confirmed finding whose fixer throws
    // (StructuredOutput retry cap). The loop must run to roundCap WITHOUT a clean
    // round and report the branch as NOT ready — the sole guard of that safety
    // property. (Also proves a throwing fixer resolves the workflow, never aborts.)
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        // Mixed rounds surface the finding on the Claude lens-0 reviewer; gpt-only
        // rounds (past the mixed cap) surface it on the Sol lens-0 reviewer.
        if (/^review-r\d+:1$/.test(l)) return finding('needs a fix'); // mixed rounds
        if (/^sol-r\d+:1$/.test(l)) return finding('needs a fix'); // gpt-only rounds (lens 0 on Sol)
        if (/^verify-r\d+:1$/.test(l)) return { real: true, reason: 'confirmed' }; // every round
        if (l.startsWith('fix-r')) return { __throw: 'StructuredOutput retry cap' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    // Workflow resolves with a structured result rather than throwing out.
    assert.equal(typeof r, 'object');
    assert.equal(r.confirmedFindingsResolved, 0, 'a throwing fixer applies nothing → nothing counts resolved');
    assert.equal(r.loopClean, false, 'a round with an unfixed confirmed finding is not clean');
    assert.equal(r.reviewIncomplete, false, 'coverage was complete — the finding was confirmed, not lost');
    assert.equal(r.readyForPR, false, 'unresolved confirmed findings must block ready-for-PR');
    assert.ok(
        r.residualRisks.some((s) => /round cap with unresolved confirmed findings/i.test(s)),
        'the round-cap residual risk is reported',
    );
});

test('a fixer that reports a finding unresolved blocks certification even if a later round is clean', async () => {
    // The reproduced fail-open: the fixer explicitly returns applied:[],
    // unresolved:[id], yet the next round happens to come back empty. Trusting that
    // empty round would certify a still-present defect — the fixer's own report
    // must block it.
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l === 'review-r1:1') return finding('needs a real fix');
        if (l === 'verify-r1:1') return { real: true, reason: 'confirmed' };
        if (l === 'fix-r1') return { applied: [], unresolved: ['r1f1'], commits: [] }; // fixer admits it could not fix
        return undefined; // round 2 reviewers return empty (a non-deterministic miss)
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.loopClean, true, 'round 2 was clean (reviewers missed the still-present defect)');
    assert.equal(r.reviewIncomplete, false, 'coverage itself was complete — this is a fixer failure, not a lost scope');
    assert.equal(r.readyForPR, false, 'an unresolved confirmed finding must block ready-for-PR');
    assert.equal(r.confirmedFindingsResolved, 0, 'nothing was actually applied');
    assert.ok(r.residualRisks.some((s) => /unapplied\/unresolved/i.test(s)));
    assert.ok(!r.ledger.some((e) => e.status === 'fixed'), 'an unfixed finding is never ledgered as fixed');
});

test('an unresolved finding is NOT cleared by a later fixer fully applying an UNRELATED finding', async () => {
    // The persistent-unresolved regression: round 1 leaves finding A unresolved;
    // round 2 fully applies an UNRELATED finding B; round 3 comes back clean. A
    // single unfixedConfirmed boolean would be reset to false by B's clean apply
    // and wrongly certify the branch while A is still in the diff. Per-finding
    // fingerprint tracking must keep A unresolved until A itself is applied or
    // independently refuted.
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l === 'review-r1:1') return finding('finding A needs a real fix');
        if (l === 'verify-r1:1') return { real: true, reason: 'A reproduces' };
        if (l === 'fix-r1') return { applied: [], unresolved: ['r1f1'], commits: [] }; // A left unresolved
        if (l === 'review-r2:1')
            return { findings: [{ file: 'other.js', line: 9, severity: 'major', summary: 'finding B unrelated', failureScenario: 'z' }] };
        if (l === 'verify-r2:1') return { real: true, reason: 'B reproduces' };
        if (l === 'fix-r2') return { applied: ['r2f1'], unresolved: [], commits: ['c'] }; // B fully applied
        return undefined; // round 3 reviewers empty → clean round
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.loopClean, true, 'round 3 came back clean');
    assert.equal(r.reviewIncomplete, false, 'coverage was complete throughout');
    assert.equal(r.confirmedFindingsResolved, 1, 'only B was actually applied');
    assert.equal(r.readyForPR, false, 'unresolved finding A must still block certification after B is fixed');
    assert.ok(r.residualRisks.some((s) => /unapplied\/unresolved/i.test(s)));
});

test('a fixer that applies only SOME confirmed findings does not certify', async () => {
    // Two confirmed findings; the fixer applies one and silently drops the other
    // (neither in applied nor unresolved). Fail closed on the dropped id.
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l === 'review-r1:1')
            return {
                findings: [
                    { file: 'a.js', line: 1, severity: 'major', summary: 'A', failureScenario: 'x' },
                    { file: 'b.js', line: 2, severity: 'major', summary: 'B', failureScenario: 'y' },
                ],
            };
        if (/^verify-r1:\d+$/.test(l)) return { real: true, reason: 'both real' };
        if (l === 'fix-r1') return { applied: ['r1f1'], unresolved: [], commits: ['c'] }; // r1f2 dropped
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.readyForPR, false, 'a confirmed finding neither applied nor unresolved blocks certification');
    assert.equal(r.confirmedFindingsResolved, 1, 'only the applied finding is counted resolved');
});

test('a fixer that fully applies every confirmed finding certifies (applied ids honored)', async () => {
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l === 'review-r1:1') return finding('fix me');
        if (l === 'verify-r1:1') return { real: true, reason: 'confirmed' };
        if (l === 'fix-r1') return { applied: ['r1f1'], unresolved: [], commits: ['c'] };
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.confirmedFindingsResolved, 1, 'the applied finding counts as resolved');
    assert.equal(r.readyForPR, true);
    assert.ok(r.ledger.some((e) => e.status === 'fixed'));
});

test('a throwing verify fixer does not abort the whole workflow', async () => {
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l.startsWith('verify-fix')) return { __throw: 'StructuredOutput retry cap' };
        if (opts.phase === 'Verify' && l.startsWith('verify')) {
            return { gates: [{ name: 'g', pass: false }], allBlockingPassed: false, failures: ['boom'] };
        }
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(typeof r, 'object');
    assert.equal(r.readyForPR, false);
    assert.ok(r.residualRisks.some((s) => /BLOCKING gate/i.test(s)));
});

test('every split review round still runs a whole-diff Sol reviewer', async () => {
    const { agent, calls } = makeAgent(null);
    await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    const wholeDiffSol = calls.some(
        (c) =>
            (c.opts.label || '').startsWith('sol-r') &&
            !/THROUGH THIS LENS ONLY/.test(c.prompt) &&
            /across correctness, security\/privacy \(fail-closed\)/.test(c.prompt),
    );
    assert.ok(wholeDiffSol, 'a whole-diff (unscoped) Sol reviewer runs under modelSplit');
});

test('explore runs 8 agents weighted 2 Claude/Opus + 6 gpt-5.6-sol at xhigh', async () => {
    const { agent, calls } = makeAgent(null);
    await runWorkflow(baseArgs({ depth: 'standard' }), agent, parallel, phase, () => {});
    const explore = calls.filter((c) => /^explore:\d+/.test(c.opts.label || ''));
    assert.equal(explore.length, 8, '8 explorers at standard depth');
    const claude = explore.filter((c) => !c.opts.model);
    const sol = explore.filter((c) => c.opts.model === 'gpt-5.6-sol');
    assert.equal(claude.length, 2, 'first 2 explorers run on Claude/Opus');
    assert.equal(sol.length, 6, 'remaining 6 explorers run on gpt-5.6-sol');
    assert.ok(sol.every((c) => c.opts.effort === 'xhigh'), 'explore Sol slots run at xhigh');
});

test('plan Sol slots (incl. synthesis) run at xhigh', async () => {
    const { agent, calls } = makeAgent(null);
    await runWorkflow(baseArgs({ depth: 'standard' }), agent, parallel, phase, () => {});
    const planSol = calls.filter((c) => /^plan:/.test(c.opts.label || '') && c.opts.model === 'gpt-5.6-sol');
    assert.ok(planSol.length >= 1, 'at least one plan slot runs on Sol');
    assert.ok(planSol.every((c) => c.opts.effort === 'xhigh'), 'plan Sol slots run at xhigh');
});

test('review escalates to gpt-5.6-sol-only after the mixed round cap', async () => {
    // A confirmed finding every round whose fixer throws → the loop runs to
    // hardRoundCap. Mixed rounds (≤ roundCap) use Claude lens reviewers; every
    // later round is gpt-only (no Claude lens reviewer runs past the mixed cap).
    const { agent, calls } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (/^review-r\d+:1$/.test(l)) return finding('x'); // mixed rounds
        if (/^sol-r\d+:1$/.test(l)) return finding('x'); // gpt-only rounds
        if (/^verify-r\d+:1$/.test(l)) return { real: true, reason: 'c' };
        if (l.startsWith('fix-r')) return { __throw: 'cap' };
        return undefined;
    });
    // quick depth → mixed roundCap 2; cap the hard ceiling at 5 to keep it short.
    const r = await runWorkflow(baseArgs({ depth: 'quick', hardRoundCap: 5 }), agent, parallel, phase, () => {});
    const roundsWith = (re) =>
        new Set(
            calls
                .map((c) => c.opts.label || '')
                .map((l) => l.match(re))
                .filter(Boolean)
                .map((m) => Number(m[1])),
        );
    const claudeReviewRounds = roundsWith(/^review-r(\d+):/);
    const solReviewRounds = roundsWith(/^sol-r(\d+):/);
    assert.ok(![...claudeReviewRounds].some((n) => n > 2), 'no Claude lens reviewer past the mixed cap (2)');
    assert.ok(solReviewRounds.has(3) && solReviewRounds.has(5), 'gpt-5.6-sol reviewers run the gpt-only rounds');
    assert.equal(r.readyForPR, false, 'unresolved confirmed findings across the escalation block PR');
    assert.equal(r.reviewRounds, 5, 'the loop ran to the hard round cap');
});

test('verify enforces a committed, clean handoff as a blocking gate', async () => {
    const { agent, calls } = makeAgent(null);
    await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    const verifyCall = calls.find((c) => c.opts.phase === 'Verify' && (c.opts.label || '').startsWith('verify'));
    assert.ok(verifyCall, 'verify runner invoked');
    assert.match(verifyCall.prompt, /git status --porcelain/);
    assert.match(verifyCall.prompt, /BLOCKING/);
    // Reviewers are also told an uncommitted change is a finding, so a dirty tree
    // is not silently invisible to the committed-range review.
    const reviewCall = calls.find((c) => (c.opts.label || '').startsWith('review-r'));
    assert.match(reviewCall.prompt, /git -C .* status --porcelain/);
});

test('codex-cli: an unavailable codex run falls back to Claude instead of a silent clean', async () => {
    const { agent, calls } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l.startsWith('sol-cli-r')) return { findings: [], solUnavailable: true }; // codex missing/non-zero
        if (l === 'review-r1:2') return finding('defect a lensless codex run would have missed');
        if (l.startsWith('verify-r1')) return { real: true, reason: 'confirmed' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs({ solVia: 'codex-cli' }), agent, parallel, phase, () => {});
    assert.ok(r.confirmedFindingsResolved >= 1, 'codex-unavailable scope covered by Claude');

    // The codex harness prompt must fail closed and be injection-hardened.
    const harness = calls.find((c) => (c.opts.label || '').startsWith('sol-cli-r'));
    assert.ok(harness, 'codex harness invoked');
    assert.match(harness.prompt, /solUnavailable/, 'harness signals unavailability rather than empty findings');
    assert.match(harness.prompt, /rm -f/, 'harness cleans up its temp files');
    // Injection-hardened: the prompt is written to a temp file with the Write tool
    // between <<<PROMPT>>> markers — NO shell heredoc, so no delimiter for an
    // untrusted brief line to close (mirrors the codexAgent read-only harness).
    assert.match(harness.prompt, /Write tool/, 'prompt written via the Write tool, not a shell heredoc');
    assert.match(harness.prompt, /<<<PROMPT>>>/, 'prompt fenced by non-shell markers');
    assert.doesNotMatch(harness.prompt, /cat > "\$P" <</, 'no shell heredoc in the review harness');
    assert.doesNotMatch(harness.prompt, /SOL_PROMPT_/, 'the collidable/computable heredoc nonce is gone');
});

test('codex-cli: a THROWING codex harness falls back to Claude, not a lost scope', async () => {
    // Distinct from the "solUnavailable" case above: here the harness agent itself
    // THROWS. Without a try/catch around runSol the slot would null out with no
    // Claude fallback, silently dropping that review scope.
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l.startsWith('sol-cli-r')) return { __throw: 'codex harness crashed' };
        if (l === 'review-r1:2') return finding('defect the thrown codex scope would have missed');
        if (l.startsWith('verify-r1')) return { real: true, reason: 'confirmed' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs({ solVia: 'codex-cli' }), agent, parallel, phase, () => {});
    assert.ok(r.confirmedFindingsResolved >= 1, 'thrown codex scope covered by the Claude fallback');
});

test('codex-cli preflight: an unavailable codex CLI trips the breaker before any Sol slot spawns', async () => {
    // The route is statically known at launch, so one cheap probe short-circuits a
    // dead codex-cli route instead of burning a harness agent + Claude fallback per
    // Sol slot before the runtime breaker trips.
    const { agent, calls } = makeAgent((_p, opts) => {
        if ((opts.label || '') === 'codex-preflight') return { available: false, version: '' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs({ solVia: 'codex-cli' }), agent, parallel, phase, () => {});
    assert.ok(calls.some((c) => (c.opts.label || '') === 'codex-preflight'), 'preflight probe spawned on the codex-cli route');
    assert.equal(r.modelCoverage.solDead, true, 'a missing codex CLI marks the Sol route dead up front');
    assert.ok(!calls.some((c) => (c.opts.label || '').startsWith('sol-cli-r')), 'no codex harness spawned once the route is known dead');
    assert.ok(calls.some((c) => (c.opts.label || '').startsWith('explore')), 'explore still runs (on Claude)');
});

test('codex-cli preflight: a healthy codex CLI leaves the Sol route live', async () => {
    const { agent, calls } = makeAgent((_p, opts) => {
        if ((opts.label || '') === 'codex-preflight') return { available: true, version: 'codex 1.2.3' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs({ solVia: 'codex-cli' }), agent, parallel, phase, () => {});
    assert.equal(r.modelCoverage.solDead, false, 'a healthy probe does not trip the breaker');
    assert.ok(calls.some((c) => (c.opts.label || '').startsWith('sol-cli-r')), 'codex harness runs on a live route');
});

test('the preflight probe does not run on the agent route', async () => {
    const { agent, calls } = makeAgent(null);
    await runWorkflow(baseArgs({ solVia: 'agent' }), agent, parallel, phase, () => {});
    assert.ok(!calls.some((c) => (c.opts.label || '') === 'codex-preflight'), 'no codex preflight when solVia is agent');
});

test('a non-split round still runs at least one whole-diff Sol reviewer at solReviewers:0', async () => {
    // modelSplit:false + solReviewers:0 must NOT yield a Sol-less round: the
    // Math.max(1, SOL_REVIEWERS) floor keeps the "≥1 whole-diff Sol reviewer per
    // round" contract even under an explicit non-default override.
    const { agent, calls } = makeAgent(null);
    await runWorkflow(baseArgs({ modelSplit: false, solReviewers: 0 }), agent, parallel, phase, () => {});
    const solReviewer = calls.some((c) => (c.opts.label || '').startsWith('sol-r'));
    assert.ok(solReviewer, 'at least one Sol reviewer runs even with modelSplit off and solReviewers:0');
});

test('a verifier failure alongside a confirmed finding marks coverage incomplete', async () => {
    // One batch, two findings: A is confirmed, B's verifier throws (null verdict).
    // Fixing A must NOT silently drop B — the round is coverage-incomplete, so the
    // run can never certify clean even if a later round comes back empty.
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l === 'review-r1:1')
            return {
                findings: [
                    { file: 'a.js', line: 1, severity: 'major', summary: 'A confirmed', failureScenario: 'x' },
                    { file: 'b.js', line: 2, severity: 'major', summary: 'B unverifiable', failureScenario: 'y' },
                ],
            };
        if (l === 'verify-r1:1') return { real: true, reason: 'A real' }; // A confirmed
        if (l === 'verify-r1:2') return { __throw: 'verifier down for B' }; // B unresolved
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.reviewIncomplete, true, 'an unverified finding in a confirmed batch keeps coverage incomplete');
    assert.equal(r.readyForPR, false);
    assert.ok(r.residualRisks.some((s) => /incomplete coverage/i.test(s)));
});

test('a verify-fix that commits after a clean review round is not ready-for-PR', async () => {
    // Review certifies clean, then a gate fails and VERIFY-FIX commits new code.
    // Those commits never went through adversarial review, so the stale cleanRound
    // must not certify them: readyForPR is false with a re-review residual risk.
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l === 'verify') return { gates: [{ name: 'g', pass: false }], allBlockingPassed: false, failures: ['boom'] };
        if (l.startsWith('verify-retry')) return { gates: [{ name: 'g', pass: true }], allBlockingPassed: true, e2e: { run: false, pass: true } };
        if (l.startsWith('verify-fix')) return { applied: ['a'], commits: ['c1'] }; // commits unreviewed code
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.loopClean, true, 'the review round itself was clean');
    assert.equal(r.verifyFixCommitted, true);
    assert.equal(r.readyForPR, false, 'unreviewed verify-fix commits must block ready-for-PR');
    assert.ok(r.residualRisks.some((s) => /never adversarially reviewed/i.test(s)));
});

test('every explorer contributes to the plan digest (equal-share, not head-slice)', async () => {
    // 8 large explorer maps: a 12KB head-slice only ever showed the first ~3.
    // With the per-item budget, the FIRST and the LAST explorer's identifying
    // marker must both reach the planners.
    const { agent, calls } = makeAgent((_p, opts) => {
        const m = /^explore:(\d+)/.exec(opts.label || '');
        if (m)
            return {
                owningLayer: `MARKER_EXPLORER_${m[1]}`,
                files: [{ path: 'a', role: 'x'.repeat(3000) }],
                consumers: [], contracts: [], testSeams: [],
            };
        return undefined;
    });
    await runWorkflow(baseArgs({ depth: 'standard' }), agent, parallel, phase, () => {});
    const plan = calls.find((c) => (c.opts.label || '').startsWith('plan:'));
    assert.match(plan.prompt, /MARKER_EXPLORER_1\b/, 'first explorer present');
    assert.match(plan.prompt, /MARKER_EXPLORER_8\b/, 'last explorer present (was dropped by the head-slice)');
});

test('a docs run explores 4 docs-relevant angles and skips Localize', async () => {
    const { agent, calls } = makeAgent(null);
    const r = await runWorkflow(baseArgs({ surface: 'docs', runtime: false, depth: 'standard' }), agent, parallel, phase, () => {});
    const explore = calls.filter((c) => /^explore:\d+/.test(c.opts.label || ''));
    assert.equal(explore.length, 4, 'docs runs use the 4 docs angles, not 8 code explorers');
    assert.ok(explore.some((c) => /the DOCS surface: nav\/mkdocs structure/.test(c.prompt)), 'the DOCS-surface angle runs');
    assert.ok(explore.every((c) => !/DATA\/STATE\/CONCURRENCY/.test(c.prompt)), 'no concurrency explorer for docs');
    assert.ok(!calls.some((c) => c.opts.phase === 'Localize'), 'no Localize agent for docs');
    assert.equal(r.readyForPR, true);
});

test('non-docs surfaces keep the full explorer list and Localize behavior', async () => {
    const { agent, calls } = makeAgent(null);
    await runWorkflow(baseArgs({ surface: 'client', depth: 'standard', runtime: false }), agent, parallel, phase, () => {});
    const explore = calls.filter((c) => /^explore:\d+/.test(c.opts.label || ''));
    assert.equal(explore.length, 8);
    assert.ok(calls.some((c) => c.opts.phase === 'Localize'), 'client surface still localizes');
});

test('issue + no briefText: a Phase-0 agent hydrates the brief from the live issue', async () => {
    const { agent, calls } = makeAgent((_p, opts) => {
        if ((opts.label || '') === 'fetch-issue')
            return { number: 452, title: 'Fix the widget', body: 'THE LIVE ISSUE BODY with acceptance criteria', url: 'https://x/452', updatedAt: '2026-07-20' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs({ issue: 452 }), agent, parallel, phase, () => {});
    const fetch = calls.find((c) => (c.opts.label || '') === 'fetch-issue');
    assert.ok(fetch, 'fetch-issue agent spawned');
    assert.match(fetch.prompt, /gh issue view 452 --json number,title,body,url,updatedAt/);
    assert.equal(fetch.opts.effort, 'low', 'the fetch is cheap');
    const impl = calls.find((c) => (c.opts.label || '').startsWith('implement'));
    assert.match(impl.prompt, /THE LIVE ISSUE BODY with acceptance criteria/, 'hydrated body reaches CONTRACTS');
    assert.match(impl.prompt, /authoritative — read in full/, 'hydrated brief is treated as inlined brief text');
    assert.equal(r.readyForPR, true);
});

test('issue-only launch replaces the placeholder TASK line with the fetched issue title', async () => {
    // In the preferred issue:N-only shape, hydration must also fill TASK so agents
    // do not open with "No task text supplied." above the authoritative brief.
    const { agent, calls } = makeAgent((_p, opts) => {
        if ((opts.label || '') === 'fetch-issue')
            return { number: 452, title: 'Fix the widget', body: 'ACCEPTANCE CRITERIA', url: 'https://x/452', updatedAt: '2026-07-20' };
        return undefined;
    });
    await runWorkflow(baseArgs({ issue: 452 }), agent, parallel, phase, () => {});
    const impl = calls.find((c) => (c.opts.label || '').startsWith('implement'));
    assert.doesNotMatch(impl.prompt, /No task text supplied/, 'placeholder TASK replaced after hydration');
    assert.match(impl.prompt, /Resolve issue #452: Fix the widget/, 'TASK line derived from the fetched issue title');
});

test('an explicit task is NOT overwritten by issue hydration', async () => {
    const { agent, calls } = makeAgent((_p, opts) => {
        if ((opts.label || '') === 'fetch-issue')
            return { number: 452, title: 'Fix the widget', body: 'ACCEPTANCE CRITERIA', url: 'https://x/452', updatedAt: '2026-07-20' };
        return undefined;
    });
    await runWorkflow(baseArgs({ issue: 452, task: 'EXPLICIT LAUNCHER TASK' }), agent, parallel, phase, () => {});
    const impl = calls.find((c) => (c.opts.label || '').startsWith('implement'));
    assert.match(impl.prompt, /EXPLICIT LAUNCHER TASK/, 'explicit task wins over the fetched title');
});

test('an explicit briefText suppresses the issue fetch (launcher brief stays authoritative)', async () => {
    const { agent, calls } = makeAgent(null);
    await runWorkflow(baseArgs({ issue: 452, briefText: 'MANUAL BRIEF' }), agent, parallel, phase, () => {});
    assert.ok(!calls.some((c) => (c.opts.label || '') === 'fetch-issue'), 'no fetch when briefText supplied');
    const impl = calls.find((c) => (c.opts.label || '').startsWith('implement'));
    assert.match(impl.prompt, /MANUAL BRIEF/);
});

test('a failed issue fetch with no other task source pauses before the writer (fail closed)', async () => {
    // issue:N was the intended brief source; the fetch failed and nothing else
    // authoritative was supplied. Running agents on placeholders would implement
    // AND certify with no acceptance criteria — pause instead.
    const { agent, calls } = makeAgent((_p, opts) => {
        if ((opts.label || '') === 'fetch-issue') return null;
        return undefined;
    });
    const r = await runWorkflow(baseArgs({ issue: 452 }), agent, parallel, phase, () => {});
    assert.equal(r.status, 'paused');
    assert.equal(r.resumeFrom.phase, 'explore');
    assert.match(r.pauseReason, /hydration failed|authoritative requirements/i);
    assert.ok(!calls.some((c) => (c.opts.label || '').startsWith('explore')), 'no explorers without authoritative requirements');
    assert.ok(!calls.some((c) => (c.opts.label || '').startsWith('implement')), 'no writer without authoritative requirements');
    assert.equal(r.readyForPR, false);
    assert.ok(r.residualRisks.some((s) => /PAUSED .*resume/i.test(s)));
});

test('a failed issue fetch still runs when an explicit task was supplied (brief-path fallback preserved)', async () => {
    const { agent, calls } = makeAgent((_p, opts) => {
        if ((opts.label || '') === 'fetch-issue') return null;
        return undefined;
    });
    const r = await runWorkflow(baseArgs({ issue: 452, task: 'EXPLICIT TASK, no fetch needed' }), agent, parallel, phase, () => {});
    const impl = calls.find((c) => (c.opts.label || '').startsWith('implement'));
    assert.match(impl.prompt, /brief text not inlined; open the path above/, 'existing brief-path fallback preserved');
    assert.match(impl.prompt, /EXPLICIT TASK, no fetch needed/);
    assert.equal(r.readyForPR, true, 'a failed fetch does not block when a task was supplied');
});

test('envSetup is interpolated into every CONTRACTS prompt and the verify env echo is present', async () => {
    const { agent, calls } = makeAgent(null);
    await runWorkflow(
        baseArgs({ envSetup: 'export DOTNET_ROOT=$HOME/.dotnet; export PATH="$DOTNET_ROOT:$PATH"' }),
        agent,
        parallel,
        phase,
        () => {},
    );
    const impl = calls.find((c) => (c.opts.label || '').startsWith('implement'));
    const verifyCall = calls.find((c) => c.opts.phase === 'Verify');
    assert.match(impl.prompt, /ENVIRONMENT \(run before ANY build\/test command/);
    assert.match(impl.prompt, /DOTNET_ROOT=\$HOME\/\.dotnet/);
    assert.match(verifyCall.prompt, /DOTNET_ROOT=\$HOME\/\.dotnet/, 'verify inherits the env prelude via CONTRACTS');
    assert.match(verifyCall.prompt, /command -v dotnet && dotnet --version/, 'verify echoes the toolchain');
    assert.match(verifyCall.prompt, /\$DOTNET_ROOT precedes the system\ndotnet on PATH/, 'generic PATH-precedence rule');
});

test('without envSetup no ENVIRONMENT block is injected (default prompts unchanged)', async () => {
    const { agent, calls } = makeAgent(null);
    await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.ok(
        calls.every((c) => !/ENVIRONMENT \(run before ANY build\/test command/.test(c.prompt)),
        'no env block by default',
    );
});

test('a below-quorum explore spawns one consolidated recovery explorer and continues', async () => {
    // quick depth = 2 explorers, quorum 2. One fails → recovery explorer covers
    // the gap → the run proceeds normally.
    const { agent, calls } = makeAgent((_p, opts) => {
        if ((opts.label || '') === 'explore:1') return null;
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.ok(calls.some((c) => (c.opts.label || '') === 'explore:recovery'), 'recovery explorer spawned');
    assert.equal(r.status, 'complete');
    assert.equal(r.readyForPR, true);
    assert.equal(r.agentStats.explore.attempted, 3, '2 parallel + 1 recovery attempts accounted');
    assert.equal(r.agentStats.explore.nulls, 1);
});

test('an explore still below quorum after recovery pauses before the writer', async () => {
    const { agent, calls } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l === 'explore:1' || l === 'explore:recovery') return null;
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.status, 'paused');
    assert.match(r.pauseReason, /quorum|maps/i);
    assert.equal(r.resumeFrom.phase, 'explore');
    assert.ok(!calls.some((c) => (c.opts.label || '').startsWith('plan')), 'no planners after quorum failure');
    assert.ok(!calls.some((c) => (c.opts.label || '').startsWith('implement')), 'no writer after quorum failure');
    assert.ok(!calls.some((c) => c.opts.phase === 'Verify'), 'no verify after quorum failure');
    assert.equal(r.readyForPR, false);
});

test('a below-quorum plan phase spawns one recovery planner and continues', async () => {
    // standard depth = 3 planners, quorum 2. Two fail → recovery planner
    // restores the quorum.
    const { agent, calls } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l.startsWith('plan:2') || l.startsWith('plan:3')) return null; // (plan:2 is a ':sol' slot)
        return undefined;
    });
    const r = await runWorkflow(baseArgs({ depth: 'standard' }), agent, parallel, phase, () => {});
    assert.ok(calls.some((c) => (c.opts.label || '') === 'plan:recovery'), 'recovery planner spawned');
    assert.equal(r.status, 'complete');
    assert.equal(r.readyForPR, true);
});

test('agentStats accounts every phase on a happy run', async () => {
    const { agent } = makeAgent(null);
    const r = await runWorkflow(baseArgs({ depth: 'standard' }), agent, parallel, phase, () => {});
    assert.equal(r.agentStats.explore.attempted, 8);
    assert.equal(r.agentStats.explore.succeeded, 8);
    assert.equal(r.agentStats.plan.attempted, 3);
    assert.ok(r.agentStats.review.attempted >= 1, 'review batches accounted');
});

test('three consecutive Sol failures trip the breaker: later rounds spawn no Sol attempts', async () => {
    // Every Sol-routed agent throws (dead router). Round 1 burns its attempts
    // (that is where the 3 consecutive failures accrue); a confirmed finding
    // forces round 2, which must go STRAIGHT to Claude — zero sol-r2 spawns.
    const { agent, calls } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (opts.model === 'gpt-5.6-sol') return { __throw: 'router down' };
        if (l === 'review-r1:1') return finding('real defect');
        if (l === 'verify-r1:1') return { real: true, reason: 'confirmed' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.ok(r.reviewRounds >= 2, 'a second round ran');
    assert.ok(!calls.some((c) => /^sol-r2:/.test(c.opts.label || '')), 'no Sol reviewer spawned after the breaker tripped');
    assert.ok(calls.some((c) => /^review-r2:/.test(c.opts.label || '')), 'round-2 scopes covered by Claude');
    assert.equal(r.modelCoverage.solDead, true);
    assert.ok(r.modelCoverage.roundsWithoutSol.includes(1), 'the Sol-less round is visible');
    assert.ok(
        r.residualRisks.some((s) => /WITHOUT real cross-family/i.test(s)),
        'the lost cross-family coverage is a named residual risk',
    );
});

test('a clean review round with NO real Sol coverage cannot certify (mixed-model contract)', async () => {
    // Every Sol slot is unroutable, so the certifying round ran entirely on Claude
    // fallbacks — not the documented cross-family review. readyForPR previously
    // ignored roundsWithoutSol and certified anyway; it must now fail closed.
    const { agent } = makeAgent((_p, opts) => {
        if (opts.model === 'gpt-5.6-sol') return { __throw: 'router down' }; // all Sol → Claude fallback
        return undefined; // Claude reviewers return empty → clean round
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.loopClean, true, 'the round itself found nothing');
    assert.equal(r.modelCoverage.solDead, true, 'the Sol route is dead');
    assert.equal(r.reviewIncomplete, true, 'a Sol-less certifying round is not a certified review');
    assert.equal(r.readyForPR, false, 'the mixed-model contract blocks certification without real Sol coverage');
    assert.ok(r.residualRisks.some((s) => /cross-family/i.test(s)));
});

test('modelCoverage reports requested vs actual per slot class on a healthy run', async () => {
    const { agent } = makeAgent(null);
    const r = await runWorkflow(baseArgs({ depth: 'standard' }), agent, parallel, phase, () => {});
    assert.equal(r.modelCoverage.solDead, false);
    assert.deepEqual(r.modelCoverage.roundsWithoutSol, []);
    assert.ok(r.modelCoverage.slots.Explore.ranSol >= 1, 'explore Sol slots recorded');
    assert.ok(r.modelCoverage.slots.Review.ranSol >= 1, 'review Sol slots recorded');
    assert.equal(r.modelCoverage.slots.Explore.claudeFallback, 0, 'no silent fallbacks on a healthy route');
});

test('a Sol success resets the breaker counter (two failures never trip it)', async () => {
    // Sol lens slots fail twice in round 1 but the whole-diff Sol reviewer
    // succeeds — the counter resets, solDead stays false.
    let solFails = 0;
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (opts.model === 'gpt-5.6-sol' && /^sol-r1:[12]$/.test(l) && solFails < 2) {
            solFails++;
            return { __throw: 'transient' };
        }
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.modelCoverage.solDead, false, 'two non-consecutive-with-success failures never kill the route');
    assert.equal(r.readyForPR, true);
});

test('docs surface: confirmed minors become advisory notes and the round counts clean', async () => {
    // A confirmed MINOR wording-adjacent defect on a docs surface must not force
    // another full fix round: it is reported in advisoryNotes and the round is
    // clean (SR-15's churn driver).
    const { agent, calls } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l === 'review-r1:1')
            return { findings: [{ file: 'docs/a.md', line: 3, severity: 'minor', summary: 'stale sentence', failureScenario: 'x' }] };
        if (l.startsWith('verify-r1')) return { real: true, severity: 'minor', reason: 'true but cosmetic' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs({ surface: 'docs', runtime: false }), agent, parallel, phase, () => {});
    assert.equal(r.loopClean, true, 'a minors-only round counts clean');
    assert.equal(r.reviewRounds, 1);
    assert.ok(r.advisoryNotes.some((s) => /stale sentence/.test(s)), 'the confirmed minor is reported as advisory');
    assert.ok(!calls.some((c) => (c.opts.label || '').startsWith('fix-r')), 'no fixer runs for minors only');
    assert.equal(r.readyForPR, true);
});

test('non-docs surfaces still fix confirmed minors (severity gate is docs/spec-scoped)', async () => {
    const { agent, calls } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l === 'review-r1:1')
            return { findings: [{ file: 'a.js', line: 1, severity: 'minor', summary: 'off by one', failureScenario: 'x' }] };
        if (l.startsWith('verify-r1')) return { real: true, severity: 'minor', reason: 'reproduces' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.ok(calls.some((c) => (c.opts.label || '').startsWith('fix-r')), 'code-surface minors still reach the fixer');
    assert.equal(r.advisoryNotes.length, 0);
    assert.ok(r.confirmedFindingsResolved >= 1);
});

test('docs/spec reviews carry a severity rubric and verifiers are required to return severity', async () => {
    // The docs/spec severity gate defaults an omitted severity to major and churns
    // an extra fix round; the finding bar now ships an explicit rubric and the
    // verifier prompt (and schema) require severity so it is never omitted.
    const { agent, calls } = makeAgent((_p, opts) => {
        if (opts.label === 'review-r1:1')
            return { findings: [{ file: 'docs/a.md', line: 3, severity: 'minor', summary: 's', failureScenario: 'x' }] };
        if ((opts.label || '').startsWith('verify-r1')) return { real: true, severity: 'minor', reason: 'cosmetic' };
        return undefined;
    });
    await runWorkflow(baseArgs({ surface: 'docs', runtime: false }), agent, parallel, phase, () => {});
    const review = calls.find((c) => (c.opts.label || '').startsWith('review-r1'));
    assert.match(review.prompt, /SEVERITY \(required on EVERY finding/, 'docs finding bar ships the severity rubric');
    const verify = calls.find((c) => (c.opts.label || '').startsWith('verify-r1'));
    assert.match(verify.prompt, /Return severity \(blocker\/major\/minor\) REQUIRED/, 'verifier is required to return severity');
});

test('docs surface: the hard round cap defaults to roundCap+1, not 10', async () => {
    // quick depth → mixed roundCap 2 → docs hard cap 3. A blocker every round
    // with a throwing fixer must stop after 3 rounds instead of churning to 10.
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (/^review-r\d+:1$/.test(l)) return finding('real blocker'); // mixed rounds
        if (/^sol-r\d+:1$/.test(l)) return finding('real blocker'); // gpt-only round(s)
        if (/^verify-r\d+:1$/.test(l)) return { real: true, severity: 'blocker', reason: 'c' };
        if (l.startsWith('fix-r')) return { __throw: 'cap' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs({ surface: 'docs', runtime: false }), agent, parallel, phase, () => {});
    assert.equal(r.reviewRounds, 3, 'docs hard cap is roundCap+1 (2+1)');
    assert.equal(r.readyForPR, false);
});

test('the finding ledger reaches round-2 reviewers with fixed and refuted dispositions', async () => {
    // Round 1: finding A confirmed+fixed, finding B refuted. Round-2 reviewer
    // prompts must carry both dispositions and the no-re-report rule.
    const { agent, calls } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l === 'review-r1:1')
            return {
                findings: [
                    { file: 'a.js', line: 1, severity: 'major', summary: 'A real defect', failureScenario: 'x' },
                    { file: 'b.js', line: 2, severity: 'major', summary: 'B bogus claim', failureScenario: 'y' },
                ],
            };
        if (l === 'verify-r1:1') return { real: true, reason: 'A reproduces' };
        if (l === 'verify-r1:2') return { real: false, reason: 'B impossible: guarded upstream' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.loopClean, true, 'round 2 is clean');
    const round2 = calls.filter((c) => /^(review|sol)-r2:/.test(c.opts.label || ''));
    assert.ok(round2.length, 'round 2 reviewers ran');
    for (const c of round2) {
        assert.match(c.prompt, /FINDING LEDGER/, 'ledger block present');
        assert.match(c.prompt, /A real defect/, 'fixed finding listed');
        assert.match(c.prompt, /B impossible: guarded upstream/, 'refuted reason carried forward');
        assert.match(c.prompt, /NEW evidence/, 'no-re-report rule present');
    }
    assert.ok(r.ledger.some((e) => e.status === 'fixed'), 'result exposes the fixed entry');
    assert.ok(r.ledger.some((e) => e.status === 'refuted'), 'result exposes the refuted entry');
});

test('the finding ledger carries EVERY disposition to later rounds (equal-share, not a head-slice)', async () => {
    // A churny round-1: 40 findings — #1 confirmed+fixed, #2..#40 refuted with long
    // reasons — produces 40 ledger entries well past the old 6000-char JSON slice.
    // The round-2 reviewer prompt must still carry the NEWEST dispositions (which a
    // head-slice dropped), so reviewers don't re-report them.
    const N = 40;
    const { agent, calls } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l === 'review-r1:1') {
            return {
                findings: Array.from({ length: N }, (_, k) => ({
                    file: `f${k + 1}.js`, line: k + 1, severity: 'major',
                    summary: `LEDGER_ENTRY_${k + 1}`, failureScenario: 'x'.repeat(40),
                })),
            };
        }
        const m = /^verify-r1:(\d+)$/.exec(l);
        if (m) {
            const idx = Number(m[1]);
            return idx === 1
                ? { real: true, reason: 'CONFIRM_1 ' + 'y'.repeat(260) } // forces round 2 + a fixed entry
                : { real: false, reason: `REFUTE_${idx} ` + 'z'.repeat(260) };
        }
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.ok(r.ledger.length >= N, `all ${N} dispositions recorded (got ${r.ledger.length})`);
    const round2 = calls.filter((c) => /^(review|sol)-r2:/.test(c.opts.label || ''));
    assert.ok(round2.length, 'round 2 ran');
    for (const c of round2) {
        assert.match(c.prompt, /FINDING LEDGER/, 'ledger present in round 2');
        assert.match(c.prompt, /REFUTE_2\b/, 'an EARLY refuted disposition survives');
        assert.match(c.prompt, /REFUTE_40\b/, 'the NEWEST refuted disposition survives (dropped by the old 6000-char head-slice)');
        assert.match(c.prompt, /LEDGER_ENTRY_1\b/, 'the fixed disposition survives');
    }
});

test('round-1 reviewers see no ledger block (nothing resolved yet)', async () => {
    const { agent, calls } = makeAgent(null);
    await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    const round1 = calls.filter((c) => /^(review|sol)-r1:/.test(c.opts.label || ''));
    assert.ok(round1.length, 'round 1 ran');
    for (const c of round1) assert.doesNotMatch(c.prompt, /FINDING LEDGER/);
});

test('reviewMode:"spec" swaps in the spec lenses and the citation rule', async () => {
    const { agent, calls } = makeAgent(null);
    await runWorkflow(baseArgs({ surface: 'docs', runtime: false, reviewMode: 'spec' }), agent, parallel, phase, () => {});
    const reviewPrompts = calls.filter((c) => c.opts.phase === 'Review').map((c) => c.prompt);
    assert.ok(reviewPrompts.some((p) => /Acceptance traceability/.test(p)), 'spec lens present');
    assert.ok(reviewPrompts.some((p) => /Implementability/.test(p)), 'spec lens present');
    assert.ok(reviewPrompts.every((p) => !/Lifecycle & concurrency/.test(p)), 'code lenses are replaced');
    assert.ok(
        reviewPrompts.some((p) => /SPEC REVIEW MODE/.test(p) && /NOT findings/.test(p)),
        'citation + no-editorial-preference rule present',
    );
});

test('a verify-fixer that commits but returns null is still caught by the HEAD-sha check', async () => {
    // The fixer commits real code, then dies before reporting (null / throw /
    // omitted commits array). The old commits-array-only detection would leave
    // verifyFixCommitted false and certify unreviewed code. HEAD moving between
    // the failing verify and the green re-verify must mark the branch unreviewed
    // regardless of what the fixer reported.
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l === 'verify') return { gates: [{ name: 'g', pass: false }], allBlockingPassed: false, failures: ['boom'], headSha: 'aaa111' };
        if (l.startsWith('verify-retry')) return { gates: [{ name: 'g', pass: true }], allBlockingPassed: true, e2e: { run: false, pass: true }, headSha: 'bbb222' };
        if (l.startsWith('verify-fix')) return null; // committed, then failed to report
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.loopClean, true, 'the review round itself was clean');
    assert.equal(r.verifyFixCommitted, true, 'HEAD moved after a verify-fix → unreviewed commits');
    assert.equal(r.readyForPR, false);
    assert.ok(r.residualRisks.some((s) => /never adversarially reviewed/i.test(s)));
});

test('an unverifiable HEAD after a verify-fix fails closed', async () => {
    // If the re-verify cannot report HEAD at all, the loop cannot prove the
    // fixer did NOT commit — treat the branch as unreviewed (fail closed).
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l === 'verify') return { gates: [{ name: 'g', pass: false }], allBlockingPassed: false, failures: ['boom'], headSha: 'aaa111' };
        if (l.startsWith('verify-retry')) return { gates: [{ name: 'g', pass: true }], allBlockingPassed: true, e2e: { run: false, pass: true } }; // no headSha
        if (l.startsWith('verify-fix')) return { applied: [], commits: [] }; // claims nothing committed
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.verifyFixCommitted, true, 'unreadable HEAD after a fix attempt fails closed');
    assert.equal(r.readyForPR, false);
});

test('an unchanged HEAD across a no-op verify-fix attempt stays ready-for-PR', async () => {
    // The fixer ran but proved it committed nothing, and HEAD is identical
    // across verify runs — the reviewed range is unchanged, so a green re-verify
    // may certify.
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l === 'verify') return { gates: [{ name: 'g', pass: false }], allBlockingPassed: false, failures: ['flake'], headSha: 'aaa111' };
        if (l.startsWith('verify-retry')) return { gates: [{ name: 'g', pass: true }], allBlockingPassed: true, e2e: { run: false, pass: true }, headSha: 'aaa111' };
        if (l.startsWith('verify-fix')) return { applied: [], commits: [] };
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.verifyFixCommitted, false, 'identical HEAD + empty commits report → nothing unreviewed');
    assert.equal(r.readyForPR, true);
});

test('an unknown surface coerces to cross and runs every surface gate', async () => {
    const { agent, calls } = makeAgent(null);
    await runWorkflow(baseArgs({ surface: 'clinet', runtime: false }), agent, parallel, phase, () => {});
    const verifyCall = calls.find((c) => c.opts.phase === 'Verify' && (c.opts.label || '').startsWith('verify'));
    assert.ok(verifyCall, 'verify runner invoked');
    // cross superset: client-only, server-only, perf, and docs gates all present.
    assert.match(verifyCall.prompt, /npm run test:client:coverage/);
    assert.match(verifyCall.prompt, /dotnet build .*JellyfinCanopy\.csproj/);
    assert.match(verifyCall.prompt, /npm run check:performance-rules/);
    assert.match(verifyCall.prompt, /npm run check:docs/);
});

test('the performance-rules gate runs on the client surface', async () => {
    const { agent, calls } = makeAgent(null);
    await runWorkflow(baseArgs({ surface: 'client' }), agent, parallel, phase, () => {});
    const verifyCall = calls.find((c) => c.opts.phase === 'Verify' && (c.opts.label || '').startsWith('verify'));
    assert.match(verifyCall.prompt, /npm run check:performance-rules/, 'client verification includes the perf-rules gate');
});

test('the docs gate runs even on a non-docs surface', async () => {
    const { agent, calls } = makeAgent(null);
    await runWorkflow(baseArgs({ surface: 'server' }), agent, parallel, phase, () => {});
    const verifyCall = calls.find((c) => c.opts.phase === 'Verify' && (c.opts.label || '').startsWith('verify'));
    assert.match(verifyCall.prompt, /npm run check:docs/, 'docs validation is not gated on the declared surface');
});
