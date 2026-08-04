# ADR-0013 — Post-pilot server-platform tranche

Status: **accepted** (2026-08-04) · Owner: programme · Extends
[ADR-0012](0012-native-first-scope.md) without replacing the completed
native-first pilot

Tracking issue: [#637](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/637)

## Context

ADR-0012 chose the smallest path to a real consumer: EP-01 plus the bounded
first-party parts of EP-02, EP-06 and EP-08. That decision was correct for the
starting conditions. There were no external extension authors, and building a
registry, provider runtime, state service, event service and public SDK before
one client used the protocol would have maximised risk **R-01**.

The pilot has now changed the decision boundary:

- Platform v1 has a live Jellyfin 12 host boundary, checked-in OpenAPI and
  schemas, an additive-only compatibility gate and a complete conformance pack.
- The first-party actor, action-authority, replay, access-check, bounds and
  redacted-audit foundations are implemented rather than hypothetical.
- The owner has explicitly directed Project 3 to continue on the Canopy server.
  Native-client implementation is a separate workstream and is not a dependency
  of this tranche.
- The EP-00 separate-plugin and headless fixtures already prove the two
  boundaries the next tranche must turn into supported server contracts: a
  load-context-safe JSON ABI and a consumer that knows nothing about Canopy
  internals.

Continuing directly from an EP-02 implementation issue would still be wrong.
ADR-0012 deliberately froze C2 through C5, so widening the production surface
requires an EP-00-level decision with named consumers, authority rules, failure
semantics and an explicit stopping point.

## Decision

Activate the **internal server-platform tranche** previously considered as
Option B in ADR-0012. The active dependency chain is:

```text
EP-02 remainder -> EP-03 -> { EP-04, EP-05 implementation }
EP-04 health contract -> EP-05 C5 exit
{ EP-04, EP-05 exits } -> EP-06 remainder
```

This activates the following capability families, additively within Platform
v1:

- **C2:** extension registry, manifest-bound approval, requested-versus-granted
  capabilities and lifecycle state;
- **C3:** bounded server-plugin provider invocation over the JSON ABI;
- **C4:** extension-global and extension-per-user namespaced state;
- **C5 subset:** registry and provider lifecycle, health and contribution
  invalidation events with bounded reconnect/resync behavior;
- **C10:** redacted registry and provider diagnostics needed to operate C2 and
  C3.

The first implementation remains smaller than those capabilities. EP-02 starts
with immutable actor-kind and namespaced capability domain contracts. It adds no
route, credential, grant, manifest or persistence by itself. Each later slice
must have its own bounded issue and contract-first evidence.

## Named consumers and proof chain

The tranche does not pretend that external adoption already exists. It instead
requires a vertical proof chain before any capability is called delivered:

| Capability | First consumer | Required proof before delivery |
|---|---|---|
| C2 registry | the Canopy grant/registry owner and the EP-00 separate-plugin fixture | manifest identity, approval, fingerprint drift, revoke and lifecycle matrix |
| C3 provider runtime | the independently packaged EP-00 provider fixture | load-order reversal, absence, failure, timeout, bounds, disable, uninstall and upgrade |
| C4 state | the reference provider fixture through the registry-owned namespace | cross-extension/user isolation, quotas, optimistic concurrency, crash/corruption recovery and delete/export |
| C5 subset | registry/provider lifecycle, health and invalidation plus a credential-bound Z3b headless companion-service fixture | service authentication, exact bounded provider-id grant, minimal non-C10 schema, reconnect cursor, bounded retention, event gap, generation-fenced revoke and `resync-required`; no user/media events |
| C10 diagnostics | the administrator operating the registry/provider runtime | admin-only access, bounded records and token/payload/error redaction |

These fixtures are conformance consumers, not evidence of public ecosystem
adoption. Public SDK, beta and GA claims remain deferred until independent
external authors exist and EP-09 through EP-11 are deliberately activated.

## Authority and security invariants

1. Acting user and administrator status come only from Jellyfin authentication
   and current host lookup. Caller-shaped user, device, extension or manifest
   data is never authority.
2. Before adding a new actor kind, authority-relevant Jellyfin user resolution
   converges on one authenticated, claims-only, fail-closed owner
   ([#638](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/638)).
   The user-actor factory does not accept that parser's GUID, a
   `ClaimsPrincipal` or any caller-shaped value. It accepts only an unforgeable
   internal boundary result produced after authentication, explicit API-key
   rejection, unique canonical user claim, live host-user lookup and current
   elevation. Invocation and every protected data release re-read current host
   access/elevation.
   Actor kinds are then closed and non-interchangeable: user client, installed
   server provider and external companion service. Only kernel-owned factories
   construct them. Administrator authority is not a fourth interchangeable
   identity: it is the current elevation property of the same request-scoped
   Jellyfin user actor. An elevated user remains eligible for ordinary user
   operations and additionally qualifies for elevated-user operations. A
   provider comes only from an
   approved registry record bound to the installed plugin GUID and manifest
   fingerprint.
3. Capability identifiers are exact, case-sensitive, namespaced and bounded.
   Wildcards, prefix inheritance and caller registration are forbidden. The
   effective set is the bounded intersection of requested, granted and current
   actor authority; a grant never promotes the actor.
4. A plugin manifest requests capabilities; it never grants them. Provider
   grants are admin decisions bound to the exact installed-plugin identity,
   manifest fingerprint and requested set. A companion service has no plugin
   manifest: its grant is instead bound to a kernel-owned service registration,
   credential generation and exact requested set. These grant subjects are
   different domain types and cannot be exchanged.
5. A companion service principal has no acting Jellyfin user and can never
   select or impersonate one. Its independently revocable, expiring and
   rotatable credential authenticates only a kernel-owned service id, is stored
   only as a bounded hash, is returned raw once and is never logged. Existing
   anonymous, user and elevated operations reject service principals. A service
   may call only a future operation explicitly marked service-capable in the
   authored contract. Its effective authority is the intersection of current
   credential generation, service registration, admin grant, exact capability
   and operation actor-kind ceiling. User delegation and administrator
   authority for services are outside this tranche. Jellyfin administrator API
   keys are never reused.
6. Extension grants are ceilings. Every user-facing operation is re-authorized
   against the current Jellyfin principal, user, item, library and parental
   policy at invocation time.
7. An installed provider is registry-bound in-process identity, not a service
   credential actor. Only the kernel invokes it, with a derived allow-listed
   context. Authority generations are typed and never shared or
   interchangeable: provider generation advances on registry disable/revoke,
   fingerprint drift, upgrade or uninstall; service generation advances on
   credential issue/rotation/expiry/revoke, registration lifecycle or grant
   change. A change rejects new admission immediately and requests cooperative
   cancellation. The kernel rechecks the applicable typed generation, grant,
   lifecycle and every applicable current user, item, library, parental-access
   and elevation dimension immediately before accepting a provider result and
   before every authority-protected commit **or data release**. Data
   release includes state reads, stale-ETag current-state responses, resync
   snapshots, exports, diagnostics, event/response stream chunks, catalog
   publication and action results. Stale work/results are discarded; buffered
   data is destroyed; an in-progress stream terminates without another protected
   chunk. Check and release are one serialized, bounded linearization step: each
   bounded chunk/response obtains a short kernel-owned release lease under the
   typed generation, with a strict byte/deadline cap; generation advance waits
   only for those bounded leases and prevents any new old-generation lease. Once
   a kernel-owned generation advance/revoke transaction returns, no
   old-generation protected release may begin or complete. Jellyfin host policy
   changes occur outside this lock; the kernel repeats live host checks as the
   final step for every bounded release and stops at the first observed change,
   but does not claim a transaction boundary Jellyfin does not expose. The
   late/revoked outcome is safely audited. A provider may already have started
   an irreversible provider-owned or external effect before cancellation or
   revoke arrives; the kernel cannot stop or roll it back and audits the
   late/revoked outcome. Provider code may continue in Z0 after its result is
   discarded and cannot be contained. Jellyfin may retain loaded code until
   restart; no document may claim otherwise.
8. Provider calls are bounded by request/response size, depth, deadline,
   concurrency and circuit state. A deadline protects the caller, not the
   server, and a malicious installed plugin remains outside containment.
9. Ordinary user and provider state/event paths derive extension and, where
   applicable, user namespace from kernel-owned actors. Service actors do not
   access C4 state in this tranche. A service event grant is bound to an explicit
   bounded set of registry-owned provider ids; enqueue, snapshot and delivery
   filter to that set. Its minimal lifecycle/health/invalidation schema excludes
   C10 inventory, manifest, attribution, circuit/error detail and every user/media
   field. Only a separate elevated
   administrator management operation may name a target extension/user namespace
   as the audited object of bounded export or delete; that target is never the
   acting identity, cannot be used for ordinary reads/writes, and cross-user
   response data is isolated.
10. Diagnostics contain stable codes, correlation and bounded metadata only;
   never tokens, service secrets, upstream keys, provider payloads or raw
   exceptions.

## Failure, lifecycle and compatibility gates

- Missing, incompatible, disabled, unhealthy, revoked, expired, upgraded and
  restart-pending actors fail independently with a documented machine outcome.
- Registry/provider work never becomes a synchronous startup dependency.
- Every listing is bounded and paged; every cache, queue, circuit, retention
  buffer and concurrency pool has an explicit owner and limit.
- Platform v1 remains additive-only. Existing first-party pilot routes and
  actors neither gain third-party authority nor change shape.
- Service authentication is a separate Platform boundary. It never passes a
  service credential into Jellyfin authentication, synthesizes a Jellyfin user,
  or makes a service principal eligible for an existing user/elevated route.
- Before the first non-user route, authored OpenAPI and frozen conformance
  metadata add an exact `x-canopy-actor-kinds` per-operation allowlist and
  extend `x-canopy-authority` with `service` only for an additive service route.
  Existing operations retain their current authority and gain matching
  anonymous/user actor metadata without widened eligibility. Every new actor kind and
  service-capable operation is an additive reviewed contract change with a live
  rejection matrix for every other actor kind.
- Conformance includes API-key, deleted-user and stale-elevation actor
  construction rejection, plus revoke-during-read, stale-ETag conflict,
  snapshot, export, diagnostics and streamed-chunk cases. The matrix changes
  user deletion/elevation, item access, library membership, parental policy,
  service grant and provider lifecycle during release. It proves that after a
  kernel-owned generation change commits no old-generation protected release
  begins or completes, and that each host-policy change observed by the final
  live check prevents that release.
- Experimental provider/state/event routes remain absent until their OpenAPI,
  schemas, frozen inventory, conformance fixture and rollback behavior land in
  the same reviewed slice.

## What remains deferred

- EP-07 declarative web contributions and browser-layout breadth;
- Jellyfin library, user-data, playback and settings event families, including
  Active Streams; the active C5 subset is registry/provider lifecycle, health
  and invalidation only;
- the broader C8 native descriptor language and additional native clients;
- EP-09 public SDKs, scaffolding and public conformance distribution;
- EP-10 independent external adoption;
- EP-11 beta, certification and GA;
- EP-12 default adoption policy;
- marketplaces, automatic installation, remote code distribution, arbitrary
  same-origin script, a generic proxy and malicious-plugin sandboxing.

Activating any of those requires another explicit programme decision with its
own named consumer and evidence. This ADR does not authorize Android work,
deployment or release.

## Consequences

- ADR-0012 remains the record of why the native-first pilot was the correct
  starting scope. Its statement that C2 through C5 were deferred is historical
  after this decision; this ADR controls the post-pilot active tranche.
- Project order returns to the server-side prefix of the original roadmap. EP-04
  and EP-05 implementation may proceed in parallel only after EP-03 and the
  required EP-02 authority foundations are complete. EP-05 cannot pass its
  provider-health event exit proof until EP-04 owns the authoritative health and
  circuit contract/runtime.
- **R-01 remains High.** Internal fixtures prove correctness and usefulness of
  the boundary, not third-party demand. The tranche stops before web, SDK and GA
  costs that require external adoption.
- **R-03 and R-05 remain High.** Work stays one bounded child and one owning
  layer at a time; no milestone closes from partial pilot evidence.
- The completed first-party pilot stays a compatibility consumer throughout the
  tranche, but no client-repository change is part of this decision.
- ADR-0013 accepts the server-tranche decisions in ADR-0003, ADR-0004, ADR-0005,
  ADR-0006, ADR-0008 and ADR-0011 as binding architecture. Their production
  behavior remains unimplemented until each owning milestone passes its exit
  gate. ADR-0007 remains deferred. Completed EP-00/EP-01 evidence already makes
  ADR-0001, ADR-0002, ADR-0009 and ADR-0010 binding.

## First bounded follow-up

EP-02 first closes the already-live resolver divergence through
[#638](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/638),
without activating any deferred surface. Issue
[#640](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/640)
then defines the immutable actor-kind domain and construction boundaries. The first capability-domain
slice is [#639](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/639):
versioned exact capability identifiers and a pure grant-ceiling evaluator; it
depends on #640 for the actor-authority input. Routes, grant persistence,
credentials, manifests and provider calls are explicitly later children.
Issue [#645](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/645)
froze the strict installed-provider manifest v1 contract and deterministic
semantic content fingerprint; #647 added descriptor-safe host binding; #650 added
the authoritative persisted lifecycle registry; and #652 composes those owners
behind one lazy post-start, epoch-fenced, single-flight worker with independent
test-only provider packages. Every public/admin route and provider invocation
remains a later slice. Issue #654 is the first EP-04 child: it freezes the
load-context-safe provider ABI, operation declarations and bounded envelopes,
content-addressed embedded payload schemas, and turns Alpha into the independent
Hello contract fixture without adding a
production reflection binder or invocation path.
