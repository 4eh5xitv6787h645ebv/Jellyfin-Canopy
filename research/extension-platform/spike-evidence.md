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

## S5 — Path containment holds against traversal, symlinks and link cycles

`GET /Ep00Spike/Traversal`. The fixtures live in `/config/ep00-linktests`,
**deliberately outside every plugin directory** — see the startup hazard below.
The containment function takes its root as a parameter, so a controlled directory
exercises exactly the code path a plugin root would.

| Candidate | Accepted | Rejected by |
|---|---|---|
| `jellyfin-canopy-extension.json` | no | absent (no manifest in the fixture root) |
| `../jellyfin-canopy-extension.json` | no | containment |
| `../../../../../../etc/passwd` | no | containment |
| `..\..\..\etc\passwd` | no | containment |
| `subdir/../../escape.json` | no | containment |
| `/etc/passwd` | no | absolute path |
| `manifest.json\0/etc/passwd` | no | embedded NUL |
| `escape-dir/passwd` (`escape-dir -> /etc`) | no | **symlink escapes root** |
| `escape-file` (`-> /etc/hostname`) | no | **symlink escapes root** |
| `hop-etc/openssl.cnf` (two hops, both links inside the root) | no | **symlink escapes root** |
| `cycle` (`cycle -> cycle2 -> cycle`) | no | **unresolvable link target (IOException)** |
| `inside-file` (`-> inside.json`) | **yes** | — correctly *not* a false positive |

**Four defects were found here and fixed rather than documented away.** Each was
found by a review of the probe, not by the probe, which is itself the point.

1. **Windows separators were never evaluated.** `..\..\..\etc\passwd` originally
   reported `absent`, because a backslash is a legal filename character on Linux,
   so the candidate resolved to a missing file *inside* the root. A pass for the
   wrong reason reads exactly like a real pass. Separators are now normalised
   first.
2. **A symlinked directory component escaped entirely.** `Path.GetFullPath` is
   lexical and `FileInfo.LinkTarget` sees only the leaf, so `escape-dir/passwd`
   passed containment and the reader returned `/etc/passwd` with
   `reason=accepted`.
3. **One resolution pass was not enough.** After fixing (2), a *two-hop* chain
   still escaped: resolving one component introduces new components that are
   themselves links. `hop-etc -> <root>/hop-root/ssl` with `hop-root -> /etc` —
   both links inside the root, neither target lexically outside it — resolved to
   `/etc/ssl` only on the second pass. Resolution now runs to a fixed point,
   bounded at 40 passes.
4. **A link cycle threw out of the reader.** A loop passes `File.Exists` (which
   lstats) and the size cap (the link string is short), so `File.ReadAllText` was
   the first thing to fail — and `Discover()` has no `try`/`catch` around its
   per-plugin loop, so one plugin root containing a loop would have taken manifest
   discovery down for *every* plugin. It is now a rejection.

**A startup hazard found by accident, worth recording.** An earlier version of
this probe created its fixtures inside the host plugin's own directory. With a
link to `/` among them, **Jellyfin did not start** — the plugin loader walks
plugin roots looking for assemblies and followed it. A plugin package that ships
a symlink can therefore prevent the server from booting. Related to
[T-16](threat-model.md#t-16--plugin-directory-deletion-by-manifest-name-collision--high-accepted),
and the reason the fixtures moved out of `/config/plugins`.

The spike's remaining TOCTOU gap is closed by #647's production reader: the
opened descriptor is the authority, its resolved target must remain inside the
verified root, descriptor state is compared before and after the bounded read,
and a fresh Jellyfin host snapshot must still match before an immutable bound
observation can be returned. The pre-open resolution is defense in depth only.

## S6 — Provider failure modes all map to bounded host errors

`GET /Ep00Spike/Invoke`, host deadline 2000 ms:

| Operation | Result |
|---|---|
| `ping` | `ok=true elapsed=1ms chars=280` |
| `throw` | `ok=false error=provider_faulted` |
| `invalid-json` | `ok=false error=provider_response_invalid_json` — validated *before* leaving the boundary |
| `unknown-op` | `ok=true` — the provider answered `{"ok":false,"error":"unknown_operation"}`; an unknown operation is a provider-level answer, not a transport fault |
| `big` (2 MB) | `ok=true chars=2000021` — no host-imposed response cap exists yet |
| `hang` (8 s, ignores cancellation) | `ok=false error=provider_deadline_exceeded elapsed=2257ms` |
| `cancellable-hang` (8 s, honours cancellation) | `ok=false error=provider_cancelled elapsed=2003ms` |
| caller aborts mid-call | `caller_cancelled` — never charged to the provider, even when the provider is *also* running away |
| entrypoint returns `Task` rather than `Task<string>` | `provider_abi_mismatch` — an ABI violation, not a null result |

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

The binder now awaits the provider's own task with `WaitAsync(deadline + grace)`
and branches on the outcome. Cooperation *is* observable.

Two follow-on defects surfaced when the fixed binder was re-reviewed, and both
are the kind that only bite in production:

- a **caller abort against an uncooperative provider** still reached the timeout
  branch first, so a client closing its connection was charged to the provider
  and would have tripped its circuit breaker for someone else's network problem;
- `provider_cancelled` was assigned to *any* `OperationCanceledException`,
  including one the provider raised on its own unrelated token, and depended on
  whether the entrypoint happened to be `async`.

Both are now guarded on which token actually fired.
[ADR-0004](adr/0004-provider-invocation.md) lists every resulting code and records
the racing shape as a rejected alternative, because an EP-04 implementer would
otherwise write it again.

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

## S15 — Hot lifecycle: nothing is ever unloaded, and disable needs a restart

Replay with [`spikes/ep-00/run-hot-lifecycle.sh`](spikes/ep-00/run-hot-lifecycle.sh).
Every transition below was driven through Jellyfin's **own admin endpoints** on a
running server, with exactly one restart at the start and one at the end to show
the contrast. A blocking GC with finalizers ran before each snapshot, so a
collectible context had every chance to go away.

| Transition | `pluginPresent` | `pluginStatus` | assembly loaded | DI resolves | invoke | contexts | first-seen ALC alive |
|---|---|---|---|---|---|---|---|
| baseline | true | `Active` | true | true | `ok` | 3 (2 collectible) | true |
| `POST …/Disable` | true | **`Restart`** | true | true | `provider_absent` | 3 | true |
| `POST …/Enable` | true | **`Restart`** | true | true | `provider_absent` | 3 | true |
| `DELETE …` (uninstall) | **false** | — | — | false | `provider_absent` | **3** | **true** |
| drop a new plugin directory in | false | — | — | false | `provider_absent` | 3 | true |
| restart | true | `Active` | true | true | `ok` | 3 | true |

Four results, and three of them contradict an assumption the earlier documents
made.

**1. The collectible context is never unloaded.** This is the headline. After the
plugin was uninstalled and its directory deleted from disk, the weak reference
taken at first sight was *still alive*, still holding two assemblies, and the
collectible-context count never moved. `IsCollectible = true` means the runtime
*may* unload a context; it does so only when the context is explicitly unloaded
and nothing references it. Jellyfin never unloads one. **An extension's code stays
in the process for the lifetime of the server**, whatever the registry says.

**2. Disable does not mean disabled — it means `Restart`.** The status flips to
`PluginStatus.Restart`, not `Disabled`. The instance is still there, the assembly
is still loaded, and Jellyfin's DI still hands out the registered singleton. The
only thing that changed is a string in the manifest. A platform that treats
"disabled" as "cannot run" and does nothing else would keep invoking a disabled
extension.

**3. Enable-after-disable also requires a restart.** `POST …/Enable` returned
`204` and left the status at `Restart`. There is no runtime path back to `Active`.

**4. Runtime install is not discovered.** Dropping a fully formed plugin directory
into `/config/plugins` on a running server did nothing; the plugin appeared only
after the restart.

**What this means for the platform.** Three things:

- The registry's `disabled`, `revoked` and `absent` states must be **enforced by
  the kernel at invocation**, not inferred from the host. The spike's binder was
  already right to refuse on `Manifest.Status != Active` — that check is the only
  reason `provider_absent` came back instead of a successful call to a plugin the
  administrator had just disabled.
- `Restart` is a **ninth lifecycle state** the compatibility terminology did not
  have: *administratively changed, pending a restart to take effect*. It is
  observably different from `disabled` and must be surfaced to an admin as "this
  needs a restart", not as a completed action.
- **Revocation cannot reclaim memory or stop loaded code.** It can only stop the
  kernel from calling it. Any wording promising that a revoked extension "stops
  working" must mean "stops being invoked by the platform", which is a strictly
  weaker claim, and is now the wording used.

Recorded against [#493](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/493).

## S16 — The manifest read is a TOCTOU, and a FIFO stalls it

Replay: probe K in [`spikes/ep-00/run-spike.sh`](spikes/ep-00/run-spike.sh). The
containment decision now lives in one place —
[`PathContainment`](spikes/ep-00/Jellyfin.Plugin.Ep00Host/PathContainment.cs) —
so EP-03 inherits it rather than re-deriving it.

### The race is real, not theoretical

A background task alternates one filename inside the root between an honest file
and a symlink pointing outside it, while a reader loops. 4,000 iterations,
~21,000 swaps, under half a second:

| Read order | successful reads | **leaks** | torn reads | rejections |
|---|---|---|---|---|
| validate the path, then open it | 2,200 | **369** | ~400 | — |
| open it, then validate the descriptor | 188 | **0** | 32 | 1,843 |

The obvious order leaked the contents of a file outside the plugin root on **17%
of its successful reads**. An extension can trigger this whenever it likes: it
controls the files in its own directory, and the kernel reads manifests on a
schedule the extension does not control but can observe.

The correct order opens first and then decides about the **open descriptor**, via
`/proc/self/fd`. Three details are load-bearing:

- **Fail closed when the descriptor cannot be described.** A deleted inode
  resolves to `"<path> (deleted)"`. Falling back to the pre-open decision there is
  exactly the hole being closed — that is *precisely* when the pre-open decision is
  least trustworthy. An earlier version kept the fallback and leaked on ~17% of its
  reads, i.e. it fixed nothing.
- **Resolve only the first hop of `/proc/self/fd/N`.** That link *is* the answer;
  following further re-introduces a resolution the descriptor has already settled.
- **Torn reads are not leaks.** The writer truncates before writing, so a reader
  can legitimately see an empty file. An earlier version counted those as leaks and
  made a working fix look broken. Only content matching the file *outside* the root
  counts.

The 1,843 rejections are the fix working: under contention the safe reader mostly
declines rather than guessing. A real kernel retries; it does not relax the check.

### A named pipe stalls the reader

| Candidate | Result |
|---|---|
| `fifo` (a `mkfifo` named pipe) | `rejected: open blocked (not a regular file?)` |

`open(2)` on a FIFO **blocks until a writer appears**. A plugin that ships a named
pipe called `jellyfin-canopy-extension.json` would hang the reader indefinitely —
and discovery iterates every plugin, so one such file stalls discovery for all of
them. The spike bounded the open and refused the candidate. The production #647
reader instead avoids the blocking content open entirely: it opens metadata with
nonblocking/descriptor semantics, rejects non-regular types, and accepts only an
explicit local-filesystem allow-list on Linux or fixed local drives on Windows.
Classification itself still requires a first root lookup, and this does not claim
that in-process code can kill a synchronous kernel/driver operation after the OS
accepts it or safely reclaim buffers before cancelled Windows I/O completes. That
host-availability residual is recorded in ADR-0005 and the threat model and tracked
by #648. Directories are rejected before content reading.

Two related notes: a 5,000-character name is refused by the platform
(`PathTooLongException`), and neither Unicode normalisation form of `café.json`
collides with the other, so containment does not depend on filesystem
normalisation behaviour.

### Shapes that are accepted, and should be

`./inside.json`, `sub/./../inside.json`, `inside.json/` and `inside.json/.` all
resolve inside the root and are accepted. `.` is refused as a directory and `..`
by containment.

Recorded against [#494](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/494).

## S17 — Browser: slots render idempotently, the frame is genuinely isolated, and there is no CSP

Replay with [`spikes/ep-00/run-web-spike.sh`](spikes/ep-00/run-web-spike.sh). It
builds Canopy, brings up the repository's **own** dockerized Jellyfin 12
(`e2e/docker`), seeds it, and runs a throwaway Playwright spec against the real
web client. The spec lives under `research/` with its own Playwright config so it
can never join the required E2E suite.

**Correcting an earlier claim:** EP-00 said "Playwright is not provisioned in this
environment". That was wrong — it is a dependency of the repository and needed
only `npm ci`. The browser half of EP-00's required verification was skipped for a
reason that did not hold.

### Jellyfin 12 serves no CSP

```
content-security-policy : (absent)
x-frame-options         : (absent)
```

Nothing constrains what script in the app shell may do. For the platform this cuts
both ways: there is no CSP to design a broker *within*, and equally no CSP that
would contain a misbehaving contribution. **An opaque-origin iframe is the only
isolation primitive actually available in the browser**, which raises the value of
the deferred sandboxed-frame design rather than lowering it.

### The facade is exactly as unprotected as the charter claimed

```
rootIsFrozen    : false
coreIsFrozen    : false
rootIsWritable  : true      ← page script replaced JC.escapeHtml and it took effect
hasVersionField : false
pluginVersion   : 2.0.0.0
```

Every claim [the charter](charter.md) made from reading the source is confirmed in
a live browser. `window.JellyfinCanopy` is described in `src/facade.ts` as the
"STABLE, FROZEN public surface"; at runtime it is an ordinary mutable object whose
members any script on the page can replace — including `escapeHtml`, which the
repository's own XSS guards route through. It also carries **no API version
field**, so a consumer cannot ask what it is talking to.

### A declarative descriptor renders correctly through the existing primitive

A v1-shaped descriptor — no markup, no selectors, no script, and a deliberately
hostile label of `Request <img src=x onerror=alert(1)>`:

| Property | Result |
|---|---|
| mount called 3× → nodes rendered | **1** (idempotent) |
| hostile label rendered as | **text**; child elements created: **0** |
| injected script executed | **no** |
| after `handle.remove()` → nodes | **0** (teardown really tears down) |
| two vendors' contributions coexisting | **1 each, no collision** |

This is the evidence ADR-0007 decisions 1–6 were missing. Canopy's
`ensureInjected` supports the slot model directly, mounting is idempotent by key,
teardown is real, and host-owned rendering neutralises a hostile label without the
extension being trusted.

**A contract gotcha worth writing down.** `buildFn` must **attach the node itself
and return it** — the injector only stamps `data-jc-key`, it does not append.
Returning a detached element renders nothing, silently. The first version of this
spike did exactly that and measured zero nodes. EP-07's renderer must not repeat
it.

### The opaque-origin frame denies everything it should

An `<iframe sandbox="allow-scripts">` — deliberately **without**
`allow-same-origin`:

| Probe | Result |
|---|---|
| frame's `location.origin` | `"null"` (opaque) |
| frame reads `parent.document` | **false** |
| frame reads `parent.localStorage` | **false** |
| frame reads `parent.ApiClient.accessToken()` | **false** |
| host reads `frame.contentWindow.document` | **false** |
| every inbound message attributable to its frame | **true** (`event.source` identity) |
| inbound `event.origin` | `"null"` |
| host → frame message delivered | **true** |

The isolation is mutual: the frame cannot reach the host, and the host cannot
reach the frame, which is precisely what makes `postMessage` the only channel and
therefore a place a capability filter can sit. `event.origin` is `"null"` for
every opaque frame, so **origin is useless for attribution** — a broker must key on
`event.source` identity, comparing against the frame elements it created.

Recorded against [#491](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/491).

## S18 — A headless native client can drive the protocol, and every refusal is distinct

Replay: probe L in [`spikes/ep-00/run-spike.sh`](spikes/ep-00/run-spike.sh), which
runs [`spikes/ep-00/native/fixture.py`](spikes/ep-00/native/fixture.py) against a
minimal server surface (negotiate / catalog / invoke). The fixture speaks only
HTTP and JSON and renders nothing — which is the only thing a fixture can honestly
prove about a protocol. **20 checks, 20 passed.**

### Negotiation and graceful omission

| Behaviour | Result |
|---|---|
| client `1–2`, host `1–2` | negotiates **2** |
| client `1–1` | negotiates **1** — an older client is not refused |
| client `9–9` | `protocol_incompatible`, with both ranges echoed |
| client declares only `row` | receives **only** rows |
| components it cannot render | reported in `componentsOmitted` **by name** |
| contributions it cannot render | reported in `omitted` with `component_not_supported_by_client` |

Omission is explicit in both directions. A client author can see *what* was
withheld and *why*, instead of wondering why a surface never appears — which is
the failure mode that makes optional protocol features undebuggable.

### The descriptor is sufficient to render

A paginated row carries **item references only** (`itemId` + label), never rendered
content, so the client fetches and draws with its own SDK. Paging reports
`page`, `pageSize`, `totalItems` and `hasMore`, and the final page correctly says
`hasMore: false`. A detail action carries a native-renderable confirmation
(`title`, `confirmLabel`, `cancelLabel`) and an **opaque capability** — the string
`method` appears nowhere in it.

### Every refusal is its own machine code

| Situation | Code |
|---|---|
| valid capability, first use | accepted |
| same capability again | `action_replayed` |
| no capability supplied | `action_missing` |
| tampered signature | `action_signature_invalid` |
| another user's capability | `action_wrong_user` |
| the extension behind it is down | `provider_unavailable` |
| unauthenticated | bare **401** — not a malformed catalog |

`action_wrong_user` and `action_expired` are deliberately separate: a client
retries one and re-authenticates for the other.

### Two design defects the fixture caught

Both would have shipped unnoticed without a client actually driving the protocol.

1. **A delimiter-sensitive capability format.** The first version joined
   `operationId`, `userId` and `expiry` with `.` and split on it. The operation id
   was `ep00.action.request` — which contains dots — so **every valid capability
   decoded as malformed**. The payload is now base64url-encoded with a unit
   separator between fields. A capability format must not be delimiter-sensitive to
   values its issuer does not control.
2. **Single-use protection rejecting a legitimate second action.** Two capabilities
   minted in the same second for the same `(operation, user)` were byte-identical,
   so the replay check refused the second one. Each capability now carries a nonce.
   This is the kind of defect that appears only under a real client's usage
   pattern — fetch catalog, act, fetch catalog, act.

### What this does not prove

Nothing about any real client. No Android TV, Roku, Kodi or Swift code was
involved. The fixture proves the protocol is *implementable* by a client that
executes no downloaded content; the [client
matrix](supported-client-matrix.md#the-first-native-adopter) records the
first-party Android TV fork as the adopter that will test whether it is
*pleasant* to implement.

Recorded against [#492](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/492).

## What this spike did not establish

Carried into later milestones rather than assumed.

1. **Byte-identical, same-version contract assemblies.** S2 used two *different*
   assembly versions. .NET load-context semantics say the same-version case
   behaves identically, but this spike did not show it.
2. ~~Collectible does not mean unloaded.~~ **Answered by
   [S15](#s15--hot-lifecycle-nothing-is-ever-unloaded-and-disable-needs-a-restart):**
   the context is never unloaded, disable and enable both need a restart, and a
   runtime drop-in install is not discovered.
3. **No concurrency or sustained load.** Every probe was sequential.
4. **No native or TV client was involved**, and that is still true —
   [S18](#s18--a-headless-native-client-can-drive-the-protocol-and-every-refusal-is-distinct)
   proves the protocol is implementable, not that any client implements it.
5. ~~No declarative web contribution, sandboxed frame or `postMessage` broker.~~
   **Done — see [S17](#s17--browser-slots-render-idempotently-the-frame-is-genuinely-isolated-and-there-is-no-csp).**
   The "Playwright is not provisioned" reason was simply wrong; it needed `npm ci`.
   Still unproven: rendering across the legacy, mobile and Web-TV layouts, and
   behaviour under a11y and localisation requirements.
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
10. ~~TOCTOU on manifest reads.~~ **Closed by
    [S16](#s16--the-manifest-read-is-a-toctou-and-a-fifo-stalls-it):** the race is
    demonstrated, the fix is measured at zero leaks, and the containment decision is
    now a single shared function.

## Probe coverage of this file

`run-spike.sh` replays probes **A–J**, covering S1–S6, S8–S14 and the S7 direct
case. Two results were produced by hand and are **not** scripted:

| Not scripted | Why |
|---|---|
| S7's nginx proxy matrix | needs a second container and three proxy configurations |
| S13's `1.0.0.0 → 2.5.0.0` upgrade row | needs a second staged plugin version |

S8's rejected header forms and S10's CORS response are covered by probe A; S14
(forged identity) is probe J.
