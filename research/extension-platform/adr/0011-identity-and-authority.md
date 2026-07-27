# ADR-0011 — Identity and authority

Status: **proposed** (EP-00) · Owner: platform security · Evidence: [S9](../spike-evidence.md#s9--authorization-semantics-verified-on-plugin-routes), [S10](../spike-evidence.md#s10--host-cors-is-permissive), [S14](../spike-evidence.md#s14--forged-identity-is-fully-resisted-but-the-token-is-in-the-claims)

## Context

Canopy already has a documented, careful position on identity: `RequestIdentityService`
resolves anonymous requests through a confidence ladder
(`Authenticated → Marker → Cookie → SingleUserServer → SharedIpCandidates → None`),
and the code states repeatedly that these tiers are **disambiguation, never
authorization** — a forged marker only lets a client opt into another user's
stricter or looser view of content it could already reach.

An extension platform is where that distinction gets tested, because an extension
will want to know "who is this?" and the honest answer differs depending on why
it is asking.

Two live results shape the design. Identity **cannot** be forged: with a
non-admin token, injecting `Jellyfin-UserId`, `X-Jellyfin-User-Id`,
`X-Emby-Authorization` or a `jellyfin-userid` cookie all resolved to the
non-admin's own id. But the `ClaimsPrincipal` handed to a controller contains
`Jellyfin-Token` — the caller's **raw bearer token**.

## Decision

1. **Authority comes only from Jellyfin authentication claims and policies.**
   The acting user is the token's user. No route value, header, cookie, manifest
   field, payload field or device id can change it.
2. **Attribution is not authority.** Client, device and extension identifiers are
   recorded for audit and never consulted for access decisions unless bound to an
   approved cryptographic credential.
3. **`RequestIdentityService` confidence tiers may narrow a candidate set; they
   may never authorize.** Anything below `Authenticated` selects *which user's own
   preferences* to apply, never *what may be accessed*. Promotion of this service
   to a platform capability is blocked until the **full ladder** is covered on its
   own terms. There is no dedicated test file; `Tests/Services/SpoilerIdentityTests.cs`
   does construct the service directly and assert on its ladder, but only along
   the Spoiler Guard path, leaving the session-by-IP and cookie tiers untested.
4. **The kernel never hands over the raw bearer token.** Not to a provider, not
   to an iframe, not into a descriptor, not into a log or an audit record. The
   provider context is an explicit allow-list
   ([ADR-0004](0004-provider-invocation.md)); the `ClaimsPrincipal` and
   `HttpContext` are never passed. Note the precise claim: an installed provider
   is constructed by Jellyfin's container and can inject
   `IHttpContextAccessor` to reach the live principal itself. The allow-list
   prevents *accidental* exposure; containing a provider that wants the token is
   [T-03](../threat-model.md#t-03--malicious-or-compromised-installed-plugin--critical-accepted),
   which is accepted, not mitigated.
5. **Re-authorize at invocation.** Item, user, library and parental access are
   checked again when an action runs, never inherited from the context a
   contribution or provider supplied. Canopy's existing `UserAccessQuery` /
   `IItemLookupService` fail-closed pattern — including refusing to authorize
   against a truncated candidate list — is the model.
6. **Two policies only, deny by default.** Plain `[Authorize]` for any signed-in
   user; `Policies.RequiresElevation` for administrators.
   `Policies.DefaultAuthorization` **does not exist** in Jellyfin 12 — the
   roadmap's assumption is corrected here. Anonymity is explicit and enumerated.
7. **`401`/`403` stay bare**, matching verified host behaviour
   ([ADR-0002](0002-protocol-and-version-negotiation.md)).
8. **Same-origin is not a security boundary.** The host answers
   `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Headers:
   authorization`, so any web origin can call Jellyfin with a token it holds
   ([S10](../spike-evidence.md#s10--host-cors-is-permissive)). Every request is
   authorized on its own merits; no CSRF-by-origin assumption is made.
9. **Service credentials** for companion services are independently revocable,
   expiring, rotatable, stored hashed, and shown once at creation. A Jellyfin
   admin API key is never reused as a platform credential.
10. **Actions are opaque, short-lived capabilities** binding extension,
    operation, user, device, catalog revision, scopes and expiry — with
    replay protection. A client never names a provider method.
11. **Operations declare the authority they need**, and the kernel intersects it
    with the caller's own Jellyfin privileges. An operation declares
    `authenticated` or `elevated`; an `elevated` operation is refused to a
    non-admin *even when the extension holds the corresponding grant*, because a
    grant is a ceiling on the extension, never a promotion for the caller. This
    is what makes the admin-only reference capability in
    [`v1-capability-freeze.md`](../v1-capability-freeze.md#c9--reference-capability-families)
    expressible.
12. **v1 has no per-user consent.** Grants are administrator-approved and
    server-wide; a user cannot decline an approved extension. The admin and user
    kill switches in [ADR-0007](0007-declarative-web-contributions.md) turn a
    contribution *off*, they do not express consent. Stated plainly because the
    absence is a policy choice, not an oversight.
13. **Revocation is immediate** across the registry, in-flight calls, event
    subscriptions, cached catalogs and outstanding action tokens. For events this
    means re-checking at delivery and dropping the subscriber's reconnect buffer,
    not merely filtering at enqueue time
    ([ADR-0006](0006-client-event-transport.md) decision 6) — and note that
    "in-flight calls" is aspirational for a provider that ignores cancellation,
    which cannot be stopped ([ADR-0004](0004-provider-invocation.md)).
14. **Audit records are redacted by construction:** extension, operation, actor
    attribution, decision, result, duration, correlation id. Never payloads,
    never tokens, never upstream keys.

## Rationale

- Point 4 is the one that would have been got wrong by default. Passing the
  claims principal is the obvious, ergonomic choice, and it silently hands every
  installed extension a working credential for whoever is browsing — including a
  non-admin's, whenever their page triggers a contribution. It is worth doing even
  though a determined provider can reach the principal anyway, because the
  published contract should not *offer* the credential.
- Point 3 protects an existing invariant that is easy to erode: once an
  extension can ask "who is this?" and get an answer with 80% confidence,
  somebody will authorize on it.
- Point 8 is why authorization cannot be relaxed for "our own web client": the
  browser origin proves nothing.

## Consequences

- Providers cannot call Jellyfin's API as the user. If a provider needs user
  data, the platform must expose it as a scoped capability — which is the point.
- Re-authorization on every action costs a lookup. Canopy's per-`(user, RowVersion)`
  projection caching already shows how to make that affordable while
  self-invalidating on a permission change.
- Service credentials are new infrastructure: issue, hash, store, rotate, revoke,
  audit.

## Rejected alternatives

- **Forward the user's token to providers so they can call Jellyfin directly.**
  Rejected: unbounded authority, unrevocable, unauditable, and it makes every
  extension a credential-theft target.
- **Let a trusted extension declare the acting user.** Rejected: confused-deputy
  by construction.
- **Use `RequestIdentityService` tiers for authorization when confidence is
  high.** Rejected: the tiers are explicitly documented as disambiguation, and
  the marker is an unkeyed hash by design.
- **Rely on CORS or same-origin for CSRF protection.** Rejected on
  [S10](../spike-evidence.md#s10--host-cors-is-permissive).
- **Reuse a Jellyfin admin API key for companion services.** Rejected:
  unscoped, unrevocable independently, and indistinguishable in audit from a real
  admin.
