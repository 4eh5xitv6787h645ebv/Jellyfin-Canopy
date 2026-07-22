# jellyfin-canopy-agentic-loop

A Bun-inspired, multi-agent execution engine for Jellyfin Canopy work — bug
fixes, features, refactors, and general changes. It carries a change through
**parallel explore + plan**, a **single-writer implement**, an **adversarial
review-until-clean loop**, and **repo-native verification**, then hands a clean
branch back for PR.

It is a *how*, layered on top of the *what*: every contract, gate, and
safety/PR rule is owned by
[`../jellyfin-canopy-engineering/SKILL.md`](../jellyfin-canopy-engineering/SKILL.md)
and `AGENTS.md`. This skill never restates or overrides them.

## Why

Reading a large AI-authored diff by hand does not build confidence. Bun's
Zig→Rust rewrite built it three ways instead: a language-independent test suite,
**adversarial review in split context** (the reviewer never saw the author's
reasoning and is told to assume the code is wrong), and **fixing the process
that generated bad code** rather than each bad line. This skill applies the same
loop to Canopy, using the repo's own Vitest/xUnit/E2E suite as the conformance
oracle.

## Files

| File | Role |
| --- | --- |
| `SKILL.md` | Entry point — method, what runs in the main thread vs. the engine, guardrails. |
| `references/adversarial-review.md` | The review loop: split-context rules, lenses, finding verification, done criteria. |
| `workflows/canopy-loop.js` | The Claude Code Workflow script that runs the phases deterministically. |
| `agents/openai.yaml` | Portable interface metadata. |

## Using it (Claude Code)

1. The main thread establishes scope and safety and creates the isolated
   worktree + dedicated branch from current `origin/main` (per the engineering
   skill), and writes the task brief.
2. From inside that worktree, launch the loop:

   ```
   Workflow({
     scriptPath: ".agents/skills/jellyfin-canopy-agentic-loop/workflows/canopy-loop.js",
     args: {
       worktree: "<abs worktree path>",
       branch:   "<type>/<slug>",
       task:     "<full task / issue / repro>",
       brief:    "<path to task-brief.md>",
       briefText: "<the brief CONTENTS inlined — preferred; agents may never open the path>",
       issue:    123,              // commit-subject ref; with NO briefText, a Phase-0 agent
                                   // fetches the live issue body as the brief (self-hydration)
       surface:  "client" | "server" | "cross" | "docs",
       runtime:  true,
       depth:    "quick" | "standard" | "deep",
       startPhase: "explore",      // resume a paused/limit-killed run with "review" or "verify"
       reviewedHead: "<sha>",      // verify-resume only: certifies the prior clean review when
                                   // verify reports this exact HEAD (record the paused run's headSha)
       ledger: [/* paused run's result.ledger */],  // review-resume only: seed prior
                                   // fix/refute dispositions so they are not re-churned
       envSetup: "<shell prelude run before any build/test, e.g. DOTNET_ROOT exports>",
       reviewMode: "spec",         // opt-in for specification authoring (spec lenses)
       solVia:   "codex-cli",      // default; or "agent" (needs a Sol-capable router)
       solEffort: "high",
       solReviewers: 1,            // whole-diff Sol reviewers per round (min 1)
       stallPatience: 2,           // review-loop non-convergence: no-progress rounds → stop (default 2)
       backstopRounds: 25,         // review-loop absolute ceiling (default ~25; docs/spec roundCap+1)
       hardRoundCap: 10            // EXPLICIT OVERRIDE: old fixed cap — pins the backstop AND disables the stall detector
     }
   })
   ```

3. Monitor with `/workflows`. Read the returned result (`readyForPR`,
   `residualRisks`, gate/e2e evidence). If `readyForPR`, the main thread verifies
   the push target, pushes, and opens the PR. Deployment to `:8099` and releases
   remain separate, explicitly-authorized actions.

### Depth

| depth | explorers | planners | mixed review round cap | verify-fix cap |
| --- | --- | --- | --- | --- |
| quick | 2 | 2 | 2 | 1 |
| standard | 8 | 3 | 4 | 2 |
| deep | 8 | 3 | 4 | 3 |

The "mixed" cap is the Claude+Sol panel; if the loop is still not clean after
it, review **continues with `gpt-5.6-sol` as the only reviewer**. The loop then
terminates on one of three signals, not an arbitrary count:

- **a clean round** (no confirmed findings);
- **a progress stall** — `stallPatience` consecutive rounds with no progress
  (default 2), or a round whose confirmed findings are wholly a re-report of
  ledger-disposed items (pure oscillation). A stall is **non-convergence**: the
  run stops, does not certify, and returns a "did not converge" residual asking a
  human to split the change. "Progress" = the confirmed-finding count strictly
  fell vs the previous round, or ≥1 confirmed finding was newly applied;
- **a runaway backstop** — an absolute ceiling (`backstopRounds`, default ~25;
  docs and `reviewMode:"spec"` default mixed-cap+1) so a pathologically entangled
  file cannot loop forever even while nominally making progress one finding at a
  time.

This replaces the old fixed 10-round cap: a legitimately-converging change is
**never** cut off by a count, and a stalled one (the #167 config-page.js case:
8 h / 21 M tokens / never converged) stops fast and surfaces for a human.
`hardRoundCap` still works as an explicit override — it pins the backstop to that
fixed count **and** disables the stall detector, restoring the old fixed-count
behavior for callers who want it.

`surface` selects which repo-native gates run (docs runs also use 4
docs-specific explore angles and skip Localize — `server` runs skip Localize too,
having no client locale surface); `runtime:true` additionally
builds the Release DLL and runs `npm run e2e:local` (dockerized
`jellyfin/jellyfin:unstable`).

### Operating envelopes

The loop serves two envelopes:

- **FIXES** — contained bug fixes and small changes: `depth:"quick"` plus a
  patch-sized brief (tight acceptance criteria, narrow surface) keeps the run
  light: 2 explorers, 2 planners, a 2-round mixed cap, surface-scoped gates.
- **FEATURES** — large multi-day work: run `standard`/`deep`; the loop survives
  provider outages by returning `status:"paused"` with `pauseReason` +
  `resumeFrom` instead of burning retries, and a later session re-enters with
  `startPhase:"review"`/`"verify"` against the same branch. A verify-only resume
  is fail-closed (no review ran) unless the pause followed a clean review round:
  pass `reviewedHead:<the returned headSha>` and it certifies iff verify reports
  that exact HEAD. Campaigns over an issue queue relaunch per issue (`issue: N`
  self-hydrates the brief) and use the returned resume fields
  (`resumeFrom`/`headSha`/`loopClean`/`ledger`) as the per-issue checkpoint —
  pass the persisted `ledger` back on a `startPhase:"review"` resume so the review
  loop keeps its prior refutations/fixes suppressed instead of re-churning them.

### Model routing

The loop spreads models by role to spare Claude/Opus budget:

- **Implementation** — the single writer runs on **Fable (high)**, falling back
  to **Opus (high)** if Fable is exhausted (`implementModel` / `implementFallback`).
- **Read-only steps except the gate runner** — with `modelSplit: true` (default):
  **explore runs 8 explorers on a non-docs standard/deep run — 2 Claude + 6
  `gpt-5.6-sol`** (`exploreClaudeCount`, Sol slots at `xhigh`; a `quick` run uses 2
  explorers and a `docs` surface uses its 4 docs-specific angles = 2 Claude + 2
  Sol); plan (incl. synthesis), the review lenses, and
  finding-verification alternate **~50/50 Claude / `gpt-5.6-sol`**; an
  unroutable Sol slot falls back to Claude. After 3 consecutive Sol failures a
  circuit breaker sends the remaining Sol slots straight to Claude, and the
  result's `modelCoverage` records requested-vs-actual models per slot class.
- **Final verify / gate run** — stays on **Claude** (one authoritative model
  runs the repo gates; never split to Sol).
- **Fixers** — stay on Claude/Opus (they write code).

Every **mixed** review round (up to the mixed cap) runs **both** Claude and
**≥1 `gpt-5.6-sol` (high)** reviewer; escalation rounds past the mixed cap are
`gpt-5.6-sol`-only. The Sol side is obtained one of two ways, chosen with
`solVia`:

- `"codex-cli"` (default) — a harness subagent shells out to the local `codex`
  CLI (`-a never -s read-only exec -m gpt-5.6-sol`) with
  `references/codex-review-schema.json`. Works without any router setup.
- `"agent"` — requests `gpt-5.6-sol` directly on the subagent. Needs a
  Sol-capable route for Claude Code, e.g. the CLIProxyAPI router that exposes
  `gpt-5.6-sol`
  ([how-to](https://vallettasoftware.com/blog/post/run-gpt-5-6-in-claude-code)).
  No `codex` dependency.

Each Sol slot is fail-closed: if the route/CLI is unavailable, that slot's scope
(its lens, or the whole diff) is reviewed by Claude instead — the slot is never
dropped and a round is never certified clean with a lens left unreviewed. Treat a
missing Sol pass as a signal to fix the route, not as a clean review — and the loop
enforces it: the round that certifies `loopClean` MUST have **real** cross-family
coverage. A clean round whose every Sol slot fell back to Claude (dead route) sets
`reviewIncomplete`, so `readyForPR` stays false until the Sol route is fixed.

## Non–Claude-Code runtimes

The Workflow tool is Claude Code specific. Any capable agent runtime can follow
the same method by hand: spawn read-only explorer/planner/reviewer sub-agents in
parallel, keep exactly one writer, and run the loop and gates from
`references/adversarial-review.md` and the engineering skill.
