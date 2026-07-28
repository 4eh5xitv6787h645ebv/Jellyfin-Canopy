# ADR-0010 — Deprecation and support policy

Status: **proposed** (EP-00) · Owner: platform governance

## Context

The moment a third party builds against this platform, changing it has a cost
someone else pays. Canopy has never had to think this way: it owns both sides of
`window.JellyfinCanopy` and of its 183 routes, so "frozen" has been enforceable
by a compile-time type assertion in its own build.

That technique does not survive contact with an external consumer.

## Decision

### Versioning

- The **protocol** is SemVer-major-only in the route (`/Platform/v1`). Additive,
  backward-compatible change happens inside `v1`; anything else is `v2`.
- **Schemas** are versioned independently of the protocol and of each other.
- The **SDK** is locked to the schema version it was generated from.
- An **extension** declares the protocol range it supports; the kernel enforces
  it at registration.

### Support window

- **N / N-1** for protocol majors: when `v2` ships, `v1` remains supported.
- Two incompatible majors **coexist**; `v1` is not mutated to look like `v2`.
- Minimum deprecation window before removal: **one Canopy minor release and 90
  days, whichever is longer**, and never inside a patch release.
- Deprecation is announced in-band (`Deprecation` and `Sunset` response headers),
  in the changelog, and in the compatibility matrix — all three, not one.

### Additive-only rules inside a major

Permitted: new optional request fields, new response fields, new enum members
behind a capability flag, new operations, new slots, new event types, relaxing a
validation bound.

Forbidden: removing or renaming anything, tightening a bound, changing a default,
changing a status code or machine error code, changing the meaning of an existing
field, or making an optional field required.

Enforced by an OpenAPI/JSON-Schema breaking-change gate in CI, not by review.

### Supported host matrix

- Only the Jellyfin 12 patch versions listed in the compatibility matrix are
  supported. Jellyfin 13 is **not** claimed.
- Only the client classes with a passing conformance run are listed as supported
  ([supported-client matrix](../supported-client-matrix.md)).
- `targetAbi` has no ceiling in Jellyfin's own metadata
  ([ADR-0009](0009-packaging-and-kernel-placement.md)), so an untested host
  version is refused by the kernel, not by the host.

### Legacy surfaces

- Existing `/JellyfinCanopy/*` routes and `window.JellyfinCanopy` members remain
  compatible and are **not** deprecated by the platform's arrival.
- They become adapters over the same owning service. Parity tests prove one owner
  serves both. Old and new business logic must never coexist.
- The facade gains an explicit platform API version field — it has none today.

### Security response

A security issue in a published contract may break the additive-only rule, with a
documented advisory, a coordinated timeline, and the change carried into the
compatibility matrix and release notes.

## Rationale

- N/N-1 with coexistence is the only policy that lets a consumer upgrade on its
  own schedule. A single mutable version means every kernel change is a
  potential outage for someone.
- Machine enforcement matters more than the policy text: the repository's
  existing ratchets work because CI fails, not because a reviewer remembers.
- Refusing untested host versions is a deliberate choice to fail closed. The
  alternative — running on an unknown Jellyfin patch and hoping — produces bug
  reports nobody can act on.

## Consequences

- Two protocol majors must be runnable side by side once `v2` exists, including
  in tests.
- Every schema change carries a compatibility classification in its PR.
- The compatibility matrix is a maintained artifact with an owner, not a
  README paragraph.

## Rejected alternatives

- **"We'll version it when someone actually uses it."** Rejected: by then the
  unversioned surface *is* the contract. This is precisely how Canopy arrived at
  183 unversioned routes.
- **Date-based or Canopy-plugin-version-based API versioning.** Rejected: couples
  consumers to Canopy's release cadence, which is the coupling the platform
  exists to remove.
- **Deprecate the legacy surfaces to force adoption.** Rejected: an explicit
  program non-goal, and it would break working installations to make an
  architecture diagram tidier.
- **Support Jellyfin 13 on the assumption it will be compatible.** Rejected: an
  explicit non-goal, and nothing tested it.
