#!/usr/bin/env bash
# Seed a throwaway dockerized Jellyfin 12 for the E2E suite:
#   1. install the freshly built plugin DLL into a clean config volume,
#   2. generate a handful of tiny valid movies, one dedicated 40-second
#      Auto-Skip movie, and a 2×2-episode TV series with ffmpeg (testsrc2 clips),
#   3. boot the compose stack and complete the startup wizard via the API,
#   4. create the Movies + Shows libraries and the two test users the specs
#      expect,
#   5. enable the plugin features the specs exercise (tags, random button,
#      hidden content, Spoiler Guard), wait for the scan, seed episode
#      titles/overviews, and mark S01E01 played for the non-admin user.
#
# Idempotent: every run starts from a wiped config/cache/media state.
# Requirements: docker (compose v2), curl, jq. ffmpeg is used from the host
# when available, otherwise from jellyfin-ffmpeg inside the pulled image.
#
# Optional Seerr/TMDB seeding (bare by default — no secrets in the repo/CI
# unless supplied): export any of these before running to also wire the
# TMDB and Seerr integration the security specs exercise. When unset the
# seed is bare and those specs SKIP (see e2e/fixtures/seerr.ts):
#   TMDB_API_KEY               a TMDB v3 API key            -> TmdbEnabled
#   SEERR_URL             a reachable Seerr URL    \
#   SEERR_API_KEY         its API key                   > SeerrEnabled
#   SEERR_RESPECT_PARENTAL  true|false (default true) — parental gating
#   JF_IMAGE              compose image override (default jellyfin:12.0-rc2)
#   JF_LAYOUT_ENFORCEMENT None|ForceExperimental|ForceLegacy (default None)
#   JF_E2E_PROJECT        validated Compose namespace (default docker)
#   JF_E2E_STATE_DIR      marker-owned config/cache/media root (default HERE)
#   JF_PORT               loopback host port; 0 asks Docker for a free port
#   JF_CPUS               Jellyfin CPU quota (default 2)
#   JF_FFMPEG_THREADS     host encoder threads per seed (default 2)
#   JF_E2E_IMAGE_PREFETCHED true requires the exact JF_IMAGE to already exist
#                         locally (used by CI after its parallel preparation)
#   JF_BIND_ADDRESS       numeric bind address (default 127.0.0.1)
#   JF_ALLOW_NON_LOOPBACK true explicitly permits a non-loopback bind, but only
#                         when all four JF_* user/password values are nondefault
#
# Usage:
#   dotnet build Jellyfin.Plugin.JellyfinCanopy/JellyfinCanopy.csproj -c Release
#   bash e2e/docker/seed.sh                # default port 8100 (bare)
#   TMDB_API_KEY=... SEERR_URL=... SEERR_API_KEY=... bash e2e/docker/seed.sh
#   JF_BASE_URL=http://127.0.0.1:8100 npm run e2e
#   docker compose -f e2e/docker/compose.yml down -v
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
FIXTURE_CONTRACT="${REPO_ROOT}/e2e/fixtures/media-fixtures.json"
export JF_IMAGE="${JF_IMAGE:-jellyfin/jellyfin:12.0-rc2}"
IMAGE="${JF_IMAGE}"

DEFAULT_ADMIN_USER="jc_arradmin"
DEFAULT_ADMIN_PASS="Test669Pw!x"
DEFAULT_USER_NAME="jc_arruser"
DEFAULT_USER_PASS="Test669Pw!x"

E2E_PROJECT="${JF_E2E_PROJECT:-docker}"
if [ "${JF_E2E_STATE_DIR+x}" = x ]; then
    STATE_INPUT="${JF_E2E_STATE_DIR}"
    CUSTOM_STATE=1
else
    STATE_INPUT="${HERE}"
    CUSTOM_STATE=0
fi
export JF_BIND_ADDRESS="${JF_BIND_ADDRESS:-127.0.0.1}"
ALLOW_NON_LOOPBACK="${JF_ALLOW_NON_LOOPBACK:-false}"
export JF_PORT="${JF_PORT:-8100}"
export JF_CPUS="${JF_CPUS:-2}"
export JF_FFMPEG_THREADS="${JF_FFMPEG_THREADS:-2}"
export JF_UID JF_GID
JF_UID="$(id -u)"
JF_GID="$(id -g)"

BASE=''
ADMIN_USER="${JF_ADMIN_USER:-${DEFAULT_ADMIN_USER}}"
ADMIN_PASS="${JF_ADMIN_PASS:-${DEFAULT_ADMIN_PASS}}"
USER_NAME="${JF_USER_NAME:-${DEFAULT_USER_NAME}}"
USER_PASS="${JF_USER_PASS:-${DEFAULT_USER_PASS}}"
PLUGIN_DLL="${PLUGIN_DLL:-${REPO_ROOT}/Jellyfin.Plugin.JellyfinCanopy/bin/Release/net10.0/Jellyfin.Plugin.JellyfinCanopy.dll}"
PLUGIN_ID="9ffa12bc-f4b5-406c-ab1d-d575acbeea7b"
CLIENT_AUTH='MediaBrowser Client="JC-E2E-Seed", Device="seed", DeviceId="jc-e2e-seed", Version="1.0.0"'
LAYOUT_ENFORCEMENT="${JF_LAYOUT_ENFORCEMENT:-None}"

log() { echo "[seed] $*"; }
fail() { echo "[seed] ERROR: $*" >&2; exit 1; }

[ -f "${PLUGIN_DLL}" ] || fail "plugin DLL not found at ${PLUGIN_DLL} — build Release first"
command -v jq >/dev/null || fail "jq is required"
command -v curl >/dev/null || fail "curl is required"
[ -f "${FIXTURE_CONTRACT}" ] || fail "fixture contract not found at ${FIXTURE_CONTRACT}"

[[ "${E2E_PROJECT}" =~ ^[a-z0-9][a-z0-9_-]*$ ]] \
    || fail "JF_E2E_PROJECT must start with a lowercase letter or digit and contain only lowercase letters, digits, underscore, and dash"
[ "${#E2E_PROJECT}" -le 63 ] \
    || fail "JF_E2E_PROJECT must be at most 63 characters"

[[ "${JF_PORT}" =~ ^[0-9]+$ ]] \
    || fail "JF_PORT must be an integer from 0 through 65535"
[ "${#JF_PORT}" -le 5 ] \
    || fail "JF_PORT must be an integer from 0 through 65535"
JF_PORT="$((10#${JF_PORT}))"
[ "${JF_PORT}" -le 65535 ] \
    || fail "JF_PORT must be an integer from 0 through 65535"
export JF_PORT

[[ "${JF_CPUS}" =~ ^[0-9]+([.][0-9]+)?$ ]] \
    || fail "JF_CPUS must be a positive number"
jq -en --arg cpus "${JF_CPUS}" '$cpus | tonumber | . > 0 and . <= 64' >/dev/null \
    || fail "JF_CPUS must be greater than 0 and at most 64"
JF_CPUS="$(jq -nr --arg cpus "${JF_CPUS}" '$cpus | tonumber')"
export JF_CPUS

[[ "${JF_FFMPEG_THREADS}" =~ ^[0-9]+$ ]] \
    || fail "JF_FFMPEG_THREADS must be an integer from 1 through 8"
[ "${#JF_FFMPEG_THREADS}" -le 1 ] \
    || fail "JF_FFMPEG_THREADS must be an integer from 1 through 8"
JF_FFMPEG_THREADS="$((10#${JF_FFMPEG_THREADS}))"
[ "${JF_FFMPEG_THREADS}" -ge 1 ] && [ "${JF_FFMPEG_THREADS}" -le 8 ] \
    || fail "JF_FFMPEG_THREADS must be an integer from 1 through 8"
export JF_FFMPEG_THREADS

[[ "${JF_BIND_ADDRESS}" =~ ^[0-9A-Fa-f:.]+$ ]] \
    || fail "JF_BIND_ADDRESS must be a numeric IPv4 or IPv6 address"
case "${JF_BIND_ADDRESS}" in
    127.*|::1) ;;
    *)
        [ "${ALLOW_NON_LOOPBACK}" = true ] \
            || fail "non-loopback JF_BIND_ADDRESS requires JF_ALLOW_NON_LOOPBACK=true"
        if [ "${ADMIN_USER}" = "${DEFAULT_ADMIN_USER}" ] \
            || [ "${ADMIN_PASS}" = "${DEFAULT_ADMIN_PASS}" ] \
            || [ "${USER_NAME}" = "${DEFAULT_USER_NAME}" ] \
            || [ "${USER_PASS}" = "${DEFAULT_USER_PASS}" ]; then
            fail "non-loopback binding refuses every default E2E username and password; supply a runner-scoped credential set"
        fi
        ;;
esac
[ -n "${ADMIN_USER}" ] && [ -n "${ADMIN_PASS}" ] \
    && [ -n "${USER_NAME}" ] && [ -n "${USER_PASS}" ] \
    || fail "seeded usernames and passwords must not be empty"
[ "${ADMIN_USER}" != "${USER_NAME}" ] \
    || fail "seeded admin and non-admin usernames must be distinct"

case "${LAYOUT_ENFORCEMENT}" in
    None|ForceExperimental|ForceLegacy) ;;
    *) fail "JF_LAYOUT_ENFORCEMENT must be None, ForceExperimental, or ForceLegacy" ;;
esac

# Resolve the state root without following a caller-controlled symlink chain.
# The default source-adjacent state remains compatible with the documented
# single-server flow. A custom state root is claimed by an exact marker before
# any known child is removed, and reuse requires the same project/path marker.
if (( CUSTOM_STATE == 1 )); then
    command -v realpath >/dev/null \
        || fail "custom JF_E2E_STATE_DIR requires GNU realpath"
    realpath -ms -- . >/dev/null 2>&1 \
        || fail "custom JF_E2E_STATE_DIR requires GNU realpath with -m and -s"
    stat -c '%u' -- . >/dev/null 2>&1 \
        || fail "custom JF_E2E_STATE_DIR requires GNU stat with -c"
    if [[ "${STATE_INPUT}" != /* ]]; then
        STATE_INPUT="${REPO_ROOT}/${STATE_INPUT}"
    fi
    STATE_LEXICAL="$(realpath -ms -- "${STATE_INPUT}")"
    STATE_DIR="$(realpath -m -- "${STATE_INPUT}")"
    [ "${STATE_LEXICAL}" = "${STATE_DIR}" ] \
        || fail "JF_E2E_STATE_DIR must not contain or traverse symbolic links"
else
    STATE_DIR="${HERE}"
fi
[[ "${STATE_DIR}" != *:* && "${STATE_DIR}" != *$'\n'* ]] \
    || fail "JF_E2E_STATE_DIR must not contain colon or newline characters"
[ "${STATE_DIR}" != / ] \
    || fail "JF_E2E_STATE_DIR must not be the filesystem root"
if [ "${STATE_DIR}" = "${REPO_ROOT}" ] || [[ "${REPO_ROOT}" == "${STATE_DIR}/"* ]]; then
    fail "JF_E2E_STATE_DIR must not be the repository root or one of its parents"
fi

STATE_MARKER="${STATE_DIR}/.jc-e2e-state-v1"
EXPECTED_MARKER="$(printf 'Jellyfin Canopy E2E state v1\nproject=%s\nstate=%s' "${E2E_PROJECT}" "${STATE_DIR}")"
if (( CUSTOM_STATE == 1 )); then
    if [ -e "${STATE_DIR}" ] && [ ! -d "${STATE_DIR}" ]; then
        fail "custom JF_E2E_STATE_DIR exists but is not a directory: ${STATE_DIR}"
    fi
    if [ ! -e "${STATE_DIR}" ]; then
        mkdir -m 700 -p -- "${STATE_DIR}"
    fi
    [ ! -L "${STATE_DIR}" ] \
        || fail "custom JF_E2E_STATE_DIR must not be a symbolic link"
    [ "$(stat -c '%u' -- "${STATE_DIR}")" = "${JF_UID}" ] \
        || fail "custom JF_E2E_STATE_DIR must be owned by uid ${JF_UID}"

    if [ -e "${STATE_MARKER}" ]; then
        [ -f "${STATE_MARKER}" ] && [ ! -L "${STATE_MARKER}" ] \
            || fail "custom E2E state marker must be a regular non-symlink file"
        [ "$(stat -c '%u' -- "${STATE_MARKER}")" = "${JF_UID}" ] \
            || fail "custom E2E state marker must be owned by uid ${JF_UID}"
        [ "$(cat -- "${STATE_MARKER}")" = "${EXPECTED_MARKER}" ] \
            || fail "custom JF_E2E_STATE_DIR marker belongs to another path or Compose project"
    else
        FIRST_STATE_ENTRY="$(find "${STATE_DIR}" -mindepth 1 -maxdepth 1 -print -quit)"
        [ -z "${FIRST_STATE_ENTRY}" ] \
            || fail "custom JF_E2E_STATE_DIR must be empty before its ownership marker is created"
        if ! (set -o noclobber; printf '%s\n' "${EXPECTED_MARKER}" > "${STATE_MARKER}") 2>/dev/null; then
            [ -f "${STATE_MARKER}" ] && [ ! -L "${STATE_MARKER}" ] \
                && [ "$(cat -- "${STATE_MARKER}")" = "${EXPECTED_MARKER}" ] \
                || fail "could not claim custom JF_E2E_STATE_DIR safely"
        fi
    fi
fi

CONFIG_DIR="${STATE_DIR}/config"
CACHE_DIR="${STATE_DIR}/cache"
MEDIA_DIR="${STATE_DIR}/media"
SEED_RESULT="${STATE_DIR}/seed-result.json"
SEED_RESULT_TMP="${STATE_DIR}/seed-result.json.tmp"
for OWNED_PATH in "${CONFIG_DIR}" "${CACHE_DIR}" "${MEDIA_DIR}" "${SEED_RESULT}" "${SEED_RESULT_TMP}"; do
    [ ! -L "${OWNED_PATH}" ] \
        || fail "refusing to reset symlinked E2E state path: ${OWNED_PATH}"
done
export JF_CONFIG_DIR="${CONFIG_DIR}"
export JF_CACHE_DIR="${CACHE_DIR}"
export JF_MEDIA_DIR="${MEDIA_DIR}"
export JF_E2E_PROJECT="${E2E_PROJECT}"
COMPOSE=(docker compose --project-name "${E2E_PROJECT}" --file "${HERE}/compose.yml")

AUTOSKIP_NAME="$(jq -er '.autoSkip.name | select(type == "string" and length > 0)' "${FIXTURE_CONTRACT}")"
AUTOSKIP_FILE_PREFIX="$(jq -er '.autoSkip.filePrefix | select(type == "string" and length > 0)' "${FIXTURE_CONTRACT}")"
AUTOSKIP_DURATION="$(jq -er '.autoSkip.durationSeconds | select(type == "number" and . > 0)' "${FIXTURE_CONTRACT}")"
AUTOSKIP_END="$(jq -er '.autoSkip.segmentEndSeconds | select(type == "number" and . > 0)' "${FIXTURE_CONTRACT}")"
AUTOSKIP_MARGIN="$(jq -er '.autoSkip.minimumMarginSeconds | select(type == "number" and . > 0)' "${FIXTURE_CONTRACT}")"
AUTOSKIP_MIN_DURATION="$(jq -nr --argjson end "${AUTOSKIP_END}" --argjson margin "${AUTOSKIP_MARGIN}" '$end + $margin')"
AUTOSKIP_MIN_TICKS="$(jq -nr --argjson seconds "${AUTOSKIP_MIN_DURATION}" '$seconds * 10000000 | floor')"
jq -en --argjson duration "${AUTOSKIP_DURATION}" --argjson minimum "${AUTOSKIP_MIN_DURATION}" \
    '$duration >= $minimum' >/dev/null \
    || fail "Auto-Skip fixture duration ${AUTOSKIP_DURATION}s is below required ${AUTOSKIP_MIN_DURATION}s"

# A different parent path on every wiped seed produces a different Jellyfin
# item ID. The filename and post-scan display name stay stable, and the display
# name is the only discovery key the browser spec uses.
SEED_NONCE="${JF_E2E_SEED_ID:-$(date -u +%Y%m%d%H%M%S%N)-$$}"
[[ "${SEED_NONCE}" =~ ^[A-Za-z0-9._-]+$ ]] \
    || fail "JF_E2E_SEED_ID may contain only letters, digits, dot, underscore, and dash"
AUTOSKIP_FILENAME="${AUTOSKIP_FILE_PREFIX}.mp4"
AUTOSKIP_RELATIVE_DIR="Movies/JC-Auto-Skip-Seed-${SEED_NONCE}"
AUTOSKIP_RELATIVE_PATH="${AUTOSKIP_RELATIVE_DIR}/${AUTOSKIP_FILENAME}"
AUTOSKIP_CONTAINER_PATH="/media/${AUTOSKIP_RELATIVE_PATH}"

# ── 1. clean state + plugin install ─────────────────────────────────────────
log "resetting project ${E2E_PROJECT} state under ${STATE_DIR} (config/cache/media)"
if ! "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1; then
    fail "could not tear down Compose project ${E2E_PROJECT}; refusing to reset its state"
fi
rm -rf -- "${CONFIG_DIR}" "${CACHE_DIR}" "${MEDIA_DIR}"
rm -f -- "${SEED_RESULT}" "${SEED_RESULT_TMP}"
mkdir -p -- "${CONFIG_DIR}/plugins/JellyfinCanopy_e2e" "${CACHE_DIR}" "${MEDIA_DIR}"
cp -- "${PLUGIN_DLL}" "${CONFIG_DIR}/plugins/JellyfinCanopy_e2e/"
log "installed plugin DLL into the isolated config volume"

# ── 2. tiny valid media (h264/aac so the Playwright Chromium can play them) ──
if command -v ffmpeg >/dev/null; then
    run_ffmpeg() { (cd "${MEDIA_DIR}" && ffmpeg -hide_banner -loglevel error "$@"); }
else
    log "no host ffmpeg — using jellyfin-ffmpeg from ${IMAGE}"
    if [ "${JF_E2E_IMAGE_PREFETCHED:-false}" = true ]; then
        docker image inspect "${IMAGE}" >/dev/null 2>&1 \
            || fail "JF_E2E_IMAGE_PREFETCHED=true but ${IMAGE} is not available locally"
    else
        docker pull -q "${IMAGE}" >/dev/null
    fi
    # Current jellyfin images ship ffmpeg at /usr/lib/jellyfin-ffmpeg/ffmpeg —
    # try that first; the old /usr/lib/jellyfin/ffmpeg path is the fallback.
    # The first attempt's stderr is silenced so a wrong-path miss doesn't spam
    # a docker error per clip; the fallback stays loud for real failures.
    run_ffmpeg() {
        docker run --rm -u "${JF_UID}:${JF_GID}" -v "${MEDIA_DIR}:/media" -w /media \
            --entrypoint /usr/lib/jellyfin-ffmpeg/ffmpeg "${IMAGE}" -hide_banner -loglevel error "$@" 2>/dev/null \
        || docker run --rm -u "${JF_UID}:${JF_GID}" -v "${MEDIA_DIR}:/media" -w /media \
            --entrypoint /usr/lib/jellyfin/ffmpeg "${IMAGE}" -hide_banner -loglevel error "$@"
    }
fi

# Movies and Shows live in dedicated subfolders so the recursive Movies-library
# scan never descends into the TV tree (and vice-versa) — a single /media root
# shared by both collection types would misidentify episode files as movies.
mkdir -p "${MEDIA_DIR}/Movies" "${MEDIA_DIR}/Shows"

make_clip() { # <relative-path> <tone-hz> [duration-seconds]
    local duration="${3:-5}"
    jq -en --argjson duration "${duration}" '$duration > 0' >/dev/null \
        || fail "invalid clip duration '${duration}' for $1"
    # Tag the audio stream as English so the language-tags renderer has a real
    # language to stamp (a bare testsrc clip reports "und", which the renderer
    # skips). Genres + a community rating are added post-scan via the API below.
    run_ffmpeg \
        -f lavfi -i "testsrc2=duration=${duration}:size=640x360:rate=24" \
        -f lavfi -i "sine=frequency=$2:duration=${duration}" \
        -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest \
        -threads "${JF_FFMPEG_THREADS}" \
        -metadata:s:a:0 language=eng -y "$1"
}

log "generating test movies"
make_clip "Movies/Alpha Adventure (2021).mp4" 440
make_clip "Movies/Beta Voyage (2022).mp4" 550
make_clip "Movies/Gamma Quest (2023).mp4" 660
make_clip "Movies/Delta Horizon (2024).mp4" 770
log "generating dedicated Auto-Skip movie (${AUTOSKIP_DURATION}s, seed ${SEED_NONCE})"
mkdir -p "${MEDIA_DIR}/${AUTOSKIP_RELATIVE_DIR}"
make_clip "${AUTOSKIP_RELATIVE_PATH}" 880 "${AUTOSKIP_DURATION}"

# ── TV: one series, 2 seasons × 2 episodes, for the Spoiler Guard specs ───────
# Series/Season NN/… S0xE0y naming so Jellyfin's naming resolver builds the
# Series → Season → Episode hierarchy. The episodes carry generic names on disk;
# the real (spoiler-y) titles come from the metadata patch below so the strip
# filter has something to replace with "Season X, Episode Y".
SHOW_NAME="Guard Test Show"
log "generating test series '${SHOW_NAME}' (2 seasons × 2 episodes)"
mkdir -p "${MEDIA_DIR}/Shows/${SHOW_NAME}/Season 01" "${MEDIA_DIR}/Shows/${SHOW_NAME}/Season 02"
make_clip "Shows/${SHOW_NAME}/Season 01/${SHOW_NAME} S01E01.mp4" 480
make_clip "Shows/${SHOW_NAME}/Season 01/${SHOW_NAME} S01E02.mp4" 500
make_clip "Shows/${SHOW_NAME}/Season 02/${SHOW_NAME} S02E01.mp4" 520
make_clip "Shows/${SHOW_NAME}/Season 02/${SHOW_NAME} S02E02.mp4" 540

# ── 3. boot + startup wizard ─────────────────────────────────────────────────
log "starting Compose project ${E2E_PROJECT} on ${JF_BIND_ADDRESS}:${JF_PORT} with ${JF_CPUS} Jellyfin CPUs"
"${COMPOSE[@]}" up -d

CONTAINER_ID="$("${COMPOSE[@]}" ps -q jellyfin)"
[ -n "${CONTAINER_ID}" ] || fail "could not resolve the Jellyfin Compose container ID"
EXPECTED_NANO_CPUS="$(jq -nr --arg cpus "${JF_CPUS}" '$cpus | tonumber * 1000000000 | round')"
ACTUAL_NANO_CPUS="$(docker inspect --format '{{.HostConfig.NanoCpus}}' "${CONTAINER_ID}")"
[[ "${ACTUAL_NANO_CPUS}" =~ ^[1-9][0-9]*$ ]] \
    || fail "Jellyfin container reported invalid HostConfig.NanoCpus '${ACTUAL_NANO_CPUS}'"
[ "${ACTUAL_NANO_CPUS}" = "${EXPECTED_NANO_CPUS}" ] \
    || fail "Jellyfin container CPU quota is ${ACTUAL_NANO_CPUS} NanoCpus; expected ${EXPECTED_NANO_CPUS} for JF_CPUS=${JF_CPUS}"
log "verified Jellyfin CPU quota: ${JF_CPUS} CPUs (${ACTUAL_NANO_CPUS} NanoCpus)"
PORT_BINDINGS="$(docker inspect --format '{{json (index .NetworkSettings.Ports "8096/tcp")}}' "${CONTAINER_ID}")"
PUBLISHED_PORT="$(printf '%s' "${PORT_BINDINGS}" | jq -er \
    'select(type == "array" and length == 1) | .[0].HostPort | select(test("^[0-9]+$"))')" \
    || fail "Jellyfin container did not publish exactly one numeric host port"
PUBLISHED_ADDRESS="$(printf '%s' "${PORT_BINDINGS}" | jq -er \
    'select(type == "array" and length == 1) | .[0].HostIp | select(type == "string" and length > 0)')" \
    || fail "Jellyfin container did not publish exactly one host address"
[ "${PUBLISHED_ADDRESS}" = "${JF_BIND_ADDRESS}" ] \
    || fail "Docker published Jellyfin on ${PUBLISHED_ADDRESS}, expected ${JF_BIND_ADDRESS}"
if [ "${JF_PORT}" -ne 0 ] && [ "${PUBLISHED_PORT}" -ne "${JF_PORT}" ]; then
    fail "Docker published Jellyfin on port ${PUBLISHED_PORT}, expected ${JF_PORT}"
fi
case "${PUBLISHED_ADDRESS}" in
    *:*) BASE="http://[${PUBLISHED_ADDRESS}]:${PUBLISHED_PORT}" ;;
    0.0.0.0) BASE="http://127.0.0.1:${PUBLISHED_PORT}" ;;
    *) BASE="http://${PUBLISHED_ADDRESS}:${PUBLISHED_PORT}" ;;
esac

log "waiting for the server to answer"
PUBLIC_INFO=''
SERVER_VERSION=''
for _ in $(seq 1 60); do
    if PUBLIC_INFO="$(curl -fsS -m 3 "${BASE}/System/Info/Public" 2>/dev/null)" \
        && SERVER_VERSION="$(printf '%s' "${PUBLIC_INFO}" \
            | jq -er '.Version | select(type == "string" and length > 0)' 2>/dev/null)"; then
        break
    fi
    PUBLIC_INFO=''
    SERVER_VERSION=''
    sleep 3
done
[ -n "${SERVER_VERSION}" ] \
    || fail "server never returned parseable System/Info/Public JSON on ${BASE}"
IMAGE_ID="$(docker inspect --format '{{.Image}}' "${CONTAINER_ID}")"
log "server version ${SERVER_VERSION}, image ${IMAGE} (${IMAGE_ID})"

wizard() { # <method> <path> [json-body]
    # /System/Info/Public answers 200 slightly before the Startup API is ready,
    # so the first wizard call can catch a transient 503 — retry briefly.
    local attempt
    for attempt in $(seq 1 10); do
        if [ $# -ge 3 ]; then
            curl -fsS -X "$1" "${BASE}$2" -H "Authorization: ${CLIENT_AUTH}" \
                -H 'Content-Type: application/json' -d "$3" && return 0
        else
            curl -fsS -X "$1" "${BASE}$2" -H "Authorization: ${CLIENT_AUTH}" && return 0
        fi
        [ "${attempt}" -lt 10 ] && sleep 3
    done
    return 1
}

log "completing the startup wizard"
wizard POST /Startup/Configuration '{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}'
wizard GET /Startup/User >/dev/null
wizard POST /Startup/User "$(jq -nc --arg name "${ADMIN_USER}" --arg password "${ADMIN_PASS}" \
    '{Name: $name, Password: $password}')"
wizard POST /Startup/RemoteAccess '{"EnableRemoteAccess":true,"EnableAutomaticPortMapping":false}'
wizard POST /Startup/Complete

# ── 4. admin token, library, second user ─────────────────────────────────────
log "authenticating the seeded admin"
TOKEN="$(curl -fsS -X POST "${BASE}/Users/AuthenticateByName" \
    -H "Authorization: ${CLIENT_AUTH}" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg username "${ADMIN_USER}" --arg password "${ADMIN_PASS}" \
        '{Username: $username, Pw: $password}')" | jq -r .AccessToken)"
[ -n "${TOKEN}" ] && [ "${TOKEN}" != "null" ] || fail "could not authenticate the seeded admin"
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
    || fail "Jellyfin Canopy plugin did not load (check config/log/)"

log "creating the Movies library"
api POST "/Library/VirtualFolders?name=Movies&collectionType=movies&paths=%2Fmedia%2FMovies&refreshLibrary=true" \
    '{"LibraryOptions":{"EnableRealtimeMonitor":false}}'

log "creating the Shows library"
api POST "/Library/VirtualFolders?name=Shows&collectionType=tvshows&paths=%2Fmedia%2FShows&refreshLibrary=true" \
    '{"LibraryOptions":{"EnableRealtimeMonitor":false}}'

log "creating the seeded non-admin user"
api POST /Users/New "$(jq -nc --arg name "${USER_NAME}" --arg password "${USER_PASS}" \
    '{Name: $name, Password: $password}')" >/dev/null

# ── 5. plugin feature flags (+ optional TMDB/Seerr) + scan wait ──────────────
log "enabling the plugin features the specs exercise"

# Optional Seerr/TMDB integration — bare unless the env vars are supplied
# (never hardcode a key; CI passes these as secrets when it wants the security
# specs to RUN rather than SKIP). See e2e/fixtures/seerr.ts for the gate.
TMDB_API_KEY="${TMDB_API_KEY:-}"
SEERR_URL="${SEERR_URL:-}"
SEERR_API_KEY="${SEERR_API_KEY:-}"
case "${SEERR_RESPECT_PARENTAL:-true}" in
    false|FALSE|0|no) SEERR_RESPECT_PARENTAL=false ;;
    *) SEERR_RESPECT_PARENTAL=true ;;
esac

PLUGIN_CONFIG="$(api GET "/Plugins/${PLUGIN_ID}/Configuration" \
    | jq --arg tmdb "${TMDB_API_KEY}" \
         --arg seerrUrl "${SEERR_URL}" \
         --arg seerrKey "${SEERR_API_KEY}" \
         --arg layout "${LAYOUT_ENFORCEMENT}" \
         --argjson seerrParental "${SEERR_RESPECT_PARENTAL}" \
        '.QualityTagsEnabled = true
        | .GenreTagsEnabled = true
        | .LanguageTagsEnabled = true
        | .RatingTagsEnabled = true
        | .RandomButtonEnabled = true
        | .HiddenContentEnabled = true
        | .CalendarPageEnabled = true
        | .DownloadsPageEnabled = true
        | .SpoilerBlurEnabled = true
        | .ShowFileSizes = true
        | .ShowWatchProgress = true
        | .LayoutEnforcement = $layout
        | (if $tmdb != "" then .TMDB_API_KEY = $tmdb else . end)
        | (if ($seerrUrl != "" and $seerrKey != "")
             then .SeerrUrls = $seerrUrl
                | .SeerrApiKey = $seerrKey
                | .SeerrEnabled = true
                | .SeerrRespectParentalRatings = $seerrParental
             else . end)')"
api POST "/Plugins/${PLUGIN_ID}/Configuration" "${PLUGIN_CONFIG}" >/dev/null
log "layout enforcement: ${LAYOUT_ENFORCEMENT}"

if [ -n "${TMDB_API_KEY}" ]; then
    log "optional: TMDB configured (TmdbEnabled)"
else
    log "optional: TMDB not configured — TMDB/reviews specs will SKIP"
fi
if [ -n "${SEERR_URL}" ] && [ -n "${SEERR_API_KEY}" ]; then
    log "optional: Seerr configured (${SEERR_URL}, respectParental=${SEERR_RESPECT_PARENTAL})"
else
    log "optional: Seerr not configured — Seerr specs will SKIP"
fi

log "waiting for the library scan to index all movies and the exact Auto-Skip path"
ADMIN_ID="$(api GET /Users | jq -r --arg name "${ADMIN_USER}" '.[] | select(.Name == $name) | .Id')"
MOVIES=0
AUTOSKIP_SCAN_JSON=''
AUTOSKIP_MATCH_COUNT=0
AUTOSKIP_SCAN_TICKS=0
AUTOSKIP_SCAN_SOURCE_COUNT=0
for _ in $(seq 1 60); do
    AUTOSKIP_SCAN_JSON="$(api GET "/Items?IncludeItemTypes=Movie&Recursive=true&userId=${ADMIN_ID}&Fields=Path,MediaSources")"
    MOVIES="$(printf '%s' "${AUTOSKIP_SCAN_JSON}" | jq -r '.TotalRecordCount // 0')"
    AUTOSKIP_MATCH_COUNT="$(printf '%s' "${AUTOSKIP_SCAN_JSON}" | jq -r \
        --arg path "${AUTOSKIP_CONTAINER_PATH}" \
        '[.Items[]? | select(.Path == $path)] | length')"
    AUTOSKIP_SCAN_TICKS="$(printf '%s' "${AUTOSKIP_SCAN_JSON}" | jq -r \
        --arg path "${AUTOSKIP_CONTAINER_PATH}" \
        'first(.Items[]? | select(.Path == $path)
            | ((.MediaSources // [] | map(.RunTimeTicks // 0) | max // 0) as $source
               | if $source > 0 then $source else (.RunTimeTicks // 0) end)) // 0')"
    AUTOSKIP_SCAN_SOURCE_COUNT="$(printf '%s' "${AUTOSKIP_SCAN_JSON}" | jq -r \
        --arg path "${AUTOSKIP_CONTAINER_PATH}" \
        'first(.Items[]? | select(.Path == $path) | (.MediaSources // [] | length)) // 0')"
    if [ "${MOVIES}" -ge 5 ] 2>/dev/null \
        && [ "${AUTOSKIP_MATCH_COUNT}" -eq 1 ] 2>/dev/null \
        && [ "${AUTOSKIP_SCAN_SOURCE_COUNT}" -ge 1 ] 2>/dev/null \
        && [ "${AUTOSKIP_SCAN_TICKS}" -ge "${AUTOSKIP_MIN_TICKS}" ] 2>/dev/null; then
        break
    fi
    sleep 5
done
[ "${MOVIES}" -ge 5 ] || fail "library scan indexed only ${MOVIES} movies (expected at least 5)"
[ "${AUTOSKIP_MATCH_COUNT}" -eq 1 ] \
    || fail "Auto-Skip fixture '${AUTOSKIP_NAME}' (ID <missing>, duration <missing>) was not indexed at ${AUTOSKIP_CONTAINER_PATH}"
[ "${AUTOSKIP_SCAN_SOURCE_COUNT}" -ge 1 ] 2>/dev/null \
    || fail "Auto-Skip fixture '${AUTOSKIP_NAME}' at ${AUTOSKIP_CONTAINER_PATH} has no probed media source after the scan wait"
[ "${AUTOSKIP_SCAN_TICKS}" -ge "${AUTOSKIP_MIN_TICKS}" ] 2>/dev/null \
    || fail "Auto-Skip fixture '${AUTOSKIP_NAME}' at ${AUTOSKIP_CONTAINER_PATH} has ${AUTOSKIP_SCAN_TICKS} ticks; ${AUTOSKIP_MIN_TICKS} required"

# Resolve by the physical path owned by this seed, validate the media metadata,
# then apply the stable logical name used by the spec. Re-read after the update
# so seed success cannot hide a stale/ambiguous title.
AUTOSKIP_ID="$(printf '%s' "${AUTOSKIP_SCAN_JSON}" | jq -er \
    --arg path "${AUTOSKIP_CONTAINER_PATH}" \
    'first(.Items[]? | select(.Path == $path) | .Id) // empty')"
AUTOSKIP_DTO="$(api GET "/Users/${ADMIN_ID}/Items/${AUTOSKIP_ID}?Fields=Path,MediaSources")"
AUTOSKIP_ACTUAL_TICKS="$(printf '%s' "${AUTOSKIP_DTO}" | jq -r \
    '(.MediaSources // [] | map(.RunTimeTicks // 0) | max // 0) as $source
     | if $source > 0 then $source else (.RunTimeTicks // 0) end')"
AUTOSKIP_ACTUAL_SECONDS="$(jq -nr --argjson ticks "${AUTOSKIP_ACTUAL_TICKS}" '$ticks / 10000000')"
jq -en --argjson actual "${AUTOSKIP_ACTUAL_SECONDS}" --argjson minimum "${AUTOSKIP_MIN_DURATION}" \
    '$actual >= $minimum' >/dev/null \
    || fail "Auto-Skip fixture '${AUTOSKIP_NAME}' (ID ${AUTOSKIP_ID}) is ${AUTOSKIP_ACTUAL_SECONDS}s; ${AUTOSKIP_MIN_DURATION}s required"
AUTOSKIP_PATCHED="$(printf '%s' "${AUTOSKIP_DTO}" | jq --arg name "${AUTOSKIP_NAME}" '.Name = $name')"
api POST "/Items/${AUTOSKIP_ID}" "${AUTOSKIP_PATCHED}" >/dev/null \
    || fail "could not apply stable name '${AUTOSKIP_NAME}' to Auto-Skip item ${AUTOSKIP_ID}"

AUTOSKIP_NAMED_JSON="$(api GET "/Items?IncludeItemTypes=Movie&Recursive=true&userId=${ADMIN_ID}&Fields=Path,MediaSources")"
AUTOSKIP_NAMED_COUNT="$(printf '%s' "${AUTOSKIP_NAMED_JSON}" | jq -r \
    --arg name "${AUTOSKIP_NAME}" '[.Items[]? | select(.Name == $name)] | length')"
[ "${AUTOSKIP_NAMED_COUNT}" -eq 1 ] \
    || fail "Auto-Skip fixture '${AUTOSKIP_NAME}' is ambiguous after naming (${AUTOSKIP_NAMED_COUNT} exact matches)"
AUTOSKIP_NAMED_ID="$(printf '%s' "${AUTOSKIP_NAMED_JSON}" | jq -er \
    --arg name "${AUTOSKIP_NAME}" 'first(.Items[]? | select(.Name == $name) | .Id) // empty')"
AUTOSKIP_NAMED_PATH="$(printf '%s' "${AUTOSKIP_NAMED_JSON}" | jq -er \
    --arg name "${AUTOSKIP_NAME}" 'first(.Items[]? | select(.Name == $name) | .Path) // empty')"
[ "${AUTOSKIP_NAMED_ID}" = "${AUTOSKIP_ID}" ] \
    || fail "Auto-Skip fixture '${AUTOSKIP_NAME}' changed ID after metadata update (${AUTOSKIP_ID} -> ${AUTOSKIP_NAMED_ID})"
[ "${AUTOSKIP_NAMED_PATH}" = "${AUTOSKIP_CONTAINER_PATH}" ] \
    || fail "Auto-Skip fixture '${AUTOSKIP_NAME}' resolved to unexpected path ${AUTOSKIP_NAMED_PATH}"
log "resolved Auto-Skip fixture: name='${AUTOSKIP_NAME}', ID=${AUTOSKIP_ID}, duration=${AUTOSKIP_ACTUAL_SECONDS}s, path=${AUTOSKIP_CONTAINER_PATH}"

log "waiting for the library scan to index the test series + episodes"
SERIES_ID=""
EPISODES=0
for _ in $(seq 1 60); do
    SERIES_ID="$(api GET "/Items?IncludeItemTypes=Series&Recursive=true&userId=${ADMIN_ID}" \
        | jq -r --arg n "${SHOW_NAME}" 'first(.Items[]? | select(.Name == $n) | .Id) // empty')"
    if [ -n "${SERIES_ID}" ]; then
        EPISODES="$(api GET "/Shows/${SERIES_ID}/Episodes?userId=${ADMIN_ID}" | jq -r '.TotalRecordCount // 0')"
        [ "${EPISODES}" -ge 4 ] 2>/dev/null && break
    fi
    sleep 5
done
[ -n "${SERIES_ID}" ] || fail "library scan never indexed the '${SHOW_NAME}' series"
[ "${EPISODES}" -ge 4 ] || fail "library scan indexed only ${EPISODES} episodes of '${SHOW_NAME}'"

# ── 6. per-movie metadata so every enabled tag family can render ─────────────
# The generated testsrc clips carry no genre or rating, so the genre- and
# rating-tags renderers had nothing to stamp (only quality + language, which
# come from the media itself, tagged). Give each movie real Genres and a
# CommunityRating via the item-update API so the per-family tag assertions in
# tags.spec.ts / non-admin.spec.ts stay meaningful on this bare seed.
log "seeding genre + rating metadata so every tag family renders"
MOVIE_IDS="$(api GET "/Items?IncludeItemTypes=Movie&Recursive=true&userId=${ADMIN_ID}" | jq -r '.Items[].Id')"
i=0
for MID in ${MOVIE_IDS}; do
    # Rotate a genre set and vary the community rating a little per movie; jq
    # picks both from the loop index so no fragile shell array-splitting.
    DTO="$(api GET "/Users/${ADMIN_ID}/Items/${MID}")"
    PATCHED="$(printf '%s' "${DTO}" | jq \
        --argjson idx "$((i % 4))" \
        '([["Action","Adventure"],["Comedy","Drama"],["Science Fiction","Thriller"],["Documentary"]][$idx]) as $g
         | .Genres = $g
         | .CommunityRating = (6.5 + ($idx * 0.5))')"
    api POST "/Items/${MID}" "${PATCHED}" >/dev/null || fail "could not update metadata for item ${MID}"
    i=$((i + 1))
done
log "updated metadata on ${i} movies (genres + community rating; audio lang baked at encode)"

# ── 7. episode titles + overviews so the strip filter has spoiler-y text ─────
# The naming resolver names each episode "Guard Test Show S0xE0y" on disk, which
# already looks like the strip placeholder. Give every episode a distinctive
# real title + synopsis so the "Season X, Episode Y" title replacement and the
# "Spoiler Guard activated" overview swap are observable (real → placeholder).
log "seeding episode titles + overviews on '${SHOW_NAME}'"
EP_JSON="$(api GET "/Shows/${SERIES_ID}/Episodes?userId=${ADMIN_ID}&fields=Overview")"
EP_COUNT="$(printf '%s' "${EP_JSON}" | jq -r '.Items | length')"
e=0
while [ "${e}" -lt "${EP_COUNT}" ]; do
    EID="$(printf '%s' "${EP_JSON}" | jq -r --argjson i "${e}" '.Items[$i].Id')"
    S="$(printf '%s' "${EP_JSON}" | jq -r --argjson i "${e}" '.Items[$i].ParentIndexNumber // 0')"
    N="$(printf '%s' "${EP_JSON}" | jq -r --argjson i "${e}" '.Items[$i].IndexNumber // 0')"
    DTO="$(api GET "/Users/${ADMIN_ID}/Items/${EID}")"
    PATCHED="$(printf '%s' "${DTO}" | jq \
        --arg name "The Secret of Chapter ${S}.${N}" \
        --arg ov "The villain is revealed and a hero falls in S${S}E${N}." \
        '.Name = $name | .Overview = $ov')"
    api POST "/Items/${EID}" "${PATCHED}" >/dev/null || fail "could not update metadata for episode ${EID}"
    e=$((e + 1))
done
log "updated titles + overviews on ${e} episodes of '${SHOW_NAME}'"

# ── 8. mark S1E1 played for the non-admin user (watched pass-through fixture) ─
# The specs assert a WATCHED episode's real title survives while UNWATCHED ones
# are stripped, and that per-user isolation holds — so exactly one episode must
# be watched for jc_arruser (and left untouched for the admin).
log "marking S01E01 played for the seeded non-admin user"
USER_ID="$(api GET /Users | jq -r --arg name "${USER_NAME}" '.[] | select(.Name == $name) | .Id')"
USER_TOKEN="$(curl -fsS -X POST "${BASE}/Users/AuthenticateByName" \
    -H "Authorization: ${CLIENT_AUTH}" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg username "${USER_NAME}" --arg password "${USER_PASS}" \
        '{Username: $username, Pw: $password}')" | jq -r .AccessToken)"
[ -n "${USER_TOKEN}" ] && [ "${USER_TOKEN}" != "null" ] || fail "could not authenticate the seeded non-admin user"
USER_AUTHED="Authorization: ${CLIENT_AUTH}, Token=\"${USER_TOKEN}\""
S1E1_ID="$(printf '%s' "${EP_JSON}" \
    | jq -r 'first(.Items[]? | select(.ParentIndexNumber == 1 and .IndexNumber == 1) | .Id) // empty')"
[ -n "${S1E1_ID}" ] || fail "could not resolve S01E01 of '${SHOW_NAME}'"
# v12 marks played via POST /UserPlayedItems/{itemId} in the calling user's
# context (docs/v12-platform.md — the legacy /Users/{id}/PlayedItems path is
# kept as a fallback for older builds).
curl -fsS -X POST "${BASE}/UserPlayedItems/${S1E1_ID}" -H "${USER_AUTHED}" -H 'Content-Type: application/json' >/dev/null 2>&1 \
    || curl -fsS -X POST "${BASE}/Users/${USER_ID}/PlayedItems/${S1E1_ID}" -H "${USER_AUTHED}" -H 'Content-Type: application/json' >/dev/null \
    || fail "could not mark S01E01 played for the seeded non-admin user"
log "marked S01E01 (${S1E1_ID}) played for the seeded non-admin user"

# Machine-readable evidence for local/CI diagnostics only. The spec deliberately
# does not read this file: it must discover the current item through Jellyfin's
# authenticated API so a stale database ID can never become an implicit input.
jq -n \
    --arg seedId "${SEED_NONCE}" \
    --arg baseUrl "${BASE}" \
    --arg project "${E2E_PROJECT}" \
    --arg image "${IMAGE}" \
    --arg imageId "${IMAGE_ID}" \
    --arg serverVersion "${SERVER_VERSION}" \
    --arg layoutEnforcement "${LAYOUT_ENFORCEMENT}" \
    --argjson port "${PUBLISHED_PORT}" \
    --argjson cpus "${JF_CPUS}" \
    --argjson actualNanoCpus "${ACTUAL_NANO_CPUS}" \
    --arg id "${AUTOSKIP_ID}" \
    --arg name "${AUTOSKIP_NAME}" \
    --arg path "${AUTOSKIP_CONTAINER_PATH}" \
    --argjson durationSeconds "${AUTOSKIP_ACTUAL_SECONDS}" \
    --argjson requiredMinimumSeconds "${AUTOSKIP_MIN_DURATION}" \
    '{
        seedId: $seedId,
        baseUrl: $baseUrl,
        port: $port,
        project: $project,
        cpus: $cpus,
        actualNanoCpus: $actualNanoCpus,
        image: $image,
        imageId: $imageId,
        serverVersion: $serverVersion,
        layoutEnforcement: $layoutEnforcement,
        autoSkip: {
            id: $id,
            name: $name,
            path: $path,
            durationSeconds: $durationSeconds,
            requiredMinimumSeconds: $requiredMinimumSeconds
        }
    }' > "${SEED_RESULT_TMP}"
mv -- "${SEED_RESULT_TMP}" "${SEED_RESULT}"

log "ready: ${BASE} (project=${E2E_PROJECT}, cpus=${JF_CPUS}, ${MOVIES} movies, series '${SHOW_NAME}' with ${EPISODES} episodes, Spoiler Guard enabled)"
log "run the suite with: JF_BASE_URL=${BASE} npm run e2e"
