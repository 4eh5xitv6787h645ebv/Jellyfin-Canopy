#!/usr/bin/env bash
# EP-00 throwaway spike runner.
#
# Builds the two independently packaged spike plugins, installs them into a
# disposable Jellyfin 12 container, and replays probes A-J from
# ../../spike-evidence.md. Three results there were produced by hand and are NOT
# scripted: S7's nginx proxy matrix, S13's 1.0.0.0 -> 2.5.0.0 upgrade row, and
# S8's rejected authentication header forms. See "Probe coverage of this file".
#
# This is throwaway research code. It is deliberately outside the solution and
# is never built by CI. Nothing here becomes Platform v1.
#
# Usage:  ./run-spike.sh [port]
set -euo pipefail

PORT="${1:-8199}"
IMAGE="${EP00_IMAGE:-jellyfin/jellyfin:12.0-rc3.20260722-020441}"
NAME="${EP00_CONTAINER:-ep00-jf12}"
ADMIN_USER="${EP00_ADMIN_USER:-ep00admin}"
# Throwaway credential for a disposable container that is destroyed at the end of
# the run. Override with EP00_ADMIN_PW if your environment forbids a literal.
ADMIN_PW="${EP00_ADMIN_PW:-$(head -c 18 /dev/urandom | base64 | tr -d '/+=')Aa1!}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"

# The container writes into $WORK as root, so the temp directory cannot be removed
# from here. Stop the container first, then delete its files from inside a
# throwaway container that does run as root.
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run --rm -v "$WORK:/work" alpine:3 sh -c 'rm -rf /work/..?* /work/.[!.]* /work/*' >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

export DOTNET_ROOT="${DOTNET_ROOT:-$HOME/.dotnet}"
export PATH="$DOTNET_ROOT:$PATH"

log() { printf '\n=== %s ===\n' "$*"; }

log "Build (host ships SpikeContracts 1.0.0, provider ships 2.0.0)"
dotnet build "$HERE/Jellyfin.Plugin.Ep00Provider/Jellyfin.Plugin.Ep00Provider.csproj" \
  -c Release -p:SpikeContractsVersion=2.0.0 >/dev/null
dotnet build "$HERE/Jellyfin.Plugin.Ep00Host/Jellyfin.Plugin.Ep00Host.csproj" \
  -c Release -p:SpikeContractsVersion=1.0.0 >/dev/null

stage_plugin() {
  local dir="$1" guid="$2" name="$3" desc="$4" src="$5"
  mkdir -p "$WORK/$dir"
  cp "$src"/*.dll "$WORK/$dir/"
  cat > "$WORK/$dir/meta.json" <<META
{
  "category": "General",
  "changelog": "",
  "description": "$desc",
  "guid": "$guid",
  "name": "$name",
  "overview": "EP-00 spike",
  "owner": "jellyfin-canopy",
  "targetAbi": "12.0.0.0",
  "timestamp": "2026-07-27T00:00:00Z",
  "version": "1.0.0.0",
  "status": "Active",
  "autoUpdate": false,
  "imagePath": "",
  "assemblies": []
}
META
}

stage_plugin Ep00SpikeHost_1.0.0.0 \
  a0b1c2d3-e4f5-4061-8273-8495a6b7c8d9 "EP-00 Spike Host" \
  "Throwaway EP-00 spike platform host." \
  "$HERE/Jellyfin.Plugin.Ep00Host/bin/Release/net10.0"
stage_plugin Ep00SpikeProvider_1.0.0.0 \
  b1a7c3d2-4e5f-4a6b-8c9d-0e1f2a3b4c5d "EP-00 Spike Provider" \
  "Throwaway EP-00 spike provider." \
  "$HERE/Jellyfin.Plugin.Ep00Provider/bin/Release/net10.0"

# The extension manifest is deliberately shipped only by the provider, so the
# discovery probe can show both the found and the absent case.
cat > "$WORK/Ep00SpikeProvider_1.0.0.0/jellyfin-canopy-extension.json" <<'MANIFEST'
{
  "schemaVersion": 1,
  "id": "ep00.spike.provider",
  "pluginId": "b1a7c3d2-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
  "version": "1.0.0",
  "kind": "server-provider",
  "platform": { "min": 1, "max": 1 },
  "scopes": ["platform.discovery"],
  "operations": ["ping", "hang", "big", "throw", "invalid-json"]
}
MANIFEST

log "Start disposable Jellyfin 12 ($IMAGE) on :$PORT"
docker rm -f "$NAME" >/dev/null 2>&1 || true
mkdir -p "$WORK/config" "$WORK/cache"
docker run -d --name "$NAME" -p "$PORT:8096" \
  -v "$WORK/config:/config" -v "$WORK/cache:/cache" "$IMAGE" >/dev/null

B="http://localhost:$PORT"
wait_up() {
  local prefix="${1:-}"
  for _ in $(seq 1 60); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "$B$prefix/System/Info/Public")" = "200" ]; then
      return 0
    fi
    sleep 3
  done
  echo "server did not come up" >&2
  return 1
}
wait_up

# /System/Info/Public answers 200 well before the server will accept a startup-wizard
# POST, which returns 503 until initialisation finishes. Liveness is not readiness:
# retry until the first wizard call is actually accepted.
retry() {
  local attempts="$1"; shift
  local n=1
  until "$@"; do
    if [ "$n" -ge "$attempts" ]; then
      echo "gave up after $attempts attempts: $*" >&2
      return 1
    fi
    n=$((n + 1))
    sleep 3
  done
}

log "Complete startup wizard"
route_is() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$1")" = "$2" ]
}

retry 40 curl -sf -o /dev/null -X POST "$B/Startup/Configuration" -H 'Content-Type: application/json' \
  -d '{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}'
retry 10 curl -sf -o /dev/null "$B/Startup/User"
retry 10 curl -sf -o /dev/null -X POST "$B/Startup/User" -H 'Content-Type: application/json' \
  -d "{\"Name\":\"$ADMIN_USER\",\"Password\":\"$ADMIN_PW\"}"
retry 10 curl -sf -o /dev/null -X POST "$B/Startup/Complete"

read_token() { python3 -c 'import json,sys; print(json.load(sys.stdin)["AccessToken"])'; }
TOKEN="$(curl -sf -X POST "$B/Users/AuthenticateByName" -H 'Content-Type: application/json' \
  -H 'Authorization: MediaBrowser Client="ep00", Device="spike", DeviceId="ep00spike", Version="1.0.0"' \
  -d "{\"Username\":\"$ADMIN_USER\",\"Pw\":\"$ADMIN_PW\"}" | read_token)"
AUTH="Authorization: MediaBrowser Token=$TOKEN"

curl -sf -o /dev/null -X POST "$B/Users/New" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"Name\":\"ep00user\",\"Password\":\"$ADMIN_PW\"}"
TOKEN2="$(curl -sf -X POST "$B/Users/AuthenticateByName" -H 'Content-Type: application/json' \
  -H 'Authorization: MediaBrowser Client="ep00", Device="spike2", DeviceId="ep00spike2", Version="1.0.0"' \
  -d "{\"Username\":\"ep00user\",\"Pw\":\"$ADMIN_PW\"}" | read_token)"

log "Probe A — host authentication and authorization semantics (no plugin needed)"
printf 'bare 401 body bytes   : %s\n' "$(curl -s -o /dev/null -w '%{size_download}' "$B/System/Info")"
for p in api_key apikey ApiKey token accessToken; do
  printf 'query auth %-12s : %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "$B/System/Info?$p=$TOKEN")"
done
# Header forms Jellyfin 12 does and does not accept. Labels are written out so the
# token never appears in the transcript.
header_probe() {
  printf 'header %-30s : %s\n' "$1" \
    "$(curl -s -o /dev/null -w '%{http_code}' "$B/System/Info" -H "$2")"
}
header_probe 'X-Emby-Token'                "X-Emby-Token: $TOKEN"
header_probe 'X-MediaBrowser-Token'        "X-MediaBrowser-Token: $TOKEN"
header_probe 'Authorization: Bearer'       "Authorization: Bearer $TOKEN"
header_probe 'Authorization: Emby'         "Authorization: Emby Token=$TOKEN"
header_probe 'Authorization: MediaBrowser' "Authorization: MediaBrowser Token=$TOKEN"
printf 'CORS preflight        : '
curl -s -i -X OPTIONS "$B/System/Info" -H 'Origin: https://evil.example' \
  -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization' \
  | grep -i 'access-control-allow' | tr -d '\r' | paste -sd' '

# The HOST is deliberately given a manifest claiming the PROVIDER's GUID, so the
# fingerprint-mismatch rejection has a negative case to reject.
cat > "$WORK/Ep00SpikeHost_1.0.0.0/jellyfin-canopy-extension.json" <<'IMPOSTOR'
{
  "schemaVersion": 1,
  "id": "ep00.impostor",
  "pluginId": "b1a7c3d2-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
  "version": "9.9.9",
  "kind": "server-provider"
}
IMPOSTOR

log "Install both spike plugins"
docker cp "$WORK/Ep00SpikeHost_1.0.0.0" "$NAME:/config/plugins/"
docker cp "$WORK/Ep00SpikeProvider_1.0.0.0" "$NAME:/config/plugins/"
# Symlinks for the containment probe: one escaping directory component, one
# escaping leaf, and one that legitimately stays inside the root.
# Link fixtures for the containment probe. They live OUTSIDE /config/plugins on
# purpose: Jellyfin walks plugin roots for assemblies, and a link to "/" inside one
# prevents the server from starting at all.
docker exec "$NAME" sh -c '
  R=/config/ep00-linktests
  mkdir -p "$R"
  echo "{}" > "$R/inside.json"
  ln -sfn /etc              "$R/escape-dir"
  ln -sfn /etc/hostname     "$R/escape-file"
  ln -sfn inside.json       "$R/inside-file"
  # Two-hop chain: both links are inside the fixture root and neither target is
  # lexically outside it. Only fixed-point resolution catches this.
  ln -sfn /etc              "$R/hop-root"
  ln -sfn "$R/hop-root/ssl" "$R/hop-etc"
  # A loop, to prove the reader rejects rather than throwing out of discovery.
  ln -sfn cycle2 "$R/cycle"
  ln -sfn cycle  "$R/cycle2"'
docker restart "$NAME" >/dev/null
wait_up
# Plugin controllers are routed a little after the server answers /System/Info.
# NB: the command must be re-evaluated on every attempt, so this has to be a
# function call - `retry N test "$(curl ...)" = 200` expands the curl exactly once
# and then loops on a stale value until it gives up.
retry 40 route_is "$B/Ep00Spike/Discovery" 200

log "Probe B — load contexts and type identity"
curl -s "$B/Ep00Spike/Self" -H "$AUTH" | python3 -m json.tool
curl -s "$B/Ep00Spike/TypeIdentity" -H "$AUTH" | python3 -m json.tool

log "Probe C — manifest discovery bound to the real plugin GUID, and traversal"
curl -s "$B/Ep00Spike/Manifests" -H "$AUTH" | python3 -m json.tool
curl -s "$B/Ep00Spike/Traversal" -H "$AUTH" | python3 -m json.tool

log "Probe D — provider failure isolation (host deadline 2000 ms)"
for spec in 'ping|{}' 'throw|{}' 'invalid-json|{}' 'unknown-op|{}' 'big|{"bytes":2000000}' 'hang|{"ms":8000}' 'cancellable-hang|{"ms":8000}'; do
  op="${spec%%|*}"; body="${spec#*|}"
  printf '%-18s ' "$op"
  curl -s -G "$B/Ep00Spike/Invoke" -H "$AUTH" \
    --data-urlencode "operationId=$op" --data-urlencode "requestJson=$body" \
    --data-urlencode 'deadlineMs=2000'
  echo
done

log "Probe E — event stream and long-poll fallback"
curl -sN -H "$AUTH" "$B/Ep00Spike/Stream?events=4&intervalMs=700" | python3 -c '
import sys, time
t0 = time.monotonic()
for line in sys.stdin:
    if line.startswith("data:"):
        print(f"{time.monotonic() - t0:6.2f}s  {line.strip()}")
'
printf 'EventSource (no header)   : %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "$B/Ep00Spike/Stream?events=1")"
printf 'EventSource (?apikey=)    : %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "$B/Ep00Spike/Stream?events=1&apikey=$TOKEN")"
curl -s -H "$AUTH" -w ' [%{time_total}s]\n' "$B/Ep00Spike/LongPoll?waitMs=1500"

log "Probe F — authorization matrix over plugin routes"
printf '%-34s %-6s %-6s %-6s\n' endpoint anon user admin
for ep in Discovery Whoami AdminOnly Plugins TypeIdentity Manifests; do
  printf '%-34s %-6s %-6s %-6s\n' "/Ep00Spike/$ep" \
    "$(curl -s -o /dev/null -w '%{http_code}' "$B/Ep00Spike/$ep")" \
    "$(curl -s -o /dev/null -w '%{http_code}' "$B/Ep00Spike/$ep" -H "Authorization: MediaBrowser Token=$TOKEN2")" \
    "$(curl -s -o /dev/null -w '%{http_code}' "$B/Ep00Spike/$ep" -H "$AUTH")"
done

log "Probe G — request-size and JSON-depth boundaries"
for n in 1000000 29000000 30000000; do
  python3 -c 'import sys; n=int(sys.argv[1]); sys.stdout.write("{\"blob\":\"" + "x"*n + "\"}")' "$n" > "$WORK/payload.json"
  printf '%12s bytes -> %s\n' "$n" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/Ep00Spike/Echo" -H "$AUTH" \
       -H 'Content-Type: application/json' --data-binary "@$WORK/payload.json")"
done
python3 -c 'print("{\"a\":"*200 + "1" + "}"*200)' > "$WORK/deep.json"
printf 'depth 200 -> '
curl -s -X POST "$B/Ep00Spike/Echo" -H "$AUTH" -H 'Content-Type: application/json' \
  --data-binary "@$WORK/deep.json"
echo

log "Probe J — forged identity (non-admin token, injected user ids)"
ADMIN_ID="$(curl -s "$B/Users/Me" -H "$AUTH" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Id"])')"
resolved() {
  curl -s "$B/Ep00Spike/Whoami" -H "Authorization: MediaBrowser Token=$TOKEN2" "$@" \
    | python3 -c 'import json,sys; print([c["Value"] for c in json.load(sys.stdin)["claims"] if c["Type"]=="Jellyfin-UserId"])'
}
printf 'non-admin baseline            : %s\n' "$(resolved)"
printf 'Jellyfin-UserId header        : %s\n' "$(resolved -H "Jellyfin-UserId: $ADMIN_ID")"
printf 'X-Jellyfin-User-Id header     : %s\n' "$(resolved -H "X-Jellyfin-User-Id: $ADMIN_ID")"
printf 'X-Emby-Authorization UserId   : %s\n' "$(resolved -H "X-Emby-Authorization: MediaBrowser UserId=$ADMIN_ID")"
printf 'jellyfin-userid cookie        : %s\n' "$(resolved -b "jellyfin-userid=$ADMIN_ID")"
printf 'admin id (must NOT appear)    : %s\n' "$ADMIN_ID"

log "Probe H — reverse proxy base path"
curl -s "$B/System/Configuration/network" -H "$AUTH" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); d["BaseUrl"]="/jf"; print(json.dumps(d))' > "$WORK/net.json"
curl -s -o /dev/null -X POST "$B/System/Configuration/network" -H "$AUTH" \
  -H 'Content-Type: application/json' --data-binary "@$WORK/net.json"
docker restart "$NAME" >/dev/null
wait_up /jf
printf 'plugin route under /jf : %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "$B/jf/Ep00Spike/Discovery")"
printf 'plugin route bare      : %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "$B/Ep00Spike/Discovery")"

log "Probe I — lifecycle matrix"
lifecycle_probe() {
  printf '  binding : %s\n' "$(curl -s "$B/jf/Ep00Spike/TypeIdentity" -H "$AUTH" \
    | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("host route unavailable"); raise SystemExit
print("found=%s diag=%s cast=%s di=%s" % (d.get("providerAssemblyFound"), d.get("diagnostic"), d.get("directCastSucceeded"), d.get("diResolvedInstance")))')"
  printf '  invoke  : %s\n' "$(curl -s -G "$B/jf/Ep00Spike/Invoke" -H "$AUTH" \
    --data-urlencode 'operationId=ping' --data-urlencode 'deadlineMs=2000' | head -c 120)"
  printf '  order   : %s\n' "$(docker logs "$NAME" 2>&1 | grep 'Loaded plugin:' | tail -8 \
    | sed 's/.*Loaded plugin: //' | tr '\n' '|')"
}

echo "-- baseline (host name sorts first)"; lifecycle_probe
echo "-- load order reversed (manifest name decides order)"
docker exec "$NAME" sh -c 'sed -i "s/\"name\": \"EP-00 Spike Provider\"/\"name\": \"AAA Spike Provider\"/" /config/plugins/Ep00SpikeProvider_1.0.0.0/meta.json'
docker restart "$NAME" >/dev/null; wait_up /jf; lifecycle_probe
echo "-- provider disabled"
docker exec "$NAME" sh -c 'sed -i "s/\"status\": \"Active\"/\"status\": \"Disabled\"/" /config/plugins/Ep00SpikeProvider_1.0.0.0/meta.json'
docker restart "$NAME" >/dev/null; wait_up /jf; lifecycle_probe
echo "-- provider uninstalled"
docker exec "$NAME" sh -c 'rm -rf /config/plugins/Ep00SpikeProvider_1.0.0.0'
docker restart "$NAME" >/dev/null; wait_up /jf; lifecycle_probe
echo "-- platform absent (host removed, provider reinstalled)"
docker cp "$WORK/Ep00SpikeProvider_1.0.0.0" "$NAME:/config/plugins/"
docker exec "$NAME" sh -c 'rm -rf /config/plugins/Ep00SpikeHost_1.0.0.0'
docker restart "$NAME" >/dev/null; wait_up /jf
printf '  jellyfin health : %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "$B/jf/System/Info/Public")"
printf '  host route      : %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "$B/jf/Ep00Spike/Discovery")"
# Count errors for THIS boot only. `tail -200` would inspect a window, not a boot,
# and would quietly under-report on a chatty startup.
BOOT_START="$(docker inspect "$NAME" --format '{{.State.StartedAt}}')"
printf '  boot errors     : %s\n' "$(docker logs --since "$BOOT_START" "$NAME" 2>&1 | grep -c '\[ERR\]' || true)"

log "Done — the container and its temporary state are removed on exit."
