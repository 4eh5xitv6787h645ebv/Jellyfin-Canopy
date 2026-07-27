# ADR-0009 — Packaging and kernel placement

Status: **proposed** (EP-00) · Owner: platform kernel · Evidence: [S1](../spike-evidence.md#s1--one-collectible-assemblyloadcontext-per-plugin), [S13](../spike-evidence.md#s13--lifecycle-matrix)

## Context

Three things have to be packaged: the **kernel** (which the charter places inside
Canopy behind a host adapter), an **extension** (a second Jellyfin plugin), and
the **developer-facing artifacts** (SDK helpers, schemas, samples).

Jellyfin 12 constrains all three:

- one unnamed collectible `AssemblyLoadContext` per separately installed plugin;
- plugin metadata is `meta.json` — `guid`, `name`, `version`, `targetAbi`,
  `status`, `assemblies`, and nothing else useful;
- `targetAbi` is a **minimum** server version with **no ceiling**;
- **no dependency declaration mechanism exists** between plugins;
- load order is alphabetical by manifest `name` — deterministic, undocumented,
  untested, and an emergent property of a private sort call.

## Decision

### Kernel

Ships inside `Jellyfin.Plugin.JellyfinCanopy`, behind a single host-adapter
interface so the kernel never references `MediaBrowser.*` directly. Rationale and
migration path are in the [charter §6](../charter.md#6-kernel-placement-decision).

### Extension

An extension is an **ordinary Jellyfin 12 plugin** with three additions:

1. `jellyfin-canopy-extension.json` in its plugin root
   ([ADR-0005](0005-manifest-discovery.md));
2. an entrypoint type registered by concrete type in its own
   `IPluginServiceRegistrator` ([ADR-0004](0004-provider-invocation.md));
3. a declared platform protocol range.

It is installed, updated, disabled and removed by Jellyfin's normal plugin
mechanisms. The platform adds no installer, no package feed and no update channel.

### Compatibility declaration

Because `targetAbi` has no ceiling and there is no inter-plugin dependency
mechanism, compatibility is declared **in the extension manifest**, as a platform
protocol range, and enforced by the kernel at registration. Jellyfin's own
metadata is not asked to express something it cannot.

### SDK artifacts

- checked-in **OpenAPI + JSON Schemas** — the runtime source of truth;
- **source-only / generated** C# helpers, so nothing becomes a shared runtime
  type ([ADR-0003](0003-json-abi.md));
- a TypeScript client/web-adapter SDK, and Kotlin models where practical;
- SDK versions **locked** to the protocol/schema version they were generated
  from; a mismatch fails the build rather than degrading silently.

### Load order

**Load order is never depended on.** Binding is lazy and per-invocation
([ADR-0004](0004-provider-invocation.md)), which is what let every permutation in
the [lifecycle matrix](../spike-evidence.md#s13--lifecycle-matrix) pass. The
kernel must tolerate an extension registering before it does.

## Rationale

- Riding Jellyfin's plugin lifecycle means install, update, disable, uninstall
  and the admin UI are all free and already familiar. Building a parallel
  installer would mean owning code signing, integrity and update distribution —
  all program non-goals.
- Declaring compatibility in our own manifest is the only place with room for it,
  and it keeps the kernel — not the host — as the enforcement point.
- Locking SDK to schema version prevents the specific failure where a consumer's
  generated models drift from the wire format and produce validation errors that
  look like server bugs.

## Consequences

- Two manifests per extension (`meta.json` + the extension manifest). Duplication
  is bounded, and the fingerprint check turns it into a consistency guarantee.
- Extension developers need Jellyfin plugin-packaging knowledge. The scaffolding
  templates in EP-09 exist to make that a template rather than research.
- The kernel version and the plugin version are the same number today. When the
  kernel is extracted they diverge, which is why the protocol version — not the
  plugin version — is what consumers negotiate against
  ([ADR-0002](0002-protocol-and-version-negotiation.md)).

## Rejected alternatives

- **Kernel as a separate plugin now.** Rejected for v1 —
  [charter §6](../charter.md#6-kernel-placement-decision). Short version: it
  would force the ABI to be depended on before it was ever exercised, and there
  is no mechanism to express the resulting load-order dependency.
- **A shared runtime SDK NuGet package containing interfaces.** Rejected —
  [ADR-0003](0003-json-abi.md).
- **Naming the kernel to win the load-order race.** Rejected — it works today,
  is undocumented and untested, and buys nothing that lazy binding does not.
- **A Canopy-specific extension installer or package feed.** Rejected: a
  marketplace and remote code distribution are explicit program non-goals.
- **Requiring extensions to pin an exact Canopy version.** Rejected: it converts
  every Canopy patch release into a coordinated release for every extension.
