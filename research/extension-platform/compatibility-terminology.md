# Compatibility terminology

Tracking issue: [#39 — EP-00](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/39)
Status: **proposed** (EP-00)

The programme uses these words with exactly these meanings. Where a roadmap issue
uses a term loosely, this file is authoritative. Policy lives in
[ADR-0010](adr/0010-deprecation-and-support-policy.md).

## Version concepts — six, never conflated

| Term | What it versions | Who declares it | Where it appears |
|---|---|---|---|
| **Protocol version** | the request/response contract of Platform v1 | the kernel | the route (`/Platform/v1`) and negotiation |
| **Manifest schema version** | the shape of `jellyfin-canopy-extension.json` | the kernel | `schemaVersion` in the manifest |
| **Surface schema version** | the shape of one contribution or descriptor family | the kernel, per family | negotiation and each descriptor |
| **Host ABI version** | the Jellyfin API surface the kernel compiles against | Jellyfin | build metadata and the support matrix |
| **SDK version** | a generated helper package | the kernel's release process | package metadata; **locked** to the schema it was generated from |
| **Extension version** | one extension's own release | the extension author | `meta.json` and the extension manifest |

An extension's version says nothing about which protocol it speaks; that is
declared separately as a range.

## State words

These describe *why* something is unavailable. They are never collapsed into a
single "unavailable" — a user who can act on the difference must be able to see
it.

| State | Meaning | Observable difference |
|---|---|---|
| **Absent** | the platform, or the extension, is not installed | plugin not in `IPluginManager.Plugins`; platform route returns `404` |
| **Disabled** | installed but switched off by an administrator | still present with `Manifest.Status = Disabled` |
| **Pending** | discovered, awaiting admin approval | present, never invoked |
| **Incompatible** | present, but its declared protocol range does not intersect the kernel's | present, never invoked, with an actionable reason |
| **Unhealthy** | approved, but failing health probes | present, may be circuit-broken |
| **Quarantined** | isolated after repeated failures or corrupt state | present, not invoked, admin action required |
| **Revoked** | grants withdrawn; credentials invalid | present, all access refused immediately |
| **Unsupported** | works, but this capability does not exist on this client class | contribution omitted, never approximated |

Verified distinguishable in the [lifecycle
matrix](spike-evidence.md#s13--lifecycle-matrix): a disabled plugin reported
`provider present but status=Disabled`, an uninstalled one reported `no plugin
with GUID … in IPluginManager.Plugins`.

## Compatibility words

| Term | Meaning |
|---|---|
| **Backward compatible** | a consumer built against an older minor keeps working unchanged |
| **Forward compatible** | a consumer built against a newer minor tolerates an older server: unknown optional fields ignored, unsupported required capabilities disable only that contribution |
| **Additive change** | permitted inside a major — new optional fields, new operations, new enum members behind a capability flag, relaxed bounds |
| **Breaking change** | requires a new major — removal, rename, tightened bound, changed default, changed status or machine code, changed field meaning, optional becoming required |
| **Deprecated** | still works, announced for removal, carries `Deprecation` and `Sunset` headers |
| **Removed** | gone in a new major; the previous major stays supported under the N/N-1 window |
| **Compatibility surface** | an existing Canopy route or facade member kept working through an adapter over the same owning service — **not** a member of Platform v1 |
| **Supported** | a passing conformance run exists for that host version and client class |
| **Best effort** | it may work; nothing is tested; no support is offered |

## Client-reach words

Four distinct things, routinely conflated. See the [supported-client
matrix](supported-client-matrix.md).

| Term | Meaning |
|---|---|
| **Browser injection** | Canopy's script runs in the page — full reach |
| **WebView reach** | a native app hosting Jellyfin's web client inherits injection, with input and layout caveats |
| **Server-side effect** | ordinary Jellyfin data (tags, collections, playlists, segments) that every client sees with no adoption |
| **Native adoption** | the client's authors implemented the descriptor protocol in their own codebase |

Web TV mode in a browser is browser injection. It is **never** evidence of native
TV support.

## Words this programme does not use

| Avoid | Because |
|---|---|
| "sandboxed plugin" | an installed .NET plugin is not sandboxed; scopes reduce accidental exposure only |
| "secure by default" | unfalsifiable; state the specific control instead |
| "supports Android TV" | unless a conformance run exists for that client |
| "frozen" for `window.JellyfinCanopy` without qualification | it is frozen by a compile-time type assertion, not at runtime |
| "the platform guarantees" | the platform enforces what it can and documents what it cannot |
