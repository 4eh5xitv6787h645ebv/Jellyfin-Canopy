#!/usr/bin/env bash
# EP-00.2 — browser spike for ADR-0007.
#
# Builds Canopy, brings up the repository's own disposable dockerized Jellyfin 12
# (e2e/docker), seeds it, and runs the throwaway sandbox spec against it.
#
# The spec lives under research/ and uses its own Playwright config, so it is
# never part of the required E2E suite.
#
# Usage:  ./run-web-spike.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
cd "$REPO_ROOT"

export DOTNET_ROOT="${DOTNET_ROOT:-$HOME/.dotnet}"
export PATH="$DOTNET_ROOT:$PATH"
export JF_PORT="${JF_PORT:-8100}"
export JF_E2E_PROJECT="${JF_E2E_PROJECT:-ep00web}"

log() { printf '\n=== %s ===\n' "$*"; }

cleanup() {
  docker compose -p "$JF_E2E_PROJECT" -f e2e/docker/compose.yml down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "Build the plugin (this also builds the client bundle)"
dotnet build Jellyfin.Plugin.JellyfinCanopy/JellyfinCanopy.csproj -c Release >/dev/null

log "Seed a disposable dockerized Jellyfin 12 on :$JF_PORT"
bash e2e/docker/seed.sh

log "Run the EP-00.2 sandbox spec"
JF_BASE_URL="http://127.0.0.1:$JF_PORT" \
  npx playwright test --config research/extension-platform/spikes/ep-00/web/playwright.config.ts

log "Done — the disposable stack is torn down on exit."
