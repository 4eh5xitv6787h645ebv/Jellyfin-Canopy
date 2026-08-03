# ADR-0006 — Client event transport

Status: **accepted for the registry/provider C5 subset** (ADR-0013; EP-05 implementation pending) · Owner: platform kernel · Evidence: [S7](../spike-evidence.md#s7--event-streaming-survives-the-host-pipeline), [S8](../spike-evidence.md#s8--browser-eventsource-cannot-authenticate-safely)

## Context

Canopy already pushes live config changes to browsers, but by an unusual route:
it rides Jellyfin's own session channel, sending a `GeneralCommand` of type
`SetPlaybackOrder` — chosen precisely *because* the web client ignores it — with
a `JellyfinCanopy` marker in its arguments. There is no way for another plugin to
publish, and the reconnection path is a separate polling endpoint.

That trick does not generalise. Jellyfin's native WebSocket message type is a
closed enum, and smuggling arbitrary event types through it is an explicit
program constraint. It also carries an unquantified risk: whether a **native**
client gracefully ignores an unexpected payload under a known message type, or
hard-crashes, has not been tested on real hardware.

## Decision

1. **Primary transport: an authenticated `text/event-stream` response consumed by
   `fetch()` streaming**, not by `EventSource`. User operations use Jellyfin's
   `Authorization` header. An explicitly service-capable operation instead uses
   the dedicated `X-Canopy-Service-Credential` header at the separate Platform
   service-auth boundary; it never enters Jellyfin authentication and never
   synthesizes a user. Supplying both Jellyfin and service credentials, or a
   service credential to a non-service operation, returns a bare, non-cacheable
   `400` before lookup or enqueue.
   The service stream inherits the deny-by-default Platform service controller
   base from ADR-0001, never `[AllowAnonymous]`. Missing, malformed,
   syntactically valid but unknown, expired, revoked or rotated-old credentials
   return a bare, non-cacheable `401`; a current recognized credential denied by
   registration, grant or operation ceiling returns the same bare,
   non-cacheable `403` shape as user authorization. The status distinction
   exposes only whether authentication succeeded; neither bare response includes
   a service identifier, registration, grant, operation or denial detail.
2. **Fallback: a bounded long-poll** with the same cursor semantics.
3. **Query-string credentials are forbidden on every platform route**, and the
   rule needs teeth: Jellyfin 12 authenticates `?apikey=` / `?ApiKey=` in host
   middleware *before* a plugin controller runs, so "we do not use it" is not
   enforcement. A platform action filter must reject any request whose query
   string carries a credential parameter (ordinal-ignore-case) with a structured
   `400`, and an architecture test must assert the filter is registered.
4. Events carry an id and a per-stream cursor; reconnect resumes within a bounded
   retention window; a gap outside retention returns `resync-required` rather
   than a silently incomplete stream.
5. Delivery is **at-least-once within bounded retention**. Events are
   invalidations and notifications, never the sole source of truth.
6. Authorization is applied **before enqueueing and again at delivery**. For a
   user stream this means the current Jellyfin principal and access; for a
   service stream it means the current credential generation, registration,
   exact grant and service-operation ceiling.
   Enqueue-time filtering alone is not enough: an event authorized before a
   permission change would still be delivered out of a reconnect buffer
   afterwards, which contradicts the immediate-revocation rule in
   [ADR-0011](0011-identity-and-authority.md). A grant change or a Jellyfin
   permission change drops the subscriber's buffer and forces `resync-required`.
   High-volume changes are coalesced; queues and per-consumer memory are bounded;
   a slow consumer is disconnected and told to resync rather than allowed to grow
   a queue. Service credential rotation, expiry, revoke, registration disable,
   grant change or generation change applies the same recheck and destroys the
   service subscriber buffer; a no-user service is never eligible for a
   user-scoped event family.
7. `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-store` are set on the
   stream.
8. **Jellyfin's native WebSocket enum is not extended or smuggled through.**

## Rationale

The decisive evidence is authentication, not buffering.

`EventSource` cannot set request headers. Its only authentication option is a
query-string token — which lands in proxy access logs, browser history and
`Referer` headers. Jellyfin 12 *does* accept `?apikey=` (and `?ApiKey=`), and has
dropped the 10.x `?api_key=` spelling
([S8](../spike-evidence.md#s8--browser-eventsource-cannot-authenticate-safely)).
So `EventSource` would work — by doing the wrong thing. For Jellyfin-user
operations, `fetch()` streaming carries `Authorization: MediaBrowser Token=…`
properly, which is the only header form Jellyfin 12 accepts (`X-Emby-Token`,
`X-MediaBrowser-Token` and `Authorization: Bearer` all return `401`). The first
service-capable event operation is separate: a credential-bound companion may
subscribe only to registry/provider lifecycle, health and invalidation for the
explicit bounded provider-id set in its exact grant, and may read only the
matching filtered resync snapshot. The minimal event schema excludes C10
inventory, manifest, attribution, circuit/error detail and all Jellyfin
user/media data. It uses `X-Canopy-Service-Credential`, rechecks typed service
generation/grant before each chunk, and destroys its buffer on revoke, expiry,
rotation, registration or grant change. The header is redacted everywhere and
forbidden on non-service operations.

Streaming itself is not the problem:
[S7](../spike-evidence.md#s7--event-streaming-survives-the-host-pipeline) shows
`text/event-stream` passes through Jellyfin's MVC/Kestrel pipeline unbuffered,
chunked, at source cadence.

**A hypothesis this ADR does not rest on.** The expectation that a buffering
reverse proxy would stall SSE was **not reproduced**. nginx streamed correctly
with buffering off, with buffering on (its default), *and* with
`proxy_ignore_headers X-Accel-Buffering` forcing the hint to be discarded. The
long-poll fallback is retained because some deployments and some client runtimes
genuinely cannot consume a streaming response — not because proxy buffering was
shown to break anything here.

## Consequences

- The web client uses `fetch()` + `ReadableStream`, so the reconnect/backoff
  logic `EventSource` gives for free must be written and tested.
- Every consumer must handle `resync-required`; samples must demonstrate it.
- Canopy's existing `GeneralCommand` mechanism stays as-is for its current
  purpose. It is a compatibility surface, not the platform transport, and the two
  must not be conflated.

## Rejected alternatives

- **`EventSource` with a query-string token.** Rejected: puts a credential in
  logs and history. This is the whole point of the ADR.
- **A plugin-owned WebSocket endpoint.** Deferred, not rejected outright — it
  duplicates connection management and adds a second auth path. Revisit only if
  streaming proves inadequate under load.
- **Extending Jellyfin's `SessionMessageType` enum, or smuggling payloads under
  an existing type.** Rejected: a program constraint, and the native-client crash
  risk is untested.
- **Webhooks / arbitrary outbound HTTP.** Explicit v1 non-goal.
- **Polling only.** Rejected: Canopy already demonstrates that live updates are
  worth having, and polling at a useful interval costs more than a stream.
