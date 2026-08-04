# ADR-0004 — Provider invocation, binding and failure isolation

Status: **accepted; ABI/envelope contract frozen by EP-04.1, invocation pending** · Owner: platform kernel · Evidence: [S3](../spike-evidence.md#s3--cross-plugin-di-works-but-only-by-foreign-concrete-type), [S6](../spike-evidence.md#s6--provider-failure-modes-all-map-to-bounded-host-errors), [S13](../spike-evidence.md#s13--lifecycle-matrix), [S14](../spike-evidence.md#s14--forged-identity-is-fully-resisted-but-the-token-is-in-the-claims)

## Context

[ADR-0003](0003-json-abi.md) settles *what* crosses the boundary. This settles
*how the kernel gets a reference to the thing on the other side*, and what
happens when that thing misbehaves.

The one binding path that worked in the spike: resolve the provider through
`IPluginManager`, take the `Type` object **out of the provider's own assembly**,
ask Jellyfin's shared container for that `Type`, and invoke reflectively.

## Decision

### Binding

1. Providers register their entrypoint **by concrete type only**
   (`services.AddSingleton<MyProviderEntrypoint>()`). They never register against
   a platform-owned interface — that resolves to `null`.
2. The kernel locates the plugin by **GUID**, never by display name. The name is
   mutable, is what Jellyfin sorts load order on, and is attacker-influenced.
3. Binding is **lazy, per invocation**. Nothing is resolved at startup.
4. Binding is re-evaluated every call, so an upgrade rebinds automatically —
   verified across `1.0.0.0 → 2.5.0.0`
   ([S13](../spike-evidence.md#s13--lifecycle-matrix)).
5. Payload schemas are resolved only from the foreign provider assembly under
   the fixed content-addressed resource convention frozen by ADR-0003, and their
   bytes must hash to the manifest digest before use. Binding never follows a
   manifest-selected path or CLR selector.

### Provider context

The kernel derives a **minimal, explicit allow-list** and passes it as JSON:
correlation id, negotiated protocol version, granted scopes, an opaque user and
device attribution, validated item/surface context, locale and accessibility
hints, the remaining deadline, and the operation input.

It never passes the `ClaimsPrincipal`, the `HttpContext`, the
`IServiceProvider`, a database handle, or any host service.
[S14](../spike-evidence.md#s14--forged-identity-is-fully-resisted-but-the-token-is-in-the-claims)
is why: the claims principal contains `Jellyfin-Token` — the caller's **raw
bearer token**.

**This is hygiene, not a boundary — and the distinction must not be blurred.** A
provider's entrypoint is constructed by Jellyfin's own container
(decision 1 above), so it can constructor-inject anything the host registers,
including `IHttpContextAccessor`. The kernel invokes the provider synchronously on
the request's execution context, so that accessor returns the live `HttpContext`
for exactly the request being brokered:

```csharp
public sealed class MyProviderEntrypoint(IHttpContextAccessor http)
{
    public Task<string> InvokeAsync(string op, string json, CancellationToken ct)
        => Task.FromResult(http.HttpContext!.User.FindFirst("Jellyfin-Token")!.Value);
}
```

Withholding the principal from the *call* is worth doing — it stops a careless
provider from acquiring a credential it never meant to hold, and it keeps the
published contract honest about what the platform offers. It does **not** stop a
provider that wants the token. That is the same accepted risk as
[T-03](../threat-model.md#t-03--malicious-or-compromised-installed-plugin--critical-accepted):
an installed plugin runs inside the trusted process.

No document in this programme may describe the allow-list as preventing token
access. It prevents *accidental* token access.

### Failure isolation

Every outcome maps to a stable code. Verified:

| Provider behaviour | Kernel result |
|---|---|
| returns valid JSON | `ok` |
| throws (sync or async) | `provider_faulted` — one code; do not split by whether the exception arrived wrapped in `TargetInvocationException`, which depends only on whether the entrypoint is `async` |
| returns malformed JSON | `provider_response_invalid_json` (validated **before** leaving the boundary) |
| returns an oversized response | `provider_response_too_large` — **must be added**; the spike had no cap |
| honours cancellation at the deadline | `provider_cancelled` — assigned only when the kernel's own deadline token fired, never for a cancellation the provider raised on some other token |
| exceeds the deadline without cooperating | `provider_deadline_exceeded` |
| the **caller** aborts | `caller_cancelled` — never attributed to the provider, never counted against its circuit breaker. This must be checked *before* the deadline branch: a caller abort against a provider that ignores cancellation otherwise reaches the timeout first and is misfiled. |
| entrypoint returns `Task` rather than `Task<string>` | `provider_abi_mismatch` — distinct from returning nothing |
| plugin disabled | `provider_disabled` |
| plugin uninstalled / absent | `provider_absent` |
| circuit open | `provider_unavailable` |

Plus: per-extension concurrency caps, bulkheads so one provider cannot starve
another, and circuit breakers that open on repeated faults.

### The honest limit

A deadline **protects the caller, not the server**. In the spike the kernel
returned on time, but a provider that ignores the cancellation token kept
running in-process afterwards and could not be killed.

A cooperative provider *is* distinguishable, but only if the kernel cancels at
the deadline, allows a short grace window, and then **awaits** the task rather
than racing a timer against it. The spike's first binder raced a
`Task.Delay` of the same duration and collapsed both cases into one code; the
corrected binder separates them — `provider_cancelled` at ~2003 ms versus
`provider_deadline_exceeded` at ~2254 ms. The kernel must therefore emit two
codes, and must not copy the racing shape. See
[S6](../spike-evidence.md#s6--provider-failure-modes-all-map-to-bounded-host-errors).

Therefore: providers are **trusted in-process code**. Scopes reduce accidental
exposure. They do not contain a malicious or pathological provider, and no
document in this program may claim otherwise.

## Rationale

- GUID binding is not paranoia: display name literally determines load order, so
  it is the one field an adversarial plugin has an incentive to manipulate.
- Lazy binding is what made the entire lifecycle matrix pass. With load order
  reversed, with the provider disabled, uninstalled, or upgraded, the kernel
  behaved correctly and Jellyfin stayed healthy — because nothing was resolved at
  startup. Given that Jellyfin offers **no dependency declaration mechanism**,
  late binding is the only defensible design.
- Validating the provider's response *before* it leaves the boundary means a
  buggy provider produces a protocol error rather than corrupting a client.

## Consequences

- Reflection on every call. Method handles are cached per bound assembly version
  and invalidated on rebind.
- The kernel must distinguish `disabled` from `absent`, which it can: a disabled
  plugin is still in `IPluginManager.Plugins` with `Manifest.Status = Disabled`,
  an uninstalled one is gone entirely.
- Response size capping is new work — it did not exist in the spike and is an
  EP-04 acceptance criterion, not an existing property.

## Rejected alternatives

- **Eager binding at startup.** Rejected: creates an ordering dependency the host
  gives no mechanism to express, and turns a broken extension into a startup
  failure.
- **Binding by plugin display name.** Rejected on the load-order evidence.
- **Passing the `ClaimsPrincipal` for convenience.** Rejected on
  [S14](../spike-evidence.md#s14--forged-identity-is-fully-resisted-but-the-token-is-in-the-claims):
  it leaks the bearer token.
- **Killing a runaway provider thread.** Not available on .NET, and
  `Thread.Abort` does not exist. Recorded as a permanent limitation.
- **Trusting a provider's declared timeout.** Rejected: the deadline is the
  kernel's.
- **Racing a timer against the provider task to enforce the deadline.** Rejected
  on evidence: it collapses a cooperative provider and a runaway one into the
  same error code, leaks a timer per call, and leaves the losing task
  unobserved.
