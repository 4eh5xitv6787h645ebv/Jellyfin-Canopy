# Android TV Client Developer Guide

!!! info "Where this code lives"
    The client is a separate repository:
    [`4eh5xitv6787h645ebv/jellyfin-androidtv`](https://github.com/4eh5xitv6787h645ebv/jellyfin-androidtv).
    Paths on this page are relative to that repository, not to the plugin.

This is the counterpart to the [Developer Guide](developers.md) for the
**native Android TV client** — the first-party adopter of the Canopy
Extension Platform.

The web guide's rules are about a browser: DOM mutation batches, observers,
injected script. None of that applies here. A TV client has its own physics —
a D-pad instead of a pointer, a focus system that crashes if you move a view
out from under it, a 10-foot UI where a 200 ms hitch is visible, and hardware
an order of magnitude slower than the phone you are testing on. This page
records what actually breaks, with the evidence that established it.

Like the Canopy guide, it favours precision over hand-holding, and every claim
that came from a live device says so.

---

## The Android TV platform

### Two integration halves, deliberately different

| | Platform v1 | Seerr proxy |
|---|---|---|
| Routes | `/JellyfinCanopy/Platform/v1/...` | `/JellyfinCanopy/seerr/...` |
| Contract | frozen, versioned, schema-checked in CI | the web client's own routes |
| Client code | renders whatever the catalog describes | knows Seerr's shapes |
| Used for | item-detail actions (Spoiler Guard, Hidden Content, Seerr request) | search, discovery, ratings, credits |

Platform v1 has no search or discovery surface — that is
ADR-0012 (`research/extension-platform/adr/`)'s scope
decision, not an oversight. Discovery therefore rides the authorized legacy
proxy. **Do not "unify" these two halves.** The platform half must stay
feature-agnostic so new server contributions appear with no client change; the
proxy half is explicitly allowed to know Seerr.

### Everything rides the session ApiClient

All Canopy and Seerr traffic goes through the injected `ApiClient` singleton
(`SeerrRepository`, `ApiClientCanopyTransport`). Base URL, access token, TLS
and connection pooling are SDK-owned.

**A repository must never accept a URL, token, or acting user from a caller.**
If a function signature contains a token, the design is already wrong: the
server derives identity from the access token alone, and every attempt to
override it via header, cookie or route value was probed and rejected
server-side (Canopy spike S14).

### Graceful omission, never approximation

When a server has no Canopy plugin, has Seerr disabled, or the user is not
linked, the client shows **nothing** — no empty state, no dead button, no
error toast on a screen the user did not ask about.

This is a hard requirement of the
supported client matrix,
and it is also why the Discover toolbar entry is gated on a *resolved*
capability rather than on a preference alone: a preference defaults to on, and
a default-on button on a server with no Canopy is a dead end.

---

## Performance and correctness rules

These are numbered so review comments can cite them. T-rules are TV-specific;
they exist because each one has already broken this app at least once.

### T1 — Never mutate a row that may hold focus

Removing a `ListRow`, or rebinding a details row wholesale, detaches the
focused view. The next D-pad event then walks a view that is no longer in the
hierarchy and the app dies:

```
java.lang.IllegalArgumentException: parameter must be a descendant of this view
    at android.view.ViewGroup.offsetRectBetweenParentAndChild
    at android.view.FocusFinder.findNextFocus
```

This has been reproduced three separate ways: rebuilding the Seerr search row,
inserting late-arriving action buttons via `setItem()`, and re-adding rows
after a search re-emitted. Use `MutableObjectAdapter.replaceAll` with a stable
identity (row header), `ArrayObjectAdapter.setItems` with a real `DiffCallback`,
and targeted `addActionView`/`removeActionView` instead of a full rebind.

**Corollary:** the crash also surfaces inside Compose's
`AndroidComposeView.findNextViewInEmbeddedView` when the mutated rows live in
an `AndroidFragment<RowsSupportFragment>` — which is every Compose-hosted
screen in this app. The fix is the same; the stack just looks different.

### T2 — Claim focus after asynchronous content

Leanback does not reclaim focus for content that arrived after the screen was
created. Navigate to a screen that loads asynchronously, and the *previous*
screen's focused view is still the window's focus — see T1 for how that ends.

After first content lands: `fragment.view?.post { fragment.view?.requestFocus() }`.
Once only; re-claiming on later updates yanks focus away from the user.

### T3 — The SDK's raw `request()` runs on the calling dispatcher

`ApiClient.request()` does **not** hop threads. Called from `lifecycleScope` or
`viewModelScope` — both `Main.immediate` — it performs network I/O on the UI
thread. A debug build tolerates it; a release build on real hardware throws
`NetworkOnMainThreadException` and takes the process with it.

Wrap the round trip **and the JSON decode** in `withContext(Dispatchers.IO)`.
Overseerr detail and credits payloads are hundreds of KiB; parsing those on the
UI thread is a visible hitch even when it does not crash.

### T4 — Render first, enrich second

A screen must paint from the first response. Secondary data (ratings, 4K
capability, remaining quota) arrives later and updates **in place**.

Never await enrichment before the first paint, and never rebuild the row to
apply it — that is T1. Reuse the existing button and relabel it, so a late
quota turns `Request` into `Request (3 left)` without swapping a view the user
may be focused on.

### T5 — Late UI must not reflow what is already on screen

Buttons that appear after the row is drawn are unavoidable when the server
decides what they are. Buttons that *move* what is already drawn are not.

Insert new actions before the overflow button, append when there is none, and
never re-add existing views. Reserve nothing: an empty gap that never fills
reads worse than an appearing button.

### T6 — Cached artwork survives server-side re-rendering

Spoiler Guard blurs images **behind the same URL and image tag**. Coil's memory
and disk caches key on the URL, so the unprotected image keeps being served
until it is evicted — the user's workaround was clearing app storage by hand.

After any Canopy action reporting a `jellyfin_item` refresh, drop the image
caches. Clear both wholesale, not per item: protecting a *series* changes its
*episodes'* artwork, and the cache cannot be queried by item.

### T7 — Read preferences reactively, or accept a stale screen

`rememberPreference` keeps a **local** snapshot and ignores writes made
elsewhere (its own KDoc says so). It is correct for the screen that owns the
editor and wrong for everyone else: the toolbar kept offering a surface the
user had just disabled until the app restarted.

Use `observePreference` (a `SharedPreferences` listener) when a composable
merely *reads* a preference someone else may change.

### T8 — Degrade to omission on every read failure

Every Seerr read returns an empty list or `null` on failure and the surface
disappears. Do not surface a transport error to the user on a screen they did
not initiate, and do not latch a failure permanently — `discoverByGenre`
returns `null` (retryable) rather than `hasMore = false`, so one blip does not
end paging for the life of the screen.

Negative capability answers are cached with a short TTL; positive ones are
sticky for the session.

### T9 — Bound everything that comes from a server

The Platform half enforces route allowlists, byte caps, JSON depth limits and
duplicate-key rejection. The proxy half rides the ordinary SDK and gets none of
that, so bound it in the mapper: cap rows (20) and credits (50), validate TMDB
image paths against `^/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$` before building a
URL, and ignore unknown enum values rather than failing the whole response.

### T10 — Never log a server-controlled response fragment

`SerializationException` messages embed the offending JSON. `Timber.DebugTree`
is planted in release builds. Log the message, never the throwable, for any
parse failure — the platform client already does this deliberately.

---

## Testing

### Layers

| Layer | Location | Covers |
|---|---|---|
| Unit | `app/src/test/kotlin/integration/canopy/` | protocol client, wire validation, bounds |
| Unit | `.../integration/canopy/seerr/` | proxy mapping, request bodies, status/quota/ratings parsing |
| Scenario E2E | `e2e/canopy-seerr/e2e_seerr_surfaces.py` | every surface and button, on a real device |
| Soak E2E | `e2e/canopy-seerr/e2e_soak.py` | navigation-shaped failures a linear pass cannot reach |

### Scenario suite

Seven independent, selectable scenarios sharing one app session:

```
python3 e2e_seerr_surfaces.py <serial> [package] --only settings
python3 e2e_seerr_surfaces.py <serial> [package] --list
```

Verify one change in ~15 s instead of re-running everything. `--cold` restores
the restart-per-scenario behaviour for benchmarking or isolating interference.

A step whose precondition the connected server cannot satisfy (an item with no
cast, no Seerr result linked to the library) reports **passed with a `skipped`
note**. Read the notes before calling a run full coverage.

### Soak

A seeded random walk across every screen, weighted to keep descending into
content, checking after each move that the app has not crashed, left the
foreground, or gone blank — and sampling PSS to catch a leak.

```
python3 e2e_soak.py <serial> [package] --minutes 20 --seed 7
```

Every move is recorded; a failure prints the exact path and writes the full
stack to `e2e-evidence/soak/`. It never submits a request or completes an
action dialog — a soak must not spam a real Seerr instance or mutate state that
changes later runs.

**This layer earns its keep.** The T1 crash survived four clean scenario runs
and could not be reproduced by hand; the soak found it in 13 moves and gave a
replayable path.

### Driver

`atv_driver_fast.py` replaces per-command process spawns with persistent
connections — uiautomator2's on-device server for reads, scrcpy's control
socket for input, one long-lived `adb shell`. Measured on a Shield over WiFi
adb:

| Operation | `adb` per command | persistent | speedup |
|---|---:|---:|---:|
| UI read | 2.23 s | 0.13 s | ~17x |
| Key event | 86 ms | 0.1 ms | ~800x |

Cheap reads are not just faster, they change what the tests can do: fixed
`sleep()` calls become `wait_text()` polls, which is where most of the
wall-clock win and nearly all of the flake reduction comes from.

### Verify on a release build, on hardware

T3 is the standing example: main-thread network I/O that a debug build absorbs
silently kills a release build on a Shield. R8 also renames the SDK's logger
tag, so test assertions must match HTTP log lines by URL, not by tag.

---

## Project structure

| Path | Contents |
|---|---|
| `integration/canopy/` | Platform v1 client: routes, transport, wire models, bounds, coordinator |
| `integration/canopy/seerr/` | Seerr proxy repository and models |
| `ui/itemdetail/CanopyItemDetailController.kt` | item-detail action surface and placement modes |
| `ui/itemdetail/CanopyFormPresenter.kt` | shared server-defined form renderer |
| `ui/canopy/CanopyQuickActions.kt` | standalone action chooser (long-press, Manage) |
| `ui/seerr/` | Discover, Seerr detail, person, genre grid, row helpers |
| `ui/search/SeerrCardPresenter.kt` | Seerr cards, matching native card composition |
| `e2e/canopy-seerr/` | drivers, scenario suite, soak, evidence |

### Where the seams are

- **Adding a server contribution** should need no client change. If it does,
  the client has hardcoded something the catalog was supposed to describe.
- **Adding a Seerr surface** means a repository method plus a screen; the
  repository owns bounding, mapping and failure handling, never the UI.
- **Rendering a Seerr entity** goes through `SeerrCardPresenter` so it stays
  visually identical to native rows — same `ItemCard`/`ItemPreview`
  composition, same aspect ratios, same 130 dp base height for landscape.
