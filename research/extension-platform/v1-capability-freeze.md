# Frozen v1 capability list

Tracking issue: [#39 — EP-00](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/39)
Status: **post-pilot tranche activated 2026-08-04** by
[ADR-0013](adr/0013-server-platform-tranche.md). The completed native-first
starting scope remains recorded in [ADR-0012](adr/0012-native-first-scope.md)
and [#583](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/583).
"Frozen" means *the list does not grow without a new EP-00-level decision* —
not that every listed capability is implemented.

**Completed pilot floor:** C1, C6, the bounded C8 subset, C9 and the
first-party audit subset of C10. **Active server tranche:** C2, C3, C4, the
registry/provider subset of C5 and the registry/provider part of C10. **Still deferred:** C7, the broader C8
surface language, public SDKs, external-adoption claims and GA — see the tables
at the end.

Adding to this list requires named consumers, a security and authority analysis,
failure and lifecycle behaviour, a compatibility policy and a bounded tracking
child. Removing from it is cheap and encouraged.

---

## C1 — Discovery and negotiation

| | |
|---|---|
| **Anonymous** | platform availability and supported protocol range. Nothing else — no users, no installed extensions, no topology, no configuration. |
| **Authenticated** | negotiated protocol version, feature flags, and a catalog filtered to the actor's current Jellyfin access. Extension grants apply only after the C2 milestone has delivered its bound registry and grant owner. |
| Client declares | supported protocol range, surface schemas, component set, input modes, layout constraints, locale, accessibility, image support. |
| ADR | [0002](adr/0002-protocol-and-version-negotiation.md) |

## C2 — Extension registry and lifecycle

Manifest discovery bound to real installed-plugin identity; admin approval;
requested-versus-granted scopes; the lifecycle states in
[compatibility-terminology](compatibility-terminology.md#state-words); a
user-filtered catalog and admin diagnostics.

**Activated for the server tranche; discovery, authority and orchestration foundations delivered by #645, #647, #650 and #652.** The
strict installed-provider manifest v1 envelope and its canonical semantic
fingerprint are frozen. An explicit descriptor-safe sweep can now bind that
declaration to an immutable Jellyfin host GUID/version/assembly observation
without creating authority. The internal #650 registry now owns exact
fingerprint/request approval, provider-ceiling grants, one-use elevated decisions,
generation-fenced lifecycle, dormant restart hydration, strict atomic persistence
and evidence-preserving corruption recovery. #652 composes one lazy
`ApplicationStarted`-gated, single-flight owner whose opaque one-use epochs fence
authority before host/filesystem reads and reject stale completions before
persistence. Its independently built Alpha/Omega packages and deterministic
upgrade, downgrade, assembly, scope, malformed and lifecycle variants remain
test-only and are never loaded or invoked by Canopy. The slice adds no routes,
automatic approval or provider invocation. Runtime health and the EP-03 exit gate
remain undelivered.
Built-in Canopy families continue to need no third-party manifest or grant. Their existing
caller-filtered C1/C6 catalog is not evidence for C2. Delivery requires the
separate-plugin fixtures, orchestration, runtime admission tests and
the EP-03 exit gate. ADR [0005](adr/0005-manifest-discovery.md).

The immutable v1 authority-name floor is authored in this order:

1. `jellyfin.canopy.discovery.read`
2. `jellyfin.canopy.items.lookup`
3. `jellyfin.canopy.user-data.read`
4. `jellyfin.canopy.events.subscribe`
5. `jellyfin.canopy.storage.read`
6. `jellyfin.canopy.ui.contribute`
7. `jellyfin.canopy.integrations.invoke`
8. `jellyfin.canopy.administration.manage`
9. `jellyfin.canopy.diagnostics.read`

These exact, case-sensitive names reserve bounded authority domains; they do
not claim that the corresponding routes or implementations are active. Runtime,
authored Platform v1 and frozen conformance metadata pin their exact actor-kind
and elevation ceilings. A later v1 capability is an additive reviewed change to
all three owners; wildcard, prefix, inherited and caller-registered authority
remain forbidden.

## C3 — Server-plugin provider invocation

A convention-based entrypoint invoked over the JSON ABI with a derived context,
a kernel-owned deadline, concurrency caps, bulkheads, circuit breakers, a
response size cap, and stable failure codes.

**Activated for the server tranche; not yet delivered.** Existing EP-06 pilot
routes continue to call Canopy's in-process owning services and do not silently
become provider routes. C3 delivery requires an independently packaged fixture
and the EP-04 failure/lifecycle/bounds gate. Provider-to-provider calls,
provider access to Jellyfin DI, the database or the filesystem, and streaming
provider responses remain out of scope.
ADRs [0003](adr/0003-json-abi.md), [0004](adr/0004-provider-invocation.md).

## C4 — Namespaced state

Extension-global and extension-per-user JSON documents, schema-versioned,
bounded on every axis, with ETag/`If-Match` concurrency, atomic batch writes,
crash-safe persistence, corruption quarantine, transactional migrations, and
export/delete for a user and for an extension.

**Activated for the server tranche; not yet delivered.** The first consumer is
the reference provider fixture through a registry-owned namespace. Existing
Canopy stores are reusable owners or patterns; they are not implicitly C4.

Not in v1: blobs, media, a general database, cross-extension state, or a
returnable secret. ADR [0008](adr/0008-storage-ownership.md).

## C5 — Events

A full-program catalog would cover platform registry, health and contribution
invalidation plus approved Jellyfin/Canopy library, user-data, playback and
settings changes. The active server tranche is deliberately narrower: **only
registry/provider lifecycle, health and contribution invalidation events**.
Jellyfin library, user-data, playback, settings and Active Streams events remain
deferred. The active subset uses authenticated `fetch()` streaming plus bounded
long-poll, with event ids, per-stream cursors, heartbeats, reconnect, bounded
retention and `resync-required`.

**Activated for the server tranche; not yet delivered.** The native pilot still
refreshes through catalog revision/ETag, action-result refresh hints and
refetch. Those mechanisms do not provide an event stream, reconnect cursor,
retention buffer or `resync-required`, and no pilot evidence may be cited as
satisfying C5. The active C5 subset starts with registry/provider lifecycle,
health and invalidation plus a new credential-bound Z3b headless service fixture
and must pass the EP-05 isolation/retention gate. This is distinct from the S18
Jellyfin-user native-client fixture.

Also out of scope: webhooks, arbitrary outbound HTTP, exactly-once delivery,
infinite retention and custom Jellyfin WebSocket message types.
ADR [0006](adr/0006-client-event-transport.md).

## C6 — Opaque actions

Short-lived, replay-protected action capabilities binding operation,
authenticated user, item/context, catalog revision, allowed inputs, expiry and a
nonce — re-authorized against current Jellyfin access at invocation. A device id
is attribution, never authority. Idempotency keys, cancellation, bounded work
and stable failure codes apply to every pilot mutation.

Extension/grant bindings and provider operations are active server-tranche work
under C2/C3; they must be additive and cannot change existing pilot authority.
Progress and a general operation-status resource remain deferred unless a named
C3 consumer and a separate programme decision establish their need.

Not in the pilot: a client naming a provider method; a client supplying an
arbitrary URL.
ADR [0011](adr/0011-identity-and-authority.md).

## C7 — Declarative web slots

**Deferred full-program design.**

Exactly nine, and no more, in v1:

1. navigation entry
2. home / media row
3. item badge
4. item-detail action
5. item-detail information section
6. player action / marker
7. form / dialog
8. status / notification
9. platform settings surface

Actions permitted from a slot: navigate to a Jellyfin item, play a Jellyfin item,
invoke an approved opaque action, confirm-or-form then invoke, refresh the
contribution, show a localized toast or dialog.

Not in v1: extension-supplied HTML, CSS, selectors or script; remote module URLs;
a general component tree; **the sandboxed iframe and `postMessage` broker**, which
have no content to carry while the preceding line holds. ADR
[0007](adr/0007-declarative-web-contributions.md) — decisions 1–6 proposed but
**unverified in a browser** ([#491](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/491)).

## C8 — Native-safe descriptor schema

A strict subset of C7 that a native client renders with its own components. The
pilot subset is item-detail action/status presentation, confirmation, bounded
flat forms, notifications and loading/empty/error states. It uses Jellyfin item
references, semantic icons, bounded localized text and bounded field/choice
counts.

Navigation, rows/cards, badges, item-detail information sections, player
actions/markers, general paging and deep links remain deferred until a named
consumer requires them. This pilot does not keep a speculative universal native
UI language alive.

Not in v1: anything requiring the client to execute downloaded content.
ADR [0007](adr/0007-declarative-web-contributions.md), plus the
[client matrix](supported-client-matrix.md).

## C9 — Reference capability families

Three, chosen because each exercises a different axis. Each is exposed through
its owning Canopy implementation/service layer — never reimplemented. The
Spoiler Guard, Hidden Content and Seerr owners and their bounded Platform
adapters are delivered by the completed native pilot; later provider work must
compose those owners rather than copy them.

| Family | Axis | Candidate |
|---|---|---|
| Per-title user state | opaque action + per-user isolation | **Spoiler Guard** — delivered through its shared owner and Platform adapter |
| Per-user content workflow | state/filtering + cross-user isolation | **Hidden Content** — replaces the unclaimed bookmarks/selected-user-state candidate; it does not add a fourth family |
| Integration action workflow | opaque action + upstream | a Seerr request action on item detail |

These are the complete native-pilot product-family budget: **Spoiler Guard,
Hidden Content and Seerr**. Active Streams is explicitly outside the activated
C5 subset, alongside library, user-data, playback and settings events.
Bookmarks/selected user state and the Discovery home row remain deferred.

## C10 — Diagnostics and audit

The native pilot includes redacted action audit records carrying operation,
actor/client attribution, decision, result, duration and correlation id. Local
recent-failure diagnostics may expose only the same redacted fields.

Bounded registry state, provider circuit state and third-party extension
attribution are active server-tranche work. Diagnostic bundles remain deferred.

Never: payloads, tokens, upstream keys, or any telemetry leaving the server.

---

## Explicitly not in v1

Arbitrary same-origin JavaScript · a shared runtime contracts DLL · a marketplace
or remote installation · sandboxing malicious .NET code · a generic upstream
proxy · provider-to-provider calls · cross-extension state · blob or media
storage · webhooks · custom Jellyfin WebSocket message types · modifying official
Jellyfin clients · Jellyfin 13 support · telemetry.

## Dependency order — post-pilot server tranche

```
completed pilot: EP-00 ─▶ EP-01 ─▶ EP-02 pilot ─▶ EP-06 pilot ─▶ EP-08 pilot

active server tranche:
EP-02 remainder ─▶ EP-03 ─▶ { EP-04, EP-05 implementation }
                                  EP-04 health contract ─▶ EP-05 C5 exit
                                  { EP-04, EP-05 exits } ─▶ EP-06 remainder

deferred: EP-07, broader EP-08, EP-09, EP-10, EP-11, EP-12
```

The completed EP-06 pilot did not wait on EP-03/04/05: its gateway calls
Canopy's own owning services through the host adapter. The remaining EP-06
third-party work does wait on EP-03/04/05. It adds a provider source; it does not
replace or reshape the first-party source.

### Native-first pilot gates

These gates decide whether the bounded Android TV pilot is evidenced. They do
not rewrite a roadmap parent's live checklist and do not, by themselves, close
that parent.

| Epic | Pilot evidence required | Still deferred from the original parent |
|---|---|---|
| EP-02 | Claims-only first-party actor; invocation-time user/item/library/parental checks; replay/idempotency and request bounds; redacted action audit; cross-user and permission-revocation tests | manifest grants/approvals, service credentials, provider and companion-service actors, registry/event-subscription revocation, global audit administration |
| EP-06 | Negotiation, caller-filtered catalog/surface resolution and opaque actions over the shared owners for Spoiler Guard, Hidden Content and Seerr; legacy/platform parity; Android TV plus independent headless-contract evidence | third-party provider fan-out, server-plugin/browser consumers, provider bulkheads/circuits, event discovery, general admin management and operation-status APIs |
| EP-08 | Android TV and the headless fixture negotiate, safely omit unsupported content, render and invoke the bounded item-detail action/status + confirmation/form subset; D-pad/a11y/lifecycle/offline/security fallbacks pass | home rows and other broad native surfaces, C5 event-gap/resync behavior, public generated SDKs and generic multi-client adoption guides |

Parent issues
[#41](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/41),
[#46](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/46) and
[#47](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/47) remain
open unless their live exit gates are formally re-scoped or every original
criterion has evidence. A pilot gate is never evidence for a deferred row in
the table above.

### Post-pilot server-tranche gates

Activation is not completion. These gates bind each active capability to a
consumer and its owning milestone:

| Capability | Owning exit gate | Required first proof |
|---|---|---|
| C2 | EP-02 authority foundation plus EP-03 registry/lifecycle | exact capability vocabulary, grant ceiling, manifest fingerprint and revoke/lifecycle matrix |
| C3 | EP-04 provider runtime | separate-plugin JSON ABI fixture; load-order, absence, timeout, bounds, failure, disable, uninstall and upgrade |
| C4 | EP-05 state | reference-provider namespace; cross-extension/user isolation, quotas, ETag, crash/corruption recovery and delete/export |
| C5 subset | EP-05 events | registry/provider lifecycle, health and invalidation through the credential-bound Z3b headless service fixture; exact bounded provider-id grant, minimal non-C10 schema, authentication, reconnect, retention, gap, revoke and `resync-required`; no user/media events |
| C10 remainder | EP-02, EP-03, EP-04 and EP-06 owners | admin-only bounded registry/provider diagnostics with token, payload and exception redaction |

No row is a public-support claim. EP-09 through EP-11 remain the owners of
public packaging, independent adoption and GA evidence.

EP-04 and EP-05 implementation may proceed in parallel after EP-03. EP-05
cannot pass its provider-health C5 exit proof until EP-04 owns the authoritative
health/circuit contract and runtime.

### What remains deferred and why

| Deferred | Why it can wait |
|---|---|
| EP-07 declarative web contributions | Canopy already owns the web surface; highest cost, lowest marginal value, layout breadth untested |
| broader EP-08 native surfaces | no named client need beyond the completed item-detail pilot |
| EP-09 SDKs, scaffolding, conformance kit | for external developers who do not exist yet |
| EP-10 independent pilots | requires EP-09 |
| EP-11 certification, beta, GA | requires a public contract, which this scope deliberately avoids |
| EP-12 je12-dev adoption policy | applies to a finished platform |

| Capability | Delivered by | v1 scope |
|---|---|---|
| C1 discovery/negotiation | EP-01, EP-06 | **in** |
| C2 registry + lifecycle | EP-02, EP-03 | **active server tranche; manifest, host binding, authoritative lifecycle registry and lazy single-flight orchestration delivered** |
| C3 provider invocation | EP-04 | **active server tranche; not yet delivered** |
| C4 namespaced state | EP-05 | **active server tranche; not yet delivered** |
| C5 events | EP-05 | **registry/provider lifecycle-health-invalidation subset active; broader Jellyfin/Canopy events deferred** |
| C6 opaque actions | EP-02, EP-06 | **in** |
| C7 declarative web slots | EP-07 | **deferred** |
| C8 native descriptor schema | EP-08 | **in, bounded pilot subset only** |
| C9 reference capability families | EP-06 | **in** — exactly Spoiler Guard, Hidden Content and Seerr |
| C10 diagnostics + audit | EP-02, EP-03, EP-04, EP-06 | **pilot audit delivered; bounded registry/provider diagnostics active** |
