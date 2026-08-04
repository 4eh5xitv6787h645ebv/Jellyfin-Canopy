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

See [Android TV Client](androidtv-features.md) for screenshots of every
surface described here.

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
[ADR-0012](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy)'s scope
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
[supported client matrix](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy),
and it is also why the Discover toolbar entry is gated on a *resolved*
capability rather than on a preference alone: a preference defaults to on, and
a default-on button on a server with no Canopy is a dead end.

---

## Performance and correctness rules

These are numbered so review comments can cite them. T-rules are TV-specific;
they exist because each one has already broken this app at least once.

### T0 — Memory growth in a soak is usually the bitmap cache

Total PSS is not a leak signal on this app. Across a 90-move soak on a Shield,
PSS grew from 101 MB to 324 MB — but the breakdown says it is cache, not a
leak:

| Pool | Start | End |
|---|---:|---:|
| Java heap | 27 MB | **23 MB** |
| Native | 15 MB | 60 MB |
| Graphics | 12 MB | 140 MB |

Java heap *shrank*; the growth is entirely bitmaps in Graphics/Native, which is
Coil filling its cache budget against a real library. PSS also drops
mid-run when the cache trims. Always read the breakdown
(`e2e_soak.py` prints it) before calling growth a leak — and treat a rising
**Java heap** as the signal that matters.

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
screen in this app.

Conservative mutation narrows the window but **cannot close it**: the throw is
inside framework code the app does not drive. `MainActivity.dispatchKeyEvent`
therefore contains that one exception and resets focus. This is measured, not
defensive habit — removing the guard reproduced the crash three times in 180
soak moves on seeds that are otherwise clean.

**Corollary 2:** `ListRow` rejects a null adapter. Building a placeholder row
to carry a header throws `IllegalArgumentException: ObjectAdapter cannot be
null` — an easy mistake to make while restructuring row updates, and one that
looked exactly like the focus crash until the *message* was compared rather
than the exception type.

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

### T10 — Notice the host retiring a route

Canopy emits `Deprecation` and `Sunset` headers on Platform routes it is
retiring (EP-01.10). A client that ignores them keeps working right up to the
sunset date and then fails with no warning.

`CanopyClient` logs the notice once per route per process. It is deliberately
a **developer** signal, not a user-facing one: a viewer cannot act on it, so it
must never reach the UI or repeat per request.

### T11 — A control never shows a clipped label

Detail-row buttons are a fixed-width, two-line field. Contribution labels come
from the *server* and are far longer than the app's own one-word labels
("Play", "Watched"), so they overflow: first wrapping oddly, then breaking
**mid-word** into things like `Con figure`.

Two rules, both enforced in `FullDetailsFragment`:

1. **Measure, do not guess.** An action becomes a button only when its label
   renders whole at the button's real dimensions (`labelFitsButton` builds a
   `StaticLayout` against the same width, size and line count as
   `text_under_button.xml`). Labels vary by feature, locale and translation,
   so a hardcoded length limit would be wrong somewhere.
2. **Overflow is a destination, not a failure.** Anything that does not fit —
   or does not fit *the remaining slots* — goes to "Other options" rather than
   being squeezed into the row.

Injected actions must also re-run the host's own overflow accounting
(`showMoreButtonIfNeeded`) so built-in actions collapse around them. Reserve
slots first and let that accounting rebalance: measuring free space at
resolve time always concludes there is none, because nothing has collapsed
yet.

### T12 — A control that carries state must announce it

The shared `Checkbox`/`RadioButton` were drawn but not described: no
`toggleableState`, no `selected`. On a 10-foot UI that means a screen-reader
user hears the row's label and never learns whether the setting is on — and
the accessibility tree exposes no state at all, so tests have to infer a
setting from downstream UI instead of reading it.

Any control representing state gets semantics at the component, not the call
site, so every screen using it benefits at once. `atv_driver`'s
`toggle_state()` then reads the real value.

### T13 — Never log a server-controlled response fragment

`SerializationException` messages embed the offending JSON. `Timber.DebugTree`
is planted in release builds. Log the message, never the throwable, for any
parse failure — the platform client already does this deliberately.

---

### T14 — A title linked to a Jellyfin item is already in the library

Seerr reports its own `status`, and that status describes *Seerr's* request
pipeline, not your library. A title the server has matched to a Jellyfin item
carries a `jellyfinMediaId`, and that link is the authoritative answer to "do I
have this?" — whatever `status` says beside it.

Trusting the raw status offers a Request action for something the user is
already looking at in their own library, which reads as the integration being
broken.

Resolve the effective status once, at the boundary:

```kotlin
private fun effectiveStatus(wire: Int?, jellyfinMediaId: String?) =
    if (!jellyfinMediaId.isNullOrBlank()) SeerrMediaStatus.AVAILABLE
    else SeerrMediaStatus.fromWire(wire)
```

Apply it in **every** mapper, not just the one whose bug you noticed. Cards and
detail screens are mapped separately here, so fixing `toDiscoverItem` left
`toItemDetails` still offering Request for owned titles. The 4K state is a
separate axis with its own link — resolve it against `jellyfinMediaId4k`.

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
replayable path. It also caught a null-adapter regression that a passing
scenario suite missed entirely.

A 25-minute run on merged master (seed 42) covered **1068 moves with zero
failures**, and settled the memory question for good: PSS climbs while the
bitmap cache fills and then sits flat.

```
PSS MB by move: 0:119 100:109 200:159 300:318 400:286 600:288 800:288 1000:284
```

Steady from move ~300 onward across 750 further moves, with the Java heap
*shrinking* 27 → 19 MB. Growth that plateaus is a cache; growth that keeps
climbing is a leak.

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
