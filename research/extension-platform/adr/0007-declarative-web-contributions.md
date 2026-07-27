# ADR-0007 — Declarative web contributions

Status: **provisional** (EP-00) — see *Open question* below · Owner: web adapter

## Context

Canopy's browser layer is substantial and hard-won: a route/navigation owner that
patches history exactly once, a single multiplexed body `MutationObserver` (a
performance rule forbids feature-owned observers), an idempotent
`ensureInjected(key, anchor, build)` primitive, a three-layer teardown model, a
feature loader with import purity, dependency ordering, retry backoff and scope
staleness, and a layout owner that abstracts modern versus legacy Jellyfin.

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
7. **Interactive untrusted content, if it ships at all, uses an opaque-origin
   iframe and a capability-filtered `postMessage` broker.** The frame is never
   handed the Jellyfin token.
8. `window.JellyfinCanopy` stays compatible. It gains an explicit **platform API
   version field** — it currently has none — and platform APIs are versioned
   separately from the plugin version.

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

## Open question — why this ADR is *provisional*

**No browser spike ran.** Playwright is not provisioned in this environment, so
the opaque-origin iframe, the `postMessage` broker, CSP behaviour, and slot
rendering across the modern/legacy/mobile/Web-TV layouts are all **unverified**.
Decisions 1–6 rest on the existing codebase, which is solid evidence; decision 7
rests on nothing yet.

This ADR is therefore *provisional* and is promoted to *proposed* only when the
EP-00 child issue covering the web sandbox and `postMessage` proof closes. Until
then, no later milestone may treat the sandboxed-frame path as available.

## Consequences

- Some legitimate extension ideas will not fit v1 slots. That is the cost of a
  bounded surface; the answer is to extend the slot vocabulary deliberately in a
  later version, not to add an escape hatch.
- The web adapter becomes a first-class, separately versioned component.
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
