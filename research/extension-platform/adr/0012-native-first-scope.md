# ADR-0012 — Native-first scope for v1

Status: **accepted** (2026-07-28) · Owner: programme · Supersedes the implicit
assumption in [`v1-capability-freeze.md`](../v1-capability-freeze.md) that all
twelve milestones would run

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

## Rationale

**The platform's marginal value is highest where Canopy cannot reach at all.**
For the web, Canopy already injects directly and owns the whole surface; a
platform there mostly buys the ability for *third parties* to contribute UI, and
there are none. For native, the value is different in kind — it is the only way
any Canopy capability reaches Android TV.

**It defers the most expensive and least proven work.** EP-07 is the bulk of the
remaining cost, and the browser spike verified the mechanism on the **modern
layout only**; legacy, mobile, Web-TV, accessibility, localisation and jank
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

Third-party extensibility, a public SDK, and the conformance kit. An external
developer cannot build against this scope — that is the point, not an oversight.
The contracts are **internal-facing but versioned**, so going public later is
additive work rather than a redesign.

## Consequences

- The `v1` in `/JellyfinCanopy/Platform/v1` is a real version with a real
  compatibility policy, but its only consumers are first-party. A `v2` therefore
  costs nothing externally, which materially lowers **R-09**.
- EP-06 must extract capability families to owning services anyway, so the
  no-duplication rule (**R-08**) still applies in full.
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
  consumes — no descriptors, no actions, no events — and so is not a path to the
  Android TV work at all.
