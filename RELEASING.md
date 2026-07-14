# Releasing

Releases are automated by [`.github/workflows/release.yml`](.github/workflows/release.yml).
Nobody builds ZIPs by hand, and nobody hand-edits `manifest.json` — the
committed manifest is the plugin catalog every installed copy polls for
updates, and a malformed entry bricks in-app updates for all users.

## Cutting a release

1. Merge the release source through a pull request and make sure every
   required **Build & Test** and **Security Scan** check is green on the
   current default branch. Direct pushes to the default branch are blocked.
2. Tag that reviewed default-branch commit and push the tag. The existing convention is a bare
   4-part version (a `v` prefix with 3 parts also works):

   ```bash
   git tag 12.0.0.0
   git push origin 12.0.0.0
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
   - creates the GitHub Release with a changelog generated from the commit
     subjects since the previous tag, and attaches the ZIP;
   - regenerates `manifest.json` (new entry prepended, MD5 checksum computed
     from the real ZIP, timestamped) and opens a PR with the change.

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

### Custom release notes

To write the changelog yourself, draft a GitHub release for the tag (with
your notes as the body) *before* pushing the tag, or push the tag from the
release UI. When a release for the tag already exists, the workflow reuses
its body as the manifest changelog and only attaches the ZIPs.

### Manifest ABI streams

New releases publish only `targetAbi: 12.0.0.0` manifest entries. The
manifest's existing `targetAbi: 10.11.0.0` entries are frozen history: they
keep serving the final Jellyfin 10.11-compatible release line and must never
be edited or removed.

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
  truth with GitHub's live ruleset and environment APIs; requires an
  authenticated `GH_TOKEN` that can read full ruleset bypass details.

- `node scripts/release/validate-manifest.js manifest.json` — validates the
  manifest: JSON shape, required fields, 4-part versions, MD5 checksum and
  GitHub release-asset URL formats, timestamps, duplicate detection, and
  strictly-decreasing versions per `targetAbi` stream. Runs on every push/PR
  (the `manifest` job in `build.yml`) and inside the release workflow.
- `node scripts/release/update-manifest.js --manifest manifest.json --tag <tag>
  --repo <owner/name> --changelog-file <file> --asset <targetAbi>=<zip> ...` —
  prepends the release entries. Refuses non-monotonic versions, misnamed
  ZIPs, and any change that would leave the manifest invalid.

If a release ever has to be assembled manually, use `update-manifest.js`
with the downloaded assets rather than editing `manifest.json` by hand, and
run the validator before committing.
