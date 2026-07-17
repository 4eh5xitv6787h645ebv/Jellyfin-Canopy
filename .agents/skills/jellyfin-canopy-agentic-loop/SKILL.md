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
   push the branch, open the PR, watch CI, and report. Never deploy to `:8099`
   or mutate an external service as an implicit step; those need separate
   explicit authorization.

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
    surface:  "client" | "server" | "cross" | "docs",   // drives which gates run
    runtime:  true,                                       // true → also run e2e:local
    depth:    "standard",                                 // "quick" | "standard" | "deep"

    // Model routing (see "Model routing" below):
    modelSplit:  true,           // ~50/50 Claude/Sol on read-only steps to spare Opus budget
    solVia:      "agent",        // "agent" (subagent model param, needs router) | "codex-cli"
    solModel:    "gpt-5.6-sol",
    solEffort:   "high",
    solReviewers: 1,             // Sol whole-diff reviewers when modelSplit is off
    implementModel:    "fable",  // implementer runs on Fable (high) …
    implementFallback: "opus"    // … falling back to Opus (high) if Fable is exhausted
  }
})
```

### Model routing

To keep a run from burning all of Claude's budget, the loop deliberately spreads
models by role:

- **Implementation** — the single writer runs on **Fable (high)**, falling back
  to **Opus (high)** if Fable is exhausted/unavailable. Never split mid-change.
- **Everything read-only except implementation** — with `modelSplit: true`,
  explore, plan, the review lenses, finding-verification, and the gate runner
  alternate **~50/50 Claude / `gpt-5.6-sol` (high)**. A Sol slot that can't be
  routed falls back to Claude, so no slot is lost.
- **Fixers** (review fixer, verify fixer) — stay on Claude/Opus. They write code,
  so they follow the one-writer, single-model rule.

Sol slots run on Sol only when `solVia: "agent"` (the model param) is backed by a
Sol-capable route — e.g. the CLIProxyAPI router that exposes `gpt-5.6-sol` to
Claude Code. With `solVia: "codex-cli"`, only the review round uses Sol (via the
`codex` CLI harness); the other split steps run on Claude. Set `modelSplit: false`
to run everything on Claude (implementer still uses Fable→Opus).

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
   every locale key with real translations, and update affected docs. Commit
   coherent conventional units. No `Co-Authored-By` trailers; keep issue `#N`
   out of messages.
4. **Review loop** (parallel adversarial, loop-until-clean) — see
   [`references/adversarial-review.md`](references/adversarial-review.md). Each
   round mixes models on purpose: the Claude lens reviewers **and** at least one
   `gpt-5.6-sol` (high effort) whole-diff reviewer, all in split context (diff +
   brief only, told to assume the code is wrong). Findings are deduped and
   adversarially verified to kill false positives; a single fixer applies
   confirmed findings; re-review until a clean round. Challenge the design before
   a second fix to the same owner/state model. If a workaround needs a
   paragraph-long comment to justify it, the code is wrong — fix the code.
5. **Verify** (single runner) — run the repo-native gates for the surface, and
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
