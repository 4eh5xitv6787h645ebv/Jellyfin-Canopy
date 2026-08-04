# ADR-0012 — Native-first scope for v1

Status: **accepted** (2026-07-28); completed starting-scope decision. The
post-pilot server tranche is activated separately by
[ADR-0013](0013-server-platform-tranche.md). Pilot clarification tracked by
[#583](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/583) ·
Owner: programme · Supersedes the implicit assumption in
[`v1-capability-freeze.md`](../v1-capability-freeze.md) that all twelve
milestones would run

## Context

EP-00 finished with the programme scoped as written: EP-01 through EP-12, with
GA-grade acceptance criteria — schema fuzzing, multi-hour soak, a private beta
with external provider and client authors, SDKs in C#, TypeScript and Kotlin, a
conformance kit, and a native TV reference adapter.

Two facts made that scope worth re-examining before EP-01 fixed anything
expensive.

**There are no external consumers.** Not "few" — none. Every acceptance criterion
that assumes an ecosystem (private beta, three-language SDKs, conformance kit,
independent pilots) is work whose value is contingent on developers who have not
asked for it. That is risk **R-01**, scored High/High, and it does not improve by
building more platform.

**There is exactly one committed consumer, and it is native.** A first-party
Kotlin fork of `jellyfin-androidtv` is in development by the same owner. That
changed **R-02** from High to Medium — but it also concentrated the entire
adoption case on one client class.

Four options were considered: the full programme (A), an internal platform v0
covering EP-01→EP-06 (B), native-first covering EP-01/02/06/08 (C), and
extracting the reusable primitives with no kernel at all (D).

## Decision

**Option C.** Build **EP-01, EP-02, EP-06 and EP-08**. Defer EP-03's full
registry, EP-04's provider SDK, EP-05's state and event platform, EP-07's web
contributions, and all of EP-09 through EP-12.

The first-party pilot has exactly three named product families: **Spoiler
Guard, Hidden Content and Seerr**. Hidden Content takes the previously unclaimed
bookmarks/selected-user-data slot; it does not create a fourth slot or widen the
three-family budget.

The active work inside EP-02, EP-06 and EP-08 is correspondingly narrower than
the original roadmap-parent checklists:

- **EP-02 pilot:** authoritative first-party client actors, opaque-action
  authority and replay controls, invocation-time Jellyfin access checks, bounds,
  redacted audit and immediate invalidation of first-party catalogs/actions.
  Third-party grants, manifest approvals, service credentials, provider actors
  and event-subscription revocation remain deferred with EP-03 through EP-05.
- **EP-06 pilot:** authenticated negotiation, filtered catalogs, native surface
  resolution and opaque actions over the three named Canopy owning services.
  The gateway has no dependency on EP-03, EP-04 or EP-05 and needs no server
  plugin or browser consumer to prove this first-party pilot.
- **EP-08 pilot:** the first-party Android TV fork and the independent headless
  fixture negotiate and exercise the bounded native-safe item-detail
  action/status, confirmation and form subset. Catalog revision/ETag, action
  results, bounded refresh hints and refetch provide invalidation. They are not
  an event transport and do not satisfy C5.

These are **native-first pilot gates**, not declarations that every unchecked
criterion on parent issues
[#41](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/41),
[#46](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/46) or
[#47](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/47) is
complete. A parent stays open unless its live exit gate is formally re-scoped or
all of its original criteria have evidence.

## Rationale

**The platform's marginal value is highest where Canopy cannot reach at all.**
For the web, Canopy already injects directly and owns the whole surface; a
platform there mostly buys the ability for *third parties* to contribute UI, and
there are none. For native, the value is different in kind — it is the only way
any Canopy capability reaches Android TV.

**It defers the most expensive and least proven work.** EP-07 is the bulk of the
remaining cost, and the browser spike verified the mechanism on the **modern
layout only**; modern mobile, Web-TV, accessibility, localisation and jank
budgets are all untested. EP-08's protocol, by contrast, is already exercised end
to end by the headless fixture
([S18](../spike-evidence.md#s18--a-headless-native-client-can-drive-the-protocol-and-every-refusal-is-distinct)):
negotiation, graceful omission, paginated rows, confirmed actions and six distinct
refusal codes.

**The server-side-effect class already works on native, today.** A Spoiler Guard
toggle added to the Android TV fork flips server state and the client sees blurred
thumbnails and replaced episode titles with **no rendering code at all**
([jellyfin-androidtv#1](https://github.com/4eh5xitv6787h645ebv/jellyfin-androidtv/pull/1)).
That is a hardcoded route rather than a platform capability, which is precisely
what EP-06 turns it into — so the first capability family has a working precedent
and a real consumer on day one.

**Nothing is foreclosed.** Contracts stay versioned either way, and ADR-0010's
additive-only rule means option A or B remains reachable by continuing rather than
by rewriting. C is a subset of B, which is a prefix of A.

## What this gives up, stated plainly

Third-party extensibility, C5 event streaming, a public SDK, and the conformance
kit. An external developer cannot build against this scope — that is the point,
not an oversight. The contracts are **internal-facing but versioned**, so going
public later is additive work rather than a redesign.

## Consequences

- The `v1` in `/JellyfinCanopy/Platform/v1` is a real version with a real
  compatibility policy, but its only consumers are first-party. A `v2` therefore
  costs nothing externally, which materially lowers **R-09**.
- EP-06 must extract capability families to owning services anyway, so the
  no-duplication rule (**R-08**) still applies in full.
- Hidden Content replaces the unclaimed selected-user-data/bookmarks reference
  candidate. The product-family count remains three; adding another family
  still requires a new EP-00-level decision.
- C5 remains deferred. Native invalidation in the pilot is cache-aware refetch,
  not an event stream, reconnect buffer or `resync-required` implementation.
- **A new risk: single-consumer bias.** With one adopter the protocol may end up
  shaped around one client's needs and prove awkward for the next. Mitigation: the
  headless fixture from EP-00.3 stays green alongside the real client, so every
  contract has at least one consumer that cannot quietly depend on Android TV
  behaviour.
- Deferred milestones stay open on the board but are marked deferred, so the
  roadmap does not read as eleven items in progress.

## Rejected alternatives

- **Option A, the full programme.** Nothing in EP-00 showed it cannot be built.
  Rejected because its acceptance criteria assume an ecosystem that no evidence
  says wants to exist, and because 12–24 months part-time competes directly with
  the bug inventory (**R-05**).
- **Option B, internal platform v0 (EP-01→EP-06).** A reasonable answer and a
  superset of C. Rejected as the *starting* scope because it still builds the
  provider runtime and state/event platform before anything consumes them; C
  reaches a working native consumer sooner and B remains reachable by continuing.
- **Option D, extract the primitives and skip the kernel.** Taken more seriously
  than its size suggests — `ArrUrlGuard`, `BoundedTtlCache`, `UserAccessQuery` and
  `AtomicFile` are nearly reuse-ready, so a fortnight would deliver most of the
  practical reuse. Rejected because it cannot deliver anything a *client*
  consumes — no descriptors or actions — and so is not a path to the Android TV
  work at all.
