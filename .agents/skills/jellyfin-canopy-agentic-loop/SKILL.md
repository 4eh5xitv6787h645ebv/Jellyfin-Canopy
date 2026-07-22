---
name: jellyfin-canopy-agentic-loop
description: Bun-style multi-agent orchestration for Jellyfin Canopy work — bug fixes, features, refactors, and general changes driven by parallel explore/plan phases and an implement → adversarial-review → fix loop, then repo-native verification. Use when you want the change carried by a fan-out of agents with split-context adversarial review rather than a single writer, on any task in 4eh5xitv6787h645ebv/Jellyfin-Canopy. This skill governs HOW the work runs; all repository contracts, safety rules, gates, and PR discipline come from jellyfin-canopy-engineering and AGENTS.md, which it obeys unchanged.
---

# Jellyfin Canopy agentic loop

This skill is an **execution engine**, not a second rulebook. It runs a Canopy
change as a set of parallel agent loops modelled on Bun's Zig→Rust rewrite:
one implementer, two or more adversarial reviewers, a fixer, and a
verify-driven definition of done. It exists to raise confidence on non-trivial
changes by making review independent, parallel, and hostile to the code.

**It does not restate contracts.** Every safety rule, architecture contract,
gate command, coverage/lint policy, and PR/merge/CI rule is owned by:

- [`.agents/skills/jellyfin-canopy-engineering/SKILL.md`](../jellyfin-canopy-engineering/SKILL.md) — the canonical end-to-end workflow;
- [`AGENTS.md`](../../../AGENTS.md), `CONTRIBUTING.md`, `SECURITY.md`, and the instructions nearest the files in scope.

Read those first. This skill only adds the multi-agent *shape* on top. Where
this file and the engineering skill ever appear to disagree, the engineering
skill and the repository documents win.

## The method (why it looks like this)

Day-to-day engineering is a loop: pick a task, write the change, have it
reviewed for regressions and correctness, apply the feedback. Bun's rewrite
scaled that loop by splitting the roles across separate agents with separate
context windows:

- **Split context.** The agent that wrote the code wants it merged; that bias
  is real for models too. So the reviewer is a *different* agent that never saw
  the implementer's reasoning — only the diff and the brief — and is told to
  assume the code is wrong and find out why. **1 implementer, 2+ adversarial
  reviewers, 1 fixer.** Implementers do not review; reviewers do not implement.
- **Confidence comes from three things**, not from reading a huge diff by hand:
  a language-independent test suite (Canopy's Vitest + xUnit + E2E), adversarial
  review, and — when something is wrong — **fixing the process that produced the
  code, not just the line**. If a whole class of mistake keeps appearing, edit
  the implementer/reviewer instructions, don't hand-patch each instance.
- **Parallelise the read-only work, serialise the writer.** Exploration,
  planning judgement, review, and finding-verification are read-only and fan out
  wide. Implementation and fixes mutate the worktree and must be **one writer at
  a time** — the repository's "one writer per worktree" rule is non-negotiable.

## What runs where

Two things stay in the **main thread** (the human-facing agent), because they
need authority, judgement, or an outward-facing action:

1. **Scope, safety, and branch setup** — restate the outcome; confirm it isn't
   already native/implemented/infeasible; establish the isolated worktree and
   dedicated branch from current `origin/main` exactly as the engineering skill
   describes. Write the task brief (acceptance criteria, non-goals, owning
   layer, reuse decisions, risks, reviewer questions).
2. **Publish and prove** — after the loop returns clean, verify the push target,
   push the branch, open the PR (put `Closes #<N>` in the body so the merge
   auto-closes the issue and moves its Project 4 item to Done), watch CI, and
   report. Never deploy to `:8099` or mutate an external service as an implicit
   step; those need separate explicit authorization.

Everything between — explore, plan, implement, adversarial review loop, and
repo-native verification — runs inside the **Workflow engine**.

## Running the loop (Claude Code)

In Claude Code, execute the loop deterministically with the bundled Workflow
script. Launch it **from inside the prepared worktree** and pass the task
context as `args`:

```
Workflow({
  scriptPath: ".agents/skills/jellyfin-canopy-agentic-loop/workflows/canopy-loop.js",
  args: {
    worktree: "<absolute path to the prepared worktree>",
    branch:   "<type>/<slug>",
    task:     "<the full task: issue text / feature contract / bug + repro>",
    brief:    "<path to the task-brief.md the main thread wrote>",
    briefText: "<the brief CONTENTS inlined — preferred; agents may never open the path>",
    issue:    123,               // commit-subject ref; with NO briefText a Phase-0 agent
                                 // fetches the live issue body as the brief (self-hydration)
    surface:  "client" | "server" | "cross" | "docs",   // drives which gates run
    runtime:  true,                                       // true → also run e2e:local
    depth:    "standard",                                 // "quick" | "standard" | "deep"
    startPhase: "explore",       // "review"/"verify" resume a paused run on the same branch
    reviewedHead: "<sha>",       // with startPhase:"verify" ONLY: the HEAD the paused run was
                                 // clean at — certifies the prior review iff verify reports the same HEAD
    ledger: [/* the paused run's returned result.ledger */],  // seed the finding ledger on a
                                 // startPhase:"review" resume so prior fixes/refutations stay suppressed
    envSetup: "<shell prelude every build/test agent runs first (e.g. DOTNET_ROOT exports)>",
    reviewMode: "spec",          // opt-in spec-authoring lenses (acceptance traceability, …)

    // Model routing (see "Model routing" below):
    modelSplit:  true,           // ~50/50 Claude/Sol on read-only steps to spare Opus budget
    solVia:      "codex-cli",    // default; or "agent" (subagent model param, needs a Sol-capable router)
    solModel:    "gpt-5.6-sol",
    solEffort:   "high",
    solReviewers: 1,             // whole-diff Sol reviewers per round (min 1, split or not)
    implementModel:    "fable",  // implementer runs on Fable (high) …
    implementFallback: "opus"    // … falling back to Opus (high) if Fable is exhausted
  }
})
```

### Operating envelopes

- **FIXES** (light): for a contained bug fix, use `depth:"quick"` with a
  patch-sized brief and a narrow `surface` — 2 explorers, 2 planners, 2 mixed
  review rounds, surface-scoped gates. The safety essentials (requirement
  fidelity, fail-closed review, gate integrity) stay on.
- **FEATURES** (multi-day): use `standard`/`deep`. On a terminal provider
  failure (session/usage limit, quota, credits) the loop STOPS spawning agents
  and returns `status:"paused"` with `pauseReason` and `resumeFrom`; relaunch
  later with `startPhase:"review"` (or `"verify"`) on the same branch instead of
  re-burning explore/plan/implement. A verify-only resume normally never certifies
  `readyForPR` — **except** when the pause came AFTER a certified-clean review
  round (`resumeFrom.phase==="verify"`, the run's `loopClean` was true): record the
  paused run's returned `headSha` (or `git -C <worktree> rev-parse HEAD`) and
  resume with `startPhase:"verify"` **plus** `reviewedHead:<that sha>`. The run
  certifies iff the verify agent independently reports the same HEAD (proving no
  commit changed since the clean review); any mismatch stays fail-closed. For
  campaigns over an issue queue, relaunch per issue with `issue: N` (self-hydrating
  brief) and persist each run's returned `resumeFrom`/`headSha`/`loopClean`/`ledger`
  as the per-issue checkpoint. Pass the persisted `ledger` back as `ledger:` on a
  `startPhase:"review"` resume so the review loop keeps its prior refutations and
  fixes suppressed instead of re-churning them.

### Model routing

To keep a run from burning all of Claude's budget, the loop deliberately spreads
models by role:

- **Weighted Claude / `gpt-5.6-sol` split — the whole way, except two roles.** With
  `modelSplit: true`, explore, plan (incl. synthesis), the review lenses, and the
  review's finding-verification are spread across Claude and `gpt-5.6-sol`:
  - **Explore** runs 8 explorers on a non-docs standard/deep run; the first 2 on
    Claude/Opus and the remaining 6 on `gpt-5.6-sol` (override with
    `exploreClaudeCount`). A `quick` run uses 2 explorers, and a `docs` surface uses
    its 4 docs-specific angles (2 Claude + 2 Sol) — the "6 Sol" figure is the
    standard/deep code-surface case, not every run.
  - **Explore + plan** (incl. synthesis) run their Sol slots at **`xhigh`**
    reasoning effort on the `"agent"` route (`solExplorePlanEffort`, default
    `xhigh`); on the default `"codex-cli"` route those slots run at
    `solLightEffort` (default `medium`) — synthesis passes `xhigh` through on
    either route. Plan keeps a ~50/50 split.
  - **Review** runs the mixed panel (Claude lenses + `gpt-5.6-sol`) for the first
    `roundCap` rounds (standard = 4); if still not clean it CONTINUES with
    `gpt-5.6-sol` as the ONLY reviewer up to `hardRoundCap` (default 10; docs
    surfaces and `reviewMode:"spec"` default to `roundCap`+1 instead). Review Sol
    stays at `solEffort` (high). Three consecutive Sol failures trip a circuit
    breaker (remaining Sol slots go straight to Claude); the result's
    `modelCoverage` shows requested-vs-actual coverage.
  Under `solVia: "codex-cli"` (default) the Sol slots run through a generalized
  `codex` harness; under `solVia: "agent"` they use the subagent model param via a
  router. Any Sol slot that can't be routed **falls back to Claude**, so no slot is
  lost (even in a gpt-only round).
- **Implementation (excepted)** — the single writer runs on **Fable (high)**,
  falling back to **Opus (high)** if Fable is exhausted/unavailable. Never split
  mid-change, never gpt.
- **Final verify / gate run (excepted)** — stays on **Claude**: one authoritative
  model runs the repo gates. Never split to Sol.
- **Fixers** (review fixer, verify fixer) — stay on Claude/Opus. They write code,
  so they follow the one-writer, single-model rule.

Set `modelSplit: false` to run all read-only phases on Claude (implementer still
Fable→Opus; review still gets ≥1 whole-diff `gpt-5.6-sol` reviewer).

### Incidental bugs → the bug inventory

While exploring, agents surface **unrelated pre-existing bugs** they notice (they
do **not** fix them — no scope creep). The loop returns them as
`result.incidentalBugs`. **Only when issue creation, labelling, and Project
mutation are authorized for this run** does the main thread dedupe against open
issues and file the genuinely-new ones to the **Jellyfin Elevate Bug Inventory
(Project 4)** with the `bug-inventory` + `no-stale` labels. Absent that
authorization, surface the deduped list as a **proposed issue payload for the
user to disposition** — do not mutate GitHub. Filing issues, like deploys and
releases, is an outward-facing action, not an implicit step of the loop.

The script fans out agents per phase, loops the review until a clean round, runs
the repo-native gates, and returns a structured result (diff stat, findings
resolved, gate evidence, E2E evidence, residual risks). **Monitor it** with
`/workflows` and read its returned result — its agents' text is not shown to the
user, so relay what matters. Requirements:

- The Workflow tool is opt-in and billable. Invoking this skill on a real task
  **is** that opt-in; do not launch the loop speculatively.
- The loop assumes the worktree already exists on the right branch with the
  toolchain installed (`npm ci`, `DOTNET_ROOT` on `PATH`). Do that in step 1.
- The loop writes code and commits inside the one worktree. Do not start a
  second writer, a deploy, or an E2E run against a shared server while it runs.

If the Workflow tool is unavailable (a non–Claude-Code runtime reading this
skill), follow the same phases manually: spawn read-only explorer/planner/
reviewer sub-agents in parallel, keep a single writer, and apply the loop and
gates described in [`references/adversarial-review.md`](references/adversarial-review.md).

## The phases

The engine ([`workflows/canopy-loop.js`](workflows/canopy-loop.js)) runs:

1. **Explore** (parallel, read-only) — map the owning layer, every producer/
   consumer, the nearest implemented analogue, existing cross-cutting helpers,
   the contracts the change touches, and the test seams. No guessing about where
   code lives.
2. **Plan** (parallel judge panel) — a few independent plans, each choosing the
   owning layer, reuse-vs-new decisions, and the simplest state/failure model;
   adversarially scored and synthesised into one canonical plan. Prefer deleting
   or delegating state over adding a flag/retry/lock/observer.
3. **Implement** (single writer) — build the change at its owner, update every
   affected consumer, add tests that fail before the fix (admin and non-admin,
   negative/fallback paths, concurrency/cache invalidation where relevant), add
   any new i18n key **only to the base `en.json`** (the Localize phase fans out
   the translations), and update affected docs. Commit coherent conventional
   units. No `Co-Authored-By` trailers; **include the issue number `#N`** in
   each commit subject (e.g. end it with ` (#123)`).
4. **Review loop** (parallel adversarial, loop-until-clean) — see
   [`references/adversarial-review.md`](references/adversarial-review.md). Each
   mixed round runs models on purpose: the Claude lens reviewers **and** at least
   one `gpt-5.6-sol` (high effort) whole-diff reviewer, all in split context (diff
   + brief only, told to assume the code is wrong); rounds past the mixed cap are
   `gpt-5.6-sol`-only up to `hardRoundCap`. Findings are deduped and adversarially
   verified to kill false positives; a **finding ledger** (fixed + refuted, with
   verifier reasons) is injected into later rounds so resolved items are not
   re-reported without new evidence; a single fixer applies confirmed findings;
   re-review until a clean round. On docs surfaces (and `reviewMode:"spec"`) only
   confirmed blocker/major findings drive fix rounds — confirmed minors are
   returned as `advisoryNotes`. Challenge the design before
   a second fix to the same owner/state model. If a workaround needs a
   paragraph-long comment to justify it, the code is wrong — fix the code.
5. **Localize** (single cheap agent, low effort) — translation busywork, kept off
   the expensive path. The implementer adds new i18n keys only to the base
   `en.json`; this step runs **after** the review loop (so the other 25 locale
   files never consume adversarial review) and **before** verify (so
   `validate-translations` passes at parity). It fans the base keys out to every
   locale on a low-effort model (gpt/opus on `low`, `localizeEffort`), commits one
   `chore(i18n)` unit, and no-ops when no keys changed. Skipped for `server` and
   `docs` surfaces. It still runs on a `startPhase:"verify"` resume (a run that
   paused between the clean review and Localize would otherwise fail
   `validate-translations` forever). Not adversarially reviewed — translations are
   mechanical, the commit lands before the first verify, and the
   `validate-translations` gate enforces parity.
6. **Verify** (single runner) — run the repo-native gates for the surface, and
   for runtime-relevant work build the Release DLL and run `npm run e2e:local`
   (exercise admin and non-admin, assert real DOM/server state, zero
   non-whitelisted console errors, zero unexpected plugin 4xx). Lint is advisory
   per repo policy; every other gate is blocking. On failure, loop back a
   bounded number of times to fix, then re-verify.

## Guardrails carried from the repository

- Only `4eh5xitv6787h645ebv/Jellyfin-Canopy`. `n00bcodr/Jellyfin-Enhanced` and
  `4eh5xitv6787h645ebv/Jellyfin-Enhanced` are strictly read-only.
- One writer per worktree; parallel agents are read-only. Never let two agents
  edit the same files.
- Jellyfin 12 / .NET 10 boundary; modern MUI **and** legacy web layouts both
  stay valid when UI is touched; native markup, local assets, no jank.
- Auth/authorization, per-user isolation, escaping, cancellation, disposal,
  bounded work, and live-config generation ownership fail closed.
- Coverage and lint caps are ratchets — never lowered or widened to go green.
- Rebuild and commit generated bundles, manifests, snapshots, and translations
  from source when the repo expects it.
- Deployment to `:8099`, releases, and external-service mutations are separate,
  explicitly-authorized actions — never an implicit step of this loop.
- Verify the writable push target immediately before any push or merge.

## When to use / when not

**Use** for any real Canopy change where independent, parallel, adversarial
review earns its cost: non-trivial bug fixes, features, refactors touching a
state machine or shared owner, and anything security- or concurrency-sensitive.

**Don't** spin up the loop for a one-line typo, a docs-only wording fix, or pure
questions/audits — the engineering skill's normal single-thread flow is cheaper.
For read-only review or benchmark requests, run only the review lenses against
the supplied diff; skip implement, verify, deploy, and PR.
