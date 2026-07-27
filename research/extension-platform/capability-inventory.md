# Capability inventory

Tracking issue: [#39 — EP-00](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/39)
Status: **proposed** (EP-00)

Four buckets, as EP-00 requires: what Canopy already has, what Jellyfin 12 makes
possible, what needs a client to cooperate, and what the host simply does not
offer. Bucket D is the most valuable section — it is the list of things later
milestones must not try to build.

---

## A. Existing reusable primitives

Everything here already works in production. The column that matters is
*reuse-readiness*: whether a second party could consume it today.

| Primitive | Visibility | Interface | Consumable over HTTP today? | Work to formalize |
|---|---|---|---|---|
| `ArrUrlGuard` + `PluginHttpClients` | public static | n/a | no, nor should be | none — promote as-is. Decide the RFC1918 default for untrusted extensions. |
| `BoundedTtlCache<K,V>` | public sealed | n/a | no | none — dependency-free (BCL + `TimeProvider`) |
| `UserAccessQuery` | public static | n/a | no | wrap in platform DTOs |
| `IItemLookupService` | public | yes | partially (`items/by-providers` returns a single `Guid?`) | expose the batch/candidate shapes with platform DTOs; keep the fail-closed truncation rule |
| `ILiveSessionRegistry` | public | yes | no | the deliverable-device selector is the reusable part |
| `AtomicFile` | **internal** | n/a | no | make public — genuinely generic, already guarded by an architecture test |
| `LiveNotifierService` | public sealed | **no** | no publish surface | needs `ILiveNotifier`, a topic/payload contract and an authenticated publish route. Its carrier-command trick is a web-client implementation detail that must not enter the contract. |
| `RequestIdentityService` | public sealed | **no** | no | **blocked**: no dedicated test file. `Tests/Services/SpoilerIdentityTests.cs` does construct it and assert on its ladder, but only along the Spoiler Guard path — the session-by-IP and cookie tiers are untested on their own terms. Tiers stay disambiguation-only. |
| `SettingDescriptors` | **internal** | no | payloads readable, no registration | highest value, highest effort: public types, DI-collected registration, namespaced keys, golden-snapshot strategy for third-party keys |
| `UserConfigurationStore` / `PersistedPayloadPolicy` / `PersistedJson` | **internal** | no | only via Canopy's own typed routes | interface + namespaced file registration in place of the hard-coded whitelist — the model for [ADR-0008](adr/0008-storage-ownership.md) |
| `AssetCacheService` | public sealed | **no** | read-only, manifest keys only | needs an asset-source contribution point and per-source byte budgets |
| `ReviewsStore` | **internal** sealed | no | only via `ReviewsController` | not a platform candidate; cited as evidence of the real cost of per-extension SQLite |
| Client: `JC.core.dom.ensureInjected` | module | n/a | n/a | the injection primitive the web adapter renders slots with |
| Client: `JC.core.lifecycle` + `FeatureScope` | module | n/a | n/a | the ownership/cleanup contract a contribution needs |
| Client: `JC.core.navigation` | module | n/a | n/a | route/view lifecycle the adapter owns on behalf of extensions |
| Client: `createStableMethodFacade` | module | n/a | n/a | keeps a published surface stable across activation churn |
| Client: `registerFeatureDescriptors` / `registerPage` | module export | yes | **not on `window`** | the closest thing to an existing registration seam; first-party only |

**Two facts that shape everything above.** `window.JellyfinCanopy` is documented
as frozen but is **not** frozen at runtime — mutation is the normal publication
mechanism, and freezing is enforced by a compile-time conditional-type assertion.
And it carries **no API version field**, only `pluginVersion` and a
content-addressed `clientBuildId`.

---

## B. Feasible through Jellyfin 12 today

Verified in the spike unless marked otherwise.

| Capability | Mechanism | Evidence |
|---|---|---|
| Plugin-served HTTP routes with full auth | controllers are routed automatically | [S9](spike-evidence.md#s9--authorization-semantics-verified-on-plugin-routes) |
| Two authorization levels | `[Authorize]`, `Policies.RequiresElevation` | [S9](spike-evidence.md#s9--authorization-semantics-verified-on-plugin-routes) |
| Bare `401`/`403` | host behaviour, zero body bytes | [S9](spike-evidence.md#s9--authorization-semantics-verified-on-plugin-routes) |
| Unforgeable acting identity | claims derived from the token | [S14](spike-evidence.md#s14--forged-identity-is-fully-resisted-but-the-token-is-in-the-claims) |
| Enumerate other installed plugins | `IPluginManager.Plugins` → GUID, version, path, DLLs, status, live instance | [S1](spike-evidence.md#s1--one-collectible-assemblyloadcontext-per-plugin) |
| Cross-plugin invocation | foreign concrete `Type` from the provider's assembly + shared DI + reflection | [S3](spike-evidence.md#s3--cross-plugin-di-works-but-only-by-foreign-concrete-type) |
| Manifest bound to real plugin identity | plugin root from `IPluginManager` + GUID fingerprint | [S4](spike-evidence.md#s4--manifest-discovery-binds-to-the-real-plugin-identity-and-rejects-a-claim-to-another) |
| Unbuffered event streaming | `text/event-stream`, chunked, at source cadence | [S7](spike-evidence.md#s7--event-streaming-survives-the-host-pipeline) |
| Bounded long-poll | ordinary request | [S7](spike-evidence.md#s7--event-streaming-survives-the-host-pipeline) |
| Reverse-proxy base path | inherited automatically by plugin routes | [S12](spike-evidence.md#s12--reverse-proxy-base-path) |
| Survive load-order reversal, disable, uninstall, upgrade | lazy per-invocation binding | [S13](spike-evidence.md#s13--lifecycle-matrix) |
| Crash-safe per-user JSON state | `AtomicFile` + `UserConfigurationStore` | existing production code |
| Push to open **browser** sessions | `ISessionManager.SendMessageToUserDeviceSessions` | existing production code |
| Affect **every** client indirectly | item metadata, tags, collections, playlists, media segments | host behaviour |
| Inject UI into the web client | server-side middleware rewriting `index.html` | existing production code |

---

## C. Requires explicit client adoption

Nothing here can be delivered by installing something on the server. Each item
needs the client's authors to implement the protocol in their own codebase.

| Capability | Why the server cannot do it alone |
|---|---|
| Any UI on Android TV, Roku, Kodi, Swift or other native clients | they execute no downloaded HTML/JS and have no plugin surface |
| Native item-detail actions, home rows, badges, player actions | requires the client to fetch, render and act on a descriptor |
| Client-side event subscription on native clients | requires the client to open and maintain the stream |
| D-pad focus order, TV overscan, native accessibility | rendering is entirely the client's |
| Native deep links into an extension surface | requires the client's own routing |

Web TV mode in the browser is **not** evidence of native Android TV support. A
WebView-based client inherits injected JavaScript; a native client does not.

---

## D. Not available from the host — do not attempt

Each of these was investigated and refuted. They are recorded so a later
milestone does not spend budget rediscovering them.

| Wanted | Reality | Evidence |
|---|---|---|
| Shared CLR type identity between plugins | one collectible ALC per plugin; identically named types are unrelated; the DI failure is a **silent `null`** (`resolveByHostOwnedInterface: null`, nothing thrown) | [S1](spike-evidence.md#s1--one-collectible-assemblyloadcontext-per-plugin), [S2](spike-evidence.md#s2--no-shared-type-identity-and-the-failure-is-silent) |
| Fix the above with a resolution hook | works in isolation; Jellyfin installs none, all types resolve before any plugin code runs, `[ModuleInitializer]` does not fire during load | Jellyfin 12 source; **not probed here** |
| Two plugins with the same display name to coexist safely | Jellyfin's old-version cleanup deduplicates by manifest `name` alone and `Directory.Delete`s the loser | `PluginManager.DiscoverPlugins`; see **T-16** |
| Declare a dependency between plugins | no such field in `meta.json`; no ordering attribute | JF12 source |
| Control load order contractually | alphabetical by manifest `name` — deterministic but undocumented, untested, emergent from a private sort | [S13](spike-evidence.md#s13--lifecycle-matrix) |
| Declare a maximum supported host version | `targetAbi` is a minimum with no ceiling | JF12 source |
| Kill a runaway provider | not available on .NET; the deadline protects only the caller, and a cooperative provider is indistinguishable from an uncooperative one | [S6](spike-evidence.md#s6--provider-failure-modes-all-map-to-bounded-host-errors) |
| A `413` for an oversized request | Kestrel's 30,000,000-byte default surfaces as an opaque `500` | [S11](spike-evidence.md#s11--request-size-and-json-depth-boundaries) |
| Authenticate `EventSource` safely | it cannot set headers; the only option is a query-string token | [S8](spike-evidence.md#s8--browser-eventsource-cannot-authenticate-safely) |
| Rely on same-origin as a boundary | host answers `Access-Control-Allow-Origin: *` with `authorization` allowed | [S10](spike-evidence.md#s10--host-cors-is-permissive) |
| Custom WebSocket message types | closed enum; smuggling is a program constraint and the native-client crash behaviour is untested | JF12 source |
| An official web-client extension point | none exists; injection is the only route, and JF12's web client is a React/MUI app | JF12 source |
| `IServerEntryPoint` | removed in Jellyfin 12 | JF12 source |
| File Transformation plugin | not viable on Jellyfin 12 | Jeugins prior art |
| `?api_key=` query auth | removed in 12; `?apikey=` / `?ApiKey=` remain | [S8](spike-evidence.md#s8--browser-eventsource-cannot-authenticate-safely) |
| `X-Emby-Token` / `X-MediaBrowser-Token` / `Bearer` | all rejected; only `Authorization: MediaBrowser Token=` works | [S8](spike-evidence.md#s8--browser-eventsource-cannot-authenticate-safely) |
| `Policies.DefaultAuthorization` | does not exist in Jellyfin 12 | build failure during the spike |

---

## E. Known unknowns

Carried forward as EP-00 child issues rather than assumed either way.

1. Whether Jellyfin actually **unloads** a collectible context on disable or
   uninstall without a restart. The contexts report `IsCollectible = true`; every
   lifecycle case tested used a restart.
2. Whether an opaque-origin iframe plus a `postMessage` broker behaves as
   designed under Jellyfin's CSP. **No browser spike ran.**
3. Whether native clients ignore or **crash on** an unexpected payload sent under
   a known `SessionMessageType`. Needs real Android TV / Roku hardware.
4. Behaviour under concurrency and sustained load. Every probe was sequential.
5. Whether the provider response cap, which does not exist today, can be enforced
   without buffering the whole response.
6. Whether two plugins shipping a **byte-identical, same-version** contract
   assembly behave as S2 showed for two *different* versions. Documented .NET
   behaviour says yes; this spike did not show it.
7. Version negotiation of any kind — `/Ep00Spike/Discovery` returns a static
   range and nothing negotiates against it.
