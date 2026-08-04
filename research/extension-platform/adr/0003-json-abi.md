# ADR-0003 — The load-context-safe JSON ABI

Status: **accepted; provider contract frozen by EP-04.1, binding pending** · Owner: platform kernel · Evidence: [S1](../spike-evidence.md#s1--one-collectible-assemblyloadcontext-per-plugin), [S2](../spike-evidence.md#s2--no-shared-type-identity-and-the-failure-is-silent), [S3](../spike-evidence.md#s3--cross-plugin-di-works-but-only-by-foreign-concrete-type)

## Context

The tempting design is a shared `Canopy.Extensions.Contracts.dll` that both the
kernel and every extension reference, giving typed, compile-checked interop.

It cannot work, and EP-00 proved it rather than assuming it.

Jellyfin 12 gives **each separately installed plugin its own unnamed, collectible
`AssemblyLoadContext`** ([S1](../spike-evidence.md#s1--one-collectible-assemblyloadcontext-per-plugin)).
Two plugins each shipping `SpikeContracts.dll` — one at `1.0.0.0`, one at
`2.0.0.0` — both loaded successfully, side by side. Asking whether their
identically named `Ep00.Contracts.IExtensionProvider` types were the same type:

```
sameFullName                         : True
referenceEqualTypes                  : False
hostTypeIsAssignableFromProviderType : False
directCastSucceeded                  : False
directCastError : Unable to cast object of type
                  'Jellyfin.Plugin.Ep00Provider.Ep00ProviderEntrypoint'
                  to type 'Ep00.Contracts.IExtensionProvider'.
```

An independent load-context harness sharpened this further: the same split
happens when the contract assembly is **byte-identical at the same version**, and
resolving the host's own copy of the interface from DI returns a silent `null` —
no exception, no log entry, no `Malfunctioned` plugin status. There is also no
way to fix it from a plugin: an assembly-resolution hook on the default context
would work, but Jellyfin installs none, all plugin types are resolved before any
plugin code runs, and `[ModuleInitializer]` does not fire during load.

## Decision

**Only load-context-safe primitives cross the extension boundary.** That set is
exactly: `string`, UTF-8 JSON, `CancellationToken`, `Task`/`Task<string>`,
reflection metadata, and BCL primitives — all of which live in
`System.Private.CoreLib`, which is genuinely shared.

Concretely:

1. The wire form is **UTF-8 JSON in a `string`**, validated against a published
   JSON Schema on both sides of the boundary, in both directions.
2. **No interface, model, DTO, enum or delegate defined by the platform may be
   referenced by an extension at runtime.** A helper package may generate
   source, models and boilerplate — it must never become a runtime type-identity
   dependency.
3. The invocation signature is fixed by convention, matched reflectively:
   `Task<string> InvokeAsync(string operationId, string requestJson, CancellationToken cancellationToken)`.
4. A **dependency guard** fails the build of any sample or fixture that
   references a platform runtime assembly.
5. Operation payload schemas are provider-assembly embedded resources addressed
   by canonical lower-case SHA-256. The manifest carries the symbolic schema id
   and digest; the kernel-owned resource name is always
   `JellyfinCanopy.ProviderSchemas.{sha256}.json`. No manifest path, URL, CLR
   type, or resource name is executable or selectable.

## Rationale

- The failure mode is *silent*, which is worse than a crash: a version drift
  between two independently shipped extensions would produce a platform that
  quietly does nothing, with no diagnostic. Designing around it is not optional.
- Source generation gives back most of the ergonomics a shared DLL would have,
  without the identity coupling — the generated code compiles into the
  extension's own assembly, so there is nothing to share.
- JSON Schema validation on both sides is what converts "the types don't match"
  from a runtime cast exception into a structured, versioned protocol error.

## Consequences

- Serialization cost on every provider call. Bounded by the response caps in
  [ADR-0004](0004-provider-invocation.md) and by batching at the gateway.
- The SDK must be versioned in lockstep with the schema, and the schema — not the
  SDK — is authoritative.
- Contract tests need golden envelopes, because the compiler no longer checks
  anything across the boundary.

## Rejected alternatives

- **Shared contracts DLL.** Refuted by [S2](../spike-evidence.md#s2--no-shared-type-identity-and-the-failure-is-silent).
  Recorded here permanently so it is not re-proposed.
- **Ship the contract DLL only in the host and have extensions reference it
  without copying.** Refuted by the same harness: the assembly must be on the
  host's trusted platform assemblies list to be shared, and dropping it in the
  server directory does not achieve that.
- **`AssemblyLoadContext.Default.Resolving` hook to inject the contract.** Works
  in isolation, unreachable in practice — Jellyfin installs no such hook and all
  resolution happens before any plugin code runs.
- **Naming the kernel plugin `"AAA Platform"` to win the load-order race.** Load
  order *is* alphabetical by manifest `name`
  ([S13](../spike-evidence.md#s13--lifecycle-matrix)), so this would work today.
  Rejected: it is an emergent property of a private sort call, is nowhere
  documented or tested, and winning the race still does not buy an assembly
  resolution hook.
- **gRPC / named pipes / a local socket between plugins.** Rejected for v1:
  strictly more moving parts than an in-process reflective call, with no benefit
  the JSON ABI does not already provide.
