# EP-00 spike evidence

Tracking issue: [#39](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/39)
Roadmap board: [Jellyfin Elevate Extension Platform](https://github.com/users/4eh5xitv6787h645ebv/projects/3)

Every architectural claim in [`charter.md`](charter.md), [`adr/`](adr/) and
[`threat-model.md`](threat-model.md) that depends on how Jellyfin 12 actually
behaves is answered here by a live result, not by reading source. Where a probe
refuted an assumption, the refutation is recorded rather than removed.

## How this was produced

- Two throwaway plugins in [`spikes/ep-00/`](spikes/ep-00/): a **host** standing
  in for the platform kernel, and an independently packaged **provider**. They
  share no project reference and no repository code.
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
context. Only three contexts existed even though six server-bundled plugins were
also loaded, so server-bundled plugins do not each get their own context — this
is a property of separately installed plugin directories.

Both copies of the same-named assembly were loaded, side by side:

```
Loaded assembly SpikeContracts, Version=1.0.0.0 … from /config/plugins/Ep00SpikeHost_1.0.0.0/SpikeContracts.dll
Loaded assembly SpikeContracts, Version=2.0.0.0 … from /config/plugins/Ep00SpikeProvider_1.0.0.0/SpikeContracts.dll
```

## S2 — No shared type identity, and the failure is silent

```
sameFullName                      : True
referenceEqualTypes               : False
hostTypeIsAssignableFromProviderType : False
directCastSucceeded               : False
directCastError                   : Unable to cast object of type
                                    'Jellyfin.Plugin.Ep00Provider.Ep00ProviderEntrypoint'
                                    to type 'Ep00.Contracts.IExtensionProvider'.
```

Two types with an identical fully qualified name are **not** the same type. A
cast throws `InvalidCastException`; an `IsAssignableFrom` check simply answers
`false`.

The independent load-context harness in
`/home/jake/docs/jellyfinv12` (recorded during EP-00 research, not part of this
repository) establishes the sharper form of the same result: this happens even
when the two plugins ship a **byte-identical** contract assembly at the *same*
version, and the DI consequence of asking for the host's own copy of the
interface is a silent `null` — no exception, no log entry, no `Malfunctioned`
status. See [ADR-0003](adr/0003-json-abi-and-provider-invocation.md).

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
invoked it reflectively over `string` in / `string` out. This is the only
binding path that worked, and it is the basis of
[ADR-0003](adr/0003-json-abi-and-provider-invocation.md).

## S4 — Manifest discovery binds to the real plugin identity

`GET /Ep00Spike/Manifests`:

```
EP-00 Spike Host     root=/config/plugins/Ep00SpikeHost_1.0.0.0
                     manifestFound=false  reason=absent: no manifest at jellyfin-canopy-extension.json
EP-00 Spike Provider root=/config/plugins/Ep00SpikeProvider_1.0.0.0
                     manifestFound=true   reason=accepted
                     manifestId=ep00.spike.provider  manifestVersion=1.0.0
                     declaredPluginId=b1a7c3d2-4e5f-4a6b-8c9d-0e1f2a3b4c5d
                     fingerprintBound=true
```

The reader never scans a path of its own choosing: the root is whatever
`IPluginManager` reports for that plugin, and the manifest's self-declared
`pluginId` is checked against the GUID Jellyfin reports. A manifest that claims
someone else's identity is detected, not trusted.

## S5 — Traversal is rejected before any file is opened

`GET /Ep00Spike/Traversal`:

| Candidate | Accepted | Reason |
|---|---|---|
| `jellyfin-canopy-extension.json` | no | absent (host ships none) |
| `../jellyfin-canopy-extension.json` | no | resolves outside plugin root |
| `../../../../../../etc/passwd` | no | resolves outside plugin root |
| `..\..\..\etc\passwd` | no | absent — see caveat |
| `subdir/../../escape.json` | no | resolves outside plugin root |
| `/etc/passwd` | no | absolute path |
| `manifest.json\0/etc/passwd` | no | embedded NUL in name |

**Caveat, recorded rather than hidden:** the Windows-style separator case was
rejected only because a backslash is a legal filename character on Linux, so the
candidate resolved to a non-existent file inside the root. It did not exercise
the containment check. EP-03 must normalise separators before the containment
test rather than rely on this.

## S6 — Provider failure modes all map to bounded host errors

`GET /Ep00Spike/Invoke`, host deadline 2000 ms:

| Operation | Result |
|---|---|
| `ping` | `ok=true elapsed=1ms bytes=280` |
| `throw` | `ok=false error=provider_faulted` (`InvalidOperationException` surfaced as a stable code) |
| `invalid-json` | `ok=false error=provider_response_invalid_json` — response validated *before* leaving the boundary |
| `unknown-op` | `ok=true` — the provider answered `{"ok":false,"error":"unknown_operation"}`; unknown operations are a provider-level answer, not a transport fault |
| `big` (2 MB) | `ok=true bytes=2000021` — no host-imposed response cap exists yet |
| `hang` (8 s, ignores cancellation) | `ok=false error=provider_deadline_exceeded elapsed=2004ms` |
| `cancellable-hang` (8 s, honours cancellation) | `ok=false error=provider_deadline_exceeded elapsed=2000ms` |

**The load-bearing negative result:** the host returned on time in both hang
cases, but the provider `Task` kept running in-process and could not be killed.
The two cases are also indistinguishable from the caller's side. A deadline
protects the *caller*, never the *server*. This is why
[ADR-0003](adr/0003-json-abi-and-provider-invocation.md) treats providers as
trusted in-process code and the [threat model](threat-model.md) records
"malicious installed plugin" as out of scope for containment.

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

`Policies.DefaultAuthorization` **does not exist** in Jellyfin 12; the only
policy constant a plugin needs is `Policies.RequiresElevation`, with plain
`[Authorize]` for "any signed-in user". This is corrected wherever the roadmap
issues assume otherwise.

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
([ADR-0002](adr/0002-protocol-version-negotiation.md)).

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
([ADR-0004](adr/0004-manifest-discovery-and-registry-binding.md)).

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
[ADR-0007](adr/0007-identity-and-authority.md).

**The finding that changes a design decision:** the `ClaimsPrincipal` handed to a
controller contains

```
Jellyfin-Token   = fa886739976743cfb1eaf4475302b68c
Jellyfin-IsApiKey = False
```

— that is, the caller's **raw bearer token**, plus device, client and version
attribution. Any design that passed the `ClaimsPrincipal`, the `HttpContext`, or
an unfiltered claims collection across the provider boundary would hand every
installed extension a working credential for the calling user. The provider
context in [ADR-0003](adr/0003-json-abi-and-provider-invocation.md) is therefore
an explicit allow-list of derived values, never a pass-through, and this is
recorded as threat **T-05**.

## What this spike did not establish

Carried into later milestones rather than assumed:

1. **Collectible does not mean unloadable in practice.** The contexts report
   `IsCollectible = true`, but nothing here proved Jellyfin actually unloads one
   on disable/uninstall without a restart. Every lifecycle case above used a
   restart. EP-03 must test hot disable.
2. **No concurrency or sustained load** was applied. Every probe was sequential.
3. **No native or TV client was involved.** Nothing here supports any claim
   about Android TV, Roku, Kodi or Swift behaviour — see the
   [supported-client matrix](supported-client-matrix.md).
4. **No declarative web contribution was rendered and no sandboxed frame or
   `postMessage` broker was exercised.** Playwright is not provisioned in this
   environment, so the browser-side half of EP-00's required verification is
   carried forward as its own child issue rather than claimed. The web ADRs
   ([ADR-0007](adr/0007-identity-and-authority.md) is unaffected;
   [ADR-0005](adr/0005-declarative-web-contributions.md) is the one at risk) are
   marked *provisional* until that child closes.
5. **Proxy buffering was not shown to break SSE** (S7). Treated as an untested
   hypothesis, not a justification.
6. **The provider response size was unbounded** by the host (S6, `big`). A
   response cap is an EP-04 requirement, not something that exists today.
