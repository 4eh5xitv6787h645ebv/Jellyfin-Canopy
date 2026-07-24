---
name: jellyfin-canopy-engineering
description: Implement, fix, review, validate, publish, and merge Jellyfin Canopy repository changes with evidence-driven issue revalidation, isolated worktrees, risk-based tests, coverage ratchets, independent review, GitHub Actions diagnosis, and verified issue or project closure. Use for any bug, feature, code, test, documentation, CI, issue, pull request, review, release, or Jellyfin 12 E2E task in 4eh5xitv6787h645ebv/Jellyfin-Canopy.
---

# Jellyfin Canopy Engineering

Use this workflow from the first read through post-merge verification. Preserve
the user's requested outcome; do not narrow a difficult task into an easier
compatible-looking change.

## 1. Establish authority and safety

1. Read `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, and instructions nearest
   the files in scope.
2. Resolve the exact repository, issue, Project item, default branch, remotes,
   dirty worktrees, and current CI state before editing.
3. Treat `n00bcodr/Jellyfin-Enhanced` as strictly read-only. Limit repository
   writes to `4eh5xitv6787h645ebv/Jellyfin-Canopy`. Treat project-board metadata
   as a separate external write requiring explicit or standing user
   authorization.
4. Separate authorization to edit code from authorization to merge, deploy,
   release, comment, close items, or mutate external services. Ask only when
   authority is genuinely missing; otherwise make safe, scoped progress.
5. Never expose credentials, private URLs, media data, retained E2E artifacts,
   or unredacted logs.

Treat these repository files as the current sources of truth instead of copying
their changing details into an issue or prompt:

- `CONTRIBUTING.md` for architecture and local validation;
- `SECURITY.md` for private vulnerability reporting;
- `.github/workflows/build.yml`, `.github/workflows/security-scan.yml`, and
  `.github/workflows/translation_validation.yml` for CI behavior;
- `scripts/coverage-baselines.json` for reviewed coverage evidence;
- `e2e/docker/compose.yml` and `scripts/e2e/run-local-shards.sh` for the
  unstable/nightly runtime and local parallelism contracts.

Before every push or merge, run:

```bash
git remote get-url --push <remote-used-by-the-next-operation>
```

Resolve the actual remote used by the upcoming operation; do not check an
unrelated `origin`. Normalize HTTPS or SSH syntax to its owner/repository pair
and continue only when it is exactly
`4eh5xitv6787h645ebv/Jellyfin-Canopy`. Never change a read-only remote to bypass
this check.

## 2. Revalidate and plan

1. Fetch the current default branch without discarding local work.
2. Read the complete issue, feature request, review request, or other task
   context, plus linked items, acceptance criteria, prior attempts, current
   source, tests, and recent history at the owning layer.
3. For a bug, reproduce the trigger or prove the violated contract. For a
   feature, establish the use case, requested contract, and existing extension
   points. Search for duplicates, all producers/consumers, generated copies,
   and existing mitigations or overlapping behavior.
4. Classify every requirement and name the authoritative evidence that will
   prove it. Treat missing or indirect evidence as incomplete.
5. Record a concise plan with one active step. Use parallel agents only for
   concrete independent work such as source archaeology, isolated test runs,
   or review; never let multiple agents edit the same files.
6. Track a confirmed finding or requested feature in a Canopy issue when the
   task or standing instructions require it. Never infer project membership.
   When adding an issue to any GitHub Project is applicable and authorized,
   apply the required `no-stale` label. Add it specifically to Project 4 only
   when the current work belongs there. Otherwise report any required external
   write and request authority. Do not publish exploit-grade vulnerability
   details; follow `SECURITY.md` and use a private channel.

Do not implement speculative findings. Document decisive refutation evidence
instead. Do not silently expand one issue into unrelated cleanup.

## 3. Isolate the change

Inspect every candidate checkout with `git status --short`. Preserve dirty or
untracked user work. Create a dedicated branch and worktree from current
`origin/main`, for example:

```bash
git fetch origin main
git worktree add -b agent/<short-description>-<issue> \
  ../jellyfin-canopy-issue<issue> origin/main
```

Keep one coherent root cause or feature outcome per branch. Before publishing,
rebase onto the latest `origin/main`, resolve semantically, and repeat affected
checks.

## 4. Design the complete fix or feature

Implement behavior at its owning layer and update every affected consumer.
Preserve these repository contracts:

- Jellyfin 12 and .NET 10 are the supported server/runtime boundary.
- Modern MUI and legacy web layouts must both remain valid when UI is touched.
- Every visible UI change must satisfy the repository's
  [responsive UI contract](../../../CONTRIBUTING.md#responsive-ui-contract):
  prove containment and reachability in every affected layout and across the
  relevant phone, landscape, tablet, desktop, breakpoint-neighbor,
  long-content, and resize boundaries. A single screenshot or one emulated
  phone is not acceptance evidence.
- Authentication, authorization, per-user isolation, escaping, cancellation,
  disposal, bounded memory/work, and live-configuration generation ownership
  must fail closed.
- The official E2E image remains digest-pinned
  `jellyfin/jellyfin:unstable`; never replace it with an RC tag.
- Generated bundles, manifests, snapshots, and translations must be rebuilt
  from their source and committed when the repository expects them.
- Coverage and lint caps are ratchets. Never lower or widen them merely to make
  a branch green. Any instrumentation tolerance needs repeated identical-scope
  measurements, a minimal bound, a written rationale, and a negative boundary
  test.

For a bug, add a regression that exercises the old trigger. For a new feature,
add acceptance evidence for its externally meaningful contract and negative
boundaries. Prefer deterministic seams over sleeps, broad mocks, or tests that
merely restate implementation details.

## 5. Validate in layers

Run the narrowest useful test while iterating, then the full affected surface.
Use the exact Node/npm toolchain declared by the repository and install with
`npm ci`. Avoid running a plain full suite immediately before its coverage
command because the coverage command already runs that suite.

Core gates:

```bash
npm run check:toolchain
./verify.sh lint
npm run typecheck:src
npm run test:client:coverage
npm run build:bundle
npm run syntax
npm run typecheck
npm run test:scripts
dotnet build Jellyfin.Plugin.JellyfinCanopy/JellyfinCanopy.csproj -c Release
npm run test:server:coverage
git diff --check
```

Select proportionately:

- Client behavior: focused Vitest while iterating, then `typecheck:src`, legacy
  `typecheck`, full client coverage, bundle, syntax, and relevant
  layout/navigation E2E.
- Visible client UI: follow the
  [responsive UI contract](../../../CONTRIBUTING.md#responsive-ui-contract),
  add direct geometry/reachability assertions for every affected surface,
  register production acceptance cases in `e2e/required-test-inventory.json`,
  and capture representative evidence for every affected layout and form
  factor when layout behavior changes. For shared layout primitives or
  width-generic responsive fixes, run the permanent 50-device popularity proxy
  after deduplicating it to its distinct CSS viewports.
- Server behavior: focused xUnit while iterating, then release build and full
  server coverage.
- Cross-surface or generated resources: run both client and server owners plus
  reproducibility/manifest checks.
- Translations: `npm run validate-translations` over the full locale inventory;
  CI separately validates the changed-file boundary.
- Documentation: validate links/commands and run `mkdocs build --strict` when
  `docs/` changes.
- Workflow, dependency, or release changes: run script tests and every
  repository-owned verifier for the affected contract; keep Actions pinned by
  immutable SHA.
- Security-sensitive work: add negative authorization/escaping/input tests and
  run the repository security gates without printing secrets.

For real-browser evidence, use the disposable Jellyfin 12 stack. Official CI
uses six isolated shards with two CPUs per server. A local whole-suite run may
use:

```bash
npm run e2e:local
npm run e2e:local -- --shards 6
```

Keep two CPUs per server for parity evidence. Higher `--cpus-per-server` values
are exploratory only. Check available memory/CPU first, do not forward external
integration credentials unless explicitly required, and treat retained results
as sensitive local-only artifacts. Always tear down only the exact Compose
projects the run created.

Report exact counts, versions, scope, and commit. Do not summarize a focused
test as proof that the full gate passed.

## 6. Obtain independent review

After the branch is clean and locally validated, request at least one genuinely
independent review. Give the reviewer the task context and acceptance criteria,
exact diff or commit, and raw validation evidence; do not prime them with the
desired answer. Ask them to inspect correctness, security/privacy, lifecycle
and concurrency, bounds/performance, compatibility, test strength, and
operational failure modes.

Require either `APPROVE` or concrete findings with file/line evidence. Resolve
every material finding, add regression evidence when appropriate, repeat
affected gates, and request a fresh final verdict. If a preferred reviewer or
model is unavailable, use another independent agent or rigorous human review
and disclose the substitution; never fabricate a review.

Review agents do not push, merge, deploy, or mutate GitHub unless the user has
separately authorized that exact action.

## 7. Publish a reviewable PR

1. Inspect `git status`, the complete diff, and commits; stage only in-scope
   files.
2. Re-run `git diff --check` and the final risk-appropriate gates.
3. Verify the push URL immediately before pushing.
4. Push the dedicated branch and open a PR that links its issue when one exists.
5. State the root cause/outcome, user impact, complete change, risks, and exact
   validation. Do not claim checks that were not run.

Use a draft while known work remains. Mark ready only when implementation,
local evidence, and independent review are complete.

## 8. Diagnose CI from evidence

Watch every blocking GitHub check. For a failure, read the exact job log and
identify the failing assertion/command before changing code or rerunning.

- Fix real branch regressions at their owner and add evidence.
- Do not weaken coverage, timeouts, assertions, security policy, or E2E scope
  to absorb an unexplained failure.
- Rerun only failed jobs when evidence proves a bounded external or known
  nondeterministic failure. If it recurs or reveals a new root cause, create a
  Canopy issue when authorized. Add it to a Project only when membership and
  board maintenance are authorized, and always apply `no-stale` before doing
  so; use Project 4 only when the current task belongs there. Report
  unauthorized pending writes, then fix or explicitly disposition the finding
  within scope.
- Treat the aggregate E2E job as a summary; inspect the failed shard first.

While auto-merge waits, run a bounded post-publication watch: enabled auto-merge
does **not** update the branch when `main` advances, so alongside the checks
also inspect the PR's mergeability/behind state (e.g.
`gh pr view --json mergeable,mergeStateStatus`). When `main` has moved and the
ruleset requires an up-to-date branch:

1. update the branch from current `origin/main` and resolve semantically;
2. rerun the affected gates;
3. reconfirm the independent review still applies to the result (request a fresh
   verdict if the resolution changed reviewed code);
4. verify the push URL and push;
5. continue monitoring the NEW head commit's required checks — do not assume the
   previous green run carries over.

Keep the watch bounded: recheck on check completion or a `main` advance, not in
a tight poll, and stop once merged.

Merge only when the latest commit has all required blocking checks green and
the independent review is still applicable. Inspect the current branch ruleset;
at minimum expect Plugin, Unit tests, Client checks, the E2E aggregate, Manifest
validation, Secret Scanning, and .NET Security Audit, plus any newly required
checks. Verify every underlying E2E shard even when only the aggregate is a
required check.

## 9. Merge and prove closure

Immediately before merging, verify the writable push destination again. If the
merge is deferred to auto-merge, keep the section-8 behind-state watch running
until the merge actually lands — a PR left "behind" waits forever. After merge,
independently verify:

1. the PR state and exact merge commit;
2. the merge commit is reachable from current `origin/main`;
3. any applicable issue is closed only when its acceptance evidence is
   complete;
4. any applicable project item has its required final status (`Done` for
   Project 4) and links the PR;
5. no required review thread or blocking check remains unresolved.

Merge alone is not completion. Update progress from authoritative GitHub and
git state, not memory or intent. If issue or Project state needs a write that is
not already authorized, report it and request authority instead of mutating it.

## 10. Keep deployment separate

Do not install to port 8099, publish a release, or change a live service as an
implicit post-merge step. Require explicit user authorization for the exact
target and version. When authorized, deploy the exact merged artifact, preserve
a rollback copy, verify image/channel, health, artifact checksum, and startup
logs, and report the evidence. Otherwise leave the runtime untouched.

When the user asks to pause, finish work already in flight without starting new
items, checkpoint the remaining roadmap without marking the broader program
complete, and state clearly that work is paused rather than complete.
