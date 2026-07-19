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
    if (label.startsWith('explore')) return { owningLayer: 'x', files: [{ path: 'a', role: 'r' }], consumers: [], contracts: [], testSeams: [], helpers: ['src/core/lifecycle.ts:disposeBag'] };
    if (label.startsWith('design-lock')) {
        if (label.includes('challenge')) return { decisionId: 'd1', approach: 'a', acceptanceCriteria: [], helperDisposition: [], invariants: [] };
        return {
            decisionId: 'd1',
            approach: 'reuse the existing lifecycle disposeBag',
            invariants: [{ id: 'i1', statement: 'exactly one live handler set' }],
            helperDisposition: [{ path: 'src/core/lifecycle.ts', symbol: 'disposeBag', disposition: 'reuse', reason: 'the repo primitive' }],
            rejectedAlternatives: [{ id: 'r1', description: 'hand-rolled registry', reason: 'duplicates lifecycle.ts', reopenWhen: 'disposeBag proven unusable here' }],
            acceptanceCriteria: [{ id: 'AC1', text: 'one handler set after N visits' }],
            testProofRequirements: ['exercise the real production entry point'],
        };
    }
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

test('a persistently-unfixable finding HALTS for a design re-decision, never ready-for-PR', async () => {
    // EVERY round surfaces the SAME real, confirmed finding whose fixer throws
    // (StructuredOutput retry cap). Under the stateful review the same defect
    // re-appearing after a fix attempt is OSCILLATION: the loop must HALT with a
    // truthful haltReason (non-convergent-design) EARLY — never grind to the hard
    // cap — never count the thrown fixer as "resolved", and never be ready-for-PR.
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (/^review-r\d+:1$/.test(l)) return finding('needs a fix'); // mixed rounds
        if (/^sol-r\d+:1$/.test(l)) return finding('needs a fix'); // gpt-only rounds (lens 0 on Sol)
        if (/^verify-r\d+:1$/.test(l)) return { real: true, reason: 'confirmed' }; // every round
        if (l.startsWith('fix-r')) return { __throw: 'StructuredOutput retry cap' };
        return undefined;
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(typeof r, 'object'); // resolves with a structured result, never aborts
    assert.equal(r.loopClean, false, 'a round with an unfixed confirmed finding is not clean');
    assert.equal(r.haltReason, 'non-convergent-design', 'oscillation halts the loop for a design re-decision');
    assert.ok(r.reviewRounds < 10, 'HALTED early — did not grind to the hard cap');
    assert.equal(r.confirmedFindingsResolved, 0, 'a thrown fixer applied nothing — honest resolved count is 0');
    assert.equal(r.readyForPR, false, 'unresolved confirmed findings must block ready-for-PR');
    assert.ok(
        r.residualRisks.some((s) => /design oscillation|design re-decision|HALTED/i.test(s)),
        'the non-convergence residual risk is reported',
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
    // A DISTINCT confirmed finding every round (a fresh defect, so no oscillation
    // halt), fixer succeeds → the loop keeps finding new issues and runs to
    // hardRoundCap. Mixed rounds (≤ roundCap) use Claude lens reviewers; every
    // later round is gpt-only (no Claude lens reviewer runs past the mixed cap).
    // Distinct WORDS (not round numbers) because findingKey collapses digits.
    const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    const { agent, calls } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        const rm = l.match(/^(?:review|sol)-r(\d+):1$/);
        if (rm) {
            const w = WORDS[Number(rm[1]) - 1];
            // Distinct summary AND failureScenario so findingKey differs each round
            // (no oscillation halt) — a genuinely fresh defect per round.
            return { findings: [{ file: 'a.js', line: 1, severity: 'major', summary: 'defect ' + w, failureScenario: 'scenario ' + w }] };
        }
        if (/^verify-r\d+:1$/.test(l)) return { real: true, reason: 'c' };
        // fixer uses the happy default (succeeds) — no fixer failure, no oscillation
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

test('oscillation: a fix that does not stick (finding persists) halts for a design re-decision', async () => {
    // The fixer SUCCEEDS every round, but the SAME defect keeps being re-confirmed
    // (the fix does not resolve it) — the #167 design-thrash shape. The stateful
    // review must detect the repeat, allow one design revision, then HALT early.
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (/^(?:review|sol)-r\d+:1$/.test(l)) return finding('same unresolved defect'); // identical every round
        if (/^verify-r\d+:1$/.test(l)) return { real: true, reason: 'c' };
        // fix-r* uses the happy default → succeeds, yet the defect returns next round
        return undefined;
    });
    const r = await runWorkflow(baseArgs({ depth: 'quick', hardRoundCap: 10 }), agent, parallel, phase, () => {});
    assert.equal(r.haltReason, 'non-convergent-design', 'a persistent re-confirmed defect halts');
    assert.ok(r.reviewRounds < 10, 'halted early, not ground to the hard cap');
    assert.equal(r.loopClean, false);
    assert.equal(r.readyForPR, false);
    assert.equal(typeof r.designRevisions, 'number');
    assert.ok(r.designRevisions >= 1, 'at least one design revision was recorded before halting');
});

test('confirmedFindingsResolved counts only what a fixer actually applied', async () => {
    // One defect in round 1 only; fixer applies it; round 2 is clean.
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        if (/^(?:review|sol)-r1:1$/.test(l)) return finding('one real defect'); // round 1 only
        if (/^verify-r1:1$/.test(l)) return { real: true, reason: 'c' };
        return undefined; // round 2 reviewers → happy {findings:[]} → clean
    });
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.equal(r.loopClean, true, 'clean once the single defect is fixed');
    assert.equal(r.confirmedFindingsResolved, 1, 'honest count = the one applied fix');
    assert.equal(r.confirmedFindingsTotal, 1, 'one finding was confirmed total');
    assert.equal(r.haltReason, null);
    assert.equal(r.fixerFailures, 0);
});

test('design lock is bound, preserves discovered helpers, and is threaded into implement + review', async () => {
    const { agent, calls } = makeAgent(null);
    const r = await runWorkflow(baseArgs(), agent, parallel, phase, () => {});
    assert.ok(r.designLock && r.designLock.decisionId, 'a binding design lock is returned in the result');
    // the design-lock agent RECEIVED the programmatically-preserved discovered helper
    const lockCall = calls.find((c) => c.opts.label === 'design-lock');
    assert.ok(lockCall, 'design-lock phase ran');
    assert.match(lockCall.prompt, /lifecycle\.ts/, 'discovered helper preserved into the lock prompt (not lost to truncation)');
    // the lock is threaded into the implementer and the reviewers
    const implCall = calls.find((c) => (c.opts.label || '').startsWith('implement'));
    assert.match(implCall.prompt, /BINDING DESIGN LOCK/, 'implementer sees the lock');
    assert.ok(
        calls.some((c) => c.opts.phase === 'Review' && /BINDING DESIGN LOCK/.test(c.prompt)),
        'reviewers see the lock (they previously never received the plan/decision)',
    );
});

test('a persistent reopen-design verdict halts for a design re-decision', async () => {
    // A fresh reviewer finding each round, each VERIFIED as reopen-design (new
    // evidence the locked architecture is wrong). Distinct scenarios so it is the
    // REOPEN budget — not oscillation — that halts.
    const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
    const { agent } = makeAgent((_p, opts) => {
        const l = opts.label || '';
        const rm = l.match(/^(?:review|sol)-r(\d+):1$/);
        if (rm) {
            const w = WORDS[Number(rm[1]) - 1];
            return { findings: [{ file: 'a.js', line: 1, severity: 'major', summary: 'wrong arch ' + w, failureScenario: 'scenario ' + w }] };
        }
        if (/^verify-r\d+:1$/.test(l)) return { real: false, disposition: 'reopen-design', reason: 'lock missed a repo primitive' };
        return undefined; // fixer succeeds (happy) but the architecture keeps being wrong
    });
    const r = await runWorkflow(baseArgs({ depth: 'quick', hardRoundCap: 10 }), agent, parallel, phase, () => {});
    assert.ok(['design-reopened', 'non-convergent-design'].includes(r.haltReason), 'reopen-design halts for a re-decision');
    assert.ok(r.reviewRounds < 10, 'halted early, not ground to the hard cap');
    assert.ok(r.designRevisions >= 1);
    assert.equal(r.readyForPR, false);
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
