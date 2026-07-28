#!/usr/bin/env bash
# EP-00.4 — does anything actually go away when a plugin is disabled or uninstalled
# on a RUNNING Jellyfin 12 server?
#
# The EP-00 lifecycle matrix answered every case with a container restart, so it
# proved nothing about hot transitions. This drives Jellyfin's own admin endpoints
# and re-probes without restarting.
#
# Throwaway research code. Never built by CI. Creates and destroys its own container.
#
# Usage:  ./run-hot-lifecycle.sh [port]
set -euo pipefail

PORT="${1:-8196}"
IMAGE="${EP00_IMAGE:-jellyfin/jellyfin:12.0-rc3.20260722-020441}"
NAME="${EP00_CONTAINER:-ep00-hot}"
ADMIN_USER="${EP00_ADMIN_USER:-ep00admin}"
ADMIN_PW="${EP00_ADMIN_PW:-$(head -c 18 /dev/urandom | base64 | tr -d '/+=')Aa1!}"
PROVIDER_ID="b1a7c3d2-4e5f-4a6b-8c9d-0e1f2a3b4c5d"
PROVIDER_VERSION="1.0.0.0"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run --rm -v "$WORK:/work" alpine:3 sh -c 'rm -rf /work/..?* /work/.[!.]* /work/*' >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

export DOTNET_ROOT="${DOTNET_ROOT:-$HOME/.dotnet}"
export PATH="$DOTNET_ROOT:$PATH"

log() { printf '\n=== %s ===\n' "$*"; }
B="http://localhost:$PORT"

retry() {
  local attempts="$1"; shift
  local n=1
  until "$@"; do
    if [ "$n" -ge "$attempts" ]; then echo "gave up: $*" >&2; return 1; fi
    n=$((n + 1)); sleep 3
  done
}
route_is() { [ "$(curl -s -o /dev/null -w '%{http_code}' "$1")" = "$2" ]; }
wait_up() { retry 60 route_is "$B/System/Info/Public" 200; }

log "Build"
dotnet build "$HERE/Jellyfin.Plugin.Ep00Provider/Jellyfin.Plugin.Ep00Provider.csproj" -c Release -p:SpikeContractsVersion=2.0.0 >/dev/null
dotnet build "$HERE/Jellyfin.Plugin.Ep00Host/Jellyfin.Plugin.Ep00Host.csproj" -c Release -p:SpikeContractsVersion=1.0.0 >/dev/null

stage() {
  local dir="$1" guid="$2" name="$3" src="$4"
  mkdir -p "$WORK/$dir"
  cp "$src"/*.dll "$WORK/$dir/"
  cat > "$WORK/$dir/meta.json" <<META
{ "category": "General", "changelog": "", "description": "EP-00.4 hot-lifecycle probe.",
  "guid": "$guid", "name": "$name", "overview": "EP-00 spike", "owner": "jellyfin-canopy",
  "targetAbi": "12.0.0.0", "timestamp": "2026-07-28T00:00:00Z", "version": "1.0.0.0",
  "status": "Active", "autoUpdate": false, "imagePath": "", "assemblies": [] }
META
}
stage Ep00SpikeHost_1.0.0.0 a0b1c2d3-e4f5-4061-8273-8495a6b7c8d9 "EP-00 Spike Host" \
  "$HERE/Jellyfin.Plugin.Ep00Host/bin/Release/net10.0"
stage "Ep00SpikeProvider_$PROVIDER_VERSION" "$PROVIDER_ID" "EP-00 Spike Provider" \
  "$HERE/Jellyfin.Plugin.Ep00Provider/bin/Release/net10.0"
cat > "$WORK/Ep00SpikeProvider_$PROVIDER_VERSION/jellyfin-canopy-extension.json" <<'MANIFEST'
{ "schemaVersion": 1, "id": "ep00.spike.provider",
  "pluginId": "b1a7c3d2-4e5f-4a6b-8c9d-0e1f2a3b4c5d", "version": "1.0.0",
  "kind": "server-provider", "platform": { "min": 1, "max": 1 },
  "scopes": ["platform.discovery"], "operations": ["ping"] }
MANIFEST

log "Start disposable Jellyfin 12 on :$PORT"
docker rm -f "$NAME" >/dev/null 2>&1 || true
mkdir -p "$WORK/config" "$WORK/cache"
docker run -d --name "$NAME" -p "$PORT:8096" \
  -v "$WORK/config:/config" -v "$WORK/cache:/cache" "$IMAGE" >/dev/null
wait_up

log "Startup wizard"
retry 40 curl -sf -o /dev/null -X POST "$B/Startup/Configuration" -H 'Content-Type: application/json' \
  -d '{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}'
retry 10 curl -sf -o /dev/null "$B/Startup/User"
retry 10 curl -sf -o /dev/null -X POST "$B/Startup/User" -H 'Content-Type: application/json' \
  -d "{\"Name\":\"$ADMIN_USER\",\"Password\":\"$ADMIN_PW\"}"
retry 10 curl -sf -o /dev/null -X POST "$B/Startup/Complete"
TOKEN="$(curl -sf -X POST "$B/Users/AuthenticateByName" -H 'Content-Type: application/json' \
  -H 'Authorization: MediaBrowser Client="ep00", Device="hot", DeviceId="ep00hot", Version="1.0.0"' \
  -d "{\"Username\":\"$ADMIN_USER\",\"Pw\":\"$ADMIN_PW\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["AccessToken"])')"
AUTH="Authorization: MediaBrowser Token=$TOKEN"

log "Install both plugins and restart once (the only restart in this run)"
docker cp "$WORK/Ep00SpikeHost_1.0.0.0" "$NAME:/config/plugins/"
docker cp "$WORK/Ep00SpikeProvider_$PROVIDER_VERSION" "$NAME:/config/plugins/"
docker restart "$NAME" >/dev/null
wait_up
retry 40 route_is "$B/Ep00Spike/Discovery" 200

snapshot() {
  printf '  %-26s ' "$1"
  curl -s "$B/Ep00Spike/Runtime?collect=${2:-true}" -H "$AUTH" | python3 -c '
import json, sys
d = json.load(sys.stdin)
keys = ["pluginPresent", "pluginStatus", "pluginHasInstance", "assemblyLoaded",
        "diStillResolves", "totalLoadContexts", "collectibleLoadContexts",
        "firstSeenContextStillAlive", "firstSeenContextAssemblies"]
print(" ".join(f"{k}={d.get(k)}" for k in keys))'
}
invoke() {
  printf '  %-26s ' "$1"
  curl -s -G "$B/Ep00Spike/Invoke" -H "$AUTH" \
    --data-urlencode 'operationId=ping' --data-urlencode 'deadlineMs=2000' \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ok=%s error=%s" % (d.get("ok"), d.get("error")))'
}

log "Baseline (both plugins active, no transition yet)"
snapshot "baseline" ; invoke "baseline invoke"

log "DISABLE the provider at runtime — no restart"
curl -s -o /dev/null -w '  POST Disable -> %{http_code}\n' \
  -X POST "$B/Plugins/$PROVIDER_ID/$PROVIDER_VERSION/Disable" -H "$AUTH"
snapshot "after disable" ; invoke "after disable invoke"

log "Re-ENABLE the provider at runtime — no restart"
curl -s -o /dev/null -w '  POST Enable -> %{http_code}\n' \
  -X POST "$B/Plugins/$PROVIDER_ID/$PROVIDER_VERSION/Enable" -H "$AUTH"
snapshot "after enable" ; invoke "after enable invoke"

log "UNINSTALL the provider at runtime — no restart"
curl -s -o /dev/null -w '  DELETE -> %{http_code}\n' \
  -X DELETE "$B/Plugins/$PROVIDER_ID/$PROVIDER_VERSION" -H "$AUTH"
snapshot "after uninstall" ; invoke "after uninstall invoke"
printf '  plugin dir on disk        : '
docker exec "$NAME" sh -c "ls -d /config/plugins/Ep00SpikeProvider_$PROVIDER_VERSION 2>/dev/null || echo '(removed)'"

log "INSTALL a new plugin directory at runtime — no restart"
docker cp "$WORK/Ep00SpikeProvider_$PROVIDER_VERSION" "$NAME:/config/plugins/"
snapshot "after drop-in install" ; invoke "after drop-in invoke"

log "Finally restart, to show what the restart changes"
docker restart "$NAME" >/dev/null
wait_up
retry 40 route_is "$B/Ep00Spike/Discovery" 200
snapshot "after restart" ; invoke "after restart invoke"

log "Done — container and temporary state are removed on exit."
