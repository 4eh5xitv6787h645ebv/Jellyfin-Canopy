# Releasing

Releases are automated by [`.github/workflows/release.yml`](.github/workflows/release.yml).
Nobody builds ZIPs by hand, and nobody hand-edits `manifest.json` — the
committed manifest is the plugin catalog every installed copy polls for
updates, and a malformed entry bricks in-app updates for all users.

## Cutting a release

1. Make sure the default branch is green (the **Build & Test** workflow).
2. Tag the commit and push the tag. The existing convention is a bare
   4-part version (a `v` prefix with 3 parts also works):

   ```bash
   git tag 11.13.0.0
   git push origin 11.13.0.0
   ```

3. The **Release** workflow then:
   - runs the full quality gates (both plugin targets, unit tests, JS
     syntax/lint/type checks) — any failure aborts the release;
   - builds both flavors with the tag stamped as `AssemblyVersion`/
     `FileVersion` (the tag is the single source of truth — the version in
     the csproj is never bumped by CI);
   - packages one ZIP per Jellyfin major, with exactly the plugin DLL at the
     zip root, using the established asset names:
     - `Jellyfin.Plugin.JellyfinEnhanced_10.11.0.zip` (Jellyfin 10.11, net9.0)
     - `Jellyfin.Plugin.JellyfinEnhanced_12.0.0.zip` (Jellyfin 12, net10.0)
   - creates the GitHub Release with a changelog generated from the commit
     subjects since the previous tag, and attaches both ZIPs;
   - regenerates `manifest.json` (new entry prepended, MD5 checksum computed
     from the real ZIP, timestamped) and opens a PR with the change.

4. **Review and merge the manifest PR.** Merging it is the step that
   publishes the update to installed plugins. Note that PRs opened with the
   built-in `GITHUB_TOKEN` do not trigger the Build & Test checks — the
   manifest was already validated inside the release run.

### Custom release notes

To write the changelog yourself, draft a GitHub release for the tag (with
your notes as the body) *before* pushing the tag, or push the tag from the
release UI. When a release for the tag already exists, the workflow reuses
its body as the manifest changelog and only attaches the ZIPs.

### Jellyfin 12 in the catalog

The manifest has only ever carried the Jellyfin 10.11 flavor
(`targetAbi: 10.11.0.0`). The Jellyfin 12 ZIP is always attached to the
release for sideloading, but a `targetAbi: 12.0.0.0` manifest entry is only
generated once `INCLUDE_JF12_IN_MANIFEST` is flipped to `'true'` at the top
of `release.yml`.

## Tooling (`scripts/release/`)

Both scripts are dependency-free Node and can be run locally:

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
