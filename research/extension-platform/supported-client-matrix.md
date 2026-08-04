# Supported-client matrix

Tracking issue: [#39 — EP-00](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/39)
Status: **accepted support boundary**. A client class
is listed as supported only when a conformance run passes on it.

## The distinction that matters

Four different things get called "client support", and conflating them is how a
platform promises something it cannot deliver:

1. **Browser injection** — Canopy's script runs in the page. Full reach.
2. **WebView reach** — a native app hosting Jellyfin's web client. Inherits
   injection, with platform-specific input and layout caveats.
3. **Server-side effects visible everywhere** — item metadata, tags, collections,
   playlists, media segments. Every client sees these because they are ordinary
   Jellyfin data. **No client adoption required.**
4. **Explicit native adoption** — the client's authors implement the descriptor
   protocol in their own codebase. Nothing we ship causes this.

A server-side installation **cannot** put UI on a client in category 4 that has
not adopted the protocol. This is not a limitation to engineer around; it is the
shape of the problem.

## Matrix

| Client | Class | Injection | Descriptor UI | Events | Server-side effects | v1 status |
|---|---|---|---|---|---|---|
| Jellyfin Web (browser, modern layout) | 1 | yes | deferred (EP-07) | deferred (C5) | yes | **platform adapter deferred** |
| Jellyfin Web (classic layout) | 1 | loader boundary only | no | no | yes | **unsupported** — Jellyfin remains usable and Canopy's client feature graph does not initialize |
| Jellyfin Web on mobile browser | 1 | yes | deferred (EP-07) | deferred (C5) | yes | **platform adapter deferred** |
| Jellyfin Web TV mode (browser) | 1 | yes | deferred (EP-07) | deferred (C5) | yes | **platform adapter deferred** — *not* evidence of native TV support |
| Jellyfin Android (mobile, WebView portions) | 2 | partial | no | no | yes | **best effort**, untested |
| **`4eh5xitv6787h645ebv/jellyfin-androidtv`** (first-party fork, Kotlin) | 4 | **no** | bounded item-detail pilot evidence recorded by #626 | refetch only; no C5 adoption | yes | **first-party bounded consumer** — see below |
| Jellyfin Android TV (upstream) | 4 | **no** | no | no | yes | **unsupported** unless adopted |
| Findroid, Plethorafin and other native Android clients | 4 | **no** | no | no | yes | **unsupported** unless adopted |
| Swiftfin (iOS / tvOS) | 4 | **no** | no | no | yes | **unsupported** unless adopted |
| Roku | 4 | **no** | no | no | yes | **unsupported** unless adopted |
| Kodi (JellyCon / add-on) | 4 | **no** | no | no | yes | **unsupported** unless adopted |
| Companion services, scripts, bots | — | n/a | n/a | planned server-tranche proof through the credential-bound Z3b headless fixture, limited to registry/provider events | yes | **contract/credentials not yet delivered; no user/media authority** |

"planned" means the capability is active but not shipped; "deferred" means it
is outside the current tranche. Activating the registry/provider C5 subset for
server-side conformance does not claim support in a browser or native row whose
adapter remains deferred.
For the browser rows the *mechanism*
is verified — slot rendering, idempotent mounting, teardown and frame isolation
all measured
([S17](spike-evidence.md#s17--browser-slots-render-idempotently-the-frame-is-genuinely-isolated-and-there-is-no-csp)) — on the
**modern layout only**. See [what is not verified](#what-is-not-verified).

## What "unsupported" means

It does not mean broken. A native client that has not adopted the protocol:

- keeps working exactly as it does today;
- sees every category-3 effect (tags, collections, playlists, segments);
- simply does not render extension surfaces.

Graceful omission is a hard requirement: a client that negotiates a schema it
does not support gets the contribution **omitted**, never approximated, never
half-rendered ([ADR-0007](adr/0007-declarative-web-contributions.md)).

## The first native adopter

A first-party fork of the Android TV client —
[`4eh5xitv6787h645ebv/jellyfin-androidtv`](https://github.com/4eh5xitv6787h645ebv/jellyfin-androidtv) (Kotlin) — supplied the bounded interop evidence recorded when
Canopy issue #606 closed through #626. Client-repository work is maintained
separately. That evidence changes the programme's shape in three ways:

1. **The native protocol had a real design partner.** The bounded EP-08 pilot was
   checked against a client that renders descriptors as well as the independent
   headless fixture ([#492](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/492)).
2. **First-party Kotlin models were not speculative.** The bounded pilot used
   schema-pinned models. That does not revive
   EP-09's public Kotlin SDK or generated bindings for unrelated clients.
3. **It does not change the rule.** This client is listed as an adopter only when
   a conformance run passes on it. Being the same owner earns no exemption, and
   nothing here implies upstream Android TV, Roku, Kodi or Swift support.

The honest caveat: a single first-party adopter proves the protocol is
*implementable*, not that it is *adoptable by strangers*. Risk R-02 is reduced,
not closed.

## Adoption path for a native client

Deliberately small, so that adopting it is a weekend rather than a quarter. Each
step below is now exercised by a headless fixture
([S18](spike-evidence.md#s18--a-headless-native-client-can-drive-the-protocol-and-every-refusal-is-distinct)), so a client
author is implementing against something that has been driven end to end rather
than against prose:

1. call the authenticated negotiation endpoint, declaring supported protocol
   range, surface schemas, component set, input modes, layout constraints,
   locale, accessibility and image support;
2. fetch a filtered catalog and render only the schemas it declared;
3. render descriptors with the client's own native components — no downloaded
   HTML, CSS, JavaScript or bytecode, ever;
4. invoke mutations only through short-lived opaque action capabilities, never by
   naming a provider method;
5. handle platform-absent, offline, expired-action, permission-revoked and
   provider-unavailable states; refresh through catalog revision/ETag,
   action-result hints and refetch on relevant lifecycle transitions.

The last step is deliberately not event delivery. C5's stream, reconnect cursor,
retention window, event-gap and `resync-required` behavior are active new EP-05
server work; the existing native row remains refetch-only until a separate
client-adoption decision and conformance run say otherwise.

Every change needed lives in **that client's repository**. This repository will
not modify official Jellyfin clients.

## What is not verified

Stated plainly so the matrix is not read as stronger than the evidence:

- **The browser spike ran and passed, on the modern layout only.** Declarative slot
  rendering, idempotent mounting, teardown, coexistence of two contributions and
  opaque-origin frame isolation are all measured
  ([S17](spike-evidence.md#s17--browser-slots-render-idempotently-the-frame-is-genuinely-isolated-and-there-is-no-csp)).
  **Not** covered: modern mobile and Web-TV modes, accessibility,
  localisation, D-pad focus order and the jank budgets — which are the majority of
  EP-07's actual cost.
- **The EP-00 spike itself involved no native or TV client.** Later bounded
  first-party evidence is recorded by #626; it supports no claim about upstream
  Android TV, Roku, Kodi, Swift or any broader surface.
- Whether a native client gracefully ignores or **hard-crashes** on an unexpected
  payload under a known `SessionMessageType` is untested, and is one reason the
  platform does not use that channel.
- WebView-hosted clients (row 2) were not tested at all; "best effort" reflects
  that, not a measurement.

## Rules for changing this table

1. A cell moves to "supported" only with a passing conformance run recorded
   against that client class.
2. Web TV mode never counts as evidence for a native TV client.
3. A capability that works only in category 1 is documented as web-only, never as
   "the platform supports it".
4. Jellyfin 13 is not listed, in any row, until it is tested.
