# ADR-0011 — Identity and authority

Status: **accepted** (pilot, canonical user boundary, and closed actor domain implemented; grants/credentials/provider-service activation pending) · Owner: platform security · Evidence: [S9](../spike-evidence.md#s9--authorization-semantics-verified-on-plugin-routes), [S10](../spike-evidence.md#s10--host-cors-is-permissive), [S14](../spike-evidence.md#s14--forged-identity-is-fully-resisted-but-the-token-is-in-the-claims)

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

1. **User and administrator authority comes only from Jellyfin authentication
   claims and current host policies.** The acting user is the token's user. No
   route value, header, cookie, manifest field, payload field or device id can
   change it. A service actor is a separate, no-user principal: its authority
   comes only from a kernel-owned service registration, current credential
   generation, exact administrator grant and operation actor-kind ceiling. It
   can never become a Jellyfin user or administrator. A user actor is constructed
   only from the unforgeable internal result of the full Platform boundary after
   explicit API-key rejection, a unique canonical user claim, live host-user
   lookup and current elevation; never from a parser GUID or `ClaimsPrincipal`.
   The runtime kind vocabulary is closed over exactly Jellyfin user client,
   registry-approved installed provider, and credential-bound companion service.
   The latter two have distinct dormant proof and actor types with no user or
   elevation projection; no production proof issuer exists until its owning
   registry or credential boundary lands.
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
6. **Two Jellyfin-user policies only, deny by default.** Plain `[Authorize]` for
   any signed-in user; `Policies.RequiresElevation` for administrators. These
   policies do not authenticate or authorize a service principal, which uses a
   separate Platform boundary and an explicit service-capable operation.
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
   admin API key is never reused as a platform credential. Existing anonymous,
   authenticated-user and elevated-user operations reject service principals;
   user delegation is outside the tranche accepted by ADR-0013.
   Installed providers are different again: their identity comes only from the
   approved registry record bound to Jellyfin's installed plugin GUID and the
   current manifest fingerprint, never from a credential or caller claim.
10. **Actions are opaque, short-lived capabilities** binding extension,
    operation, user, device, catalog revision, scopes and expiry — with
    replay protection. A client never names a provider method.
11. **Operations declare both actor kind and authority ceiling.** Existing
    operations remain `anonymous`, `authenticated-user` or `elevated-user` and
    reject services. A future operation may additionally be authored as
    `service`, but then accepts only the separately authenticated no-user
    service principal. The kernel intersects the operation allowlist, exact
    grant and current actor authority. An `elevated-user` operation is refused
    to a non-admin *even when the extension holds the corresponding grant*, and
    a service grant never promotes a service to user or admin. An elevated user
    remains the same user actor and may enter ordinary authenticated-user
    operations; current elevation is additionally required for elevated-user
    operations. A grant is always a ceiling, never a promotion. This is what
    makes the admin-only reference capability in
    [`v1-capability-freeze.md`](../v1-capability-freeze.md#c9--reference-capability-families)
    expressible.
    The current implementation centralizes that decision on the operation
    definition: all three native-pilot operations admit only the Jellyfin-user
    kind, elevated users remain eligible for ordinary authenticated operations,
    and default, unknown, provider, and service projections deny. The authored
    OpenAPI and frozen metadata publish the same exact allowlists without
    changing the existing `x-canopy-authority` tokens.

    Issue #639 fixes the v1 capability vocabulary, in authored order, as
    `jellyfin.canopy.discovery.read`, `jellyfin.canopy.items.lookup`,
    `jellyfin.canopy.user-data.read`, `jellyfin.canopy.events.subscribe`,
    `jellyfin.canopy.storage.read`, `jellyfin.canopy.ui.contribute`,
    `jellyfin.canopy.integrations.invoke`,
    `jellyfin.canopy.administration.manage`, and
    `jellyfin.canopy.diagnostics.read`. Each identifier has exactly four
    dot-separated segments, the fixed lower-case ASCII `jellyfin.canopy`
    namespace, lower-case ASCII letter/digit segments with internal hyphens only,
    and a maximum length of 128 characters. Matching is ordinal and exact;
    wildcard, prefix, case-folded, dynamically registered and implicitly inherited
    authority do not exist. The authored OpenAPI, frozen conformance artifact and
    runtime definitions carry the same order and exact metadata.

    Discovery admits a Jellyfin user. Item lookup, user-data read, storage read
    and integration invocation admit Jellyfin users and installed providers.
    Event subscription admits only a companion service; UI contribution admits
    only an installed provider. Administration and diagnostics admit only a
    currently elevated Jellyfin user. Elevation remains a property of that user,
    never another actor kind. Vocabulary membership names a possible authority;
    it does not activate a route, grant, manifest, provider, service, state,
    event, UI surface or diagnostic, and later v1 additions remain reviewed
    additive changes.
12. **v1 has no per-user consent.** Grants are administrator-approved and
    server-wide; a user cannot decline an approved extension. The admin and user
    kill switches in [ADR-0007](0007-declarative-web-contributions.md) turn a
    contribution *off*, they do not express consent. Stated plainly because the
    absence is a policy choice, not an oversight.
13. **Revocation immediately denies new admission and kernel-owned effects.** It
    requests cooperative cancellation, advances the applicable typed authority
    generation, discards late results, audits the late/revoked outcome, and
    generation-fences every kernel-owned commit and protected data release.
    Releases include state/conflict reads, snapshots, exports, diagnostics,
    catalogs, action results and each response/event stream chunk; stale
    authority terminates delivery without another protected byte. Every
    applicable current user, item, library, parental-access and elevation check
    is repeated immediately before release. Check and bounded release/chunk are
    serialized under a short typed-generation lease, so once a kernel-owned
    generation advance/revoke transaction commits no old-generation protected
    release begins or completes. Jellyfin policy changes are outside that lock;
    the final live host check prevents release when it observes the change, and
    the contract claims no host transaction boundary that Jellyfin does not
    expose. For
    events this means re-checking at delivery and dropping the reconnect buffer,
    not merely filtering at enqueue time
    ([ADR-0006](0006-client-event-transport.md) decision 6). A provider may
    already have begun an irreversible upstream or provider-owned effect before
    cancellation arrives; the kernel cannot stop or roll that back, even for
    otherwise cooperative code. No contract may claim it can
    ([ADR-0004](0004-provider-invocation.md)).
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
