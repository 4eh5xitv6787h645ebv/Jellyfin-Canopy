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

## The handshake

Two routes, meant to be used as a pair:

1. **`GET /JellyfinCanopy/Platform/v1/discovery`** — anonymous. Tells you whether the
   platform is present and which protocol versions it speaks, and deliberately nothing
   else. You need this before you have any reason to authenticate.
2. **`GET /JellyfinCanopy/Platform/v1/negotiate`** — authenticated. You offer the range
   you support; the host answers with what it will actually use.

`negotiate` answers `200` with `Compatible: false` when there is no common version. That
is **not** an error — the negotiation succeeded, it just concluded "no". Render it
differently from "unavailable" and from "denied", because those are three different
problems with three different fixes.

A client that supplies no range is treated as speaking the oldest protocol only, so send
your range explicitly.

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

Platform v1 ships the bounded idempotency kernel before adding mutation routes. Every
future mutation will require exactly one `Idempotency-Key` value: 1–128 ASCII letters,
digits, `.`, `_`, `~`, or `-`. The parser is transport-neutral, so a later body-carried
key has exactly the same normalization and validation rules.

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

## Pagination

One dialect: opaque forward cursors. Pass the `NextCursor` you were given to fetch the
next page, and stop when it is `null`.

`null` is the only end-of-listing signal — a short page is not one, because pages can be
short whenever rows are filtered after being read.

Cursors are opaque on purpose. Do not decode, construct or reuse one across listings:
they are bound to the listing that issued them and signed, so a foreign or edited cursor
is **rejected** rather than silently restarting the walk from the beginning. Maximum page
size is 200; larger requests are clamped rather than refused.
