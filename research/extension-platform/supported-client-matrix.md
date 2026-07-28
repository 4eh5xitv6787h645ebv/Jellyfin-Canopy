# Supported-client matrix

Tracking issue: [#39 — EP-00](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/39)
Status: **proposed** (EP-00). This table *is* the support boundary. A client class
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
| Jellyfin Web (browser, modern layout) | 1 | yes | planned | `fetch()` stream | yes | **primary target** |
| Jellyfin Web (legacy layout) | 1 | yes | planned | `fetch()` stream | yes | **supported** — the repo keeps both layouts valid |
| Jellyfin Web on mobile browser | 1 | yes | planned | `fetch()` stream | yes | **supported** |
| Jellyfin Web TV mode (browser) | 1 | yes | planned | `fetch()` stream | yes | **supported** — *not* evidence of native TV support |
| Jellyfin Android (mobile, WebView portions) | 2 | partial | no | no | yes | **best effort**, untested |
| **`4eh5xitv6787h645ebv/jellyfin-androidtv`** (first-party fork, Kotlin) | 4 | **no** | **planned — committed adopter** | planned | yes | **design partner** — see below |
| Jellyfin Android TV (upstream) | 4 | **no** | no | no | yes | **unsupported** unless adopted |
| Findroid, Plethorafin and other native Android clients | 4 | **no** | no | no | yes | **unsupported** unless adopted |
| Swiftfin (iOS / tvOS) | 4 | **no** | no | no | yes | **unsupported** unless adopted |
| Roku | 4 | **no** | no | no | yes | **unsupported** unless adopted |
| Kodi (JellyCon / add-on) | 4 | **no** | no | no | yes | **unsupported** unless adopted |
| Companion services, scripts, bots | — | n/a | n/a | stream or long-poll | yes | **supported** via HTTP + a service credential |

"planned" means the capability is designed but not shipped. For the browser rows
the *mechanism* is now verified — slot rendering, idempotent mounting, teardown and
frame isolation all measured
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
[`4eh5xitv6787h645ebv/jellyfin-androidtv`](https://github.com/4eh5xitv6787h645ebv/jellyfin-androidtv) (Kotlin) — is in
development by the same owner and intends to consume this protocol. That changes
the programme's shape in three ways:

1. **The native protocol has a real design partner.** EP-08 can be validated
   against a client that actually renders descriptors, instead of only against a
   headless fixture ([#492](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/492)).
2. **Kotlin model generation stops being speculative.** ADR-0009 lists Kotlin
   models as "where practical"; there is now a concrete consumer for them.
3. **It does not change the rule.** This client is listed as an adopter only when
   a conformance run passes on it. Being the same owner earns no exemption, and
   nothing here implies upstream Android TV, Roku, Kodi or Swift support.

The honest caveat: a single first-party adopter proves the protocol is
*implementable*, not that it is *adoptable by strangers*. Risk R-02 is reduced,
not closed.

## Adoption path for a native client

Deliberately small, so that adopting it is a weekend rather than a quarter:

1. call the authenticated negotiation endpoint, declaring supported protocol
   range, surface schemas, component set, input modes, layout constraints,
   locale, accessibility and image support;
2. fetch a filtered catalog and render only the schemas it declared;
3. render descriptors with the client's own native components — no downloaded
   HTML, CSS, JavaScript or bytecode, ever;
4. invoke mutations only through short-lived opaque action capabilities, never by
   naming a provider method;
5. handle platform-absent, offline, expired-action, permission-revoked, event-gap
   and provider-unavailable states.

Every change needed lives in **that client's repository**. This repository will
not modify official Jellyfin clients.

## What is not verified

Stated plainly so the matrix is not read as stronger than the evidence:

- **The browser spike ran and passed, on the modern layout only.** Declarative slot
  rendering, idempotent mounting, teardown, coexistence of two contributions and
  opaque-origin frame isolation are all measured
  ([S17](spike-evidence.md#s17--browser-slots-render-idempotently-the-frame-is-genuinely-isolated-and-there-is-no-csp)).
  **Not** covered: the legacy, mobile and Web-TV layouts, accessibility,
  localisation, D-pad focus order and the jank budgets — which are the majority of
  EP-07's actual cost.
- **No native or TV client was involved in any way**, including the first-party
  fork above. Nothing in the spike supports any claim about Android TV, Roku,
  Kodi or Swift behaviour.
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
