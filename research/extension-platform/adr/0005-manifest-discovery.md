# ADR-0005 — Manifest discovery and registry binding

Status: **proposed** (EP-00) · Owner: platform kernel · Evidence: [S4](../spike-evidence.md#s4--manifest-discovery-binds-to-the-real-plugin-identity), [S5](../spike-evidence.md#s5--traversal-is-rejected-before-any-file-is-opened), [S13](../spike-evidence.md#s13--lifecycle-matrix)

## Context

An extension has to tell the platform what it is and what it wants. That
declaration is **untrusted input written by a third party into a file on disk**,
and the naive implementations — scan a directory, trust the ids inside, trust the
declared scopes — are each a distinct vulnerability.

## Decision

1. **The manifest file is `jellyfin-canopy-extension.json`**, read from the
   plugin root **that `IPluginManager` reports** for an installed plugin. The
   kernel never scans a path of its own choosing and never enumerates arbitrary
   directories.
2. **Fingerprint binding.** The manifest's self-declared `pluginId` must match
   the GUID Jellyfin reports for that plugin. A mismatch is a rejection, not a
   warning. Verified working ([S4](../spike-evidence.md#s4--manifest-discovery-binds-to-the-real-plugin-identity)).
3. **Containment before I/O.** The resolved path must canonicalize to a location
   strictly inside the plugin root; absolute paths, embedded NUL, `..` traversal
   and root-escaping symlinks are rejected before any file is opened.
   Verified ([S5](../spike-evidence.md#s5--traversal-is-rejected-before-any-file-is-opened)).
   **Path separators must be normalised first** — the spike's Windows-separator
   case passed for the wrong reason and did not exercise the containment check.
4. **Bounded.** Manifest size, id/version lengths, operation and contribution
   counts, nesting depth and local-asset counts are all capped.
5. **A manifest is never a grant.** It states what an extension *requests*. An
   administrator approves. Requested and granted scopes are stored separately.
6. **Fingerprint changes revoke approval.** Any change to the manifest
   fingerprint or the requested scope set returns the extension to *pending*.
   Stale grants are never inherited.
7. **Explicit lifecycle states**, rendered distinctly and never collapsed:
   `discovered/pending`, `enabled`, `disabled`, `incompatible`, `unhealthy`,
   `quarantined`, `revoked`, `absent`.
8. **Nothing on the startup path.** Discovery, validation and registry recovery
   run after startup, off the critical path. One malformed extension must not
   delay or fail Jellyfin or Canopy startup.
9. **Crash-safe persistence** via the existing `AtomicFile` durable-write
   primitive (temp sibling → fsync contents → rename → fsync parent directory),
   with quarantine-on-corruption and a versioned unhealthy marker — the same
   model `UserConfigurationStore` already uses.

## Rationale

- Binding to `IPluginManager`'s reported root is what makes traversal a
  *containment* problem rather than a *discovery* problem: there is exactly one
  root, and it came from the host.
- The `disabled` vs `absent` distinction is real and observable: a disabled
  plugin is still in `IPluginManager.Plugins` with `Manifest.Status = Disabled`;
  an uninstalled one is gone entirely
  ([S13](../spike-evidence.md#s13--lifecycle-matrix)). Collapsing them would make
  a recoverable admin action look like an uninstall.
- Startup isolation is not theoretical: with the host plugin removed entirely,
  Jellyfin came up healthy with **zero errors on that boot**. That is the bar.
- Re-approval on fingerprint change is the only defence against an extension
  shipping an update that quietly widens its own scopes.

## Consequences

- An extension update that changes scopes needs admin action before it works
  again. This is intended; the admin UI must make the diff obvious rather than
  presenting an opaque re-approval prompt.
- The registry is a persisted store with migrations, recovery and its own
  corruption tests.
- Discovery is restart-driven for v1. **Hot discovery is not claimed** — every
  lifecycle case in the spike used a full restart, and whether Jellyfin actually
  unloads a collectible context on disable was not established.

## Rejected alternatives

- **Scan a well-known directory for manifests.** Rejected: decouples the manifest
  from installed-plugin identity, so anyone who can write a file can register an
  extension.
- **Trust the manifest's declared id.** Rejected: it is third-party input; see
  fingerprint binding.
- **Download manifests, or let a manifest name executable content.** Rejected —
  remote code distribution is an explicit program non-goal.
- **Auto-approve extensions shipped by a "trusted" publisher.** Rejected for v1:
  there is no signing infrastructure, and a publisher allow-list is an
  authorization decision disguised as configuration.
- **Treat `disabled` as `absent`.** Rejected on the evidence above.
