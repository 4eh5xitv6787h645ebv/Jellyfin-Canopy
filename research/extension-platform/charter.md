# Jellyfin Canopy Extension Platform — charter

Tracking issue: [#39 — EP-00](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/39)
Roadmap board: [Jellyfin Elevate Extension Platform](https://github.com/users/4eh5xitv6787h645ebv/projects/3)
Status: **proposed** — this is EP-00 output, not a shipped contract. Nothing here
is implemented, and no other milestone may treat it as available.

---

## 0. Naming, before anything else

The roadmap issues were written when this plugin was called *Jellyfin Elevate*
and consistently say `window.JellyfinElevate`, `/JellyfinElevate/*` and
`jellyfin-elevate-extension.json`. **None of those identifiers exist.** The
plugin was rebranded to *Jellyfin Canopy* at 2.0.0.0 (same GUID
`9ffa12bc-f4b5-406c-ab1d-d575acbeea7b`), and the live names are:

| Roadmap wording | Actual identifier |
|---|---|
| `window.JellyfinElevate` | `window.JellyfinCanopy` |
| `/JellyfinElevate/*` | `/JellyfinCanopy/*` |
| `jellyfin-elevate-extension.json` | `jellyfin-canopy-extension.json` (proposed) |
| "Jellyfin Elevate Extension Platform" | **Canopy Extension Platform** |

This document uses the real names throughout. The program keeps its board title
for continuity; nothing else inherits the old name.

## 1. Why this exists

Canopy has already solved, carefully and repeatedly, a set of problems that every
other Jellyfin 12 plugin, browser extension, companion service and TV client has
to solve again from scratch:

- resolving *which user* a request belongs to when the answer is ambiguous
- pushing a live change to open browser sessions
- persisting per-user JSON safely across crashes, with quotas and recovery
- calling an untrusted upstream without becoming an SSRF gadget
- injecting UI into Jellyfin's web client without jank, leaks or collisions
- doing all of the above without leaking one user's data to another

Today none of that is reusable. The measurements are specific:

- **183 routes** across 22 controllers, none versioned, with **at least four
  coexisting error-envelope shapes** (an anonymous `{success, code, message}`, two
  typed generic envelopes, a Seerr upstream shape, and bare string bodies),
  **three pagination dialects**, **three size-limit mechanisms**, **two different
  caller-id resolvers** and **no correlation ID**.
- **No machine-readable contract of any kind** — no OpenAPI, no JSON Schema, no
  `[ProducesResponseType]`. The only description of the surface is prose in
  `docs/developers.md`, which explicitly says it documents a subset.
- The genuinely reusable primitives are mostly `internal`: `AtomicFile`,
  `UserConfigurationStore`, `SettingDescriptors`, `PersistedPayloadPolicy`,
  `ReviewsStore`. The public ones — `ArrUrlGuard`, `BoundedTtlCache`,
  `IItemLookupService`, `UserAccessQuery`, `ILiveSessionRegistry` — are public by
  accident of layering, not by contract.
- `window.JellyfinCanopy` is described in `src/facade.ts` as the "STABLE, FROZEN
  public surface", but it is **not frozen at runtime** — no `Object.freeze` on
  the root, and mutation is in fact the normal publication mechanism. It is
  frozen only by a compile-time conditional-type assertion in `src/entries/boot.ts`.
  It also carries **no API version field**.

So the platform's purpose is not "add an extension system". It is: *give the
capabilities Canopy already has a versioned, authorized, documented boundary, so
that a second party can use them without depending on Canopy's internals and
without Canopy losing the ability to change those internals.*

## 2. Consumers

The platform serves exactly four consumer classes. Anything that is not one of
these is out of scope for v1.

| Class | What it is | How it reaches the platform | Proven reachable? |
|---|---|---|---|
| **Server plugins** | another installed Jellyfin 12 .NET plugin | declares a manifest; the kernel invokes it in-process over a JSON ABI | **yes** — [S3](spike-evidence.md#s3--cross-plugin-di-works-but-only-by-foreign-concrete-type) |
| **Web extensions** | contributions rendered by Canopy's own web adapter | declarative surface schemas over HTTP | **not yet** — no browser spike ran |
| **Native / TV clients** | Android TV, Roku, Kodi, Swift, third-party clients | HTTP + a deliberately small descriptor schema the client chooses to implement | **no** — and cannot be, without that client's authors. A first-party [Android TV fork](https://github.com/4eh5xitv6787h645ebv/jellyfin-androidtv) is a committed adopter; see the [client matrix](supported-client-matrix.md#the-first-native-adopter). |
| **Automation / companion services** | scripts, bots, sidecar containers | HTTP + a service credential | **partly** — HTTP surface exists, credentials do not |

The asymmetry in that last column is the single most important thing in this
charter. A server plugin can be made to work by us. A native client cannot: a
server-side installation **cannot** add UI to a client that has not implemented
the protocol, and no amount of platform design changes that. Having one adopter
lined up makes the protocol testable against something real; it does not change
the asymmetry for every other client. See the
[supported-client matrix](supported-client-matrix.md).

## 3. Ownership and support boundary

**Canopy owns** the kernel, the protocol, the schemas, the registry, the web
adapter, the reference SDKs and the conformance kit. **Canopy does not own** the
extensions, and does not become responsible for their behaviour.

The boundary is drawn at three specific places:

1. **Authorization is never delegated.** Every operation is re-authorized from
   Jellyfin's authenticated principal at invocation time. A manifest, a route
   value, a header, a device identifier or a contribution's own claim about
   context is untrusted input. [ADR-0011](adr/0011-identity-and-authority.md).
2. **Containment is honestly bounded.** An installed .NET plugin already runs
   with full server-process trust. The platform reduces *accidental* exposure —
   it cannot sandbox a *malicious* installed plugin, and [S6](spike-evidence.md#s6--provider-failure-modes-all-map-to-bounded-host-errors)
   proves it: a provider that ignores cancellation keeps running after the host's
   deadline fires, and cannot be killed. Deadlines protect the caller, not the
   server.
3. **Support follows what is tested.** The [supported-client
   matrix](supported-client-matrix.md) is the support boundary. A capability that
   works only on the web client is documented as web-only, not as "the platform
   supports it".

## 4. What v1 is

A **capability-scoped, versioned HTTP boundary** over Canopy's existing owning
services, plus an in-process JSON ABI for server plugins, plus a declarative web
contribution surface rendered by Canopy's own adapter.

Concretely, v1 delivers:

- one versioned route family, `/JellyfinCanopy/Platform/v1`
  ([ADR-0001](adr/0001-route-prefix-and-namespace.md))
- checked-in OpenAPI and JSON Schemas as the source of truth
  ([ADR-0002](adr/0002-protocol-and-version-negotiation.md))
- a load-context-safe JSON ABI for server plugins
  ([ADR-0003](adr/0003-json-abi.md), [ADR-0004](adr/0004-provider-invocation.md))
- an admin-approved registry bound to real installed-plugin identity
  ([ADR-0005](adr/0005-manifest-discovery.md))
- an authenticated event stream with a bounded long-poll fallback
  ([ADR-0006](adr/0006-client-event-transport.md))
- a small set of declarative web slots
  ([ADR-0007](adr/0007-declarative-web-contributions.md))
- namespaced per-extension and per-extension-per-user state
  ([ADR-0008](adr/0008-storage-ownership.md))
- a documented compatibility and deprecation policy
  ([ADR-0010](adr/0010-deprecation-and-support-policy.md))

The frozen list of capabilities is [`v1-capability-freeze.md`](v1-capability-freeze.md).

## 5. What v1 is explicitly not

These are non-goals. Proposing them again requires new evidence, not a new
opinion.

- **Arbitrary same-origin JavaScript.** This is the entire content of
  [milestone 82's disposition](milestone-82-disposition.md): admin-pasted
  snippets run with the *viewer's* token and full DOM access, which is stored XSS
  with extra steps. Superseded, not adopted.
- **A shared runtime contracts DLL.** [S2](spike-evidence.md#s2--no-shared-type-identity-and-the-failure-is-silent)
  settles this. Two plugins shipping the same interface get two unrelated types,
  and the DI failure mode is a silent `null`.
- **A marketplace, remote installation, or any remote code distribution.**
- **Sandboxing malicious installed .NET code.** Out of reach; see §3.2.
- **Modifying official Jellyfin clients**, or promising that a server-side
  feature will appear on any native client.
- **Migrating every Canopy feature** onto the platform for architectural purity.
- **A generic upstream proxy.** Canopy's existing `GET /JellyfinCanopy/tmdb/{**apiPath}`
  is the widest surface in the plugin and is a cautionary example, not a template.
- **Jellyfin 13 support**, or support for any host version outside the tested
  matrix.
- **Telemetry.** Diagnostics stay local and redacted.

## 6. Kernel placement decision

**Decision: the kernel stays inside the Canopy plugin for v1, behind a host
adapter that makes later extraction possible.**

Options considered:

| Option | Verdict |
|---|---|
| Kernel inside Canopy, no seam | Rejected — guarantees the platform and Canopy's features fuse, and every later extraction becomes a breaking change for consumers. |
| Kernel inside Canopy, behind a host-adapter seam | **Chosen.** |
| Kernel as a separate installable plugin, now | Rejected for v1 — see blast radius below. |

Why not a separate plugin now, despite it being the architecturally "pure"
answer: a separate kernel plugin would have to reach Canopy's owning services,
and [S2](spike-evidence.md#s2--no-shared-type-identity-and-the-failure-is-silent)
shows the only way to do that across plugins is the same reflective JSON ABI the
platform is trying to define. We would be forced to define, implement and depend
on the ABI before it had ever been exercised, and every Canopy feature would
acquire a cross-plugin hop. Worse, there is **no dependency declaration
mechanism** in Jellyfin's plugin manifest and load order is an emergent property
of a sort call, so a two-plugin split creates an ordering problem the host gives
us no tools to express.

The seam that keeps extraction open:

- every Jellyfin 12 API the kernel touches goes through a single host-adapter
  interface, so the kernel never references `MediaBrowser.*` directly;
- the kernel's public contract is HTTP and JSON Schema — never a CLR type — so
  moving it to another assembly cannot break a consumer;
- the kernel owns no Canopy feature state; it calls Canopy's owning services
  through the same adapter.

**Migration path.** Extraction becomes a packaging change, not a protocol change:
the kernel assembly moves to its own plugin, Canopy declares it a soft
dependency, and the host adapter gains a second implementation that binds to
Canopy over the JSON ABI. Consumers see no change because they were never bound
to a CLR type.

**Blast radius if we get this wrong.** Keeping the kernel in-process means a
kernel defect is a Canopy defect: it ships on Canopy's release cadence, it shares
Canopy's process and its config file, and a kernel bug that throws during startup
takes Canopy with it. That is mitigated by the rule that no registry, manifest or
provider failure may run on the startup path
([ADR-0005](adr/0005-manifest-discovery.md)) — validated by
[S13](spike-evidence.md#s13--lifecycle-matrix), where removing the host plugin
entirely left Jellyfin healthy with **zero errors on that boot**.

There is a second, less obvious blast radius, and it argues the same way. A
plugin's *display name* is what Jellyfin deduplicates installations by: two
plugins sharing a `name` are treated as two versions of one plugin and the loser's
directory is deleted outright (**[T-16](threat-model.md#t-16--plugin-directory-deletion-by-manifest-name-collision--high-accepted)**).
Every additional plugin this programme ships is another reserved name and another
way for a namesake — malicious or accidental — to delete an installation. One
plugin is the smaller target.

## 7. Relationship to existing Canopy assets

These are inputs to formalize, not code to duplicate. The repository rule that
shared behaviour is fixed and extracted **at its owning source** applies without
exception: a platform adapter calls the owner, it never grows a second copy.

| Asset | Disposition |
|---|---|
| `ArrUrlGuard`, `PluginHttpClients` | already public and dependency-free — promote as-is |
| `BoundedTtlCache` | already public — promote as-is |
| `AtomicFile` | `internal`, genuinely generic — make public |
| `IItemLookupService`, `UserAccessQuery` | already public and interface-backed — wrap in platform DTOs |
| `ILiveSessionRegistry` | already an interface — the fan-out selector is the reusable part |
| `LiveNotifierService` | no interface, hard-wired to one event and one carrier command — needs an `ILiveNotifier` before it can be a platform capability |
| `RequestIdentityService` | disambiguation only, never authority; no dedicated test file and only Spoiler-Guard-scoped direct coverage — the full ladder must be covered before promotion |
| `SettingDescriptors` | `internal`, hard-coded registry, unnamespaced keys — the highest-value and highest-effort extraction |
| `UserConfigurationStore` | `internal`, hard-coded filename whitelist — the model for [ADR-0008](adr/0008-storage-ownership.md) |
| `window.JellyfinCanopy` | stays compatible; gains an explicit version field; new APIs are versioned separately |
| Existing `/JellyfinCanopy/*` routes | remain compatibility surfaces. They are **not** implicitly Platform v1. |
| Milestone 3 / `RequestIdentityService` | partial identity prior art. **PR #23 is closed and unmerged** and must never be cited as shipped. |
| Milestone 82 / User Scripts | [superseded](milestone-82-disposition.md) |
| The private `Jeugins` repository | research and prior art. **Not** a runtime dependency. |

## 8. Success metrics

Measured at the EP-11 gate, not asserted:

1. **Independence** — at least three independently packaged consumers (one
   server plugin, one web contribution, one headless/native) complete a real
   workflow using only published artifacts, built on a clean machine.
2. **No duplication** — every migrated capability has exactly one owning
   service; parity tests prove the legacy route and the platform route call it.
3. **Zero silent failures** — every failure mode a consumer can hit maps to a
   documented, machine-readable code. The silent-`null` DI failure in
   [S2](spike-evidence.md#s2--no-shared-type-identity-and-the-failure-is-silent)
   is the anti-pattern this metric exists to prevent.
4. **Isolation** — a broken, slow, incompatible, disabled or uninstalled
   extension leaves Jellyfin, Canopy and unrelated extensions healthy. The
   [lifecycle matrix](spike-evidence.md#s13--lifecycle-matrix) is the template.
5. **Bounded cost** — platform overhead against the equivalent direct path stays
   within published budgets for startup, catalog, surface resolution, action
   latency, event memory, web jank and payload size.
6. **Honest support** — every capability in the client matrix is backed by a
   passing conformance run on that client class, or is marked unsupported.

## 9. How this milestone completes

EP-00's exit gate is an approved charter, ADR set, threat model, risk register,
compatibility terminology, supported-client matrix and frozen v1 capability list.
The artifacts exist in this directory. The remaining work packages — the browser
sandbox spike, the native descriptor fixture, and the deeper conformance
questions [the spike did not
establish](spike-evidence.md#what-this-spike-did-not-establish) — are decomposed
into child issues under milestone EP-00 rather than declared done.

Parent issue #39 stays open until every acceptance criterion has evidence.
