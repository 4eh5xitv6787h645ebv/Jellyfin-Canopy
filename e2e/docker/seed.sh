#!/usr/bin/env bash
# Seed a throwaway dockerized Jellyfin 12 for the E2E suite:
#   1. install the freshly built plugin DLL into a clean config volume,
#   2. generate a handful of tiny valid movies + a 2×2-episode TV series with
#      ffmpeg (testsrc2 clips),
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
# TMDB and Jellyseerr integration the security specs exercise. When unset the
# seed is bare and those specs SKIP (see e2e/fixtures/seerr.ts):
#   TMDB_API_KEY               a TMDB v3 API key            -> TmdbEnabled
#   JELLYSEERR_URL             a reachable Jellyseerr URL    \
#   JELLYSEERR_API_KEY         its API key                   > JellyseerrEnabled
#   JELLYSEERR_RESPECT_PARENTAL  true|false (default true) — parental gating
#
# Usage:
#   dotnet build Jellyfin.Plugin.JellyfinElevate/JellyfinElevate.csproj -c Release
#   bash e2e/docker/seed.sh                # default port 8100 (bare)
#   TMDB_API_KEY=... JELLYSEERR_URL=... JELLYSEERR_API_KEY=... bash e2e/docker/seed.sh
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
PLUGIN_DLL="${PLUGIN_DLL:-${REPO_ROOT}/Jellyfin.Plugin.JellyfinElevate/bin/Release/net10.0/Jellyfin.Plugin.JellyfinElevate.dll}"
PLUGIN_ID="9ffa12bc-f4b5-406c-ab1d-d575acbeea7b"
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
mkdir -p "${HERE}/config/plugins/JellyfinElevate_e2e" "${HERE}/cache" "${HERE}/media"
cp "${PLUGIN_DLL}" "${HERE}/config/plugins/JellyfinElevate_e2e/"
log "installed plugin DLL into config/plugins/JellyfinElevate_e2e"

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

# Movies and Shows live in dedicated subfolders so the recursive Movies-library
# scan never descends into the TV tree (and vice-versa) — a single /media root
# shared by both collection types would misidentify episode files as movies.
mkdir -p "${HERE}/media/Movies" "${HERE}/media/Shows"

make_clip() { # <relative-path> <tone-hz>
    # Tag the audio stream as English so the language-tags renderer has a real
    # language to stamp (a bare testsrc clip reports "und", which the renderer
    # skips). Genres + a community rating are added post-scan via the API below.
    run_ffmpeg \
        -f lavfi -i "testsrc2=duration=5:size=640x360:rate=24" \
        -f lavfi -i "sine=frequency=$2:duration=5" \
        -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest \
        -metadata:s:a:0 language=eng -y "$1"
}

log "generating test movies"
make_clip "Movies/Alpha Adventure (2021).mp4" 440
make_clip "Movies/Beta Voyage (2022).mp4" 550
make_clip "Movies/Gamma Quest (2023).mp4" 660
make_clip "Movies/Delta Horizon (2024).mp4" 770

# ── TV: one series, 2 seasons × 2 episodes, for the Spoiler Guard specs ───────
# Series/Season NN/… S0xE0y naming so Jellyfin's naming resolver builds the
# Series → Season → Episode hierarchy. The episodes carry generic names on disk;
# the real (spoiler-y) titles come from the metadata patch below so the strip
# filter has something to replace with "Season X, Episode Y".
SHOW_NAME="Guard Test Show"
log "generating test series '${SHOW_NAME}' (2 seasons × 2 episodes)"
mkdir -p "${HERE}/media/Shows/${SHOW_NAME}/Season 01" "${HERE}/media/Shows/${SHOW_NAME}/Season 02"
make_clip "Shows/${SHOW_NAME}/Season 01/${SHOW_NAME} S01E01.mp4" 480
make_clip "Shows/${SHOW_NAME}/Season 01/${SHOW_NAME} S01E02.mp4" 500
make_clip "Shows/${SHOW_NAME}/Season 02/${SHOW_NAME} S02E01.mp4" 520
make_clip "Shows/${SHOW_NAME}/Season 02/${SHOW_NAME} S02E02.mp4" 540

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
    || fail "Jellyfin Elevate plugin did not load (check config/log/)"

log "creating the Movies library"
api POST "/Library/VirtualFolders?name=Movies&collectionType=movies&paths=%2Fmedia%2FMovies&refreshLibrary=true" \
    '{"LibraryOptions":{"EnableRealtimeMonitor":false}}'

log "creating the Shows library"
api POST "/Library/VirtualFolders?name=Shows&collectionType=tvshows&paths=%2Fmedia%2FShows&refreshLibrary=true" \
    '{"LibraryOptions":{"EnableRealtimeMonitor":false}}'

log "creating user ${USER_NAME}"
api POST /Users/New "{\"Name\":\"${USER_NAME}\",\"Password\":\"${USER_PASS}\"}" >/dev/null

# ── 5. plugin feature flags (+ optional TMDB/Seerr) + scan wait ──────────────
log "enabling the plugin features the specs exercise"

# Optional Seerr/TMDB integration — bare unless the env vars are supplied
# (never hardcode a key; CI passes these as secrets when it wants the security
# specs to RUN rather than SKIP). See e2e/fixtures/seerr.ts for the gate.
TMDB_API_KEY="${TMDB_API_KEY:-}"
JELLYSEERR_URL="${JELLYSEERR_URL:-}"
JELLYSEERR_API_KEY="${JELLYSEERR_API_KEY:-}"
case "${JELLYSEERR_RESPECT_PARENTAL:-true}" in
    false|FALSE|0|no) JELLYSEERR_RESPECT_PARENTAL=false ;;
    *) JELLYSEERR_RESPECT_PARENTAL=true ;;
esac

PLUGIN_CONFIG="$(api GET "/Plugins/${PLUGIN_ID}/Configuration" \
    | jq --arg tmdb "${TMDB_API_KEY}" \
         --arg seerrUrl "${JELLYSEERR_URL}" \
         --arg seerrKey "${JELLYSEERR_API_KEY}" \
         --argjson seerrParental "${JELLYSEERR_RESPECT_PARENTAL}" \
        '.QualityTagsEnabled = true
        | .GenreTagsEnabled = true
        | .LanguageTagsEnabled = true
        | .RatingTagsEnabled = true
        | .RandomButtonEnabled = true
        | .HiddenContentEnabled = true
        | .SpoilerBlurEnabled = true
        | .ShowFileSizes = true
        | .ShowWatchProgress = true
        | (if $tmdb != "" then .TMDB_API_KEY = $tmdb else . end)
        | (if ($seerrUrl != "" and $seerrKey != "")
             then .JellyseerrUrls = $seerrUrl
                | .JellyseerrApiKey = $seerrKey
                | .JellyseerrEnabled = true
                | .JellyseerrRespectParentalRatings = $seerrParental
             else . end)')"
api POST "/Plugins/${PLUGIN_ID}/Configuration" "${PLUGIN_CONFIG}" >/dev/null

if [ -n "${TMDB_API_KEY}" ]; then
    log "optional: TMDB configured (TmdbEnabled)"
else
    log "optional: TMDB not configured — TMDB/reviews specs will SKIP"
fi
if [ -n "${JELLYSEERR_URL}" ] && [ -n "${JELLYSEERR_API_KEY}" ]; then
    log "optional: Jellyseerr configured (${JELLYSEERR_URL}, respectParental=${JELLYSEERR_RESPECT_PARENTAL})"
else
    log "optional: Jellyseerr not configured — Seerr specs will SKIP"
fi

log "waiting for the library scan to index the movies"
ADMIN_ID="$(api GET /Users | jq -r --arg name "${ADMIN_USER}" '.[] | select(.Name == $name) | .Id')"
MOVIES=0
for _ in $(seq 1 60); do
    MOVIES="$(api GET "/Items?IncludeItemTypes=Movie&Recursive=true&userId=${ADMIN_ID}" | jq -r .TotalRecordCount)"
    [ "${MOVIES}" -ge 3 ] 2>/dev/null && break
    sleep 5
done
[ "${MOVIES}" -ge 3 ] || fail "library scan indexed only ${MOVIES} movies"

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
# be watched for je_arruser (and left untouched for the admin).
log "marking S01E01 played for ${USER_NAME}"
USER_ID="$(api GET /Users | jq -r --arg name "${USER_NAME}" '.[] | select(.Name == $name) | .Id')"
USER_TOKEN="$(curl -fsS -X POST "${BASE}/Users/AuthenticateByName" \
    -H "Authorization: ${CLIENT_AUTH}" -H 'Content-Type: application/json' \
    -d "{\"Username\":\"${USER_NAME}\",\"Pw\":\"${USER_PASS}\"}" | jq -r .AccessToken)"
[ -n "${USER_TOKEN}" ] && [ "${USER_TOKEN}" != "null" ] || fail "could not authenticate ${USER_NAME}"
USER_AUTHED="Authorization: ${CLIENT_AUTH}, Token=\"${USER_TOKEN}\""
S1E1_ID="$(printf '%s' "${EP_JSON}" \
    | jq -r 'first(.Items[]? | select(.ParentIndexNumber == 1 and .IndexNumber == 1) | .Id) // empty')"
[ -n "${S1E1_ID}" ] || fail "could not resolve S01E01 of '${SHOW_NAME}'"
# v12 marks played via POST /UserPlayedItems/{itemId} in the calling user's
# context (docs/v12-platform.md — the legacy /Users/{id}/PlayedItems path is
# kept as a fallback for older builds).
curl -fsS -X POST "${BASE}/UserPlayedItems/${S1E1_ID}" -H "${USER_AUTHED}" -H 'Content-Type: application/json' >/dev/null 2>&1 \
    || curl -fsS -X POST "${BASE}/Users/${USER_ID}/PlayedItems/${S1E1_ID}" -H "${USER_AUTHED}" -H 'Content-Type: application/json' >/dev/null \
    || fail "could not mark S01E01 played for ${USER_NAME}"
log "marked S01E01 (${S1E1_ID}) played for ${USER_NAME}"

log "ready: ${BASE} (admin=${ADMIN_USER}, user=${USER_NAME}, ${MOVIES} movies, series '${SHOW_NAME}' with ${EPISODES} episodes, Spoiler Guard enabled)"
log "run the suite with: JF_BASE_URL=${BASE} npm run e2e"
