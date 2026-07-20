# Releasing

Releases are automated by [`.github/workflows/release.yml`](.github/workflows/release.yml).
Nobody builds ZIPs by hand, and nobody hand-edits `manifest.json` — the
committed manifest is the plugin catalog every installed copy polls for
updates, and a malformed entry bricks in-app updates for all users.

## Cutting a release

1. Merge the release source through a pull request and make sure every
   required **Build & Test** and **Security Scan** check is green on the
   current default branch. Direct pushes to the default branch are blocked.
2. Tag that reviewed default-branch commit with the **next plugin version** and
   push the tag. Canopy is currently on its 2.x plugin release line; the
   Jellyfin target ABI is separately fixed at `12.0.0.0`. The tag convention
   is a bare 4-part plugin version (a `v` prefix with 3 parts also works):

   ```bash
   git tag 2.0.1.0
   git push origin 2.0.1.0
   ```

   Only the repository maintainer can create a matching release tag. Once
   created, the tag cannot be moved or deleted; a correction always receives
   a new version and tag.

3. The **Release** workflow then:
   - proves the tag commit is reachable from the current reviewed default
     branch before any expensive or write-capable job can start;
   - reuses the complete **Build & Test** and **Security Scan** workflows on
     that exact tag SHA. Lint findings remain advisory; every non-lint gate,
     the secret scan, dependency audit, and Dockerized Jellyfin 12 E2E must
     succeed;
   - waits at the protected `release` environment. Review the displayed tag
     SHA, default-branch SHA, and gate results, then explicitly approve the
     deployment. Repository administrators cannot bypass this approval;
   - builds the plugin with the tag stamped as `AssemblyVersion`/
     `FileVersion` (the tag is the single source of truth — the version in
     the csproj is never bumped by CI);
   - packages one ZIP, with exactly the plugin DLL at the zip root, using
     the established asset name:
     - `Jellyfin.Plugin.JellyfinCanopy_12.0.0.zip` (Jellyfin 12, net10.0)
   - creates the GitHub Release with complete notes from a pre-drafted body or
     commit subjects since the previous tag, and attaches the ZIP;
   - derives a separate concise catalog summary, preserves security/breaking/
     migration/upgrade subjects, and links installed users to the complete
     GitHub release notes;
   - regenerates `manifest.json` (new entry prepended, MD5 checksum computed
     from the real ZIP, timestamped) and opens a PR with the change.

   The [nightly large-library scale
   tier](CONTRIBUTING.md#nightly-large-library-scale-tier) is currently
   **advisory** and is not part of these reused gates or of `release.yml`. Once
   its budgets ratchet to blocking, the release will additionally require a
   provenance-verified scale result for the exact tag SHA — freshly dispatched,
   or reused as an immutable workflow artifact created within the preceding
   seven days whose recorded budget digest matches the tag commit — with at
   most two retries for infrastructure-only failures; a measured budget breach
   is evidence, not a retryable error. That future gate joins the existing
   no-bypass release contract; it does not change it.

4. **Review and merge the manifest PR.** Merging it is the step that
   publishes the update to installed plugins. GitHub does not automatically
   trigger workflows for a PR opened by `GITHUB_TOKEN`, so the release job
   explicitly dispatches both required workflows against the exact manifest
   proposal SHA. The protected default branch rejects the merge until those
   checks succeed and every review thread is resolved. If `main` advances,
   first update the proposal branch from `main` (using GitHub's **Update
   branch** control or a reviewer-owned rebase). After any proposal-head
   change, rerun the original **Release** workflow. Its idempotent resume path
   dispatches the suites for the exact new branch head; failed/cancelled old
   runs do not suppress that retry.

## Enforced repository policy

The auditable policy declaration is
[`scripts/release/repository-policy.json`](scripts/release/repository-policy.json).
The live repository must match it:

- the default branch accepts changes only through pull requests, rejects
  deletion/force-push, requires up-to-date branches, and requires the complete
  blocking Build/Test and Security check set specifically from GitHub Actions;
- only the named maintainer may create a release-pattern tag, while a separate
  no-bypass ruleset prevents every actor from moving or deleting one;
- the `release` environment accepts only release-pattern tags and requires an
  explicit maintainer approval with administrator bypass disabled.

This is currently a one-collaborator repository. GitHub does not permit a PR
author to approve their own PR, so the branch ruleset requires PR flow and
resolved review threads but zero platform approval reviews. Independent code
review remains recorded on the PR, and the non-bypassable environment approval
is the enforced human release decision. If a second trusted collaborator is
added, raise `required_approving_review_count` to `1` in the declaration and
live ruleset together.

`node scripts/release/verify-repository-policy.js` compares the complete live
ruleset details, bypass actors, required checks, environment reviewers/admin
bypass, and tag deployment policies with that declaration. The daily Security
Scan runs it from reviewed `main`, and every release runs it again on the exact
tag SHA. API denial or any missing/weakened/different control is blocking.
GitHub's ordinary ruleset-detail response can omit bypass actors without
marking the response incomplete, so the verifier also reads a stable current
ruleset-history version and fails closed if complete evidence is unavailable.

The workflow requires an Actions repository secret named
`REPOSITORY_POLICY_TOKEN`. Create it from a fine-grained personal access token
limited to this repository with only **Administration: Read and write** (plus
GitHub's automatic Metadata read permission), set an expiry/rotation owner, and
do not add Contents or Actions access. Administration write is unavoidable:
GitHub requires it for both ruleset-history endpoints, even though this verifier
performs only reads. Ordinary policy and environment reads use the separate,
ephemeral `GITHUB_TOKEN` with `actions: read` and `contents: read`; the external
token enters only the verifier step as `RULESET_TOKEN`.

## Emergency procedure

There is no bypass-by-tag procedure. Never move, delete, or reuse a release
tag, replace a published asset, or disable a failed gate to make a release run.
For a bad source or package, fix forward through a reviewed PR and cut a new
version.

If GitHub policy itself prevents all releases because its configuration is
wrong, open a dedicated repository issue first. Record the failing rule,
current live policy, intended temporary change, approver, and UTC timestamps;
make the narrowest policy repair; then restore and verify the complete JSON
contract before cutting any tag. Environment approval and source ancestry stay
mandatory throughout. GitHub's ruleset/environment history plus the issue and
release summary form the audit trail.

### Release-note and catalog-summary contract

To write the release notes yourself, draft a GitHub release for the tag (with
your notes as the body) *before* pushing the tag, or push the tag from the
release UI. The complete body remains on the GitHub release. If it already
fits the catalog limits, it also becomes the catalog summary. For longer
notes, put the concise installed-client summary between these invisible
markers in the draft body:

```markdown
<!-- jellyfin-canopy-catalog-summary:start -->
- Security: describe security-relevant behavior.
- Breaking: name any required operator or custom-integration action.
- Migration: explain state and compatibility behavior.
<!-- jellyfin-canopy-catalog-summary:end -->
```

The catalog copy always gains a stable link to the complete release. The
first-ever release has no meaningful commit delta, so a curated pre-draft is
mandatory; the workflow refuses to substitute the complete repository
history. Normal releases without a draft use commit subjects, retaining every
security, breaking, migration, and upgrade subject before filling the bounded
summary with other changes. Empty notes and priority information that cannot
fit are blocking and require a curated draft. Commit-generated bodies carry an
invisible ownership marker; a workflow rerun verifies and regenerates the same
body and catalog summary. If someone edits that generated body, the rerun fails
closed until the marker is removed and an explicit curated summary is added.

### Plugin versions and the manifest ABI stream

The git tag, assembly version, and manifest `version` are the Canopy plugin
version. The package name and manifest `targetAbi` describe Jellyfin
compatibility and remain `12.0.0` / `12.0.0.0` independently. This catalog
contains only Jellyfin 12 entries; Jellyfin 10.11 users must use the original
Jellyfin Enhanced repository instead.

## Tooling (`scripts/release/`)

The release tools are dependency-free Node and can be run locally:

- `node scripts/release/verify-provenance.js --tag-ref <sha-or-tag>
  --default-ref <default-ref> --default-branch <name>` — resolves both inputs
  to commits and fails unless the tag commit is an ancestor of the reviewed
  branch. The workflow records both immutable SHAs in its summary.
- `scripts/release/repository-policy.json` — the versioned source of truth for
  required checks, default-branch PR protection, release-tag creation and
  immutability, and the approval environment.
- `node scripts/release/verify-repository-policy.js` — compares that source of
  truth with GitHub's live ruleset and environment APIs; requires read-only
  `GH_TOKEN` plus `RULESET_TOKEN` with repository Administration read/write so
  stable current history supplies complete bypass-actor evidence.

- `node scripts/release/validate-manifest.js manifest.json` — validates the
  manifest: JSON shape, required fields, 4-part versions, MD5 checksum and
  GitHub release-asset URL formats, timestamps, duplicate detection, and
  strictly-decreasing versions per `targetAbi` stream. It also blocks any
  changelog over 4,096 UTF-8 bytes or 60 lines and any serialized manifest
  over 65,536 bytes. Runs on every push/PR (the `manifest` job in `build.yml`)
  and inside the release workflow.
- `scripts/release/manifest-policy.json` — the shared byte/line budget source
  consumed by the validator and the Jellyfin package-model compatibility test.
- `node scripts/release/prepare-release-notes.js ...` — keeps complete release
  notes separate from the bounded catalog summary, enforces the first-release
  curation rule, preserves priority subjects, neutralizes mention-shaped text,
  and adds the stable full-notes link.
- `node scripts/release/update-manifest.js --manifest manifest.json --tag <tag>
  --repo <owner/name> --changelog-file <file> --asset <targetAbi>=<zip> ...` —
  prepends the release entries. Refuses non-monotonic versions, misnamed
  ZIPs, and any change that would leave the manifest invalid.

If a release ever has to be assembled manually, use `update-manifest.js`
with the downloaded assets rather than editing `manifest.json` by hand, and
run the validator before committing.
