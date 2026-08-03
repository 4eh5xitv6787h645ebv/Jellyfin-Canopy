# ADR-0008 — Storage ownership

Status: **accepted design** (ADR-0013; EP-05 implementation pending) · Owner: platform kernel

## Context

Every extension will need to persist something. Left to themselves, extension
authors will write files — and will reimplement, badly, the problems Canopy has
already solved: atomic durable writes, per-file locking, size and structure
quotas, corruption quarantine, migration, and per-user isolation.

Canopy's existing `UserConfigurationStore` is a good model and a bad API. Good:
path canonicalization against a base directory, per-`(user, file)` static lock
pool, size rejection *before* the path is resolved, quarantine with a versioned
unhealthy marker and bounded corrupt-backup retention, and an architecture test
that forbids `File.WriteAllText` anywhere outside `AtomicFile`. Bad: it is
`internal`, its filename whitelist is hard-coded, and its keys are unnamespaced.

## Decision

1. **Two scopes only:** extension-global, and extension-per-user. There is no
   cross-extension scope and no way to name another extension's namespace.
2. **The kernel owns every path.** An extension supplies a *key*, never a path,
   never a user id. The effective user is derived from the authenticated
   principal, never from the request.
3. **JSON documents**, validated against a schema the extension declares, with a
   schema version and transactional migrations that roll back on failure.
4. **Bounded on every axis:** document size, namespace total size, key length and
   count, nesting depth, element counts — modelled on the existing
   `PersistedPayloadPolicy`, and enforced *before* a lock is taken or a path
   resolved.
5. **Optimistic concurrency via ETag / `If-Match`.** A missing precondition is
   `428`; a stale one is `409` carrying the server's current state. Concurrent
   writers never silently lose an update.
6. **Crash-safe writes** through the existing `AtomicFile` primitive, reused —
   not reimplemented.
7. **Corruption quarantines** the namespace and surfaces an actionable admin
   diagnostic rather than silently reseeding defaults.
8. **Export and delete** are first-class, for both a user and an extension.
   Ordinary user/provider paths still derive their namespace. Service actors
   cannot access extension-global or per-user C4 state in the ADR-0013 tranche.
   Only a separate elevated administrator
   management operation may name a target namespace as the audited object of a
   bounded export/delete, never as acting identity or an ordinary read/write
   selector. Uninstall follows an explicit retain / export / purge policy.
9. **Secrets are write-only references at most**, and only if a later milestone
   proves the protection is real. A secret is never returned to a web or native
   client, and never appears in routine diagnostics.
10. **Not offered:** arbitrary filesystem access, blob or media storage, a
    general database, or a general key-value service.

## Rationale

- Caller-supplied paths and caller-supplied user ids are the two classic ways
  this feature becomes a cross-user data breach. Both are removed by
  construction, which is cheaper than validating them everywhere.
- Reusing `AtomicFile` rather than rewriting it is the repository's
  fix-at-the-owning-source rule applied literally — and it is already guarded by
  an architecture test that would fail any second implementation.
- Rejecting oversized payloads before resolving the path is a subtlety Canopy
  already learned: otherwise an oversized write creates a user directory as a
  side effect.
- ETag semantics already exist in the codebase (weak-ETag-as-revision plus a
  strict `If-Match` parser), so this is standardization, not invention.

## Consequences

- `AtomicFile` becomes public. `UserConfigurationStore` needs an interface and a
  namespaced registration API in place of its hard-coded filename whitelist.
- Quota accounting per extension and per user is new work, including the admin
  view of who is using what.
- Migrations are the highest-risk area: a failed migration must leave the last
  valid state intact, which the existing quarantine model supports.

## Rejected alternatives

- **Let extensions write their own files under the plugin data directory.**
  Rejected: no bounds, no atomicity, no isolation, no recovery, and the
  architecture guard would have to be weakened to allow it.
- **A shared key-value store with a naming convention.** Rejected: a convention
  is not an isolation boundary.
- **SQLite per extension.** Rejected for v1 — Canopy's `ReviewsStore` shows the
  real cost (WAL configuration, `quick_check`, counter repair, backup/restore,
  migration verification) for a case that genuinely needed it. JSON documents
  with bounded size cover the v1 use cases.
- **Caller-supplied user id with an authorization check.** Rejected: it makes
  every call site a potential cross-user bug. Derivation is safe by construction.
