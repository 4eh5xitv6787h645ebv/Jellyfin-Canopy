# ADR-0005 — Manifest discovery and registry binding

Status: **accepted; bounded manifest/acquisition and authoritative registry domain implemented** (#645, #647, #650; orchestration and external fixtures pending) · Owner: platform kernel · Evidence: [S4](../spike-evidence.md#s4--manifest-discovery-binds-to-the-real-plugin-identity-and-rejects-a-claim-to-another), [S5](../spike-evidence.md#s5--path-containment-holds-against-traversal-symlinks-and-link-cycles), [S13](../spike-evidence.md#s13--lifecycle-matrix), [S16](../spike-evidence.md#s16--the-manifest-read-is-a-toctou-and-a-fifo-stalls-it)

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
   prevent a blocking content open: `open(2)` blocks forever on a FIFO, so a
   plugin shipping a named pipe as its manifest would stall discovery for every
   plugin. The production reader type-probes through metadata/nonblocking handles
   and supports only an explicit local-filesystem allow-list on Linux or fixed
   local drives on Windows.
4. **Lexical defence before I/O; descriptor containment after open.** Absolute
   paths, embedded NUL, `..` traversal and unsafe separator shapes are rejected
   before opening. Links and mount/reparse transitions cannot be trusted
   lexically: after opening, the descriptor-resolved target must be strictly
   inside the descriptor-verified plugin root or the observation is rejected.
   Verified ([S5](../spike-evidence.md#s5--path-containment-holds-against-traversal-symlinks-and-link-cycles)).
   **Three things the naive implementation gets wrong**, each found in the spike:
   separators must be normalised before any test; link resolution must cover every
   path *component*, not just the leaf; and it must run to a **fixed point**,
   because resolving one component introduces new ones that may themselves be
   links. A link cycle must be a rejection, not an exception escaping the reader —
   discovery iterates every plugin and one bad root must not take out the rest.
5. **Bounded.** Manifest size, id/version lengths, operation and contribution
   counts, nesting depth and local-asset counts are all capped.
   Issue #645 freezes the first pure installed-provider envelope before any
   filesystem reader exists: strict UTF-8 JSON at 256 KiB and depth 16; exact
   schema, identity, version, actor-kind and compatibility fields; only exact
   provider-eligible capability requests; closed properties; and immutable
   bounded parse results. Its domain-separated semantic SHA-256 fingerprint is
   stable across property, whitespace and request-set ordering, while every
   validated field change changes the fingerprint. This content fingerprint is
   not proof of installation, a signature, approval, a grant or registry identity.
   Issue #647 adds the acquisition half: one materialized Jellyfin inventory,
   one constant filename, nonblocking Linux descriptor opens and cancellable
   overlapped Windows reads, regular-file and final-target verification, a
   `MaximumDocumentBytes + 1` read, before/after
   descriptor-state checks, exact GUID/version/assembly binding and a fresh host
   re-observation. Unsupported platforms, Linux filesystem types and non-fixed
   Windows roots fail closed.
   Successful output is an immutable observation only; it still carries no
   approval, grant, lifecycle, persistence or invocation authority.
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
13. **One authoritative registry owner.** It accepts only a sealed completed-sweep
   value minted by discovery, so cancellation or a caller-selected partial array
   cannot imply absence. A complete sweep and each typed admin decision linearize
   under one lock; persistence succeeds before a new immutable snapshot is
   published. Startup hydration is dormant and releases no provider authority.
   A failed reconcile write preserves the byte-exact durable file and published
   snapshot object but installs a transient live-release fence until a complete
   sweep commits successfully; stale observed authority is never released merely
   because persistence failed. A discovery-completed inventory whose host
   identities are empty, duplicated or over the bound installs the same transient
   fence instead of leaving the preceding authority live.
14. **Authority is the live exact intersection.** Release requires the current
   compatible active observation, exact plugin GUID, semantic fingerprint,
   requested set, provider-ceiling grant, enabled disposition and provider
   generation. Every admin decision advances the generation. Fingerprint,
   scope, host version, verified assembly, host state, compatibility and presence
   drift fence old releases. Disabled/restart facts may retain approval only when
   every exact bound fact returns unchanged.
15. **Admin and recovery decisions are fresh and non-reusable.** Approve,
   replace-grant, disable, enable, revoke and explicit quarantine recovery consume
   a one-use proof that re-reads the same elevated Jellyfin user again when the
   command consumes it. A retained proof therefore fails after deletion or
   demotion. The proof is never serialized. Durable decisions retain only bounded
   administrator id, reason, UTC time and decision revision.
16. **Corruption is store-wide and recovery preserves evidence.** Strict 1 MiB
   versioned JSON preflights record, field and capability bounds before DTO
   allocation. Invalid state publishes no records. Recovery writes one of eight
   immutable prepared epochs and commits its audit evidence last; the corrupt base
   or earlier epoch is never overwritten. A recovered epoch that later corrupts is
   durably fenced before another epoch may be selected. Missing recovered state is
   fenced likewise, epochs advance monotonically past malformed evidence, and a
   recovery succeeds only after reproving that its committed epoch is authoritative.

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
- The registry is a persisted store with strict schema/version checks, immutable
  recovery evidence and corruption/capacity/concurrency tests. Its eight recovery
  epochs are deliberately bounded; exhaustion requires operator preservation and
  repair rather than deleting evidence automatically.
- Discovery is restart-driven, and that is now a measured fact rather than a
  caution: a fully formed plugin directory dropped into `/config/plugins` on a
  running server is **not discovered**, and neither disable nor enable takes effect
  until a restart ([S15](../spike-evidence.md#s15--hot-lifecycle-nothing-is-ever-unloaded-and-disable-needs-a-restart)).
- **Uninstall does not reclaim anything.** The context stays alive with its
  assemblies loaded for the life of the process. Admin diagnostics should say so
  rather than implying the extension is gone.
- In-process code cannot impose an absolute wall-clock deadline on a synchronous
  path lookup or handle open after the operating-system kernel or storage driver
  accepts it. Classification itself requires the first root lookup, so a
  host-reported link into an unsupported target can wedge before Canopy can reject
  it. Once classification succeeds, the v1 reader rejects user-space, network and
  unknown filesystem roots, uses no abandoned `Task.Run` worker, and bounds all
  application-controlled bytes, counts and concurrency. Windows cancellation must
  await native I/O ownership returning before buffers can be reclaimed. Killable
  isolation for both residuals is tracked by #648; #647 does not claim to sandbox
  or kill a wedged kernel/driver.
- #650 does not register startup/background discovery, expose routes, load or
  invoke providers, or claim provider health. Those remain bounded EP-03.4/EP-04
  work. `Unhealthy` is therefore reserved for EP-04 rather than emitted by this
  registry domain.

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
