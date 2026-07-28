# ADR-0005 — Manifest discovery and registry binding

Status: **proposed** (EP-00) · Owner: platform kernel · Evidence: [S4](../spike-evidence.md#s4--manifest-discovery-binds-to-the-real-plugin-identity-and-rejects-a-claim-to-another), [S5](../spike-evidence.md#s5--path-containment-holds-against-traversal-symlinks-and-link-cycles), [S13](../spike-evidence.md#s13--lifecycle-matrix)

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
   warning. Verified working ([S4](../spike-evidence.md#s4--manifest-discovery-binds-to-the-real-plugin-identity-and-rejects-a-claim-to-another)).
3. **Open first, then decide — and fail closed.** Validating a path and then
   opening it is a TOCTOU, and a measured one: it leaked a file from outside the
   root on **17% of successful reads** under contention
   ([S16](../spike-evidence.md#s16--the-manifest-read-is-a-toctou-and-a-fifo-stalls-it)).
   The kernel opens the file, resolves what the **descriptor** actually refers to,
   and refuses the read outright when that cannot be determined. It must also
   **bound the open**: `open(2)` blocks forever on a FIFO, so a plugin shipping a
   named pipe as its manifest would stall discovery for every plugin.
4. **Containment before I/O.** The resolved path must canonicalize to a location
   strictly inside the plugin root; absolute paths, embedded NUL, `..` traversal
   and root-escaping symlinks are rejected before any file is opened.
   Verified ([S5](../spike-evidence.md#s5--path-containment-holds-against-traversal-symlinks-and-link-cycles)).
   **Three things the naive implementation gets wrong**, each found in the spike:
   separators must be normalised before any test; link resolution must cover every
   path *component*, not just the leaf; and it must run to a **fixed point**,
   because resolving one component introduces new ones that may themselves be
   links. A link cycle must be a rejection, not an exception escaping the reader —
   discovery iterates every plugin and one bad root must not take out the rest.
5. **Bounded.** Manifest size, id/version lengths, operation and contribution
   counts, nesting depth and local-asset counts are all capped.
6. **A manifest is never a grant.** It states what an extension *requests*. An
   administrator approves. Requested and granted scopes are stored separately.
7. **Fingerprint changes revoke approval.** Any change to the manifest
   fingerprint or the requested scope set returns the extension to *pending*.
   Stale grants are never inherited.
8. **Explicit lifecycle states**, rendered distinctly and never collapsed:
   `discovered/pending`, `enabled`, `disabled`, `restart-pending`, `incompatible`,
   `unhealthy`, `quarantined`, `revoked`, `absent`. `restart-pending` is not
   optional: Jellyfin's own disable produces `PluginStatus.Restart` and leaves the
   assembly loaded and resolvable, so an admin UI that reports "disabled" would be
   lying ([S15](../spike-evidence.md#s15--hot-lifecycle-nothing-is-ever-unloaded-and-disable-needs-a-restart)).
9. **The kernel enforces state at invocation.** Because nothing is unloaded, a
   disabled or revoked extension is still fully callable through Jellyfin's DI. The
   registry's state is the *only* thing standing between an administrator's
   decision and the extension continuing to run.
10. **A plugin package may ship symlinks, and Jellyfin follows them.** A link to
   `/` inside a plugin directory prevented the server from starting at all during
   the spike. The registry cannot fix the host's own scan, but it must not add to
   the problem, and admin diagnostics should make such a root identifiable.
11. **Nothing on the startup path.** Discovery, validation and registry recovery
   run after startup, off the critical path. One malformed extension must not
   delay or fail Jellyfin or Canopy startup.
12. **Crash-safe persistence** via the existing `AtomicFile` durable-write
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
- Discovery is restart-driven, and that is now a measured fact rather than a
  caution: a fully formed plugin directory dropped into `/config/plugins` on a
  running server is **not discovered**, and neither disable nor enable takes effect
  until a restart ([S15](../spike-evidence.md#s15--hot-lifecycle-nothing-is-ever-unloaded-and-disable-needs-a-restart)).
- **Uninstall does not reclaim anything.** The context stays alive with its
  assemblies loaded for the life of the process. Admin diagnostics should say so
  rather than implying the extension is gone.

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
