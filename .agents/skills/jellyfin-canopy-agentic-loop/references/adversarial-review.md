# Adversarial review loop

The confidence mechanism of this skill. It is deliberately hostile: reviewers
are not asked "is this good?" — they are told the change is wrong and asked to
prove how. Modelled on Bun's rewrite, tuned to Canopy's contracts.

## Rules of the loop

1. **Split context.** A reviewer sees the **diff and the task brief only** —
   never the implementer's chain of thought. It never edits files. The
   implementer never reviews its own change. Roles do not mix.
2. **Default to "wrong".** Each reviewer's only job is to find bugs and concrete
   reasons the change does not work or violates a contract. "Looks fine" is not
   a finding; a finding needs a file/line and a failure scenario (inputs/state →
   wrong output/crash/leak).
3. **Two or more reviewers per round, across distinct lenses** (below), and
   **across two model families** in every *mixed* round: the Claude lens
   reviewers plus at least one `gpt-5.6-sol` reviewer at **high** effort doing a
   whole-diff pass. Diversity beats redundancy — different angles *and* different
   models catch failure modes a single model's blind spots would miss. (In
   `canopy-loop.js`: `solReviewers` ≥ 1, obtained via the subagent model param or
   the `codex` CLI per `solVia`.) *Escalation* rounds past the mixed cap
   (`roundCap`) run `gpt-5.6-sol` only until the loop terminates (clean / stall /
   backstop, see rule 5) — a distinct mode, not a mixed round. The round that
   **certifies** the branch clean must have
   **real** cross-family coverage: if its every Sol slot fell back to Claude (dead
   route), the run fails closed (`reviewIncomplete`) rather than certifying an
   all-Claude review as mixed.
4. **Verify before fixing.** Every finding is adversarially checked by an
   independent verifier that tries to *refute* it. Default to refuted when
   uncertain. Only confirmed findings reach the fixer — this kills
   plausible-but-wrong findings before they cost a change.
5. **One fixer, then re-review.** A single writer applies the confirmed findings
   at their owner, adds regression evidence, and the round repeats. The loop
   terminates on one of three signals — **never** on "we're probably fine", and
   **never** on an arbitrary round count:
   - **a clean round** (no confirmed blocker/major findings);
   - **a progress stall** — `stallPatience` consecutive rounds with no progress
     (default 2), or a round whose confirmed findings are wholly a re-report of
     ledger-disposed items (pure oscillation). A stall means the review is **not
     converging**: stop, do not certify, and surface a "did not converge" residual
     for a human (consider splitting the change). "Progress" = the
     confirmed-finding count strictly fell vs the previous round, or ≥1 confirmed
     finding was newly applied this round;
   - **a runaway backstop** — an absolute ceiling (`backstopRounds`, default ~25;
     docs/spec default mixed-cap+1) so a pathologically entangled change cannot
     loop forever even while nominally making progress one finding at a time.

   This replaces the old fixed 10-round cap: a genuinely-converging change is
   never cut off by a count (the cap's job was non-convergence detection, not
   budget control — that is now the terminal-failure pause), and a hopeless
   oscillation stops fast (the #167 config-page.js case). `hardRoundCap` remains
   an explicit override that pins the backstop to a fixed count **and** disables
   the stall detector, for callers who want the old behavior.

   The fixer reports back which findings it
   **applied** and which it left **unresolved** (by id); only applied findings are
   ledgered as fixed, and a fixer that returns nothing, reports any unresolved id,
   or does not cover every confirmed id blocks certification — a later empty round
   cannot certify a defect the fixer said is still there.
   **Carry a finding ledger between rounds**: what earlier rounds fixed and what
   the verifier refuted (with reasons) goes into every later reviewer's context,
   and a resolved item may not be re-reported without NEW evidence. For docs/spec
   surfaces, gate fixing by severity — confirmed blocker/major findings drive fix
   rounds; confirmed minors are returned as advisory notes and a minors-only
   round counts as clean.
6. **Fix the process, not the instance.** If a class of finding recurs (the same
   lens keeps catching the same kind of mistake), amend the implementer/fixer
   instructions for the next round instead of hand-patching each occurrence.
7. **Challenge the design before a second fix to the same owner.** If a fix would
   add another state flag, retry, lock, publisher, or lifecycle path — or a
   second fix touches the same state machine/ownership boundary — restate the
   required invariant and try deletion, reuse, or single ownership first. Ask the
   user if simplification would change accepted behavior.
8. **No paragraph-long justifications.** If a workaround needs a long explanatory
   comment to argue it is OK, the code is wrong — fix the code. Reviewers reject
   such comments.

## Review lenses

Assign each reviewer one lens. Skip lenses the diff cannot touch; add
task-specific reviewer questions from the brief. For Canopy, the standing lenses
are:

- **Requirement fidelity** — does it fix the ACTUAL reported defect and satisfy
  EVERY acceptance criterion in the brief — not an easier semantically-different
  change primed by the branch name or surrounding code? A change that does not
  address the reported defect is a blocking finding regardless of its quality.
- **Correctness & logic** — does it do what the brief says on the happy path and
  every branch? Off-by-one, wrong operator, eager vs. lazy evaluation, error
  paths, `null`/undefined, boundary values.
- **Security & privacy (fail closed)** — authn/authz, per-user isolation, input
  validation, output escaping, no credential/media/PII leakage, no
  exploit-grade detail in logs. Bare 401/403 preserved. Follow `SECURITY.md`.
- **Lifecycle & concurrency** — ownership of every new cache/flag/timer/retry/
  observer/lock/background job/writer; cancellation and disposal; races on
  shared state; live-config generation ownership. Each side effect has exactly
  one owner.
- **Bounds & performance** — bounded memory and work; no unbounded growth,
  polling, or hidden N×; no jank (flicker/reflow/layout shift) on any layout;
  respects the repo's performance rules.
- **Compatibility & platform** — Jellyfin 12 / .NET 10 boundary; modern MUI
  **and** legacy web layouts both remain valid; native Jellyfin markup and local
  assets; server/runtime API used as it actually exists (verify against the
  sanctioned reference trees, not memory).
- **Test strength** — tests fail before the fix and pass after; cover admin and
  non-admin, negative/fallback paths, and prove the intended lower tier ran
  (non-vacuous assertions). Deterministic seams over sleeps/broad mocks. No
  coverage-cap lowering.
- **Product semantics & scope** — no behavior added merely because it might be
  useful; no scope creep beyond the brief; shared parity gaps fixed once at the
  owner, not by making the new consumer uniquely sophisticated.
- **Docs, locale & generated artifacts** — every affected user/admin/architecture/
  security doc updated; new i18n keys present in the base `en.json` and referenced
  in code; bundles/manifests/snapshots rebuilt from source and committed. Do NOT
  deep-review the other 25 locale translations — those are fanned out afterward by
  the cheap Localize phase and enforced by the `validate-translations` gate, so
  reviewing them here is wasted effort.

## Watch for semantically-different-but-syntactically-similar code

Bun's regressions clustered here; Canopy's mixed C#/TS/JS surface has the same
trap. Flag when a mechanical-looking change hides a semantic shift:

- an assertion/guard whose argument has a **side effect** that a debug-only or
  stripped build would skip;
- eager evaluation of a default (`x ?? expensiveOrThrowing()`) that runs even
  when the value is present — prefer a lazy form;
- truncation/rounding differences on odd-length buffers or negative values;
- bounds checks present in one build/config and absent in another;
- string/byte handling that silently assumes valid UTF-8/UTF-16 where the source
  is arbitrary bytes (paths, media, network);
- format/escape passes that run over data they shouldn't (color/markup markers
  rewritten into user content).

## Definition of done for the loop

A change is loop-clean when: a full review round yields no confirmed findings;
every repo-native gate for the surface passes (lint advisory, all else
blocking); runtime-relevant work has green `e2e:local` evidence for admin and
non-admin with zero non-whitelisted console errors and zero unexpected plugin
4xx; and residual risks are named, not hidden. Anything less is reported as
in-progress, never as done.
