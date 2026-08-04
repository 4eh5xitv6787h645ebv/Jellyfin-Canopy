# ADR-0007 — Declarative web contributions

Status: **proposed** for decisions 1–6, now browser-verified · the sandboxed-frame design remains **deferred, not in v1** · Owner: web adapter · Evidence: [S17](../spike-evidence.md#s17--browser-slots-render-idempotently-the-frame-is-genuinely-isolated-and-there-is-no-csp)

## Context

Canopy's browser layer is substantial and hard-won: a route/navigation owner that
patches history exactly once, a single multiplexed body `MutationObserver` (a
performance rule forbids feature-owned observers), an idempotent
`ensureInjected(key, anchor, build)` primitive, a three-layer teardown model, a
feature loader with import purity, dependency ordering, retry backoff and scope
staleness, and a modern-layout readiness owner.

An extension that got raw DOM access would bypass all of it — and would also get
the viewer's token, because injected script runs same-origin. That is exactly the
failure of [milestone 82](../milestone-82-disposition.md).

## Decision

1. **v1 contributions are small, surface-specific declarative schemas.** Not a
   component tree, not arbitrary HTML/CSS/JS, not a JSON dialect of React.
2. **Extensions never supply selectors, CSS, markup or scripts.** They target
   **semantic slots**; Canopy's web adapter owns every Jellyfin DOM and layout
   difference.
3. **v1 slot set** (frozen in [`v1-capability-freeze.md`](../v1-capability-freeze.md)):
   navigation entry · home/media row · item badge · item-detail action ·
   item-detail information section · player action/marker · form/dialog ·
   status/notification · platform settings surface.
4. **Safe semantic actions only:** navigate to a Jellyfin item, play a Jellyfin
   item, invoke an approved opaque action, confirm-or-form then invoke, refresh
   the contribution, show a localized toast or dialog. No arbitrary URLs, no
   arbitrary schemes, no caller-chosen provider method names.
5. Rendering reuses Canopy's own primitives, so contributions inherit the
   existing idempotent mounting, keyed ownership, teardown, error boundaries,
   cancellation and admin/user kill switches.
6. Resolution is **batched and lazy**, with a total surface deadline and bounded
   partial-failure semantics, so N extensions do not produce an N-request
   waterfall or measurable jank.
7. `window.JellyfinCanopy` stays compatible. It gains an explicit **platform API
   version field** — it currently has none — and platform APIs are versioned
   separately from the plugin version.

### Deferred — not in v1

**Interactive untrusted content in an opaque-origin iframe with a
capability-filtered `postMessage` broker.** Decision 2 forbids extensions from
supplying markup, CSS, selectors or script, and
[`v1-capability-freeze.md`](../v1-capability-freeze.md#c7--declarative-web-slots)
repeats that as a v1 non-goal — so in v1 there is nothing to put *in* such a
frame. The mechanism is written down here because a later version may need it and
because the security requirements should not be re-derived from scratch: the
frame would be opaque-origin, would never receive the Jellyfin token, and every
message would pass a capability filter.

Nothing in v1 may depend on it, and no milestone may treat the sandboxed-frame
path as available.

## Rationale

- A declarative slot schema is the only design where "what can an extension do to
  the page?" has a bounded, enumerable answer. Every step toward generality
  reintroduces the milestone-82 problem.
- Reusing the existing adapter is not merely convenient: the repository's
  performance rules are machine-enforced, and a parallel injection path would
  have to re-earn every one of them.
- The facade is currently frozen only by a compile-time type assertion, with no
  runtime immutability and no version field. Publishing it as a platform surface
  without a version is how a contract becomes unversionable forever.

## What is verified, and what is not

**Verified in a real browser** against the repository's own dockerized Jellyfin 12
([S17](../spike-evidence.md#s17--browser-slots-render-idempotently-the-frame-is-genuinely-isolated-and-there-is-no-csp)):
a v1-shaped descriptor renders through `ensureInjected`; mounting three times
produces **one** node; `handle.remove()` leaves **zero**; a deliberately hostile
label (`Request <img src=x onerror=alert(1)>`) renders as **text** with zero child
elements and no script execution; and two vendors' contributions coexist without
collision. Decisions 1–6 rest on measurement, not on reading the source.

Two findings changed how the rest of this ADR is written.

**Jellyfin 12 serves no `Content-Security-Policy` at all.** There is no policy to
design a broker within, and equally none that would contain a misbehaving
contribution. This *raises* the value of the deferred opaque-origin frame — it is
the only isolation primitive the browser actually offers here — while leaving it
out of v1, because v1 has no untrusted content to put in it.

**The frame works, and its isolation is mutual.** An `<iframe sandbox="allow-scripts">`
without `allow-same-origin` gets origin `"null"` and cannot read the host DOM,
`localStorage`, or `ApiClient.accessToken()`; the host equally cannot read into it.
That mutual denial is what makes `postMessage` the only channel and therefore a
place a capability filter can sit. **`event.origin` is `"null"` for every opaque
frame, so origin is useless for attribution** — a broker must key on `event.source`
identity against the frame elements it created. That constraint is now recorded
rather than discovered later.

**Still unverified:** rendering across modern mobile and Web-TV modes, and
behaviour under the accessibility, localisation and jank budgets. Those are EP-07's
real cost and remain the content of risk R-04.

**An implementation contract, learned the hard way.** `buildFn` must **attach the
node itself and return it**; the injector only stamps `data-jc-key`. Returning a
detached element renders nothing, silently — the first version of this spike did
exactly that and measured zero nodes.

## Consequences

- Some legitimate extension ideas will not fit v1 slots. That is the cost of a
  bounded surface; the answer is to extend the slot vocabulary deliberately in a
  later version, not to add an escape hatch.
- The web adapter becomes a first-class, separately versioned component. The
  facade it publishes needs a real version field: at runtime `window.JellyfinCanopy`
  is an ordinary mutable object with **no version** and **no freeze** — page script
  replaced `JC.escapeHtml` and the replacement took effect.
- Two extensions must coexist without selector, CSS, id, listener, observer,
  route or lifecycle collisions — an explicit EP-07 acceptance criterion.

## Rejected alternatives

- **Arbitrary same-origin JavaScript.** Rejected; see
  [milestone-82 disposition](../milestone-82-disposition.md).
- **Remote module URLs / dynamic `import()` of extension code.** Rejected: remote
  code distribution is a program non-goal, and Canopy's own bundle loader is
  content-addressed against a validated manifest precisely to avoid this.
- **Extension-provided CSS or selectors.** Rejected: guarantees breakage on every
  Jellyfin web change and defeats CSS isolation. Canopy already has a
  build-failing CSS-injection guard for exactly this class of problem.
- **A general component tree in JSON.** Rejected: it is a browser renderer with
  extra steps, and it cannot be rendered natively by a TV client
  ([ADR-0009](0009-packaging-and-kernel-placement.md) keeps web and native
  schemas deliberately close).
