# ADR-0002 — Protocol, version negotiation and the error envelope

Status: **accepted and implemented** (EP-01) · Owner: platform kernel

## Context

There is no machine-readable description of Canopy's API — no OpenAPI, no JSON
Schema, no `[ProducesResponseType]`. There are at least **four coexisting
error-envelope shapes** (plus bare string bodies), **three pagination dialects**,
**three size-limit mechanisms** and **no correlation ID**. Consumers today reverse-engineer prose.

Two host behaviours constrain any answer:

- Authorization failures are **bare**: `401` and `403` return zero body bytes, on
  plugin routes and core routes alike
  ([S9](../spike-evidence.md#s9--authorization-semantics-verified-on-plugin-routes)).
- Exceeding Kestrel's 30,000,000-byte default surfaces as an **opaque `500`**,
  not a `413`, and `System.Text.Json` rejects nesting deeper than 64 as a parse
  error ([S11](../spike-evidence.md#s11--request-size-and-json-depth-boundaries)).

## Decision

1. **Checked-in OpenAPI + JSON Schema are the source of truth.** Generated SDKs
   and running endpoints are validated against them in CI; drift fails the build.
2. **Six independently versioned concepts**, never conflated: protocol version,
   manifest schema version, surface schema version, host ABI version, SDK
   version, extension version.
3. **Negotiation is highest-common-version.** An anonymous discovery endpoint
   exposes only availability and the supported protocol range — no users, no
   installed extensions, no topology, no configuration. Capability detail is
   authenticated and filtered to the caller.
4. **Jellyfin authorization failures stay bare.** `401`/`403` keep empty bodies.
   The structured envelope applies **only after** authorization succeeds.
5. **One post-authorization error envelope**, with a stable machine `code`, a
   `retryable` flag, a `correlationId`, and no internals, secrets or stack traces.
6. **Correlation IDs are mandatory** on every platform request and response, and
   appear in audit records.
7. **The kernel imposes its own bounds** well below the host's, and maps them to
   `413` with a structured body — never to the host's opaque `500`. Depth,
   element count and string length are bounded independently of byte size.
8. **Unknown optional fields are ignored**; unknown *required* capabilities
   disable only the affected contribution, never the whole response.
9. **One pagination dialect** for v1: opaque forward cursors. `take`/`skip` and
   `page`/`size` are not carried into the platform surface.

## Rationale

- The bare-`401` rule is a *description of what the host already does*, verified
  live. Wrapping it would mean intercepting Jellyfin's own pipeline.
- The kernel must own its size limits because the host's only free limit
  produces an unactionable `500`. A structured `413` is the difference between a
  consumer that can retry correctly and one that cannot.
- Six version concepts sounds like over-engineering until an extension needs to
  ship a bug fix without republishing its manifest schema — which the single
  version number makes impossible.
- Opaque cursors are already the most defensible of the three dialects in the
  codebase and the only one that survives a change of underlying store.

## Consequences

- CI gains OpenAPI/schema snapshot and breaking-change gates, plus golden
  request/response fixtures and a generated smoke client.
- Every platform response carries a correlation ID, which the current codebase
  has nowhere to source from — a small cross-cutting addition.
- Legacy routes keep their existing envelopes. They are not retrofitted.
- **One case the kernel cannot reach:** a request at or above Kestrel's
  30,000,000-byte limit is rejected by host middleware before any plugin code
  runs, so it still surfaces as the host's opaque `500`. The kernel's structured
  `413` covers everything between its own limit and that ceiling; the ceiling case
  must be documented for consumers rather than promised away.

## Rejected alternatives

- **Generate the spec from the running server at build time.** Rejected: the
  spec then documents whatever the code does, including mistakes, and a breaking
  change cannot be detected.
- **`ProblemDetails`.** Rejected: it has no stable machine code and no
  retryability signal, and its `detail` field invites leaking internals.
- **Reusing the existing `{ success, code, message }` envelope.** Rejected as
  the *starting point* — it lacks correlation and retryability — but it is the
  closest existing shape and the platform envelope is a superset, so adapters are
  mechanical.
- **Wrapping `401`/`403` in the envelope.** Rejected: it contradicts host
  behaviour and would require intercepting Jellyfin's authorization pipeline.
