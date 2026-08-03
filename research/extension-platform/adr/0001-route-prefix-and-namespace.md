# ADR-0001 — Route prefix and namespace

Status: **accepted and implemented** (EP-01) · Owner: platform kernel · Supersedes: nothing

## Context

Canopy serves 183 routes under `/JellyfinCanopy`, none of them versioned. The
roadmap issues call the prefix `/JellyfinElevate/Platform/v1`, but that prefix
does not exist — the plugin was rebranded and the live prefix is
`/JellyfinCanopy`. Jellyfin routes plugin controllers automatically with no
prefix convention of its own, so nothing prevents two plugins from colliding.

The existing surface also fails **open**: nine routes are anonymous purely by
having no attribute — and only two of the nine carry a rationale comment. A new
endpoint that forgets `[Authorize]` is anonymous, and nothing catches it.

## Decision

1. Platform v1 lives at **`/JellyfinCanopy/Platform/v1/...`**.
2. Everything already under `/JellyfinCanopy/*` is a **compatibility surface**,
   not a member of Platform v1, and is never promoted implicitly.
3. Extension-owned identifiers are namespaced by a reverse-DNS-ish extension id
   (`vendor.extension`), never by route segment. Extensions do **not** get to
   mount routes; the kernel exposes their operations through its own routes.
4. Every platform controller inherits a base that is **deny-by-default**:
   authorization is asserted in the base, and an endpoint that wants anonymity
   declares `[AllowAnonymous]` explicitly and is covered by an architecture test
   enumerating the permitted anonymous set. A future service operation does not
   bypass that base with `[AllowAnonymous]`: it inherits a separate
   deny-by-default Platform service base bound only to the Canopy service
   authentication scheme. Architecture tests enumerate every service operation,
   forbid mixing Jellyfin and service credentials, and forbid service headers on
   anonymous/user/elevated controllers.
5. The `v1` segment is a **major** version. Incompatible majors coexist as
   `/v1` and `/v2` rather than mutating in place.

## Rationale

- Rebranding evidence: the live prefix and facade are `JellyfinCanopy`
  (`Controllers/ConfigController.cs:45`, `js/plugin.js:14`). Writing v1 against a
  name that does not exist would bake a rename into the first public contract.
- [S12](../spike-evidence.md#s12--reverse-proxy-base-path) confirms plugin routes
  inherit the host base path automatically, so a versioned prefix costs nothing
  under a reverse proxy and no absolute path may be hard-coded.
- Extensions not mounting their own routes is what makes the authorization story
  tractable: there is exactly one place where a platform request is authorized.
- Fail-closed matters because the existing surface fails open. An architecture
  test over the anonymous set is the same technique the repository already uses
  for `AtomicFile` write paths.

## Consequences

- Two prefixes exist for the life of v1. Parity tests must prove a legacy route
  and its platform equivalent call the same owning service — never a copy.
- Extension operations are addressed by opaque, kernel-issued handles rather than
  by provider-chosen method names, which is also what
  [ADR-0004](0004-provider-invocation.md) needs.
- A major bump is a new route family and a migration window, not a silent change.

## Rejected alternatives

- **A top-level `/Platform` prefix.** Rejected: an unnamespaced top-level route
  from a plugin is exactly the collision risk this ADR exists to avoid.
- **Header-based versioning only.** Rejected: it makes two incompatible majors
  indistinguishable in logs, caches and proxies.
- **Letting extensions register their own controllers.** Rejected: it disperses
  authorization across untrusted code and makes revocation unenforceable.
- **Promoting the existing 183 routes to v1.** Rejected: it would freeze four
  error envelopes, three pagination dialects and an open-ended upstream proxy as
  public API.
