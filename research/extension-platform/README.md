# Canopy Extension Platform — EP-00 output

Tracking issue: [#39 — EP-00](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/39)
Roadmap board: [Jellyfin Elevate Extension Platform](https://github.com/users/4eh5xitv6787h645ebv/projects/3)

> **Scope decided 2026-07-28:** v1 is **native-first** — EP-01, EP-02, EP-06 and
> EP-08 only. See [ADR-0012](adr/0012-native-first-scope.md). Everything else is
> deferred, not cancelled.

**Nothing described here is implemented.** This directory is the decision record
for EP-00, the research milestone that has to be finished before any platform
code is written. Every document is *proposed* until its milestone's exit gate.

## Start here

| Document | What it answers |
|---|---|
| [`charter.md`](charter.md) | why this exists, who it serves, what v1 is and is not, where the kernel lives |
| [`spike-evidence.md`](spike-evidence.md) | what Jellyfin 12 actually does — 14 live probes against a disposable server |
| [`threat-model.md`](threat-model.md) | trust zones, data flow, 15 threats with residual ratings |
| [`capability-inventory.md`](capability-inventory.md) | what exists, what is feasible, what needs client adoption, what the host will never give us |
| [`supported-client-matrix.md`](supported-client-matrix.md) | which clients can actually see an extension |
| [`v1-capability-freeze.md`](v1-capability-freeze.md) | the bounded list of what v1 contains |
| [`risk-register.md`](risk-register.md) | delivery and design risk, with owners |
| [`compatibility-terminology.md`](compatibility-terminology.md) | the words, used precisely |
| [`milestone-82-disposition.md`](milestone-82-disposition.md) | why user scripts are superseded, not adopted |

## Decision records

| ADR | Subject | Status |
|---|---|---|
| [0001](adr/0001-route-prefix-and-namespace.md) | route prefix and namespace | proposed |
| [0002](adr/0002-protocol-and-version-negotiation.md) | protocol, version negotiation, error envelope | proposed |
| [0003](adr/0003-json-abi.md) | the load-context-safe JSON ABI | proposed |
| [0004](adr/0004-provider-invocation.md) | provider binding and failure isolation | proposed |
| [0005](adr/0005-manifest-discovery.md) | manifest discovery and registry binding | proposed |
| [0006](adr/0006-client-event-transport.md) | client event transport | proposed |
| [0007](adr/0007-declarative-web-contributions.md) | declarative web contributions | proposed (1–6); the sandboxed-frame decision **deferred, not in v1** |
| [0008](adr/0008-storage-ownership.md) | storage ownership | proposed |
| [0009](adr/0009-packaging-and-kernel-placement.md) | packaging and kernel placement | proposed |
| [0010](adr/0010-deprecation-and-support-policy.md) | deprecation and support policy | proposed |
| [0011](adr/0011-identity-and-authority.md) | identity and authority | proposed |
| [0012](adr/0012-native-first-scope.md) | **native-first scope for v1** | **accepted** |

## The five results that shaped everything

1. **No shared type identity.** One collectible `AssemblyLoadContext` per plugin.
   Two plugins shipping the same interface get two unrelated types, and asking DI
   for the host's copy returns a **silent `null`** — no exception, no log, no
   plugin status change. A shared contracts DLL is dead.
   ([S2](spike-evidence.md#s2--no-shared-type-identity-and-the-failure-is-silent))
2. **But cross-plugin invocation works** — by resolving the provider's *own*
   concrete `Type` from its own assembly and invoking reflectively over strings.
   ([S3](spike-evidence.md#s3--cross-plugin-di-works-but-only-by-foreign-concrete-type))
3. **The claims principal contains the caller's raw bearer token.** Passing it to
   a provider would hand every extension a working credential. The provider
   context is an allow-list, never a pass-through.
   ([S14](spike-evidence.md#s14--forged-identity-is-fully-resisted-but-the-token-is-in-the-claims))
4. **A deadline protects the caller, not the server.** A provider that ignores
   cancellation kept running after the deadline fired and could not be killed.
   Cooperation *is* observable — but only if the kernel awaits the cancelled task
   instead of racing a timer against it, which the first version of this spike got
   wrong. Containment of a malicious plugin is not achievable.
   ([S6](spike-evidence.md#s6--provider-failure-modes-all-map-to-bounded-host-errors))
5. **Lazy binding survives everything.** Reversed load order, disable, uninstall,
   upgrade and a fully absent platform all behaved correctly, with Jellyfin
   healthy and zero boot errors — because nothing is resolved at startup.
   ([S13](spike-evidence.md#s13--lifecycle-matrix))

## Reproducing the evidence

```bash
research/extension-platform/spikes/ep-00/run-spike.sh 8199
```

Builds both throwaway plugins, runs a disposable Jellyfin 12 container, and
replays probes A–J. Three results — the nginx proxy matrix, the plugin-upgrade
row and the rejected authentication header forms — were produced by hand and are
listed as unscripted in
[the coverage table](spike-evidence.md#probe-coverage-of-this-file). It touches no
existing server and is never built by CI.

## Conventions

- This directory is **research**, outside the MkDocs site and outside the docs
  link checker. It is not user-facing documentation.
- Refuted assumptions and unproven areas are recorded as prominently as
  confirmed results. See
  [what the spike did not establish](spike-evidence.md#what-this-spike-did-not-establish).
- Identifiers here are the **real** ones (`JellyfinCanopy`), not the pre-rebrand
  names the roadmap issues still use. See
  [charter §0](charter.md#0-naming-before-anything-else).
