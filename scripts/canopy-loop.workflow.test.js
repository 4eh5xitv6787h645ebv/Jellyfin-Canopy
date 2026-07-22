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

test('an explicit briefText suppresses the issue fetch (launcher brief stays authoritative)', async () => {
    const { agent, calls } = makeAgent(null);
    await runWorkflow(baseArgs({ issue: 452, briefText: 'MANUAL BRIEF' }), agent, parallel, phase, () => {});
    assert.ok(!calls.some((c) => (c.opts.label || '') === 'fetch-issue'), 'no fetch when briefText supplied');
    const impl = calls.find((c) => (c.opts.label || '').startsWith('implement'));
    assert.match(impl.prompt, /MANUAL BRIEF/);
});

test('a failed issue fetch falls back to the brief-path behavior', async () => {
    const { agent, calls } = makeAgent((_p, opts) => {
        if ((opts.label || '') === 'fetch-issue') return null;
        return undefined;
    });
    const r = await runWorkflow(baseArgs({ issue: 452 }), agent, parallel, phase, () => {});
    const impl = calls.find((c) => (c.opts.label || '').startsWith('implement'));
    assert.match(impl.prompt, /brief text not inlined; open the path above/, 'existing brief-path fallback preserved');
    assert.equal(r.readyForPR, true, 'a failed fetch alone never blocks the run');
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
