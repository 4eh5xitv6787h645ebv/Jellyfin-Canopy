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
function happy(opts) {
    const label = (opts && opts.label) || '';
    const ph = (opts && opts.phase) || '';
    if (label.startsWith('explore')) return { owningLayer: 'x', files: [{ path: 'a', role: 'r' }], consumers: [], contracts: [], testSeams: [] };
    if (label.startsWith('plan')) return { summary: 's', owningLayer: 'x', steps: ['s'], tests: ['t'], stateModel: 'm' };
    if (label.startsWith('implement')) return { changedFiles: ['f'], commits: ['c'], selfConfidence: 'high', openTodos: [] };
    if (ph === 'Review') {
        if (label.startsWith('verify-r')) return { real: false, reason: 'refuted' };
        if (label.startsWith('fix-r')) return { applied: ['a'], commits: ['c'] };
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
        return happy(opts);
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
    // Every Sol agent throws (router down); the Claude fallback for one Sol lens
    // reports a real defect. If the fallback did NOT run, no finding would exist.
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (l.startsWith('sol-r')) return { __throw: 'sol unroutable' };
        if (l === 'review-r1:2') return finding('defect on a Sol-owned lens');
        if (l.startsWith('verify-r1')) return { real: true, reason: 'confirmed' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.ok(r.confirmedFindingsResolved >= 1, 'Sol lens defect surfaced via Claude fallback');
    assert.equal(r.readyForPR, true);
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
    assert.ok(r.confirmedFindingsResolved >= 1);
    assert.equal(r.loopClean, false, 'a round with an unfixed confirmed finding is not clean');
    assert.equal(r.reviewIncomplete, false, 'coverage was complete — the finding was confirmed, not lost');
    assert.equal(r.readyForPR, false, 'unresolved confirmed findings must block ready-for-PR');
    assert.ok(
        r.residualRisks.some((s) => /round cap with unresolved confirmed findings/i.test(s)),
        'the round-cap residual risk is reported',
    );
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
    assert.match(harness.prompt, /trap 'rm -f/, 'harness cleans up its temp files');
    // Randomised, unguessable heredoc delimiter (not the fixed, collidable SOL_PROMPT).
    assert.match(harness.prompt, /<<'SOL_PROMPT_[a-z0-9]{8,}'/, 'per-run nonce heredoc delimiter');
    assert.doesNotMatch(harness.prompt, /<<'SOL_PROMPT'\n/, 'no fixed collidable delimiter');
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
