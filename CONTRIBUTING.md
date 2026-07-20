# Contributing to Jellyfin Canopy

Thank you for your interest in contributing to Jellyfin Canopy! This document provides guidelines and information to help you get started.

## 🤝 Ways to Contribute

### 1. Code Contributions

You can contribute code through:
- **Open Pull Requests**: Check the [open PRs](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/pulls) for issues that need help
- **Discussions**: Browse [Discussions](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/discussions) for feature requests and ideas that interest you
- **Bug Fixes**: Fix any bugs you encounter and submit a PR

> [!NOTE]
> Feature requests that are considered niche use cases are often moved to Discussions. Feel free to implement any of these if they interest you!

### 2. Translation Contributions

Help make Jellyfin Canopy accessible to more users by contributing translations. Locale JSON files live in `Jellyfin.Plugin.JellyfinCanopy/js/locales/` (one per language, `en.json` is the base). The exact supported list lives only in [`locale-manifest.json`](Jellyfin.Plugin.JellyfinCanopy/locale-manifest.json). To add or update a language, edit the relevant file and open a pull request; `npm run validate-translations` must pass, and all registered locales must stay in sync with `en.json`.

Locale changes reach users in the plugin build that contains them. Merging a
translation pull request does not update an already-installed plugin; both edits
to existing locales and newly registered locales require a subsequent plugin
update on the server.

See [Translate Jellyfin Canopy](docs/help.md#translate-jellyfin-canopy) for the complete contribution guide.

### Issue triage and inactivity

Inactivity is not evidence that an accepted report is fixed. The scheduled stale
workflow therefore treats issues and pull requests differently:

- Issues without an accepted-state exemption receive a reminder after 30
  inactive days. They are never closed by stale automation. This reminder window
  applies to untriaged reports and `awaiting-reporter`/`question` support states.
- `bug`, `bug-inventory`, `security`, `confirmed`, P0/P1, `enhancement`,
  `tracking`, `help wanted`, and `no-stale` are accepted backlog states and do
  not receive stale reminders. Any milestone or assignee also exempts an issue.
- Adding an issue to a GitHub Project must be paired with `no-stale`. Project 4
  already applies that label to every tracked item; issue auto-close is disabled
  as a second, policy-level safeguard.
- A maintainer may close an issue only after leaving a triage reason such as
  resolved, duplicate, invalid, superseded, or reporter-unavailable. Elapsed
  time alone is not a closure reason.
- Pull requests retain a 15-day reminder and a 3-day close window. The workflow
  posts the inactivity reason when it closes a PR; draft PRs remain exempt.

Manual runs default to the workflow's `dry_run` audit mode, which logs proposed
operations without changing issues or pull requests. Set it to false only after
reviewing that audit and intentionally applying the documented policy.

## 🚀 Getting Started

### Project Structure

The plugin is one C# project (server) plus one TypeScript module tree (client),
published as a deterministic, manifest-owned client distribution:

- `Jellyfin.Plugin.JellyfinCanopy/src/` — **the client.** Strict TypeScript ES modules organized into the boot-critical platform, import-pure feature entries under `src/entries/`, and implementation areas (`enhanced/`, `seerr/`, `arr/`, `tags/`, `elsewhere/`, `extras/`, `others/`). `scripts/build-bundle.js` uses esbuild splitting to produce `dist/entries/*.js`, content-addressed `dist/chunks/*.js`, adjacent source maps, and `dist/client-manifest.json`; there is no client monolith or area-barrel boot path.
- `scripts/bundle-budgets.json` — fail-closed limits for the boot graph, feature static and dynamically expanded closures, individual/output counts, source maps, the client manifest, and total published bytes.
- `scripts/scale-budgets.json` — machine-readable performance limits for the [nightly large-library scale tier](#nightly-large-library-scale-tier); same philosophy as `bundle-budgets.json`, currently advisory with `null` (not-yet-measured) placeholders.
- `Jellyfin.Plugin.JellyfinCanopy/Controllers/` — one small feature controller per HTTP surface, nearly all deriving from `JellyfinCanopyControllerBase` (the anonymous asset-serving `AssetsController` derives directly from `ControllerBase`).
- `Jellyfin.Plugin.JellyfinCanopy/Configuration/` — `PluginConfiguration.cs` (admin settings), `SettingDescriptors.cs` (the settings registry — the single source of truth for what reaches clients), the admin config page.
- `Jellyfin.Plugin.JellyfinCanopy.Tests/` — xUnit tests, including golden snapshots that pin the config payload contract.
- `e2e/` — the committed Playwright suite + `e2e/docker/` (dockerized, seeded Jellyfin 12 for CI and local runs).
- `docs/` — the MkDocs site, including **the [Jellyfin 12 platform guide](docs/developers.md#the-jellyfin-12-platform) — read this before touching injection, navigation or websocket code.** It is the evidence-based reference for how the Jellyfin 12 web client actually behaves (stable anchors, re-render survival, router traps, auth policy contract).

The [Developer Guide](docs/developers.md) covers the platform contracts and architecture behind these directories.

## 🛣️ The Paved Road — adding a feature

Every feature is a small set of declarative pieces. Start from the closest
import-pure entry under `src/entries/` and its descriptor in
`src/entries/feature-catalog.ts`:

```bash
node scripts/new-feature.js my-feature            # --area arr|seerr|... , --dry-run
```

The scaffolder creates an import-pure implementation module, its lazy
`src/entries/` activation boundary, a controller, an E2E stub, and a docs stub.
It also wires the logical entry into `ESM_ENTRIES` and adds an identity-scoped,
always-applicable starter descriptor to `feature-catalog.ts`; both architecture
anchors are validated before anything is written. It deliberately leaves the
feature behavior, route predicate/scope, settings and admin control, docs nav,
reviewed budget adjustment, and completed E2E proof for the contributor.

1. **A setting = a descriptor + a `data-config-key` attribute.**
   Add the property to `PluginConfiguration.cs`, register it in `SettingDescriptors.BuildRegistry()` (`Public(...)` / `Private(...)` / `PublicUser(...)` for per-user overrides — exposure lists are whitelists; secrets never get a descriptor), and add a control with `data-config-key="MyFeatureEnabled"` to `Configuration/configPage.html` — the config-page binder loads/saves every `data-config-key` automatically. The golden snapshot tests pin the payload contract, so a renamed or leaked setting fails CI.

2. **An endpoint = a small controller + a policy attribute.**
   A class deriving from `JellyfinCanopyControllerBase` with `[Route("JellyfinCanopy")]`. Auth is declarative: bare `[Authorize]` for any authenticated user, `[Authorize(Policy = Policies.RequiresElevation)]` for admin-only (returns a bare 403 with an empty body — clients branch on status code alone; JSON envelopes are for business errors only).

3. **UI = an import-pure feature entry over `JC.core`.**
   Put implementation code in the appropriate feature area and expose an entry whose module evaluation has no DOM, listener, timer, request, identity-registration, or facade-publication side effects. The entry exports `activate(scope)`; create listeners, observers, timers, and subscriptions only inside that activation, register ownership with `scope.track(...)` or return a disposer, and use `scope.signal` / `scope.isCurrent()` to reject stale async work. The scaffolder supplies the initial `ESM_ENTRIES` and catalog wiring; review its descriptor and deliberately choose identity or navigation scope, enable/applicability predicates, dependencies, and config-restart policy. If creating a feature manually, make those same two wiring changes. Descriptors name manifest keys, never paths or URLs. The build census fails if production source is unreachable from every generated graph.

   Import `JC` from `src/globals`, inject via `JC.core.dom.ensureInjected(key, anchorFn, buildFn)` — durable, idempotent, re-attaches across React re-renders, param-only navigations and the `/video` round trip — and build markup with the ui-kit (`JC.core.ui.muiIconButton` / `muiMenuItem` / `sectionContainer`) so it wears native MUI classes and theme tokens. Type the public surface as an interface and augment `JEGlobal` — the `window.JellyfinCanopy` contract stays compile-checked.

4. **Live updates = `JC.core.live.on(LIVE.*)`.**
   Subscribe to `LIVE.CONFIG_CHANGED` (admin saved config — re-init instead of requiring a reload), `LIVE.LIBRARY_CHANGED`, or `LIVE.USER_DATA_CHANGED` instead of polling. The server side pushes through `ISessionManager` (see `Services/LiveNotifierService.cs`).

5. **Proof = an `e2e/` spec.**
   Extend the stub: log in with the `loginAs` fixture, drive the feature, assert what the user sees, and assert `consoleErrors.real()` is empty. Specs must be idempotent and restore any server state they touch.

### Performance rules

Injected UI must never jank the host client — and must never silently fail to appear on a slow server or connection. The full doctrine — each rule with its reasoning and the pattern to copy — is in the [performance rules](docs/developers.md#performance-rules); the implementation sites are marked `// PERF(Rn):` in the source. Check your PR against all nine:

- [ ] **R1** Injected UI is pre-paint (`ensureInjected(..., { prePaint: true })`) or occupies reserved dimensions (`min-width` chips / `expandIn`). No insert-then-move, no placeholder-then-swap-width.
- [ ] **R2** Decorations on existing content (tags, badges, buttons on cards) are `position:absolute` overlays — they cannot shift layout.
- [ ] **R3** No new body-wide `MutationObserver` — use `JC.core.dom.onBodyMutation` or navigation events; page-scoped observers tear down via lifecycle. Never observe attributes/characterData body-wide.
- [ ] **R4** Layout reads are cached per navigation (the `getHeaderRightContainer` pattern); none inside observer ticks; reads and writes never interleave in loops.
- [ ] **R5** No `setInterval` for DOM detection; data polls are page-scoped + visibility-gated + push-nudged via `JC.core.live`.
- [ ] **R6** No remote assets: every third-party asset goes through `src/core/asset-urls.ts` + the `AssetCacheManifest` mirror. A CDN URL anywhere else fails review (content images and user-clicked links exempt).
- [ ] **R7** Feature DOM is built off-DOM and inserted once, content ready; late async data gets a compositor-only fade, never a layout-affecting swap.
- [ ] **R8** Synchronous per-mutation-batch work stays under ~2 ms (`performance.now()` guard) and overflows to the async path.
- [ ] **R9** Fail open — late beats never: readiness waits persist until the anchor mounts or navigation aborts them (no give-up timers); transient fetch errors are never cached like genuine empty answers (short error TTL, in-place bounded retry); failed async prerequisites reschedule (bounded + backoff + nav-scoped); dedup marks placed before work completes are removed when the work is dropped.

And one server-side rule (guarded by `LibraryScanEventGuardTests`):

- [ ] **S1** Any handler for `ILibraryManager.ItemAdded/ItemUpdated/ItemRemoved` (raised synchronously on the library-scan thread) does only O(1) record-and-defer work — no DB query, no `GetMediaSources`, no I/O; heavy work runs on a debounced off-thread worker that coalesces by id. See [S1](docs/developers.md#performance-rules) and `TagCacheMonitor`/`TagCacheService`.

### Security rules

Two client-side security rules, each backed by a source-scan guard test that fails the build on a new violation:

- [ ] **X1** Every `${...}` interpolated into HTML (templates, `innerHTML`, `toast()`, `insertAdjacentHTML`) is a compile-time constant / trusted producer, a coerced number (`Number(x) || 0`), or wrapped in `escapeHtml(...)` — in attribute **and** text positions; `toast()` renders innerHTML and `JC.t()` does **not** escape params. Guarded by `src/test/escape-guard.test.ts`.
- [ ] **X2** Every config/user-derived value entering a CSS context (`style="..."`, a stylesheet rule, `insertRule`, `color-mix()`, a CSS `var()`) is validated — colours through `cssColorOr(...)`/`isCssColor(...)` (`src/core/css-safe.ts`), because `escapeHtml` does not neutralize a CSS payload. Guarded by `src/test/css-injection-guard.test.ts`.

See [Client Security](docs/developers.md#client-security).

### Guard tests

Beyond the per-feature unit tests, cross-cutting **guard tests** parse the shipped source and fail on a whole *class* of regression. `npm run test:client` owns `escape-guard` and `css-injection-guard` (injection, above), `leak-guard` (object URLs, un-torn-down observers, unbounded caches/retry loops), and `error-as-empty-guard` (a failed fetch must surface an error, never a silent empty state). The [performance rules](docs/developers.md#performance-rules) use the separate `npm run check:performance-rules` gate: one parse and traversal per production TypeScript file in an isolated Node process, with a strict five-second current-thread CPU budget that client coverage instrumentation cannot distort. Server-side, `LibraryScanEventGuardTests` scans every reviewed scan-thread subscriber. The config-bridge tests in `Jellyfin.Plugin.JellyfinCanopy.Tests/Configuration/` apply the same idea to settings wiring: over one shared config-page parser (`ConfigPageSource.cs`), `ConfigControlCoverageTests` fails if an admin-settable descriptor has no config-page control and `ClientConfigKeyLivenessTests` fails if a `JC.pluginConfig.X` client read has no projecting descriptor (an always-`undefined` knob). A PR that reintroduces one of these bug classes fails CI without anyone having to spot it in review.

## 📝 Code Contribution Guidelines

### Code Style

1. **New client code is TypeScript.**

   New client modules are ES modules under `Jellyfin.Plugin.JellyfinCanopy/src/` (strict mode, real imports, unit tests where the logic is pure). The legacy `js/` tree is frozen except for conversions and bug fixes. New C# logic that can be tested without a running Jellyfin server should come with unit tests.

2. **Comments are Essential**

   - Use JSDoc/XML-doc comments for functions and classes
   - Add inline comments to explain complex logic — especially anything that exists because of a Jellyfin 12 platform quirk (link the relevant `docs/developers.md` section)
   - Document parameters, return values, and side effects

3. **Code Understanding**

   - Ensure you understand what your changes do
   - Be prepared to answer questions about your implementation
   - Test your changes thoroughly

4. **AI-Assisted Code (VibeCoded PRs)**

   - AI-assisted contributions are welcome! However:
     - You must understand what the code does
     - Be able to explain your implementation
     - Respond to code review comments
     - Clearly indicate in your PR description that AI tools were used

   Example PR description:
   ```markdown
   ## Description
   Adds feature X to improve Y

   ## Implementation Notes
   This PR was developed with AI assistance (Claude/GPT/etc.). I have reviewed
   and tested all changes and understand the implementation.

   ## Testing
   - [ ] Tested on Jellyfin 12
   - [ ] Verified no basic errors
   ```

### Pull Request Process

1. **Fork and Branch**
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/bug-description
   ```

2. **Make Your Changes**

   - Start from the scaffolder / paved road above
   - Write clean, commented code
   - Follow existing code patterns
   - Test thoroughly

3. **Commit Messages**

   - Use clear, descriptive commit messages
   - Reference issues when applicable

   Example:
   ```
   feat: add bookmark sync across duplicate items

   - Implements automatic bookmark syncing based on TMDB/TVDB IDs
   - Adds UI option to manage sync preferences
   - Fixes #123
   ```

4. **Submit PR**

   - Provide a clear description of changes
   - Include screenshots/videos for UI changes as applicable
   - List any breaking changes
   - Mention if you used AI assistance

5. **Code Review**

   - Be responsive to feedback
   - Be prepared to make requested changes

## 🧪 Testing

### Dependency update policy

`.github/dependabot.yml` is the source of truth for routine dependency
updates. Each manifest has exactly one owner and one weekly schedule:

- NuGet scans the root solution, which owns both the plugin and test projects.
  Do not add a second plugin-directory entry; it would rediscover packages with
  a conflicting schedule.
- npm scans the root `package.json` and `package-lock.json` under the exact
  Node/npm toolchain contract.
- pip scans the root `requirements-docs.in` and generated
  `requirements-docs.txt`; documentation builds use the exact Python patch in
  `.python-version-docs` and install the complete transitive lock with hashes.
- Docker Compose scans `e2e/docker/compose.yml`. The required Jellyfin image
  must remain `jellyfin/jellyfin:unstable@sha256:…`: Dependabot may refresh its
  nightly digest, but it must not replace the `unstable` channel with an RC or
  another tag. The Node integration fixture is maintained in the same manifest.
- GitHub Actions scans `.github/workflows/`; actions remain pinned by immutable
  commit SHA with their release tag in a same-line comment.

Compatible minor and patch updates may be grouped. Major npm, NuGet, action,
runtime, and ABI updates stay explicit. Jellyfin image updates are never grouped
with tooling images. There is no Dependabot auto-merge path: every bot PR must
pass the normal security, build, unit, coverage, client-distribution reproducibility, and six
shard unstable/nightly E2E gates before a maintainer can merge it.

Dependabot alerts and security updates are enabled for this public repository.
Version-update scheduling complements those alerts; it does not replace the
private vulnerability-reporting process in [SECURITY.md](SECURITY.md).

### Blocking gates and advisory signals

The repository-owned lint verifier gives local checks, pre-commit, CI, and
releases the same advisory boundary. Keep lint on its own line; every command
after it is an ordinary blocking check.

```bash
# One-time setup
nvm install                       # reads the exact Node version from .nvmrc
nvm use
npm run check:toolchain           # verifies exact Node + npm before any build
npm ci

# Client
./verify.sh lint                # ESLint findings/cap breaches are advisory;
                                # invocation/configuration failures still block
npm run typecheck:src          # tsc --strict over the TypeScript module tree (src/)
npm run test:client            # vitest unit tests for src/ modules
npm run test:client:coverage   # the same full suite once + the src/core ratchet
npm run check:performance-rules # isolated one-pass R3/R5/R6 scan + 5s CPU budget
npm run build:bundle           # deterministic split dist — fails on unreachable src/ modules
npm run syntax                 # node --check on the frozen legacy js/ tree
npm run typecheck              # opt-in @ts-check over legacy js/ files

# Server (Jellyfin 12 / net10.0; TreatWarningsAsErrors — zero warnings)
dotnet build Jellyfin.Plugin.JellyfinCanopy/JellyfinCanopy.csproj -c Release
dotnet test                    # plain xUnit when coverage evidence is not needed
npm run test:server:coverage   # the full xUnit suite once + Cobertura ratchet

# End-to-end (real browser against a real Jellyfin 12)
npm run e2e                    # JF_BASE_URL=... (default http://localhost:8099)
npm run e2e:headed             # watch it run
```

Coverage thresholds are **ratchets**: they were set just below measured coverage when introduced (`vitest.config.ts` for `src/core`, `scripts/check-dotnet-coverage.js` for the plugin assembly). Raise them as you add tests; never lower them. The coverage commands already execute the complete unit suite, so do not run the corresponding plain command immediately before them.

The ESLint warning cap (`--max-warnings` in the raw `npm run lint` script) is the same idea inverted: it is pinned at the reviewed count of typed-lint `no-unsafe-*` warnings in the converted legacy feature areas (`src/core` and `src/types` treat those rules as errors). Findings and cap breaches stay visible in logs and summaries but are advisory for delivery; the cap remains a review ratchet and must never be raised to make a branch green. When you type legacy shapes and the count drops, lower the cap to match. ESLint configuration, invocation, or internal failures are tooling failures and remain blocking.

### E2E against a disposable server

No dev server handy? The compose stack seeds a throwaway Jellyfin 12 with the freshly built plugin, generated media and the test users:

```bash
dotnet build Jellyfin.Plugin.JellyfinCanopy/JellyfinCanopy.csproj -c Release
bash e2e/docker/seed.sh                        # boots + seeds on loopback port 8100
JF_BASE_URL=http://127.0.0.1:8100 npm run e2e
docker compose -f e2e/docker/compose.yml down -v
```

CI runs the same stack on every PR across six isolated native Playwright shards
(advisory while the infrastructure earns trust). Each CI server is explicitly
capped at two CPUs and verifies Docker applied that quota before seeding.

For a faster whole-suite run on a Linux development machine, use the opt-in
local sharding runner:

```bash
npm run e2e:local                         # 4 isolated servers, 2 CPUs each
npm run e2e:local -- --shards 6           # explicit higher parallelism
```

The runner builds the plugin once, starts one fresh Jellyfin server per native
Playwright file shard, and keeps each server serial internally. The default
2-CPU server quota is the official parity profile; changing it with
`--cpus-per-server` is exploratory evidence. Four servers can use up to eight
server CPU threads in addition to the browser and build processes, so increase
the shard count only when current memory and CPU headroom allow it.

Each server uses a random loopback port and per-run credentials. TMDB/Seerr
environment variables are removed by default; forwarding them with
`--allow-external-integrations` makes the run non-hermetic and can collide with
shared external state. Results are retained under
`e2e/test-results/local-<run-id>/`. Local sharding disables Playwright traces
because they capture authentication arguments, deletes any retained file that
contains a runner password, and redacts random usernames from text diagnostics.
Still treat the directory as sensitive local-only data and do not upload or
share it unredacted. The runner requires Linux, host `ffmpeg`, and GNU
`setsid`/`timeout`; it tears down only its exact generated Compose projects.

The single-server seed is loopback-only too. Exposing it beyond the host is a
security-sensitive exception: it requires both `JF_BIND_ADDRESS=<numeric-ip>`
and `JF_ALLOW_NON_LOOPBACK=true`, plus four nondefault `JF_ADMIN_USER`,
`JF_ADMIN_PASS`, `JF_USER_NAME`, and `JF_USER_PASS` values. Never expose the
documented test credentials to a LAN or public interface.

### Nightly large-library scale tier

This section is the specification for the repository's scale-test tier. The
tier is **advisory today**: the workflow, seed generator, measurement harness,
and budget comparator are follow-up implementation issues cut from this spec
(listed at the end). Nothing here runs per PR, and nothing here currently
blocks a release. The durable heading stays stable while the tier ratchets from
advisory to blocking; its current status is expressed in this content, never by
renaming the section.

Why it exists: the per-PR gates use small seeded libraries on 2-CPU parity
servers, and the only performance artifacts are client-side jank benchmarks
(non-CI) plus the static `check:performance-rules` guard. None of that would
catch a change that makes the tag-cache build quadratic or regresses scan-event
handling at scale. The scale tier measures the plugin against genuinely large
synthetic libraries on a fixed schedule instead.

#### Job shape

A scheduled GitHub Actions workflow (nightly for profile L, weekly or
`workflow_dispatch` for profile XL) runs from `main` only. Its steps, in order:
provision an ephemeral Linode instance, attach the persistent seed Volume,
prepare the instance (Docker, plugin build under test), verify the runtime
quota, measure every metric below, compare measurements against
`scripts/scale-budgets.json`, collect results as workflow artifacts, and
destroy the instance. The workflow has **no `pull_request` trigger** and never
registers a self-hosted runner; orchestration is plain SSH from the
GitHub-hosted control-plane job.

#### Scale profiles (provisional — SR-06 canonicalizes)

- **L — 100,000 episodes.** Runs nightly.
- **XL — approximately 2,000,000 items**, provisionally targeted as roughly
  2,000,000 episodes plus 500 users as the worst-case shape, built as far as
  feasible. Runs weekly and on demand.

Both profiles are provisional definitions owned here only until SR-06
canonicalizes them; if SR-06 changes a profile, this section and the budget
file follow it.

The synthetic library is produced by a bulk-item generator extending the
existing `e2e/docker/seed.sh` machinery (follow-up issue). Stub media files are
zero-byte/sparse — no real video — so profile XL is an inode question, not a
disk-space question, and the seed script must verify `df -i` headroom on the
Volume before seeding.

#### Metrics

Every run measures, per profile, the following ten metrics. Each corresponds
one-to-one with a budget key in `scripts/scale-budgets.json`:

| Budget key | What is measured |
| --- | --- |
| `maxTagCacheFullBuildMilliseconds` | Wall-clock duration of a **cold** full tag-cache build over the seeded library — every entry constructed from scratch, per the tag-cache state protocol below. |
| `maxTagCacheFullBuildPeakResidentDeltaBytes` | Peak server resident-memory (RSS) delta during that cold full build, relative to the pre-build baseline. |
| `maxLibraryScanEventP95Milliseconds` | p95 latency of the synchronous scan-thread event handlers (the [S1 rule](#performance-rules)) during a controlled bulk add. |
| `maxResponseFilterP95MicrosecondsPerItem` | p95 latency overhead added by the plugin's complete synchronous MVC item-response filter chain — all four action filters registered in `PluginServiceRegistrator`, in registration order: `HiddenContentResponseFilter`, `SpoilerIdentityTagFilter`, `SpoilerFieldStripFilter`, `SpoilerBlurImageFilter`; any filter later added to that chain joins this metric automatically — on large item-list responses, normalized per returned item. |
| `maxPluginStartupMilliseconds` | Plugin startup duration on the seeded server with the persisted tag cache **present** (warm start, the production steady state), per the tag-cache state protocol below. |
| `maxTagCacheColdResponseBytes` | Size in bytes of the cold tag-cache response. |
| `maxTagCacheSnapshotSerializationPeakAllocatedBytes` | Peak server allocation during tag-cache snapshot serialization. |
| `maxTagCacheColdTransferP95Milliseconds` | p95 transfer time of the cold tag-cache response. |
| `maxTagCacheColdClientParseP95Milliseconds` | p95 client parse time of the cold tag-cache response. |
| `maxTagCacheColdBrowserHeapDeltaBytes` | Browser heap delta after the client consumes the cold tag-cache response. |

The last five form the tag-cache cold-response envelope required by SR-06's
response-envelope rule (SR-22): response bytes, serialization peak allocation,
transfer time, client parse time, and browser heap — not just build
time/memory.

Measurement protocol requirements for the follow-up harness:

- **Tag-cache state protocol.** Two facts about the shipped code make naive
  measurement of the tag-cache metrics wrong: `TagCacheService.BuildFullCache`
  is a *reconcile* that reuses the existing entry for any item whose source
  revision is unchanged, and `StartupService` runs `BuildFullCache` during
  startup whenever no persisted cache exists. So a build triggered over
  existing cache state measures a warm reconcile that never exercises per-item
  entry construction (a quadratic entry-build regression would pass), while
  simply deleting the cache before startup folds the initial build into the
  startup measurement. The harness must therefore measure the two metric
  groups in **separate server sessions with explicit, asserted cache state**:
  1. **Warm session — startup metric.** Start the server with the baseline's
     persisted tag cache (`tag-cache.json`) present in the instance-local
     writable state. `maxPluginStartupMilliseconds` is recorded from this
     session only; the harness asserts that startup loaded a nonzero entry
     count from disk and that no full build ran during startup.
  2. **Cold session — full-build metrics.** Stop the server, delete the
     persisted tag cache from the instance-local writable state (the Volume
     baseline itself is never modified), and start the server again. Startup
     now performs the initial full build against an empty in-memory cache;
     `maxTagCacheFullBuildMilliseconds` and
     `maxTagCacheFullBuildPeakResidentDeltaBytes` are recorded from the named
     measurement markers bracketing the build itself — never from whole-startup
     timing — and startup duration is never recorded from this session. The
     harness asserts the cold precondition (no persisted cache on disk and
     zero in-memory entries when the build starts).
  Each session's cache state (warm/cold) and the asserted preconditions are
  recorded in the result artifact; a run that cannot prove the cold
  precondition is **no-evidence** for the full-build metrics — a warm
  reconcile number is never reported under a full-build key. The cold-response
  envelope metrics below require a fully built cache and may be measured in
  either session once its load or build has completed.
- Publish **raw samples plus summarized values** (p50/p95/max as applicable)
  for both profiles, not summaries alone.
- Use fixed, named measurement markers in harness output so runs are comparable
  across time and instrumentation changes are explicit.
- Measure `maxResponseFilterP95MicrosecondsPerItem` under an **active** filter
  workload: Hidden Content entries present, and Spoiler Guard enabled with a
  non-empty policy covering unwatched items in the measured page, so each of
  the three item-shaping filters (`HiddenContentResponseFilter`,
  `SpoilerIdentityTagFilter`, `SpoilerFieldStripFilter`) does its real
  per-item work on the item-list response. `SpoilerBlurImageFilter` by design
  never does per-item work on item-list actions — it rejects every
  non-image/non-trickplay action up front and synchronously delegates — so on
  this metric its contribution is exactly that rejection-and-delegate cost,
  which **is** its real production overhead on list responses; recording it is
  correct and is not a violation of the active-workload rule (its image-path
  work is exercised only by image requests, which have no large returned-item
  page and are out of this metric's scope). Timing the disabled/empty-policy
  fast-path no-ops of the three item-shaping filters does not satisfy this
  metric.
- Record stable seed metadata (seed version/digest, profile) and topology
  metadata (instance type, region, CPU quota) with every result.
- The numbers produced here feed the SR-10 scaling documentation's
  "not yet measured" placeholders; publishing them is part of the run's job,
  not an optional extra.

#### Budget file format: `scripts/scale-budgets.json`

The budget file mirrors the philosophy of `scripts/bundle-budgets.json`:
reviewed, machine-readable integer limits committed next to the code they
constrain. Its shape:

- `schemaVersion` — currently `1`. Consumers reject unknown schema versions.
- `enforcement` — `"advisory"` or `"blocking"`. Initially `"advisory"`.
- `limits.L` and `limits.XL` — exactly these two profiles, each containing
  exactly the ten keys in the table above.

Value semantics:

- A limit is either `null` or a non-negative safe integer in the unit encoded
  by its key name (`…Milliseconds`, `…Bytes`, `…MicrosecondsPerItem`).
- `null` means **unmeasured**: the metric is still measured and reported, but
  it has no limit yet. `null` never counts as a pass.
- A measured metric **breaches** its budget when `actual > maximum` (same
  semantics as the bundle budgets).
- Consumers (the follow-up comparator) must reject unknown `schemaVersion`
  values, missing or extra profiles, missing or extra keys, and negative or
  non-integer measured limits — and, while `enforcement` is `"blocking"`, any
  `null` limit is itself a configuration failure (fail closed).

The committed JSON file is canonical; this section documents its fields and
semantics and deliberately does not duplicate its contents.

#### Comparison step and outcomes

The comparator (follow-up issue) reads `scripts/scale-budgets.json` **from the
tested commit**, validates the exact schema above, compares each numeric
`actual` with its `maximum`, and records one outcome per metric:

- **pass** — measured and within budget;
- **breach** — measured and over budget;
- **unmeasured** — the limit is `null` (reported, never treated as green).

A run that fails before producing comparable measurements (provisioning, SSH,
seeding, collection, teardown) is **no-evidence** — an infrastructure failure,
tracked separately from metric regressions and never recorded as a pass or a
breach.

#### Regression policy and the advisory→blocking ratchet

- The repository maintainer reviews every nightly failure (breach or
  no-evidence) by the next working day, and always before approving a release.
- Infrastructure no-evidence failures are triaged as CI health; a confirmed or
  repeated metric breach gets a tracked issue (opened or updated) like any
  other regression.
- Limits are populated through reviewed measurement PRs while `enforcement`
  stays `"advisory"`: after at least **seven comparable successful runs per
  profile** on unchanged instrumentation, topology, and seed version, set each
  limit from the reviewed high-water measurement plus the smallest justified
  noise margin.
- `enforcement` flips to `"blocking"` only when every limit is numeric **and**
  the follow-up workflow and release integration exist.
- Budgets follow the repository's standard ratchet rule: tighten them after
  sustained improvements; never raise one merely to turn a run green.

#### Release-blocking semantics (exact tag SHA)

Advisory results never block a PR or a release. Once `enforcement` is
`"blocking"`, the release workflow's reused quality gates (see
[RELEASING.md](RELEASING.md)) must additionally obtain a provenance-verified
**passing scale result for every profile declared in `limits` (currently L and
XL)**, each with a `testedCommitSha` that **exactly equals the tag SHA** — a
nightly result for some older `main` commit describes that commit, not the tag,
and can neither block nor satisfy a tag release. Each result artifact covers
exactly one profile, so the release gate evaluates the profiles independently
and one profile's pass never stands in for another's: an exact-SHA L pass with
a missing, stale, or breaching XL result blocks the release exactly as an L
breach would. For each required profile there are two ways to obtain its
result:

1. **Dispatch**: the release workflow dispatches a fresh scale run of that
   profile for the tag commit; or
2. **Reuse**: it reuses a canonical GitHub workflow artifact for that profile
   and that exact commit created within the preceding **seven days** (the
   freshness window).

The immutable result artifact must record: tested commit SHA, profile, seed
version and seed-input digest, the SHA-256 of the `scale-budgets.json` used,
workflow run ID and attempt, creation time, topology metadata, raw metrics,
the compared limits, enforcement mode, and outcome. Release-time reuse
verifies the artifact ID and digest, that the producing run was a `main`-only
schedule/`workflow_dispatch` run, that the recorded producing run attempt
**concluded successfully** — an artifact is uploaded at the collect step,
before teardown, so a run classified no-evidence after upload (for example,
its `always()` teardown failed to destroy the instance or detach the Volume)
fails its workflow run per the teardown contract below, and its artifacts,
however green, are never reusable evidence — that the artifact is retained
through the freshness window, that its budget digest equals the tag commit's
`scale-budgets.json` digest, and that its recorded seed-input digest equals
the digest computed from the tag commit's seed inputs for that profile (seed
inputs as canonically defined under Volume lifecycle below — including the
pinned Jellyfin server image, so a database scanned by a different Jellyfin
build can never satisfy this check) — a result measured against the wrong
library shape or the wrong server build is not evidence, no matter how fresh.

Retry policy (applied per profile): an infrastructure no-evidence failure
(provisioning, SSH, collection, teardown) permits at most **two additional
attempts** for that profile. A completed run with a budget breach is
evidence — it is not retryable. In blocking mode, lacking a fresh exact-SHA
passing result for **any** required profile after those retries blocks the
release; as with every other release gate, there is no bypass.

#### Runner topology (decided 2026-07-20): Linode ephemeral instances

The job runs on ephemeral Linode instances provisioned per run — never on
GitHub-hosted runners (too small, too variable) and never as a registered
self-hosted GitHub runner (fork-PR code-execution risk). The scheduled
workflow drives the instance over plain SSH: provision → attach → prepare →
verify → measure → compare → collect → destroy.

- **Profile L (nightly)**: Dedicated 8 GB (`g6-dedicated-4`, 4 vCPU dedicated /
  8 GB / 160 GB) at ~$0.11/hr, ~2–3 h per run.
- **Profile XL (weekly / on demand)**: Dedicated 16 GB (`g6-dedicated-8`,
  8 vCPU / 16 GB / 320 GB) at ~$0.22/hr.
- **Dedicated CPU plans only** — shared-plan noisy-neighbor variance would make
  perf budgets flap.
- **Parity inside the box**: the Jellyfin container runs with `--cpus 2` — the
  repository's official parity profile — and the run verifies Docker applied
  that quota before measuring; spare host cores absorb Docker, harness, and
  metric overhead so measurements stay clean.
- **Estimated cost**: ~$15–20/month (nightly L + weekly XL + Volume + optional
  Object Storage).

Existing account-side infrastructure (given; the follow-up implementation
documents against it rather than re-deciding it): region `eu-central`
(Frankfurt) for compute and Volume; Block Storage Volume `canopy-scale-seed`
(80 GB, id `16926868`); Object Storage bucket `canopy-scale-results` in
`de-fra-2` (S3-compatible endpoint `de-fra-1.linodeobjects.com`); a dedicated
SSH keypair; the provision/attach/teardown lifecycle was proven working on
2026-07-20.

Volume lifecycle:

- The Volume holds the pre-seeded stub library plus the scanned Jellyfin
  database so a run skips the multi-hour initial scan. Volumes attach to one
  Linode at a time (same region), so **runs are serialized** on the Volume.
- The Volume's media/database baseline is **immutable during ordinary
  measurement runs**: writable Jellyfin state is copied to instance-local
  storage; the baseline is identified by a digest of its seed inputs and
  profile; it is refreshed only through an exclusive seed-refresh path, and
  only when a seed input changes.
- **Seed inputs** — the canonical definition wherever this spec says "seed
  inputs" or "seed-input digest" — are every input that materially shapes the
  baseline library or its scanned database: the seed/generator scripts and the
  `e2e/docker` machinery they invoke, the profile definition, and the
  digest-pinned Jellyfin server image reference (`JF_IMAGE` in
  `e2e/docker/seed.sh` and `e2e/docker/compose.yml`) under which the baseline
  database was scanned. Bumping the pinned Jellyfin image digest alone
  invalidates the baseline — the Volume's database was produced by the old
  server build — even when the seed script and profile definition are
  unchanged.
- Every measurement run verifies **seed provenance before measuring**: the
  baseline digest recorded on the Volume must equal the digest computed from
  the **tested commit's** seed inputs for the profile being run. A mismatch —
  stale seed, wrong profile, changed Jellyfin image pin — is a configuration
  failure: the run is **no-evidence** (never a pass or a breach) until the
  exclusive seed-refresh path rebuilds the baseline.

Secrets and teardown:

- The Linode API token and SSH private key live as GitHub Actions secrets
  scoped to the scheduled workflow's environment, reachable only from
  `main`-only scheduled/manual dispatch. Raw run logs must never expose them.
- Teardown runs under `always()` so a failed run cannot leak a paid instance;
  it destroys the exact instance it provisioned and confirms the Volume is
  detached. A collection failure must not suppress cleanup.
- A teardown failure — instance not confirmed destroyed or Volume not
  confirmed detached — **fails the workflow run**, even when every earlier
  step (including collection and artifact upload) succeeded. This makes the
  no-evidence classification machine-visible in the run conclusion: because
  the canonical artifact is uploaded at collect, before destroy, the run
  conclusion is the only signal that distinguishes a fully successful run from
  one whose evidence was voided by a later lifecycle failure, and release-time
  reuse depends on it (see the exact-tag-SHA section above).
- GitHub workflow artifacts are the **canonical** results store. Copies
  mirrored to the Object Storage bucket are optional, analysis-only, and are
  never release evidence.

#### Why this is not a per-PR gate

The scale tier stays out of the per-PR path deliberately, and must not be
"fixed" into one later:

- a run takes multiple hours of wall-clock on paid dedicated hardware;
- the seed Volume is an exclusive, serialized resource;
- PR-triggered execution on infrastructure holding account secrets is exactly
  the fork-PR code-execution risk the topology decision excludes.

Per-PR performance protection remains what it is today: the static
`check:performance-rules` gate and the server-side guard tests
(`LibraryScanEventGuardTests`). Do not add `pull_request` triggers to the scale
workflow and do not register the Linode instances as self-hosted runners for
PR events.

#### Follow-up implementation issues cut from this spec

1. Sparse bulk-item generator extending `e2e/docker/seed.sh` (with the `df -i`
   headroom check).
2. Seed refresh/versioning tooling for the Volume baseline.
3. The `main`-only scheduled workflow: SSH provisioning, quota verification,
   `always()` teardown.
4. Measurement harness and the immutable result-artifact schema.
5. Budget comparator with fail-closed validation and its negative tests
   (unknown schema, missing/extra keys, `null` while blocking, over-budget,
   stale/wrong-SHA artifacts, missing-profile release evidence — e.g. a passing
   L artifact with no exact-SHA XL artifact — and exhausted retries).
6. Exact-tag-SHA release integration in `release.yml` (only when ratcheting to
   blocking; must require a passing result for every budgeted profile, never a
   single profile's artifact).
7. SR-06 canonicalization of the L/XL profile definitions.

### Docs

If you touch `docs/` (any user- or admin-visible change should), install the
hash-locked Python dependencies once and run the same offline, reproducible gate
used by pull requests, releases, and Pages deployment:

```bash
python -m pip install --require-hashes --requirement requirements-docs.txt
npm run check:docs
```

The docs command validates local links and anchors, an explicit offline external
URL inventory across Markdown, MkDocs configuration, and published theme
HTML/CSS, JSON/YAML/shell/HTTP examples, installation permissions, visual asset
ownership, and a strict MkDocs build. Blocking CI never probes the public
Internet. `npm run check:docs:external` is an explicit bounded live audit: before
each request and redirect it requires an inventoried HTTPS URL, resolves every
address as public, and pins those reviewed DNS answers into the request. It uses
bounded manual redirects, retries, timeouts, and a range-limited GET fallback for
HEAD false negatives; origin-only preconnect entries use DNS-only validation so
an intentionally route-less host is not reported dead. It returns a distinct non-zero result for transient
DNS/TLS/timeout/rate-limit/5xx conditions and fails policy blocks or confirmed
repeated 404/410 responses. It is not a substitute for the deterministic offline
gate.

The installation-permission contract rejects broad or recursive install-tree
write guidance and verifies the docs against the middleware defaults, legacy
`index.html` target, atomic-rename requirements, and plugin-owned
`custom_branding` storage in the shipped C# source. Update the implementation
and its least-privilege guidance together.

`check:docs-assets` treats every tracked visual file anywhere under `docs/` as
owned content: it must be referenced by the README, documentation, MkDocs
theme, or this repository's plugin manifest, and both documentation-only and
repository-wide visual-asset byte budgets are blocking ratchets. An
intentionally unreferenced asset needs a named owner, rationale, and expiry in
`scripts/docs-asset-policy.json`. Animated assets additionally need a tracked
non-animated alternative, a description presented beside it, and source-backed
`prefers-reduced-motion` evidence; GIFs are rejected.

The #147 baseline recorded 45 documentation images totalling 78,548,499 bytes
before the two unreferenced panel GIFs were removed. The owned set is now 43
files / 24,472,975 bytes, a reduction of 54,075,524 bytes (68.8%). Across the
whole repository the corresponding visual-asset payload fell from 49 files /
80,910,807 bytes to 47 files / 26,835,283 bytes. Git history was deliberately
left intact: a history rewrite and force-push would require separate approval.
For an otherwise identical current tree, removing the two GIFs reduces the
tracked checkout from 92,929,846 to 38,854,322 bytes (58.2%) and the strict
MkDocs `site/` artifact from 80,283,129 to 26,207,605 bytes (67.4%). Existing
clones retain the historical objects even though new checkouts and the
generated documentation site no longer carry those files in the current tree.

### Manual checklist

Before submitting a PR, ensure you've tested:

- [ ] Feature works as expected
- [ ] No console errors
- [ ] Compatible with Jellyfin 12.x — **both** the modern (MUI) layout and the legacy layout (`localStorage.layout`)
- [ ] Works on different browsers (Chrome, Firefox, Edge)
- [ ] Doesn't break existing functionality
- [ ] Mobile compatibility (if applicable)
- [ ] Injected UI survives navigation and the `/video` round trip (see the [React re-render survival guide](docs/developers.md#react-re-render-survival))

## 📋 Feature Request Guidelines

When proposing new features:

1. **Check Discussions First**: Your idea might already be there!
2. **Provide Context**: Explain the use case and benefit
3. **Be Specific**: Clear descriptions help implementation
4. **Consider Scope**: Is this a core feature or niche use case?

## 🐛 Bug Reports

When reporting bugs:

1. **Check Existing Issues**: Avoid duplicates
2. **Check FAQs**
3. **Provide Details** as per the Bug report template

## 💬 Getting Help

If you have questions or need help:

- **Discord**: Reach out on the [Jellyfin Community Discord](https://discord.gg/EYNFf7y4CG)
- **Discussions**: Start a discussion on GitHub
- **Issues**: For bug-related questions

## 🎨 UI/UX Contributions

For UI changes:

- Use the ui-kit (`JC.core.ui`) so injected UI matches native markup and follows the active theme
- Test with different Jellyfin themes and both layouts
- Provide before/after screenshots

---

**Thank you for contributing to Jellyfin Canopy! Your efforts help make Jellyfin better for everyone.** 💜
