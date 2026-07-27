# Frozen v1 capability list

Tracking issue: [#39 — EP-00](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/39)
Status: **proposed** (EP-00). "Frozen" means *the list does not grow without a new
EP-00-level decision* — not that it is implemented. Nothing here exists yet.

Adding to this list requires named consumers, a security and authority analysis,
failure and lifecycle behaviour, a compatibility policy and a bounded tracking
child. Removing from it is cheap and encouraged.

---

## C1 — Discovery and negotiation

| | |
|---|---|
| **Anonymous** | platform availability and supported protocol range. Nothing else — no users, no installed extensions, no topology, no configuration. |
| **Authenticated** | negotiated protocol version, feature flags, and a catalog filtered to the caller's grants and Jellyfin access. |
| Client declares | supported protocol range, surface schemas, component set, input modes, layout constraints, locale, accessibility, image support. |
| ADR | [0002](adr/0002-protocol-and-version-negotiation.md) |

## C2 — Extension registry and lifecycle

Manifest discovery bound to real installed-plugin identity; admin approval;
requested-versus-granted scopes; the lifecycle states in
[compatibility-terminology](compatibility-terminology.md#state-words); a
user-filtered catalog and admin diagnostics.

Not in v1: hot discovery without restart, remote installation, publisher trust.
ADR [0005](adr/0005-manifest-discovery.md).

## C3 — Server-plugin provider invocation

A convention-based entrypoint invoked over the JSON ABI with a derived context,
a kernel-owned deadline, concurrency caps, bulkheads, circuit breakers, a
response size cap, and stable failure codes.

Not in v1: provider-to-provider calls, provider access to Jellyfin DI, the
database or the filesystem, streaming provider responses.
ADRs [0003](adr/0003-json-abi.md), [0004](adr/0004-provider-invocation.md).

## C4 — Namespaced state

Extension-global and extension-per-user JSON documents, schema-versioned,
bounded on every axis, with ETag/`If-Match` concurrency, atomic batch writes,
crash-safe persistence, corruption quarantine, transactional migrations, and
export/delete for a user and for an extension.

Not in v1: blobs, media, a general database, cross-extension state, or a
returnable secret. ADR [0008](adr/0008-storage-ownership.md).

## C5 — Events

A curated, versioned catalog covering platform registry, health and contribution
invalidation, plus approved Jellyfin/Canopy library, user-data, playback and
settings changes. Authenticated `fetch()` stream plus bounded long-poll, with
event ids, per-stream cursors, heartbeats, reconnect, bounded retention and
`resync-required`.

Not in v1: webhooks, arbitrary outbound HTTP, exactly-once delivery, infinite
retention, custom Jellyfin WebSocket message types.
ADR [0006](adr/0006-client-event-transport.md).

## C6 — Opaque actions

Short-lived, replay-protected action capabilities binding extension, operation,
user, device, catalog revision, scopes and expiry — re-authorized at invocation.
Idempotency keys, cancellation, progress and an operation-status resource for
longer actions.

Not in v1: a client naming a provider method; a client supplying an arbitrary URL.
ADR [0011](adr/0011-identity-and-authority.md).

## C7 — Declarative web slots

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
a general component tree. ADR [0007](adr/0007-declarative-web-contributions.md) —
**provisional, unverified**.

## C8 — Native-safe descriptor schema

A strict subset of C7 that a native client can render with its own components:
navigation, rows/cards, badges, item-detail actions and information, player
actions/markers, forms/dialogs, notifications, paging, loading/empty/error
states, deep links. Item references only; semantic icons only; bounded text,
sizes, nesting and page counts.

Not in v1: anything requiring the client to execute downloaded content.
ADR [0007](adr/0007-declarative-web-contributions.md), plus the
[client matrix](supported-client-matrix.md).

## C9 — Reference capability families

Three, chosen because each exercises a different axis and each already has an
owning Canopy service. Exposed through that owner — never reimplemented.

| Family | Axis | Candidate |
|---|---|---|
| Per-user data workflow | state + per-user isolation | bookmarks / selected user state |
| Integration action workflow | opaque action + upstream | a Seerr request action on item detail |
| Admin live workflow | events + elevated authorization | Active Streams status and actions |

A fourth candidate, the Discovery home row, is a stretch goal for EP-10 rather
than a v1 commitment.

## C10 — Diagnostics and audit

Local, redacted diagnostics: registry state, health, circuit state, recent
failures with correlation ids, and a redacted diagnostic bundle. Audit records
carry extension, operation, actor attribution, decision, result, duration and
correlation id.

Never: payloads, tokens, upstream keys, or any telemetry leaving the server.

---

## Explicitly not in v1

Arbitrary same-origin JavaScript · a shared runtime contracts DLL · a marketplace
or remote installation · sandboxing malicious .NET code · a generic upstream
proxy · provider-to-provider calls · cross-extension state · blob or media
storage · webhooks · custom Jellyfin WebSocket message types · modifying official
Jellyfin clients · Jellyfin 13 support · telemetry.

## Dependency order

```
EP-00 ─▶ EP-01 ─▶ EP-02 ─▶ EP-03 ─┬─▶ EP-04 ─┐
                                  └─▶ EP-05 ─┴─▶ EP-06 ─┬─▶ EP-07 ─┐
                                                        └─▶ EP-08 ─┴─▶ EP-09 ─▶ EP-10 ─▶ EP-11 ─▶ EP-12
```

| Capability | Delivered by |
|---|---|
| C1 | EP-01, EP-06 |
| C2 | EP-03 |
| C3 | EP-04 |
| C4 | EP-05 |
| C5 | EP-05 |
| C6 | EP-02, EP-06 |
| C7 | EP-07 |
| C8 | EP-08 |
| C9 | EP-06, EP-10 |
| C10 | EP-03, EP-11 |
