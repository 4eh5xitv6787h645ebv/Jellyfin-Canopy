---
title: Performance Trace Capture
---

# Performance Trace Capture

`e2e/perf/capture-traces.js` is a hand-run developer tool that drives a **real
Chromium** (Playwright) through realistic navigation scenarios and captures a
full **Chrome DevTools performance trace** per scenario — a `.json.gz` you drop
straight into the DevTools **Performance** panel ("Load profile") to see the
timeline, flame chart, network waterfall and screenshots for a real user flow.

It is **not** wired into CI. Like [`jank-benchmark.js`](performance-rules.md#measured-impact)
it is a measurement tool you run by hand against a live server. Where the jank
benchmark reduces a run to aggregate jank numbers, this harness keeps the whole
trace so you can inspect exactly *when* each `/JellyfinEnhanced/*` request fired
and how injections raced late server responses.

The highest-value scenario is **`details-to-details`**: hopping from one item
detail straight into another reproduces a real bug class — header/detail
injections that race a late server response. That class only shows up when
responses land late, which is why the [slow-server flags](#slow-server-emulation)
exist.

## Prerequisites

- A live Jellyfin 12 server with the plugin installed. The disposable seeded
  server from `e2e/docker/` is ideal:

    ```bash
    dotnet build Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj -c Release
    bash e2e/docker/seed.sh            # → http://localhost:8100 (admin je_arradmin)
    # …run captures…
    docker compose -f e2e/docker/compose.yml down -v
    ```

- A resolvable `playwright`. The harness follows the e2e suite's `NODE_PATH`
  convention — point `NODE_PATH` at an install that has `playwright` (with its
  Chromium downloaded):

    ```bash
    export NODE_PATH=/path/with/node_modules
    ```

## Running

```bash
# All scenarios, defaults (JF_BASE_URL or http://localhost:8100):
npm run perf:trace

# A subset (positional scenario names):
npm run perf:trace -- details-to-details back-forward

# List scenarios:
npm run perf:trace -- --list

# A slow-server run (see below):
npm run perf:trace -- details-to-details --latency 300 --cpu 4
```

Each output is written to `e2e/perf/traces/<scenario>-<timestamp>-<seq>.json.gz`
(git-ignored), where `<seq>` is the per-run invocation index. That suffix means
repeating a scenario name (`npm run perf:trace -- details-to-details
details-to-details`) writes **two distinct** files instead of the second
overwriting the first. The trace is written **before** analysis, so an analysis
error never costs you the capture.

Value-taking flags (`--out`, `--latency`, `--cpu`, `--download`, `--base`,
`--user`, `--pass`, `--scenarios`) fail fast with a one-line error and a non-zero
exit when their value is missing (end of args, or the next token is another
flag) — rather than crashing or silently falling through to a default run.

### Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--base <url>` | `JF_BASE_URL` or `http://localhost:8100` | server under test |
| `--user` / `--pass` | see [Environment](#environment) | login credentials |
| `--out <dir>` | `e2e/perf/traces` | output directory |
| `--cpu <N>` | `1` | CPU throttle rate (`Emulation.setCPUThrottlingRate`) |
| `--latency <ms>` | `0` | added network latency (`Network.emulateNetworkConditions`) |
| `--download <kbps>` | `0` (unlimited) | download throughput cap |
| `--headed` | headless | show the browser |
| `--list` | — | print the scenario list and exit |

Positional arguments are scenario names; with none, every scenario runs in
order.

### Environment

Matches `e2e/fixtures/auth.ts` and `e2e/docker/seed.sh`:

| Var | Default | Meaning |
|-----|---------|---------|
| `JF_BASE_URL` | `http://localhost:8100` | server under test |
| `JE_TRACE_USER` → `JF_ADMIN_USER` → `je_arradmin` | | login user (first set wins) |
| `JE_TRACE_PASS` → `JF_ADMIN_PASS` → `Test669Pw!x` | | login password |

## Scenarios

Each scenario logs in through the web client's own `ApiClient` (with the same
session-clobber retry the e2e suite uses), waits for
`window.JellyfinEnhanced.initialized === true`, then drives a real flow. Real
card/button clicks are used where feasible, falling back to router navigation
only when a click target genuinely can't be resolved (e.g. a bare seed with no
TMDB has empty "More Like This" rows). Missing content **skips** the scenario
with a logged reason instead of failing the run.

| Scenario | Flow |
|----------|------|
| `cold-load` | fresh page load straight onto home (the boot is inside the trace) |
| `home-to-details` | home → click a library card → item details |
| `details-to-details` | details → click a More-Like-This card → details, **twice** (the high-value bug repro) |
| `back-forward` | build a details→details history, then browser Back (POP) twice, Forward once |
| `library-browse` | home → library → scroll → open an item → back |
| `search-flow` | open search, type a query, open a result |
| `series-drilldown` | series details → season/episode → back up |
| `revisit` | visit details A, navigate home, revisit A (warm-cache re-injection) |
| `playback-roundtrip` | start playback, wait ~5 s, exit the player back to details (the `/video` round trip destroys the header tray — re-injection must recover) |

Each scenario is a fresh browser + login (trace capture is browser-global in
Playwright, so isolating per scenario keeps the traces clean).

`cold-load` is special: its boot reload happens **inside** the trace window, so
it can't lean on the login helper's reload-retry. Instead, after the traced
reload it checks for the same clobbered-session bounce (session gone / no
`getCurrentUserId()`); on a bounce it **discards that trace and re-runs the whole
scenario** — new browser, re-login, re-trace — up to 3 attempts, matching the
login helper's attempt count. A trace is only kept once the boot lands
authenticated.

## Slow-server emulation

`--cpu` and `--latency`/`--download` are applied **only for the scenario window**
— login and setup run at full speed, then throttling is enabled via a CDP
session right before tracing starts. This is deliberate: the late-response bug
class only appears while the *user is navigating* under slow conditions. In a
real run `--latency 300 --cpu 4` pushes `/JellyfinEnhanced/*` request durations
from ~70 ms to ~300–430 ms and inflates long-task time several-fold, surfacing
races that a fast local server hides.

## Reading a trace

**In DevTools:** open Chrome → DevTools → **Performance** → the **Load profile**
button (up-arrow icon) → pick the `.json.gz` (DevTools loads gzipped traces
directly). You get the full timeline: main-thread flame chart, the
**Network** track (find `/JellyfinEnhanced/*` requests and see what they were
waiting behind), **layout shifts**, **long tasks**, and the **screenshots**
filmstrip captured during the flow.

**The printed summary** (per scenario, from parsing the same trace in-process):

```
--- details-to-details summary ---
  trace: e2e/perf/traces/details-to-details-….json.gz (830.0 KiB gz, 21132 events, ~6385ms window)
  requests: 24 total, 2 to /JellyfinEnhanced/*
     +1128ms     79ms  200       /JellyfinEnhanced/tag-cache/…?since=…
     +3793ms     68ms  200       /JellyfinEnhanced/tag-cache/…?since=…
  long tasks >50ms: 2 (1130.5ms total); top 1065ms@+40, 65ms@+1322
  console errors: 0 (none)
```

- **request lines** — every `/JellyfinEnhanced/*` request, sorted by start
  offset: `+<offset from trace start>  <duration>  <HTTP status>  <path>`.
  Reconstructed from the trace's `ResourceSendRequest` / `ResourceReceiveResponse`
  / `ResourceFinish` events keyed by `requestId`. A `FAIL` marker flags a
  network failure or a `>= 400` status.
- **counts** — total requests in the window vs. how many hit the plugin, plus a
  failed count.
- **long tasks >50 ms** — count, total, and the top few by duration with their
  offsets (from `RunTask` events). These are your main-thread stalls.
- **console errors** — collected via `page.on('console')` / `pageerror` for the
  traced window only.

## Limitations

- **Chromium only** — Playwright's `browser.startTracing` (and the CDP throttling)
  are Chromium-only; the harness always launches Chromium.
- **Content-dependent** — scenarios use whatever the server actually has. On a
  bare seed (no TMDB) the "More Like This" rows are empty, so `details-to-details`
  falls back to router navigation between the seeded movies (still a real
  detail→detail hop, just not click-driven). A single-item library skips the
  multi-hop scenarios.
- **Not a regression gate** — there are no assertions; this is a measurement and
  investigation tool, not a pass/fail check. Use the e2e suite and the
  `perf-rules-guard` tests for gating.
- **Trace size** — a multi-navigation scenario with CPU profiling and screenshots
  is ~0.8–1.3 MiB gzipped (~20k–35k events). Output is git-ignored.
