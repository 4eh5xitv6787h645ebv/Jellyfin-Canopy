# EP-00 spike evidence

Tracking issue: [#39](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/39)
Roadmap board: [Jellyfin Elevate Extension Platform](https://github.com/users/4eh5xitv6787h645ebv/projects/3)

Every architectural claim in [`charter.md`](charter.md), [`adr/`](adr/) and
[`threat-model.md`](threat-model.md) that depends on how Jellyfin 12 actually
behaves is answered here by a live result, not by reading source. Where a probe
refuted an assumption, the refutation is recorded rather than removed.

## How this was produced

- Two throwaway plugins in [`spikes/ep-00/`](spikes/ep-00/): a **host** standing
  in for the platform kernel, and an independently packaged **provider**. Neither
  references the other, and neither references any repository code. Each
  *separately compiles* its own copy of `SpikeContracts`, which is the point.
- Both ship their own copy of `SpikeContracts.dll` declaring the *same*
  `Ep00.Contracts.IExtensionProvider` type — the host at assembly version
  `1.0.0.0`, the provider at `2.0.0.0`.
- Replay with [`spikes/ep-00/run-spike.sh`](spikes/ep-00/run-spike.sh).

| | |
|---|---|
| Server | Jellyfin `12.0.0` |
| Image | `jellyfin/jellyfin:12.0-rc3.20260722-020441` |
| Image digest | `sha256:99c5b805c2c60ad0aefb75b0170cfd4abeacc67b2137428b5e4fff787ce7cb51` |
| Runtime | .NET 10, SDK 10.0.108, plugins target `net10.0` |
| Packages | `Jellyfin.Controller` / `Jellyfin.Model` `12.0.0-rc1` |
| Date | 2026-07-27 |
| Container | disposable, empty library, no media mounts, not any of the frozen dev servers |

---

## S1 — One collectible AssemblyLoadContext per plugin

`GET /Ep00Spike/Self` and `GET /Ep00Spike/TypeIdentity`:

```
host  load context : 13748703 name=<null> collectible=True
prov  load context : 19899650 name=<null> collectible=True
sameLoadContext    : False
AssemblyLoadContext.All:
  34621012 name=Default   collectible=False
  13748703 name=<null>    collectible=True
  19899650 name=<null>    collectible=True
```

Confirmed: each externally installed plugin gets its own **unnamed, collectible**
context. Only three contexts existed in total, while the server log for the same
boot shows eight plugins loaded (the two spikes plus six server-bundled ones), so
the server-bundled plugins are not each getting their own context — one context
per *separately installed plugin directory* is the rule this spike establishes.

Both copies of the same-named assembly were loaded, side by side:

```
Loaded assembly SpikeContracts, Version=1.0.0.0 … from /config/plugins/Ep00SpikeHost_1.0.0.0/SpikeContracts.dll
Loaded assembly SpikeContracts, Version=2.0.0.0 … from /config/plugins/Ep00SpikeProvider_1.0.0.0/SpikeContracts.dll
```

## S2 — No shared type identity, and the failure is silent

```
sameFullName                         : True
referenceEqualTypes                  : False
hostTypeIsAssignableFromProviderType : False
directCastSucceeded                  : False
directCastError                      : Unable to cast object of type
                                       'Jellyfin.Plugin.Ep00Provider.Ep00ProviderEntrypoint'
                                       to type 'Ep00.Contracts.IExtensionProvider'.
```

Two types with an identical fully qualified name are **not** the same type. A cast
throws `InvalidCastException`; an `IsAssignableFrom` check simply answers `false`.

**The silent half, probed rather than asserted.** The provider registers itself
*both* by concrete type and against **its own** copy of the shared interface —
which is what an author would write if they believed the contract assembly were
shared:

```csharp
serviceCollection.AddSingleton<Ep00ProviderEntrypoint>();
serviceCollection.AddSingleton<Ep00.Contracts.IExtensionProvider>(
    sp => sp.GetRequiredService<Ep00ProviderEntrypoint>());
```

The host then asks Jellyfin's container for **its** copy of the same interface:

```
resolveByHostOwnedInterface      : null
resolveByHostOwnedInterfaceThrew : False
```

`null`, and nothing thrown. No exception, no log entry, no `Malfunctioned` plugin
status — the registration is there, the type name matches, and the answer is
silently nothing. This is the single most important result in the file, and it is
why [ADR-0003](adr/0003-json-abi.md) forbids a shared runtime contract assembly
and why "no silent failures" is a charter success metric.

**Scope of what was shown.** The two plugins ship `SpikeContracts.dll` at
*different* assembly versions (`1.0.0.0` and `2.0.0.0`). That is sufficient for
the ABI decision, but it does **not** show the sharper case — two plugins
shipping a byte-identical contract assembly at the *same* version — which .NET
load-context semantics say behaves identically. That stronger claim is asserted
from documented runtime behaviour, not probed here, and is listed under
[what this spike did not establish](#what-this-spike-did-not-establish).

## S3 — Cross-plugin DI works, but only by foreign concrete type

```
diResolvedInstance   : True
reflectiveInvokeFound: True
reflectiveInvokeResult:
  {"ok":true,"providerId":"ep00.spike.provider",
   "contractsAssembly":"SpikeContracts, Version=2.0.0.0, …",
   "contractsLocation":"/config/plugins/Ep00SpikeProvider_1.0.0.0/SpikeContracts.dll"}
```

The host resolved the provider's singleton out of Jellyfin's shared container by
passing the `Type` object obtained **from the provider's own assembly**, then
invoked it reflectively over `string` in / `string` out.

Set against S2 this is the whole binding rule in two lines: asking for the
provider's **concrete type** works; asking for the **host's copy of an interface**
returns `null` silently. [ADR-0003](adr/0003-json-abi.md) and
[ADR-0004](adr/0004-provider-invocation.md) follow directly.

## S4 — Manifest discovery binds to the real plugin identity, and rejects a claim to another

The host plugin was deliberately given a manifest claiming the **provider's** GUID:

```json
{ "id": "ep00.impostor", "pluginId": "b1a7c3d2-4e5f-4a6b-8c9d-0e1f2a3b4c5d", … }
```

`GET /Ep00Spike/Manifests`:

| Plugin | manifest found | fingerprintBound | outcome |
|---|---|---|---|
| EP-00 Spike Host (impostor manifest) | yes | **false** | `rejected: fingerprint_mismatch`, `registered: false` |
| EP-00 Spike Provider (honest manifest) | yes | true | `registered: true` |

The root is whatever `IPluginManager` reports for that plugin, and the manifest's
self-declared `pluginId` is checked against the GUID Jellyfin reports. A manifest
claiming someone else's identity is **rejected**, not merely flagged — an earlier
version of this probe computed the flag but registered the extension anyway,
which is the difference between a security control and a report field.

**Robustness, same reader:**

| Manifest | Result |
|---|---|
| malformed JSON (`{ this is not json`) | `rejected: manifest_malformed` — `'t' is an invalid start of a property name` |
| 300 KB of filler | `rejected: manifest exceeds 256 KiB` — rejected on size *before* parsing |
| valid JSON that is not an object | `rejected: manifest_not_an_object` |

## S5 — Path containment holds against traversal *and* symlinks

`GET /Ep00Spike/Traversal`. The runner first creates, inside the host plugin root,
`escape-dir -> /etc` (a symlinked **directory component**), `escape-file ->
/etc/hostname` (a symlinked leaf) and `inside-file -> meta.json` (a symlink that
stays inside).

| Candidate | Accepted | Rejected by |
|---|---|---|
| `jellyfin-canopy-extension.json` | **yes** | — (the real manifest) |
| `../jellyfin-canopy-extension.json` | no | containment |
| `../../../../../../etc/passwd` | no | containment |
| `..\..\..\etc\passwd` | no | containment |
| `subdir/../../escape.json` | no | containment |
| `/etc/passwd` | no | absolute path |
| `manifest.json\0/etc/passwd` | no | embedded NUL |
| `escape-dir/passwd` | no | **symlink escapes plugin root** |
| `escape-file` | no | **symlink escapes plugin root** |
| `inside-file` | **yes** | — (correctly *not* a false positive) |

**Two defects were found here and fixed rather than documented away.**

1. The Windows-separator case originally reported `absent: no manifest at
   ..\..\..\etc\passwd`. A backslash is a legal filename character on Linux, so
   the candidate resolved to a missing file *inside* the root and the containment
   check was never exercised — a pass for the wrong reason, which reads exactly
   like a real pass. Separators are now normalised before any test, and the case
   is rejected by containment.
2. `Path.GetFullPath` is **lexical**: it does not resolve symlinks, and
   `FileInfo.LinkTarget` sees only the final component. So `escape-dir/passwd`
   originally passed containment, `File.Exists` returned true, and the reader
   returned the contents of `/etc/passwd` with `reason=accepted`. The probe now
   resolves every path component with `ResolveLinkTarget(returnFinalTarget: true)`
   and re-tests containment against the fully resolved path.

The second defect is the reason [#494](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/494)
exists: EP-03 must not re-derive this check, and must additionally close the
TOCTOU window by re-validating on an open handle.

## S6 — Provider failure modes all map to bounded host errors

`GET /Ep00Spike/Invoke`, host deadline 2000 ms:

| Operation | Result |
|---|---|
| `ping` | `ok=true elapsed=1ms chars=280` |
| `throw` | `ok=false error=provider_faulted` |
| `invalid-json` | `ok=false error=provider_response_invalid_json` — validated *before* leaving the boundary |
| `unknown-op` | `ok=true` — the provider answered `{"ok":false,"error":"unknown_operation"}`; an unknown operation is a provider-level answer, not a transport fault |
| `big` (2 MB) | `ok=true chars=2000021` — no host-imposed response cap exists yet |
| `hang` (8 s, ignores cancellation) | `ok=false error=provider_deadline_exceeded elapsed=2254ms` |
| `cancellable-hang` (8 s, honours cancellation) | `ok=false error=provider_cancelled elapsed=2003ms` |
| caller aborts mid-call | `caller_cancelled` — never attributed to the provider |

**The load-bearing negative result:** the host returned on time in both hang
cases, but the `hang` provider — the one that ignores the cancellation token —
kept running in-process afterwards and could not be killed. A deadline protects
the *caller*, never the *server*. This is why
[ADR-0004](adr/0004-provider-invocation.md) treats providers as trusted
in-process code and the [threat model](threat-model.md) records "malicious
installed plugin" as out of scope for containment.

**A correction, kept because the first version of this probe was wrong.** The
original binder enforced its deadline with
`Task.WhenAny(providerTask, Task.Delay(deadlineMs))` while its linked
`CancellationTokenSource` cancelled at the same instant. Two timers then fired
together and `WhenAny` returned whichever won, so:

- both hang cases reported `provider_deadline_exceeded` — and this file initially
  concluded that a cooperative provider is *indistinguishable* from a runaway one,
  which is false;
- the result was a coin flip: on the other branch the awaited task threw
  `TaskCanceledException` and the same run would have reported `provider_faulted`;
- a **caller** abort also completed the delay task, so a client closing its
  connection was reported as the provider breaching its deadline — which in the
  real design would trip that provider's circuit breaker for someone else's
  network problem;
- and every successful call leaked a live timer for the remainder of the deadline.

The binder now awaits the provider's own task with
`WaitAsync(deadline + grace)` and branches on the outcome, giving four distinct
results: `ok`, `provider_cancelled`, `provider_deadline_exceeded`, and
`caller_cancelled`. Cooperation *is* observable, and
[ADR-0004](adr/0004-provider-invocation.md) now requires all four codes and lists
the racing shape as a rejected alternative. The mistake is recorded because an
EP-04 implementer would otherwise write it again.

## S7 — Event streaming survives the host pipeline

`GET /Ep00Spike/Stream?events=4&intervalMs=700`:

```
Content-Type: text/event-stream
Transfer-Encoding: chunked
  0.03s  data: {"seq":0,…}
  0.73s  data: {"seq":1,…}
  1.43s  data: {"seq":2,…}
  2.13s  data: {"seq":3,…}
```

Frames arrived at the source cadence — Jellyfin's MVC/Kestrel pipeline does not
buffer a `text/event-stream` response.

Through an nginx reverse proxy, three configurations were tried:

| Proxy mode | Result |
|---|---|
| `proxy_buffering off` (correct) | streams at source cadence |
| `proxy_buffering on` (nginx default) | streams at source cadence |
| `proxy_buffering on` + `proxy_ignore_headers X-Accel-Buffering` | streams at source cadence |

**Refuted assumption, recorded:** the expectation that a buffering proxy would
stall SSE was *not* reproduced, even with the `X-Accel-Buffering: no` hint
deliberately ignored. nginx forwards upstream data as it arrives rather than
waiting to fill a buffer. Proxy buffering is therefore a **hypothetical** rather
than a demonstrated failure for this transport. The bounded long-poll fallback
in [ADR-0006](adr/0006-client-event-transport.md) is retained on the strength of
the *authentication* problem in S8, not on the strength of this one.

Long-poll behaved identically through all three proxy modes
(`waitMs=1500` → returned in 1.53 s).

## S8 — Browser `EventSource` cannot authenticate safely

| Attempt | Result |
|---|---|
| `EventSource` equivalent, no header | `401` |
| `?apikey=<token>` | `200` |
| `?api_key=<token>` (the Jellyfin 10.x spelling) | `401` |
| `Authorization: MediaBrowser Token=…` | `200` |
| `X-Emby-Token` / `X-MediaBrowser-Token` header | `401` |
| `Authorization: Bearer …` / `Emby Token=…` | `401` |

`EventSource` cannot set request headers, so the only way it could authenticate
is a query-string token — which lands in proxy logs, browser history and
`Referer`. Jellyfin 12 accepts `?apikey=` (and `?ApiKey=`, case-insensitively)
but has **dropped** the 10.x `?api_key=` spelling. Platform routes must forbid
query-string credentials outright and use `fetch()` streaming, which does carry
headers. This is the actual justification for
[ADR-0006](adr/0006-client-event-transport.md).

## S9 — Authorization semantics, verified on plugin routes

| Route | anon | non-admin | admin |
|---|---|---|---|
| `/Ep00Spike/Discovery` (`[AllowAnonymous]`) | 200 | 200 | 200 |
| `/Ep00Spike/Whoami` (`[Authorize]`) | 401 | 200 | 200 |
| `/Ep00Spike/AdminOnly` (`Policies.RequiresElevation`) | 401 | 403 | 200 |
| `/Ep00Spike/Plugins` | 401 | 403 | 200 |
| `/Ep00Spike/TypeIdentity` | 401 | 403 | 200 |
| `/Ep00Spike/Manifests` | 401 | 403 | 200 |

Both `401` and `403` responses carried **zero body bytes**, on plugin routes and
on core routes alike. EP-01's rule that Jellyfin authorization failures stay
bare and unstructured is therefore a description of existing behaviour, not a
new constraint.

`Policies.DefaultAuthorization` **does not exist** in Jellyfin 12 — the spike
build failed on it, which is how this was found. `MediaBrowser.Common.Api.Policies`
does expose other constants (`LocalAccessOrRequiresElevation`,
`IgnoreParentalControl`, `Download` and more); the platform's *choice* to use only
`Policies.RequiresElevation` plus plain `[Authorize]` is a design decision
([ADR-0011](adr/0011-identity-and-authority.md)), not a finding. The roadmap's
reference to `DefaultAuthorization` is corrected wherever it appears.

## S10 — Host CORS is permissive

```
Access-Control-Allow-Origin : *
Access-Control-Allow-Headers: authorization
Access-Control-Allow-Methods: GET
```

Any web origin may call Jellyfin with a token it has obtained. The platform
cannot rely on same-origin as a security boundary; every request must be
authorized on its own merits. Recorded as threat **T-07**.

## S11 — Request-size and JSON-depth boundaries

| Body | Result |
|---|---|
| 1,000,000 bytes | `200` |
| 29,000,000 bytes | `200` |
| 30,000,000 bytes | `500` |
| nesting depth 200 | `200` with `{"accepted":false,…"maximum configured depth of 64 has been exceeded"}` |

Server log for the oversize case:

```
Jellyfin.Api.Middleware.ExceptionMiddleware: Error processing request:
Request body too large. The max request body size is 30000000 bytes.
URL POST /Ep00Spike/Echo.
```

Two findings. Kestrel's 30,000,000-byte default is the only request-size limit a
plugin gets for free, and exceeding it surfaces as an **opaque `500`, not a
`413`**. `System.Text.Json`'s default maximum depth of 64 is a useful structural
bound but produces a parse error, not a protocol error. Platform v1 must impose
its own far smaller limits and map them to a structured `413`
([ADR-0002](adr/0002-protocol-and-version-negotiation.md)).

## S12 — Reverse-proxy base path

With `BaseUrl = /jf`:

| Request | Result |
|---|---|
| `/jf/System/Info/Public` | 200 |
| `/System/Info/Public` | 302 |
| `/jf/Ep00Spike/Discovery` | 200 |
| `/Ep00Spike/Discovery` | 302 |

Plugin routes inherit the host base path automatically; bare paths redirect. No
plugin-side work is required, and no absolute path may ever be hard-coded.

## S13 — Lifecycle matrix

Binding is resolved lazily, per request. Every case below was a full container
restart.

| Case | Binding | Invocation | Jellyfin |
|---|---|---|---|
| Host loads first | found, `diag=ok` | `ok=true` | healthy |
| **Load order reversed** (provider loads first) | found, `diag=ok` | `ok=true` | healthy |
| Provider `status: Disabled` | not bound, `provider present but status=Disabled` | `error=provider_absent` | healthy |
| Provider uninstalled | not bound, `no plugin with GUID … in IPluginManager.Plugins` | `error=provider_absent` | healthy |
| Provider upgraded `1.0.0.0 → 2.5.0.0` | rebound to the new version, `fingerprintBound=true` | `ok=true` | healthy |
| **Platform absent** (host removed, provider alone) | n/a — route `404` | n/a | healthy, **0 errors this boot** |

Load order was reversed by changing the provider's `meta.json` `name` — Jellyfin
sorts plugins by manifest `name`, not by directory name. An earlier attempt that
renamed only the *directories* did not change load order at all; that mistake is
recorded because it is an easy way to produce a false pass.

Disabled and uninstalled are distinguishable: a disabled plugin is still present
in `IPluginManager.Plugins` with `Manifest.Status = Disabled`, whereas an
uninstalled one is gone entirely. The platform must render these as different
states rather than collapsing both to "unavailable"
([ADR-0005](adr/0005-manifest-discovery.md)).

## S14 — Forged identity is fully resisted, but the token is in the claims

Every attempt below used a **non-admin** token and tried to make the server
resolve the *admin's* user id:

| Injection attempt | Resolved `Jellyfin-UserId` |
|---|---|
| `Jellyfin-UserId: <admin guid>` header | non-admin's own id |
| `X-Jellyfin-User-Id: <admin guid>` header | non-admin's own id |
| `X-Emby-Authorization: MediaBrowser UserId=<admin guid>` | non-admin's own id |
| `Cookie: jellyfin-userid=<admin guid>` | non-admin's own id |

The acting identity is derived from the access token alone. No header, cookie or
route value can change it. This is the foundation of
[ADR-0011](adr/0011-identity-and-authority.md).

**The finding that changes a design decision:** the `ClaimsPrincipal` handed to a
controller contains

```
Jellyfin-Token   = <the caller's access token, verbatim>
Jellyfin-IsApiKey = False
```

— that is, the caller's **raw bearer token**, plus device, client and version
attribution. Any design that passed the `ClaimsPrincipal`, the `HttpContext`, or
an unfiltered claims collection across the provider boundary would hand every
installed extension a working credential for the calling user. The provider
context in [ADR-0004](adr/0004-provider-invocation.md) is therefore
an explicit allow-list of derived values, never a pass-through, and this is
recorded as threat **T-05**.

## What this spike did not establish

Carried into later milestones rather than assumed.

1. **Byte-identical, same-version contract assemblies.** S2 used two *different*
   assembly versions. .NET load-context semantics say the same-version case
   behaves identically, but this spike did not show it.
2. **Collectible does not mean unloaded.** The contexts report
   `IsCollectible = true`, but nothing here proved Jellyfin unloads one on
   disable or uninstall without a restart. Every lifecycle case used a restart.
   → [#493](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/493)
3. **No concurrency or sustained load.** Every probe was sequential.
4. **No native or TV client was involved.** Nothing here supports any claim about
   Android TV, Roku, Kodi or Swift.
   → [#492](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/492)
5. **No declarative web contribution, sandboxed frame or `postMessage` broker.**
   Playwright is not provisioned here, so the browser half of EP-00's required
   verification did not run and
   [ADR-0007](adr/0007-declarative-web-contributions.md) decision 7 is marked
   deferred. → [#491](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/491)
6. **Version negotiation.** `/Ep00Spike/Discovery` returns a static
   `{min:1,max:1}` and nothing negotiates against it, so
   [ADR-0002](adr/0002-protocol-and-version-negotiation.md)'s highest-common-version
   rule and the `incompatible` registry state are unexercised.
7. **Proxy buffering was not shown to break SSE** (S7). Treated as an untested
   hypothesis, not as justification.
8. **Provider response size is unbounded** by the host (S6, `big`). A response cap
   is EP-04 work, not an existing property.
9. **Six of the eight lifecycle states** in
   [compatibility-terminology](compatibility-terminology.md#state-words) are design
   states with no probe. Only `absent` and `disabled` were shown distinguishable.
10. **TOCTOU on manifest reads.** S5 validates a path and then opens it; nothing
    re-validates on the open handle.

## Probe coverage of this file

`run-spike.sh` replays probes **A–I**, which cover S1–S7 and S9–S13. Three
results were produced by hand and are **not** scripted:

| Not scripted | Why |
|---|---|
| S7's nginx matrix | needs a second container and three proxy configurations |
| S13's `1.0.0.0 → 2.5.0.0` upgrade row | needs a second staged plugin version |
| S8's rejected header forms | the script covers the query-parameter forms only |

S14 (forged identity) **is** scripted, as probe J.
