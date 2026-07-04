#!/usr/bin/env bash
# Seed a throwaway dockerized Jellyfin 12 for the E2E suite:
#   1. install the freshly built plugin DLL into a clean config volume,
#   2. generate a handful of tiny valid movies with ffmpeg (testsrc2 clips),
#   3. boot the compose stack and complete the startup wizard via the API,
#   4. create the movie library + the two test users the specs expect,
#   5. enable the plugin features the specs exercise (tags, random button,
#      hidden content) and wait for the library scan to index the movies.
#
# Idempotent: every run starts from a wiped config/cache/media state.
# Requirements: docker (compose v2), curl, jq. ffmpeg is used from the host
# when available, otherwise from jellyfin-ffmpeg inside the pulled image.
#
# Usage:
#   dotnet build Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj -c Release
#   bash e2e/docker/seed.sh                # default port 8100
#   JF_BASE_URL=http://localhost:8100 npm run e2e
#   docker compose -f e2e/docker/compose.yml down -v
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
COMPOSE="docker compose -f ${HERE}/compose.yml"
IMAGE="jellyfin/jellyfin:12.0-rc2" # keep in sync with compose.yml

export JF_PORT="${JF_PORT:-8100}"
export JF_UID JF_GID
JF_UID="$(id -u)"
JF_GID="$(id -g)"

BASE="http://localhost:${JF_PORT}"
ADMIN_USER="${JF_ADMIN_USER:-je_arradmin}"
ADMIN_PASS="${JF_ADMIN_PASS:-Test669Pw!x}"
USER_NAME="${JF_USER_NAME:-je_arruser}"
USER_PASS="${JF_USER_PASS:-Test669Pw!x}"
PLUGIN_DLL="${PLUGIN_DLL:-${REPO_ROOT}/Jellyfin.Plugin.JellyfinEnhanced/bin/Release/net10.0/Jellyfin.Plugin.JellyfinEnhanced.dll}"
PLUGIN_ID="f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b"
CLIENT_AUTH='MediaBrowser Client="JE-E2E-Seed", Device="seed", DeviceId="je-e2e-seed", Version="1.0.0"'

log() { echo "[seed] $*"; }
fail() { echo "[seed] ERROR: $*" >&2; exit 1; }

[ -f "${PLUGIN_DLL}" ] || fail "plugin DLL not found at ${PLUGIN_DLL} — build Release first"
command -v jq >/dev/null || fail "jq is required"
command -v curl >/dev/null || fail "curl is required"

# ── 1. clean state + plugin install ─────────────────────────────────────────
log "resetting e2e/docker state (config/cache/media)"
${COMPOSE} down -v --remove-orphans >/dev/null 2>&1 || true
rm -rf "${HERE}/config" "${HERE}/cache" "${HERE}/media"
mkdir -p "${HERE}/config/plugins/JellyfinEnhanced_e2e" "${HERE}/cache" "${HERE}/media"
cp "${PLUGIN_DLL}" "${HERE}/config/plugins/JellyfinEnhanced_e2e/"
log "installed plugin DLL into config/plugins/JellyfinEnhanced_e2e"

# ── 2. tiny valid media (h264/aac so the Playwright Chromium can play them) ──
if command -v ffmpeg >/dev/null; then
    run_ffmpeg() { (cd "${HERE}/media" && ffmpeg -hide_banner -loglevel error "$@"); }
else
    log "no host ffmpeg — using jellyfin-ffmpeg from ${IMAGE}"
    docker pull -q "${IMAGE}" >/dev/null
    run_ffmpeg() {
        docker run --rm -u "${JF_UID}:${JF_GID}" -v "${HERE}/media:/media" -w /media \
            --entrypoint /usr/lib/jellyfin/ffmpeg "${IMAGE}" -hide_banner -loglevel error "$@" \
        || docker run --rm -u "${JF_UID}:${JF_GID}" -v "${HERE}/media:/media" -w /media \
            --entrypoint /usr/lib/jellyfin-ffmpeg/ffmpeg "${IMAGE}" -hide_banner -loglevel error "$@"
    }
fi

make_movie() { # <filename> <tone-hz>
    run_ffmpeg \
        -f lavfi -i "testsrc2=duration=5:size=640x360:rate=24" \
        -f lavfi -i "sine=frequency=$2:duration=5" \
        -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest -y "$1"
}

log "generating test movies"
make_movie "Alpha Adventure (2021).mp4" 440
make_movie "Beta Voyage (2022).mp4" 550
make_movie "Gamma Quest (2023).mp4" 660
make_movie "Delta Horizon (2024).mp4" 770

# ── 3. boot + startup wizard ─────────────────────────────────────────────────
log "starting compose stack on port ${JF_PORT}"
${COMPOSE} up -d

log "waiting for the server to answer"
for _ in $(seq 1 60); do
    curl -fsS -m 3 "${BASE}/System/Info/Public" >/dev/null 2>&1 && break
    sleep 3
done
curl -fsS -m 3 "${BASE}/System/Info/Public" >/dev/null || fail "server never came up on ${BASE}"

wizard() { # <method> <path> [json-body]
    if [ $# -ge 3 ]; then
        curl -fsS -X "$1" "${BASE}$2" -H "Authorization: ${CLIENT_AUTH}" \
            -H 'Content-Type: application/json' -d "$3"
    else
        curl -fsS -X "$1" "${BASE}$2" -H "Authorization: ${CLIENT_AUTH}"
    fi
}

log "completing the startup wizard"
wizard POST /Startup/Configuration '{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}'
wizard GET /Startup/User >/dev/null
wizard POST /Startup/User "{\"Name\":\"${ADMIN_USER}\",\"Password\":\"${ADMIN_PASS}\"}"
wizard POST /Startup/RemoteAccess '{"EnableRemoteAccess":true,"EnableAutomaticPortMapping":false}'
wizard POST /Startup/Complete

# ── 4. admin token, library, second user ─────────────────────────────────────
log "authenticating ${ADMIN_USER}"
TOKEN="$(curl -fsS -X POST "${BASE}/Users/AuthenticateByName" \
    -H "Authorization: ${CLIENT_AUTH}" -H 'Content-Type: application/json' \
    -d "{\"Username\":\"${ADMIN_USER}\",\"Pw\":\"${ADMIN_PASS}\"}" | jq -r .AccessToken)"
[ -n "${TOKEN}" ] && [ "${TOKEN}" != "null" ] || fail "could not authenticate ${ADMIN_USER}"
AUTHED="Authorization: ${CLIENT_AUTH}, Token=\"${TOKEN}\""

api() { # <method> <path> [json-body]
    if [ $# -ge 3 ]; then
        curl -fsS -X "$1" "${BASE}$2" -H "${AUTHED}" -H 'Content-Type: application/json' -d "$3"
    else
        curl -fsS -X "$1" "${BASE}$2" -H "${AUTHED}" -H 'Content-Type: application/json'
    fi
}

log "verifying the plugin loaded"
api GET /Plugins | jq -e --arg id "${PLUGIN_ID}" \
    'map(select((.Id // "" | ascii_downcase | gsub("-"; "")) == ($id | ascii_downcase | gsub("-"; "")))) | length > 0' >/dev/null \
    || fail "Jellyfin Enhanced plugin did not load (check config/log/)"

log "creating the Movies library"
api POST "/Library/VirtualFolders?name=Movies&collectionType=movies&paths=%2Fmedia&refreshLibrary=true" \
    '{"LibraryOptions":{"EnableRealtimeMonitor":false}}'

log "creating user ${USER_NAME}"
api POST /Users/New "{\"Name\":\"${USER_NAME}\",\"Password\":\"${USER_PASS}\"}" >/dev/null

# ── 5. plugin feature flags + scan wait ──────────────────────────────────────
log "enabling the plugin features the specs exercise"
PLUGIN_CONFIG="$(api GET "/Plugins/${PLUGIN_ID}/Configuration" \
    | jq '.QualityTagsEnabled = true
        | .GenreTagsEnabled = true
        | .LanguageTagsEnabled = true
        | .RatingTagsEnabled = true
        | .RandomButtonEnabled = true
        | .HiddenContentEnabled = true')"
api POST "/Plugins/${PLUGIN_ID}/Configuration" "${PLUGIN_CONFIG}" >/dev/null

log "waiting for the library scan to index the movies"
ADMIN_ID="$(api GET /Users | jq -r --arg name "${ADMIN_USER}" '.[] | select(.Name == $name) | .Id')"
MOVIES=0
for _ in $(seq 1 60); do
    MOVIES="$(api GET "/Items?IncludeItemTypes=Movie&Recursive=true&userId=${ADMIN_ID}" | jq -r .TotalRecordCount)"
    [ "${MOVIES}" -ge 3 ] 2>/dev/null && break
    sleep 5
done
[ "${MOVIES}" -ge 3 ] || fail "library scan indexed only ${MOVIES} movies"

log "ready: ${BASE} (admin=${ADMIN_USER}, user=${USER_NAME}, ${MOVIES} movies)"
log "run the suite with: JF_BASE_URL=${BASE} npm run e2e"
