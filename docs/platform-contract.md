# Platform v1 contract

Canopy publishes a machine-readable description of its extension surface. If you are
writing a client — a web integration, a native app, another plugin — this is what you
build against.

The artifacts live in [`contracts/platform/v1/`](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/tree/main/contracts/platform/v1):

| File | What it is |
|---|---|
| `openapi.json` | The contract. Routes, parameters, responses and schemas. |
| `frozen.json` | The published v1 surface, so CI can prove changes stay additive. |
| `fixtures/` | Golden request/response examples. |

## The spec is authored, not generated

This matters more than it sounds. A spec generated from the running server documents
whatever the code happens to do — mistakes included — and moves silently whenever the
code moves. A breaking change would rewrite the document that was supposed to catch it.

Here the spec is the source of truth and the server is checked against it, in both
directions:

- a route with no spec entry fails the build
- a spec entry with no route fails the build
- a schema that drifts from the type it describes fails the build
- a fixture that no longer round-trips fails the build

## What is and is not covered

Only routes under `/JellyfinCanopy/Platform/v1` are described.

The older `/JellyfinCanopy/*` routes are **compatibility surfaces**. They keep their
existing shapes, they are not documented here, and they are never promoted into the
platform implicitly. If you are starting something new, use the platform routes.

## Three things worth knowing before you write a client

**`401` and `403` have no body.** Jellyfin returns both with zero bytes, so the contract
documents them without a schema. Do not try to parse an error envelope from them — you
will get an empty string. Business and protocol failures reached after the authenticated
actor boundary carry the one error envelope.

**The acting user is the authenticated Jellyfin user.** For every authenticated
Platform route, Canopy accepts only Jellyfin's `Jellyfin-UserId` authentication claim,
then re-reads that current host user and elevation state for the request. Route, query,
body, cookie, header, marker, IP, client-name and device-id values cannot select or
elevate an actor. Client and device values are bounded attribution only. A missing,
malformed or deleted authenticated user fails closed with a bare `403`; service/API-key
actors remain outside the native-first pilot.

**Branch on `Code`, never on `Message`.** The message is human-readable and may be
reworded or translated at any time. The code set is enumerated in the spec, and each code
maps to exactly one HTTP status. Treat a code you do not recognise as a generic failure of
its status class.

## JSON wire format

Platform v1 pins one JSON format without changing any older `/JellyfinCanopy/*` route:

- requests with a body must use `application/json`; after authentication, any other or
  missing `Content-Type` returns a structured `415` with code `unsupported_media_type`
- unknown request object properties are ignored, so a newer client can send optional
  data to an older host
- an unknown request enum value returns `400 invalid_request`; the safe message names
  the field but never includes serializer internals or the rejected value
- timestamps are RFC 3339 UTC values and always carry an explicit UTC offset
- GUIDs use lowercase canonical `D` form (`aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`)

Response readers must ignore properties they do not recognise. New optional response
properties are additive within v1; rejecting the whole response would turn a compatible
host upgrade into a client failure.

## Versioning

The `v1` in the path is a **major** version. Within it, changes are additive only
(see [ADR-0010](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/blob/main/research/extension-platform/adr/0010-deprecation-and-support-policy.md)):

- new routes, new optional properties, new error codes — allowed
- removing a route, removing a required property, changing a property's type — **not**
  allowed, and CI rejects it

An incompatible change becomes a `v2` route family that coexists with `v1`, so you upgrade
on your own schedule rather than on ours.

The [Platform support and deprecation policy](platform-support-policy.md) defines the
N/N-1 support window, machine-readable registry, and in-band lifecycle headers.

## The handshake

An administrator can turn the native Platform surface off with **Advanced → Native
Platform → Enable Native Platform**. The setting defaults to on, including upgrades
whose saved XML predates the setting. It controls only `/JellyfinCanopy/Platform/v1`;
ordinary Jellyfin routes and Canopy's established web experience continue normally.

While disabled, discovery remains anonymous and returns `200` with `Available: false`,
the same protocol range, a representation-specific `ETag`, and `Cache-Control: no-store`.
Every other Platform route is rejected after Jellyfin's normal actor check and before
request-body acquisition with retryable `503 unavailable`, a correlation ID, and
`Cache-Control: no-store`. Consequently, missing or invalid authentication still gets
Jellyfin's bare `401`/`403` rather than learning a different error shape.

Every configuration save revokes outstanding native prepare handles and action
capabilities before any asynchronous notification work. Re-enabling Platform does not
revive authority issued under an older configuration. Idempotency results and
indeterminate tombstones are deliberately retained, because forgetting one could allow
a client retry to repeat an external mutation whose first outcome was ambiguous.

Two routes, meant to be used as a pair:

1. **`GET /JellyfinCanopy/Platform/v1/discovery`** — anonymous. Tells you whether the
   platform is serving requests and which protocol versions it speaks, and deliberately
   nothing else. Check `Available` before you have any reason to authenticate.
2. **`GET /JellyfinCanopy/Platform/v1/negotiate`** — authenticated. You offer the range
   you support; the host answers with what it will actually use. Its additive
   `SeerrAvailable` hint reports whether the authenticated Jellyfin user currently
   has a usable, non-blocked Seerr link. This replaces a separate user-status probe;
   Seerr operations still repeat their current authorization checks independently.

`negotiate` answers `200` with `Compatible: false` when there is no common version. That
is **not** an error — the negotiation succeeded, it just concluded "no". Render it
differently from "unavailable" and from "denied", because those are three different
problems with three different fixes.

A client that supplies no range is treated as speaking the oldest protocol only, so send
your range explicitly.

## Representation validators

Successful discovery and negotiation responses carry a strong `ETag` in the form
`"sha256-<64 lowercase hex characters>"`. The hash covers the exact Platform JSON bytes
on the wire, not a timestamp, process-local counter, or separately serialized model.
Clients may omit conditional headers; an ordinary request still returns `200` and the
complete body.

These small bootstrap envelopes are served with the `identity` content coding. This is
intentional: host response compression would otherwise create byte-distinct gzip and
identity representations after the validator was computed, making one strong validator
name two different wire representations.

- Send `If-None-Match` to revalidate a cached GET. Entity-tag lists and `*` are accepted,
  and comparison is weak as required for GET revalidation. A match returns `304`, the
  current `ETag`, and zero body bytes.
- Send `If-Match` when the response is valid only for a known representation. Entity-tag
  lists and `*` are accepted, but comparison is strong: `W/` validators never satisfy it.
  A mismatch returns `412 precondition_failed` plus the current `ETag`.
- Malformed conditional headers return `400 invalid_request`. Each of `If-Match` and
  `If-None-Match` is limited to 16 field values, 4,096 combined characters (including
  separators), and 32 parsed entity tags.

For a future mutation, the resource owner must compare `If-Match` with the current
representation and commit the change while holding the same owner lock. The GET result
filter does not make a separate check-then-write sequence atomic.

## Request limits

The platform enforces its own bounds and reports a breach as a structured `413` naming
which one you hit:

| Limit | Value |
|---|---|
| Body size | 1,048,576 bytes |
| Nesting depth | 32 |
| Array elements | 10,000 per array |
| Object keys | 1,000 per object |
| String length | 65,536 bytes |

One gap to be aware of: a request at or above **30,000,000 bytes** is rejected by
Jellyfin itself before Canopy sees it, and surfaces as an opaque `500` rather than a
`413`. The platform covers everything below that; it cannot cover the ceiling.

## Request lifecycle

After a bounded request body has been accepted, Platform v1 gives model binding and
action execution a **30-second** deadline. `HttpContext.RequestAborted` is a linked token
during that interval, so provider calls observe both a caller disconnect and the kernel
deadline through the ordinary cancellation path. Result serialization is outside the
deadline and remains cancelable by the caller; this is what lets a selected timeout
envelope be written after the deadline token has fired.

A deadline returns `504` with code `timeout`. A caller disconnect wins if both signals
race: Canopy attempts no response write and does not log it as a server fault. Cancellation
is cooperative — a provider that ignores its token cannot be killed safely, and Canopy
does not abandon it on a background task. Platform v1 actions must therefore return
bounded, non-streaming results and must not write directly to the response.

## Idempotent mutations

Platform v1 ships one bounded idempotency kernel for all mutations. Each mutation
requires exactly one idempotency key containing 1–128 ASCII letters, digits, `.`, `_`,
`~`, or `-`. The native `/actions/invoke` kernel contract carries `IdempotencyKey` in its
JSON body because Jellyfin SDK Kotlin's authenticated request seam has no per-request
header facility. Its production route binding will reject an `Idempotency-Key` header as
a competing carrier. Other future mutation routes may use the header, but both carriers
use the same transport-neutral parser and kernel semantics.

The process-local store keys an attempt by authenticated acting user, code-owned
operation, and idempotency key. The operation supplies a SHA-256 fingerprint of the
fields that determine mutation semantics:

- the same tuple and fingerprint replays an immutable semantic result in a fresh
  request envelope
- the same tuple with a different fingerprint conflicts
- a canceled or failed leader leaves an indeterminate tombstone, because the provider
  may already have applied the mutation
- canceling a coalesced follower abandons only that wait and never cancels the leader

Future routes map a different fingerprint or an indeterminate prior execution to
`409 conflict` (not automatically retryable). Admission pressure maps to retryable
`429 rate_limited`; it is rejected before mutation execution.

Terminal entries live for 10 minutes. The store admits at most 1,024 entries, 8 MiB of
stored or pre-reserved results, and 64 KiB for one result. It never pressure-evicts live
entries; it rejects new work before execution when a bound would be exceeded. State is
neither persistent nor distributed, so retry guarantees do not cross a process restart
or coordinate multiple server processes.

Coalesced waits are bounded too: at most 64 followers per in-flight key and 1,024 across
the process. Excess followers receive the same pre-execution `429 rate_limited` outcome.

## Native action audit

Every action admitted to the native Platform coordinator creates one internal attempt.
Closing that attempt appends exactly one terminal record for success, denial,
idempotency replay, capability replay or expiry, cancellation, timeout, conflict,
rate limiting, indeterminate execution, or owner failure. Exceptional disposal closes
the attempt as an internal failure. Pre-admission HTTP failures, including a request
rejected before an authoritative actor or operation is established, are outside this
action audit.

The record is a closed allowlist: a typed code-owned operation and family (or the fixed
`unresolved` sentinel), actor user ID and elevated-state bit, decision, result code,
duration, host correlation ID, and start/completion timestamps. Optional client and
device attribution is HMAC-SHA-256 reduced with a process-random key and separate
`client` and `device` domains. Invalid attribution and correlation are discarded rather
than copied. Caller operation text is discarded on failed resolution.

No token, capability, idempotency key, request body, item ID or title, Seerr key or URL,
upstream response, exception, or arbitrary message has a record or logging field. The
corresponding structured log uses only the same fixed, reduced values; its correlation
ID is the same one returned by an ordinary action response. A caller disconnect has no
response to join, but the terminal audit still carries the host correlation ID.

Retention is an in-process fixed ring of exactly 1,024 records. Appends are serialized,
constant-time, and evict the oldest completed record deterministically at capacity.
The ring therefore has constant cardinality independent of users, library size, and
request volume. Audit append or logging failures never replace or retry the selected
action outcome. Only constant-size per-stage failure counters and last-failure metadata
are retained, and the fallback warning is coalesced.

There is deliberately no audit HTTP route or global read surface in Platform v1.
Persistent or distributed retention, admin UI, export, and telemetry integration are
future work and require a separate authority and privacy review.

## Closed native-pilot operation vocabulary

Native actions do not name a controller, route, HTTP method, service or upstream
endpoint. They resolve one of three exact code-owned business operations:

| Operation | Family | Authority | Item kinds | Input schema | Generation |
|---|---|---|---|---|---:|
| `jellyfin.canopy.spoiler-guard.configure-item` | Spoiler Guard | authenticated | Movie, Series | `jellyfin.canopy.spoiler-guard.item-configuration.v1` | 1 |
| `jellyfin.canopy.hidden-content.configure-item` | Hidden Content | authenticated | Movie, Series, Episode | `jellyfin.canopy.hidden-content.item-configuration.v1` | 1 |
| `jellyfin.canopy.seerr.request-item` | Seerr | authenticated | Movie, Series | `jellyfin.canopy.seerr.item-request.v1` | 1 |

Every operation is an exact-item mutation. Its item is resolved through the current
authenticated user's Jellyfin access policy, its bounded input schema is selected by
the server, and its positive generation is bound into prepared actions so a later code
generation can invalidate older authority. Lookup is case-sensitive and fail-closed:
an unknown or caller-invented identifier has no definition and cannot be invoked.

Hidden Content's exact-item operation is owned below both HTTP dialects by one
transport-independent service. It accepts only the authenticated actor projection, a
fresh `FindAccessible` item projection, and validated configuration input. Native
mutations carry the current item-resource revision and fail on a stale precondition;
the legacy full-resource and admin routes retain their existing CAS envelopes outside
the owner. Optional bounded display and episode metadata may enrich the persisted row,
but never supplies authority or replaces the exact accessible item id and closed kind.
Provider-only rows and removal of orphaned, deleted, parental-blocked, or
library-excluded legacy rows remain explicit admin/repair orchestration: they are never
converted into a positive exact-item access decision.

`request-item` means submitting a new item-derived Seerr media request. Existing
request state can be presented as status without another mutation. It must not be
overloaded to approve, decline, cancel or modify a request: those actions bind a Seerr
request identity rather than only the current Jellyfin item, and any future pilot
addition needs its own fixed operation, bounded schema, owning service and authority
review.

### Prepared action capabilities

Preparing one of these operations issues an opaque capability for 60 seconds. The
process-local singleton signs a canonical, length-prefixed binary claim set with a
fresh 256-bit HMAC-SHA-256 authority and the complete 256-bit tag. It binds the exact
operation and server-selected schema, authenticated user, item id and kind, prepared
input SHA-256 digest, operation generation, current authority revision, expiry and a
unique 256-bit nonce. The base64url spelling is canonical and unpadded; its binary
layout is an implementation detail, not a client contract.

Optional device binding is attenuation only. A client cannot name a device: the
server may bind the current actor's bounded device attribution as a domain-separated
keyed digest. The raw device id is never placed in the decodable token. An unbound
capability remains portable between the same user's devices because device attribution
is not authority; a bound capability additionally requires an exact current-device
digest match and can never widen access or change the acting user.

The nonce is reserved when minting, not on first invocation. At most 1,024 unexpired
minted nonces exist process-wide, consumed entries remain until expiry, and capacity
never evicts a live entry. Expired entries are removed deterministically. An authority
or catalog revision change invalidates outstanding claims immediately; a process
restart creates a new HMAC authority and invalidates every earlier capability.

Inspection, current-authority validation and atomic consumption are deliberately
separate operations. The invocation coordinator can authenticate and reauthorize a
capability, return a previously stored identical idempotent result without consuming
again, and consume only when admitting a new owner execution. Concurrent or later
consumption of the same nonce is refused as replay. This primitive has no HTTP route,
controller, provider credential, durable token or long-running operation handle.

### Native action invocation coordinator

This layer is the transport-neutral kernel contract. It deliberately does not register a
controller, coordinator, dispatcher, or feature adapter in dependency injection yet;
the production resolve/prepare/invoke routes and the three feature-owner bindings land
only after their owning services exist. Until that binding lands, the rules below are
enforced and tested as kernel contracts rather than advertised as a callable endpoint.

The native invocation body contains exactly one `Capability`, one body-carried
`IdempotencyKey`, and one `Answers` array. Known fields are case-sensitive and duplicate
known properties are rejected; unknown optional properties remain forward compatible.
There are at most eight answers, each names one bounded field and carries exactly one
boolean or bounded unique option-id array. The platform's ordinary 1 MiB/depth/key/string
bounds still run before this narrower schema.

An authentic capability resolves a server-private prepared context retained in a
process-local, non-evicting 1,024-entry store until the capability's expiry. That context
binds the code-owned operation and schema, exact accessible item, kind, and series
ancestry, operation generation, feature configuration revision, and at most 4 KiB of
owner-private prepared state. Losing it on expiry or restart fails closed; clients cannot
reconstruct it by adding operation, item, provider, or precondition fields to the
invocation body.

Every invocation follows one order: authenticate and inspect the capability; resolve the
prepared context; reload the current user and exact user-scoped item; re-evaluate the
operation and feature authority and project typed input; consult idempotency; acquire the
bounded actor/operation admission lease; repeat the current checks after any queue wait;
atomically consume the capability; then call one fixed first-party owner. The dispatcher
has exactly three named ports (Spoiler Guard, Hidden Content, and Seerr), not a registry.
Owners receive only the reduced actor, accessible-item projection, validated typed input,
idempotency key, and cancellation token.

Only one owner runs for an actor/operation at a time. At most eight waiters are retained
per actor/operation, with 1,024 actor/operation keys and 1,024 waiters process-wide;
excess work fails before capability consumption. Cancellation while queued removes the
waiter. Cancellation or failure before the explicit capability-consumption boundary lets
an identical later request retry leadership, while failure after that boundary retains an
indeterminate tombstone. A bounded admission or current-authority refusal before that
boundary is shared with followers already waiting on the attempt but is not retained for
10-minute replay, so a later retry with the same key and still-unconsumed capability can
succeed after the transient condition clears. If an owner ignores cancellation and
returns a result, that semantic result remains stored for safe retry, while the canceled
request still receives the lifecycle's caller-abort or deadline outcome and audit.

An identical `(actor, operation, key, semantic input)` replays its stored result without
re-consuming the capability. Reusing the key with changed semantic input conflicts, and
using a fresh key with a consumed capability is a replay refusal. Current user, library,
parental, item, feature, schema, generation, and authority checks run before any replay is
released, so stored success never bypasses a later revocation. Unknown operations,
schemas, owners, missing prepared state, and inconsistent revalidation all fail closed.

## Pagination

One dialect: opaque forward cursors. Pass the `NextCursor` you were given to fetch the
next page, and stop when it is `null`.

`null` is the only end-of-listing signal — a short page is not one, because pages can be
short whenever rows are filtered after being read.

Cursors are opaque on purpose. Do not decode, construct or reuse one across listings:
they are bound to the listing that issued them and signed, so a foreign or edited cursor
is **rejected** rather than silently restarting the walk from the beginning. Maximum page
size is 200; larger requests are clamped rather than refused.
