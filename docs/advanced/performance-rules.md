# Performance Rules

Jellyfin Enhanced injects UI into pages the user is already looking at. Done carelessly, that means layout shift, observer storms and CDN stalls — *jank*. Every rule below was earned by finding and fixing a real regression in this codebase; together they are the plugin's jank doctrine, and they are **enforceable in review**: a PR that violates one needs a written justification in the PR description, not a shrug.

The implementation sites are marked in the source with `// PERF(Rn):` comments — grep for a rule id to see every place it is applied:

```bash
grep -rn "PERF(R3" Jellyfin.Plugin.JellyfinEnhanced/src/
```

| # | Rule | One line |
|---|------|----------|
| R1 | Pre-paint or reserved space | Injected UI is part of its anchor's first painted frame, or occupies reserved dimensions. Never insert-then-move. |
| R2 | Overlays over in-flow | Decorations on existing content are `position:absolute` — they cannot shift layout. |
| R3 | Observer budget | No feature owns a body-wide MutationObserver; use the multiplexed `JE.core.dom.onBodyMutation`. Never observe attributes body-wide. |
| R4 | One layout read per navigation | Cache layout-dependent lookups per nav; no layout reads inside observer ticks. |
| R5 | No polling | No `setInterval` for DOM detection; data polls are page-scoped, visibility-gated and push-nudged. |
| R6 | No remote assets, ever | Third-party assets go through the local asset cache (`/JellyfinEnhanced/assets/`). A CDN URL in a PR fails review. |
| R7 | Single insert | Build off-DOM, insert once with content ready; late async data fades in (compositor-only), never swaps layout. |
| R8 | Sync work budget | Pre-paint hooks stay under ~2 ms per mutation batch (`performance.now()` guard); overflow goes async. |
| R9 | Fail open — late beats never | The jank rules bound *when and how* content appears, never *whether*. A readiness wait or fetch that misses its window degrades to a late, shift-free entrance — it never silently skips the content, and a transient error is never cached as an answer. |

Those nine are client-side (jank + resilience). There is also one **server-side** rule — [S1](#s1-never-block-jellyfins-synchronous-threads) — for plugin code that runs on Jellyfin's own threads (library-scan event handlers).

Several of these rules are now backed by **source-scan guard tests** that fail `npm run test:client` on a new violation, not only on review: `src/test/perf-rules-guard.test.ts` (the R-rules), `src/test/leak-guard.test.ts` (object URLs, un-torn-down observers, unbounded TTL maps and self-rescheduling retry loops for R3/R5), plus the non-perf `css-injection-guard` and `error-as-empty-guard` companions described in [Client Security](client-security.md).

---

## R1 — Pre-paint or reserved space

**Rule.** UI injected next to or into already-visible content must do one of two things:

- **Pre-paint:** attach in the *same mutation batch* that mounted its anchor, via `ensureInjected(key, anchorFn, buildFn, { prePaint: true })`. The shared body observer runs `prePaint` injectors synchronously inside its mutation callback — a microtask after the DOM change, before render steps — so a remounted anchor never paints a frame without its injected node.
- **Reserved space:** if the node must land after the anchor painted, it occupies its final dimensions from the first frame — a `min-width` chip sized to its typical content, or the `JE.core.ui.expandIn` one-time eased entrance (which measures the natural width, collapses to 0, expands once, then removes every inline style).

Never insert-then-move. Never insert a placeholder and later swap its width.

**Why.** A node added into flow after its siblings painted shifts every one of them — that is the single most visible form of jank and exactly what the `layout-shift` performance entry counts. Pre-paint injection is *invisible*: the anchor's first painted frame already contains the node. Reserved space turns a late arrival into a paint-only change.

**The pattern to copy:**

```ts
import { ensureInjected } from '../core/dom-observer';

ensureInjected(
    'je-my-button',
    () => findAnchor(),
    (anchor, ctx) => {
        const el = buildButton();
        anchor.appendChild(el);
        // Pre-paint mounts are in the anchor's first frame — animating them
        // would only draw attention. Post-paint mounts get the one-time
        // shift-free entrance instead of snap-shifting siblings.
        JE.core.ui!.expandIn(el, { instant: ctx?.prePaint });
        return el;
    },
    { headerTray: true, prePaint: true }
);
```

**In the tree:** `src/core/dom-observer.ts` (`runPrePaintInjectors`), `src/core/ui-kit.ts` (`expandIn`), `src/enhanced/features/random-button.ts` (header-tray button), `src/enhanced/features/details-media-info.ts` (chips reserve their typical final width — progress ring, file size, flags with explicit width *and* height), `src/jellyseerr/issue-reporter.ts` (reserved-space entrance), `src/enhanced/native-tabs.ts` (one-time boot entrance).

## R2 — Overlays over in-flow

**Rule.** Anything that *decorates* existing content — tags on posters, badges, indicators, buttons layered on cards — is `position:absolute` inside a `position:relative` host. It is never an in-flow sibling of the content it decorates.

**Why.** An in-flow child changes its siblings' geometry every time it appears, disappears or resizes. An absolutely positioned overlay is removed from flow: by construction it *cannot* shift layout, no matter how late its data arrives or how often it re-renders. This is what makes the tag pipeline's late fade-ins (R7) safe.

**The pattern to copy:** the overlay container is positioned absolute against the card; the host is promoted to `position:relative` only if it is `static`.

**In the tree:** `src/core/tag-renderer-base.ts` + `src/tags/*` (all four overlay families), `src/jellyseerr/issue-reporter.ts` (issue badge over the poster).

## R3 — Observer budget

**Rule.** No feature creates its own body-wide `MutationObserver`. Watching the whole document goes through **`JE.core.dom.onBodyMutation(id, cb)`** — one multiplexed observer with a structural fast-path (attribute/text-only batches are dropped before any subscriber runs) — or, better, through navigation events (`onNavigate`, `viewshow`) when the trigger is really "the page changed". Element-scoped observers attach on the page that needs them and are torn down via lifecycle handles when it unmounts. **Never observe `attributes` or `characterData` body-wide** — not even with an `attributeFilter`.

**Why.** N separate body observers mean the browser clones every `MutationRecord` list N times and schedules N microtasks per DOM change — pure overhead that scales with feature count. Attribute observation body-wide fires on every hover, focus ring and progress-bar tick; it turns idle pages into busy ones. The refactor collapsed four sidebar-nav observers into one shared subscriber (`onSidebarRebuild`) and deleted an always-on details-page attribute observer outright.

**The pattern to copy:**

```ts
import { onBodyMutation } from '../core/dom-observer';

const handle = onBodyMutation('je-my-feature', (mutations) => {
    // structural changes only — the fast-path already filtered the rest
});
// page-scoped teardown:
lifecycle.track(handle);
```

`createObserver(id, cb, document.body, { childList: true, subtree: true })` routes to the same shared observer automatically; passing `attributes`/`attributeFilter`/`characterData` opts out of the multiplexer and creates a dedicated instance — which is exactly why it is banned body-wide.

**In the tree:** `src/core/dom-observer.ts` (`onBodyMutation`, `createObserver`, `onSidebarRebuild`), `src/enhanced/osd-rating.ts` (observer exists only while the player is mounted), `src/enhanced/features/details-page.ts` (replaced a dedicated attribute observer), `src/extras/colored-ratings.ts` (rides the shared structural observer).

## R4 — One layout read per navigation

**Rule.** Layout-dependent lookups (`offsetParent`, `offsetWidth`, `getBoundingClientRect`, `getComputedStyle`) are cached per navigation and invalidated by `onNavigate` — the `getHeaderRightContainer` pattern. No layout reads inside observer ticks. In loops, reads and writes never interleave: batch all reads, then all writes.

**Why.** Each of those properties can force a synchronous layout pass. Observer callbacks run many times per second while content streams into a page; a layout read inside one multiplies into continuous forced reflow. Interleaved read/write loops cause layout thrashing — every write invalidates the layout the next read has to recompute.

**The pattern to copy:**

```ts
let cached: HTMLElement | null = null;
onNavigate(() => { cached = null; });
function getContainer(): HTMLElement | null {
    if (cached && cached.isConnected) return cached;
    cached = resolveWithLayoutRead(); // the ONE read this navigation pays for
    return cached;
}
```

**In the tree:** `src/enhanced/helpers.ts` (`getHeaderRightContainer` per-nav cache), `src/jellyseerr/seamless-scroll.ts` (IntersectionObserver only — it exists precisely to avoid layout reads on scroll).

## R5 — No polling

**Rule.** No `setInterval` to detect DOM state — mutation batches and navigation events already tell you. Polling for *data* is allowed only when all three hold:

1. **page-scoped** — starts when the page that shows the data mounts, stops on leave (lifecycle-tracked);
2. **visibility-gated** — skips ticks while `document.visibilityState === 'hidden'`;
3. **push-nudged** — a `JE.core.live` channel (`LIVE.CONFIG_CHANGED`, `LIVE.LIBRARY_CHANGED`, `LIVE.USER_DATA_CHANGED`) triggers the refresh immediately, so the poll is a fallback cadence, not the mechanism.

**Why.** An idle Jellyfin tab should cost nothing. Permanent intervals burn CPU and battery in every open session forever, and DOM polling additionally races the thing it polls for. The old colored-ratings module ran a permanent 1 Hz full-document scan; it is now mutation- and navigation-driven with zero standing timers.

**In the tree:** `src/extras/colored-ratings.ts` (poll removed), `src/core/live.ts` (the push hub — see [Live Updates](live-updates.md)), `src/arr/requests/data.ts` (page-scoped downloads poll).

## R6 — No remote assets, ever

**Rule.** The client never loads a static asset (font, CSS, icon, flag, theme, placeholder image) from a third-party host. Every such asset is mirrored server-side by the `AssetCacheManifest` / `AssetCacheService` pair (refreshed on a ~24 h schedule) and served from `/JellyfinEnhanced/assets/<key>`; client code resolves URLs exclusively through `assetUrl()` / `flagSvgUrl()` / `flagPngUrl()` / `themeCssUrl()` in `src/core/asset-urls.ts`. **A PR that adds a CDN URL anywhere else fails review.** Adding an asset means adding it to both the server manifest and the client table — the two are kept in sync deliberately.

*Exempt:* content images (TMDB posters/backdrops, YouTube thumbnails) — they are data, not assets — and hyperlinks the user explicitly clicks.

**Why.** A third-party asset adds DNS + TLS + RTT to the first paint of whatever uses it, staggers UI as pieces arrive at CDN speed, leaks every user's browsing to that CDN, and breaks the feature when the CDN changes or is blocked. Same-origin assets arrive with the page.

**The pattern to copy:**

```ts
import { assetUrl } from '../core/asset-urls';

icon.src = assetUrl('icons/sonarr.svg');   // local mirror (default) or the
                                           // registered CDN twin if an admin
                                           // disabled the cache — never a
                                           // hardcoded remote URL
```

**In the tree:** `src/core/asset-urls.ts` (the single client table), `Services/AssetCacheManifest.cs` + `Services/AssetCacheService.cs` (the mirror), and every `// PERF(R6): no remote assets` site that consumes them.

## R7 — Single insert

**Rule.** Feature DOM is built **off-DOM** — element tree or fragment fully assembled, content included — and inserted **once**. If part of the content depends on an async fetch, start the fetch *before or in parallel with* building (so the insert usually has everything), and when data genuinely lands after insert, apply it with a **compositor-only entrance** (opacity fade — the `je-tag-fadein` pattern) into space that already exists (R1/R2). Never insert empty containers that later grow, and never swap a placeholder's size.

**Why.** Every in-flow insert is a reflow; inserting a skeleton and filling it in is two or more reflows plus a visible size change. One insert with content ready is one reflow and zero visible churn. Opacity changes composite on the GPU without layout or paint of surrounding content — a late tag fading into an absolutely positioned overlay costs nothing.

**The pattern to copy:**

```ts
const dataPromise = fetchData();          // start NOW, in parallel with build
const fragment = document.createDocumentFragment();
for (const item of items) fragment.appendChild(buildRow(item));
container.appendChild(fragment);          // ONE insert, one reflow
const data = await dataPromise;
overlay.classList.add('je-tag-fadein');   // late data: opacity-only entrance
```

**In the tree:** `src/elsewhere/elsewhere.ts` (single insert with content — the old flow inserted empty and filled in), `src/arr/arr-links.ts` (all link buttons collect into a fragment; the whole row lands in one reflow), `src/jellyseerr/item-details.ts` (sections built fully off-DOM, cards included), `src/enhanced/tag-pipeline.ts` (async passes fade tags in).

## R8 — Sync work budget

**Rule.** Synchronous work inside a mutation batch — pre-paint injectors (R1), priority body-subscribers, the tag pipeline's sync card pass — runs under a **~2 ms per-batch budget**, enforced with a `performance.now()` guard at the top of the loop. Work that would exceed the budget overflows to the async/idle path (where R7's fade-in makes the late arrival invisible).

**Why.** Pre-paint work executes between the DOM change and the next paint. That position is what makes it shift-free — and what makes it dangerous: every millisecond spent there delays the very frame it is trying to be part of. A budget keeps the fast path fast under worst-case pages (hundreds of cards in one batch) instead of only on the happy path.

**The pattern to copy** (from the tag pipeline):

```ts
const SYNC_SCAN_BUDGET_MS = 2;
const start = performance.now();
for (const card of addedCards) {
    if (performance.now() - start > SYNC_SCAN_BUDGET_MS) {
        queueForAsyncScan(remaining);     // overflow — never blow the frame
        break;
    }
    renderFromCacheIfResident(card);      // cache hits render pre-paint
}
```

**In the tree:** `src/enhanced/tag-pipeline.ts` (`SYNC_SCAN_BUDGET_MS`, the budgeted sync pass and its queued overflow), `src/enhanced/hidden-content/filter.ts` (synchronous hide inside the batch so forbidden cards never paint), `src/enhanced/playback.ts` (one presence probe per batch, not per record).

## R9 — Fail open: late beats never

**Rule.** R1–R8 constrain *when and how* injected content appears — they must never decide *whether* it appears. On a slow server, a slow connection, or a transient error (things JE cannot fix), the feature degrades to **arriving late**, shift-free per R1/R2/R7 — it does not silently skip the page view. Concretely:

- **Readiness waits don't give up.** A wait for a host anchor/container stays subscribed to the multiplexed body observer (R3 — no polling, no new observer) until the anchor mounts **or navigation aborts it**. A fixed "resolve null after N seconds" is a violation: on a slow host it converts *late* into *never*, and nothing re-triggers until the user navigates away and back. A generous absolute deadline is acceptable only as a leak backstop for signal-less callers, never as a UX budget.
- **Transient errors are not answers.** A failed fetch may be *remembered* only briefly (≤ 30 s), never with the TTL of a genuine "server said there is no data" response. Distinguish the two at the call site — a transport error that gets cached like an empty answer hides the feature for the cache lifetime, across re-navigations.
- **Failed prerequisites retry.** A one-shot handler whose async prerequisite fails (item lookup, status probe, module load) schedules a **bounded, backoff** retry scoped to the page view (abandoned on navigation, gated on `document.visibilityState`, capped by attempts or a deadline — the leak-guard enforces the cap). "Log and return" with nothing re-triggering is a violation. An init that runs once per session must never let a transient failure disable the feature until reload.
- **Dropped work is un-marked.** If a processed-set/dedup mark was placed before the work completed and the work is then dropped (navigation, batch failure), remove the mark so a later pass over surviving elements can retry — bounded, so an unreachable server isn't hammered.

**Why.** The zero-jank doctrine originally optimized for the fast path; on slow or flaky infrastructure its timeouts and negative caches turned into *content that never loads in until you re-navigate* — an inconsistent, trust-eroding experience worse than a late fade-in. Late content entering reserved space, an absolute overlay, or a below-the-fold single insert costs zero shift (that's exactly what R1/R2/R7 guarantee), so there is no jank reason to drop it. The only acceptable "never" is a genuine answer: the server said there is nothing to show, or the user navigated away.

**The pattern to copy** (readiness wait; the retry/backoff and error-TTL patterns are at the sites below):

```ts
// Wait until the anchor mounts or the page view ends — never a give-up timer.
function waitForAnchor(signal: AbortSignal): Promise<HTMLElement | null> {
    return new Promise((resolve) => {
        const found = findAnchor();
        if (found) return resolve(found);
        const handle = onBodyMutation(`my-feature-anchor-${++seq}`, () => {   // unique id per waiter
            const el = findAnchor();
            if (el) { handle.unsubscribe(); resolve(el); }
        });
        signal.addEventListener('abort', () => { handle.unsubscribe(); resolve(null); }, { once: true });
    });
}
```

**Boundaries.** R9 does not license unbounded retries or standing timers: retries carry an attempt cap or `Date.now()` budget (leak-guard-enforced), waits are torn down on navigation, and polling — where a mutation signal genuinely doesn't exist — still obeys R5 (page-scoped, visibility-gated, decaying interval). R9 changes what happens at the *end* of a bounded effort: degrade gracefully and stay recoverable, never poison state.

**In the tree:** `src/jellyseerr/discovery/filter-utils.ts` + `src/jellyseerr/item-details.ts` (`waitForPageReady`/`waitForDetailPageReady` — until-nav waits, unique waiter ids), `src/enhanced/features/details-page.ts` (item-type fetch retry), `src/enhanced/features/details-media-info.ts` + `src/enhanced/features/release-dates.ts` (`ERROR_CACHE_TTL` vs answer TTL, in-place bounded retries), `src/jellyseerr/api.ts` (transport-error status TTL ≪ genuine-negative TTL), `src/jellyseerr/issue-reporter.ts` (lazy status re-verification; per-view bounded retries), `src/elsewhere/reviews.ts` (bounded backoff visibility wait), `src/arr/arr-links.ts` (boot init retained across a slow login), `src/others/letterboxd-links.ts` + `src/enhanced/tag-pipeline.ts` (processed-set un-poisoning). Grep `PERF(R9)`.

---

## Server-side rules

R1–R9 are about the client. One rule governs the **server** — plugin code that runs on threads Jellyfin owns, where the cost lands on the host, not the browser.

## S1 — Never block Jellyfin's synchronous threads

**Rule.** A handler for a Jellyfin event that fires on a hot host thread — above all `ILibraryManager.ItemAdded` / `ItemUpdated` / `ItemRemoved`, which are raised **synchronously, one item at a time, on the library-scan thread** — must do only **O(1) record-and-defer** work: cheap in-memory checks, then record an id (or bump a counter) and return. No DB query (`GetItemList`, `GetItemById`), no media probe (`GetMediaSources`), no file or network I/O. The real work runs on a debounced, off-thread worker that **coalesces** by id.

**Why.** Jellyfin invokes these handlers inline in the scan loop and waits for each to return before moving to the next item (`LibraryManager` raises them in a `foreach` on the calling thread). Whatever the handler does is added to the scan. The tag cache learned this the hard way: its handler rebuilt the changed item *and* re-resolved and rebuilt the parent Series and Season on every episode event — each a sorted "first episode" DB query — i.e. **~1.5 s of work per episode**, on the scan thread, for a library with 100k+ episodes. Measured before/after on the same items: **~1660 ms → ~113 ms per event** once the work moved off-thread.

**The pattern to copy** (`TagCacheMonitor` → `TagCachePendingChanges` → `TagCacheService`):

```csharp
// Handler runs ON the scan thread — only record ids, never resolve them here.   // PERF(S1)
private void OnItemChanged(object? sender, ItemChangeEventArgs e)
{
    var item = e.Item;
    if (item is null || !TaggableTypes.Contains(item.GetBaseItemKind())) return;
    _service.EnqueueUpdate(item.Id);            // O(1): record id + arm a debounced timer
    if (item is Episode ep)                      // SeriesId/SeasonId are in-memory props, no DB
    {
        _service.EnqueueUpdate(ep.SeriesId);
        _service.EnqueueUpdate(ep.SeasonId);
    }
}

// A debounced Timer drains the coalesced batch OFF the scan thread, resolves each id
// (GetItemById), rebuilds the entry and persists once — so a burst for one series collapses
// to a single rebuild instead of one per episode.
```

Use a short debounce with a hard max-wait cap so a continuous scan still flushes periodically, and drain any queued work on `Dispose` so a shutdown mid-window doesn't lose it.

**Enforced.** `LibraryScanEventGuardTests` fails the build when a new file subscribes to these events without being reviewed onto its allowlist. It also checks the **synchronous body of *every* reviewed subscriber** — not just `TagCacheMonitor` — against a broadened denylist of DB queries and I/O sinks (`GetItem(s)` / `GetPeople` / `QueryItems` / `GetMediaSources` / `GetImageInfo` / `GetChildren`, plus `File.*`, `SaveChanges`, `ToListAsync` and LINQ materialization like `.First(...)`). Legitimately deferred work — the code inside a `Task.Run(...)` lambda or a named off-thread worker — is stripped before matching, so only work that would actually run on the scan thread trips the guard. A subscriber that regains inline heavy work in its synchronous prefix fails with the file and offending call named. Grep the record-and-defer sites:

```bash
grep -rn "PERF(S1)" Jellyfin.Plugin.JellyfinEnhanced/
```

**In the tree:** `Services/TagCacheMonitor.cs` (record-and-defer handler), `Services/TagCachePendingChanges.cs` (coalescing set), `Services/TagCacheService.cs` (debounced off-thread flush + `Dispose` drain), `Services/SeerrScanTriggerService.cs` (counter + debounce timer), `EventHandlers/ContinueWatchingPlaybackEvents.cs` (a bulk library removal coalesces to one hidden-content prune per user for the whole batch, not one per removed item).

---

## Measured impact

Numbers from `e2e/perf/jank-benchmark.js` — a manual measurement harness (not wired into CI; methodology in its header comment). It drives a real Chromium through a fixed flow (boot → home → library → detail → search → warm library revisit → 30 s library scroll) with `MutationObserver`, `setInterval`, `layout-shift` and `longtask` instrumentation installed **before** any page script runs. Three runs per column, medians reported.

**Read the caveat first:** *before* is the pre-refactor plugin on a Jellyfin **10.11** server; *after* is this tree on Jellyfin **12**. The host client differs, so whole-page metrics (total CLS, host long tasks, boot time) are **not** apples-to-apples. The JE-owned metrics **are**: JE-attributed shifts, JE request count/bytes, JE observer/interval counts and decoration pop-in delays measure only what the plugin does.

### JE-owned metrics (comparable across versions)

| Metric | Before (10.11 + old main) | After (12 + fixes) |
|---|---|---|
| JE-attributed layout-shift score (whole flow) | 0.0054 | **0.0002** |
| JE-attributed shift entries (whole flow) | 16 | **3** |
| Live `MutationObserver`s created by JE (idle on home) | 27 | **3** |
| … of which body-wide | 26 | 3 |
| … of which body-wide **and attribute-observing** | 24 | **0** |
| Active `setInterval` timers owned by JE (idle on home) | 2 — a permanent 1 Hz colored-ratings poll + a 30 s requests poll running even on home | **1** — a 15-min, visibility-gated plugin-update recheck |
| JE requests at boot | 78 | **33** |
| JE bytes at boot | 3 372 662 B (3.2 MiB) | **1 624 785 B (1.5 MiB)** |
| Third-party **asset-CDN** requests, whole flow (R6) | 15 across 4 hosts (jsdelivr, cdnjs, googleapis, gstatic) | **0** (only `image.tmdb.org` content) |
| Header-button pop-in after tray paint | 3 996 ms | **1 234 ms** |
| Detail-page decoration pop-in after `.mainDetailButtons` paint | 410 ms (n=9) | 569 ms (n=12) — but into reserved space / overlays, so shift-free (the shift rows above are the outcome) |
| Tag pop-in, library page (cold) | n=0 — the legacy client re-shows the cached page DOM, so the harness saw no fresh tag inserts | 138 ms (n=177), 28 rendered pre-paint |
| Tag sync-path hit rate, warm library revisit | n/a (no fresh inserts observed) | **28/177 (16 %) in the same frame as their cards** (no `je-tag-fadein` class = the R1/R8 pre-paint path, budget-bound at ~2 ms/batch); the rest fade in at ~220 ms median — intentional per R7, opacity-only into R2 overlays |

### Host-dominated metrics (context only — NOT apples-to-apples)

| Metric | Before (10.11 host) | After (12 host) |
|---|---|---|
| Whole-flow cumulative layout shift | 0.0872 | 0.3142 — the v12 React host shifts on its own; the JE-attributed row above isolates the plugin's share |
| Long tasks during boot | 3 / 262 ms | 8 / 840 ms — the v12 host boot pipeline is heavier |
| Long tasks during 30 s library scroll | 0 / 0 ms | **0 / 0 ms** — scrolling is clean on both; no JE observer or tag work surfaces as a long task |
| Boot to JE-ready | 1 543 ms | 1 926 ms — different host and different readiness gates |

### Known remainders the benchmark exposes

Reported here so the doctrine stays honest — each is visible in the census output of a fresh run:

- **R3 stragglers (resolved):** `src/arr/arr-tag-links.ts`, `src/elsewhere/elsewhere.ts` and `src/others/letterboxd-links.ts` — once body-wide observers with `attributeFilter: ['class']` — now ride the shared `JE.core.dom.onBodyMutation` multiplexer (childList-only; the old `attributeFilter` survives only in `// PERF(R3):` comments describing the retired design). No feature owns a body-wide attribute-observing observer any more, so the *after* count above is **0**. The only `attributeFilter` observers left are player-scoped (`src/enhanced/playback.ts`) and element-scoped (`src/bootstrap/login-image.ts`), neither of them body-wide.
- **R5 note:** the one standing JE interval is `src/core/live-update.ts`'s 15-minute version recheck — visibility-gated and push-nudged (config pushes carry the version), but app-scoped rather than page-scoped.
- **Home-page first-tag latency after a cold boot** is higher on the fixed build (median ≈ 2.7 s after card mount vs ≈ 0.7 s before): home cards paint long before the bundle finishes booting, and first tags wait for the server tag-cache fetch. They fade into absolute overlays, so this costs zero shift — but it is the number to beat next.
- **Residual JE-attributed shifts** (the 0.0002 above) are micrometric, ≤ 0.0001 each: the Material Symbols icon-font swap reflowing already-injected icons at boot, the `#je-active-streams` header button's one-time entrance, and the audio-language chip whose reserved width is close-but-not-exact to its final content. One run in five showed a ~0.03 JE-attributed spike on the library page that did not reproduce; `jeShifts` in the harness output names the source nodes when it does.

### Re-running

```bash
NODE_PATH=/path/with/playwright node e2e/perf/jank-benchmark.js \
  --base http://localhost:8099 --label after --runs 3 --out results.json
# pre-refactor builds (no JE.initialized flag): add --legacy
```
