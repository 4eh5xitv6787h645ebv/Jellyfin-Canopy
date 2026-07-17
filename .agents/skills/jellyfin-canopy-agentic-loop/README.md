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
       surface:  "client" | "server" | "cross" | "docs",
       runtime:  true,
       depth:    "quick" | "standard" | "deep",
       solVia:   "agent",          // or "codex-cli"
       solEffort: "high",
       solReviewers: 1
     }
   })
   ```

3. Monitor with `/workflows`. Read the returned result (`readyForPR`,
   `residualRisks`, gate/e2e evidence). If `readyForPR`, the main thread verifies
   the push target, pushes, and opens the PR. Deployment to `:8099` and releases
   remain separate, explicitly-authorized actions.

### Depth

| depth | explorers | planners | review round cap | verify-fix cap |
| --- | --- | --- | --- | --- |
| quick | 2 | 2 | 2 | 1 |
| standard | 4 | 3 | 3 | 2 |
| deep | 6 | 3 | 4 | 3 |

`surface` selects which repo-native gates run; `runtime:true` additionally
builds the Release DLL and runs `npm run e2e:local` (dockerized
`jellyfin/jellyfin:unstable`).

### Model routing

The loop spreads models by role to spare Claude/Opus budget:

- **Implementation** — the single writer runs on **Fable (high)**, falling back
  to **Opus (high)** if Fable is exhausted (`implementModel` / `implementFallback`).
- **Read-only steps except implementation** — with `modelSplit: true` (default),
  explore, plan, the review lenses, finding-verification, and the gate runner
  alternate **~50/50 Claude / `gpt-5.6-sol` (high)**; an unroutable Sol slot
  falls back to Claude.
- **Fixers** — stay on Claude/Opus (they write code).

Every review round still runs **both** Claude and **≥1 `gpt-5.6-sol` (high)**
reviewer. The Sol side is obtained one of two ways, chosen with `solVia`:

- `"agent"` (default) — requests `gpt-5.6-sol` directly on the subagent. Needs a
  Sol-capable route for Claude Code, e.g. the CLIProxyAPI router that exposes
  `gpt-5.6-sol`
  ([how-to](https://vallettasoftware.com/blog/post/run-gpt-5-6-in-claude-code)).
  No `codex` dependency.
- `"codex-cli"` — a harness subagent shells out to the local `codex` CLI
  (`-a never -s read-only exec -m gpt-5.6-sol`) with
  `references/codex-review-schema.json`. Use where the router isn't configured.

The Sol pass is best-effort: if the route/CLI is unavailable it degrades to the
Claude reviewers rather than failing the loop, so treat a missing Sol pass as a
signal to fix the route, not as a clean review.

## Non–Claude-Code runtimes

The Workflow tool is Claude Code specific. Any capable agent runtime can follow
the same method by hand: spawn read-only explorer/planner/reviewer sub-agents in
parallel, keep exactly one writer, and run the loop and gates from
`references/adversarial-review.md` and the engineering skill.
