#!/usr/bin/env bash
# Disposable Jellyfin 12 installed-provider conformance. This owns only a fresh
# mktemp root and uniquely named containers; it never targets an existing server.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOTNET_BIN="${DOTNET:-dotnet}"
IMAGE="${JF_IMAGE:?JF_IMAGE must be the workflow-owned digest-pinned Jellyfin image}"
RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jc-provider-conformance.XXXXXXXX")"
CONFIG="${RUN_ROOT}/config"
CACHE="${RUN_ROOT}/cache"
LOGS="${RUN_ROOT}/evidence"
CONTAINER="jc-provider-conformance-$$"
STATE_FILE="${CONFIG}/plugins/configurations/Jellyfin.Plugin.JellyfinCanopy.platform-provider-registry-v1.json"
ALPHA_ID="0a110000-1111-4222-8333-444455556666"
OMEGA_ID="0b220000-1111-4222-8333-444455556777"
PLUGIN_DLL="${ROOT}/Jellyfin.Plugin.JellyfinCanopy/bin/Release/net10.0/Jellyfin.Plugin.JellyfinCanopy.dll"
FIXTURES="${ROOT}/conformance/platform-providers"
START_TIMEOUT_SECONDS="${PROVIDER_CONFORMANCE_START_TIMEOUT_SECONDS:-120}"
STOP_TIMEOUT_SECONDS="${PROVIDER_CONFORMANCE_STOP_TIMEOUT_SECONDS:-30}"
ACTIVE_LABEL=""

log() { printf '[provider-conformance] %s\n' "$*"; }
fail() { printf '[provider-conformance] ERROR: %s\n' "$*" >&2; exit 1; }
scenario() { log "scenario:$1"; }

cleanup() {
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
    case "${RUN_ROOT}" in
        "${TMPDIR:-/tmp}"/jc-provider-conformance.*) rm -rf -- "${RUN_ROOT}" ;;
        *) printf '[provider-conformance] refusing unexpected cleanup root: %s\n' "${RUN_ROOT}" >&2 ;;
    esac
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null || fail 'docker is required'
command -v jq >/dev/null || fail 'jq is required'
mkdir -p -- "${CONFIG}/plugins" "${CACHE}" "${LOGS}"

reset_owned_directory() { # <exact directory below RUN_ROOT>
    local directory="$1"
    case "${directory}" in
        "${RUN_ROOT}"/*)
            rm -rf -- "${directory}"
            mkdir -p -- "${directory}"
            ;;
        *) fail "refusing to reset directory outside the owned run root" ;;
    esac
}

log 'building production plugin and independent fixture packages'
"${DOTNET_BIN}" build "${ROOT}/Jellyfin.Plugin.JellyfinCanopy.Tests/JellyfinCanopy.Tests.csproj" \
    -c Release --nologo >/dev/null

stage_package() { # <source-project> <destination-directory>
    local project="$1"
    local destination="$2"
    local package="${FIXTURES}/${project}/bin/Release/net10.0/package"
    [ -f "${package}/meta.json" ] || fail "missing meta.json for ${project}"
    [ -f "${package}/jellyfin-canopy-extension.json" ] \
        || fail "missing extension manifest for ${project}"
    local dll
    dll="$(find "${package}" -maxdepth 1 -type f -name '*.dll' -printf '%f\n')"
    [ -n "${dll}" ] && [ "$(printf '%s\n' "${dll}" | wc -l)" -eq 1 ] \
        || fail "${project} package must contain exactly one DLL"
    [ "$(find "${package}" -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 3 ] \
        || fail "${project} package must contain exactly three files"
    reset_owned_directory "${destination}"
    cp -- "${package}/${dll}" "${package}/meta.json" \
        "${package}/jellyfin-canopy-extension.json" "${destination}/"
}

stage_canopy() {
    local destination="${CONFIG}/plugins/JellyfinCanopy_conformance"
    reset_owned_directory "${destination}"
    cp -- "${PLUGIN_DLL}" "${destination}/"
}

start_server() { # <label> <expect-registry:true|false>
    local label="$1"
    local expect_registry="$2"
    local previous_revision=-1
    if [ -f "${STATE_FILE}" ]; then
        previous_revision="$(jq -er '.revision' "${STATE_FILE}")"
    fi
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
    docker run -d --name "${CONTAINER}" \
        --user "$(id -u):$(id -g)" \
        --mount "type=bind,src=${CONFIG},dst=/config" \
        --mount "type=bind,src=${CACHE},dst=/cache" \
        "${IMAGE}" >/dev/null
    ACTIVE_LABEL="${label}"

    local deadline=$((SECONDS + START_TIMEOUT_SECONDS))
    while [ "${SECONDS}" -lt "${deadline}" ]; do
        if docker exec "${CONTAINER}" curl -fsS http://127.0.0.1:8096/health >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    docker exec "${CONTAINER}" curl -fsS http://127.0.0.1:8096/health >/dev/null 2>&1 \
        || fail "Jellyfin did not become healthy for ${label}"

    if [ "${expect_registry}" = true ]; then
        while [ "${SECONDS}" -lt "${deadline}" ]; do
            if [ -f "${STATE_FILE}" ] \
                && revision="$(jq -er '.revision' "${STATE_FILE}" 2>/dev/null)" \
                && [ "${revision}" -gt "${previous_revision}" ]; then
                break
            fi
            sleep 1
        done
        [ -f "${STATE_FILE}" ] || fail "registry state was not created for ${label}"
        revision="$(jq -er '.revision' "${STATE_FILE}")"
        [ "${revision}" -gt "${previous_revision}" ] \
            || fail "registry did not advance for ${label}"
    else
        while [ "${SECONDS}" -lt "${deadline}" ]; do
            current_logs="$(docker logs "${CONTAINER}" 2>&1 || true)"
            if grep -Fq 'Loaded plugin: AAA Canopy Conformance Alpha ' <<< "${current_logs}" \
                && grep -Fq 'Loaded plugin: ZZZ Canopy Conformance Omega ' <<< "${current_logs}" \
                && grep -Fq 'Startup complete' <<< "${current_logs}"; then
                break
            fi
            sleep 1
        done
    fi
    docker logs "${CONTAINER}" > "${LOGS}/${label}.log" 2>&1
    log "${label}: healthy"
}

stop_server() {
    [ -n "${ACTIVE_LABEL}" ] || fail 'no active conformance server to stop'
    docker stop --time "${STOP_TIMEOUT_SECONDS}" "${CONTAINER}" >/dev/null \
        || fail "Jellyfin did not stop cleanly for ${ACTIVE_LABEL}"
    local exit_code
    exit_code="$(docker inspect --format '{{.State.ExitCode}}' "${CONTAINER}")"
    [ "${exit_code}" -eq 0 ] \
        || fail "Jellyfin exited non-cleanly for ${ACTIVE_LABEL}; exit=${exit_code}"
    docker logs "${CONTAINER}" > "${LOGS}/${ACTIVE_LABEL}.log" 2>&1
    docker rm "${CONTAINER}" >/dev/null
    ACTIVE_LABEL=""
}

assert_fixture_loaded() { # <label> <display-name> <assembly-name>
    local label="$1"
    local display_name="$2"
    local assembly_name="$3"
    local log_file="${LOGS}/${label}.log"
    grep -Fq "Loaded plugin: ${display_name} " "${log_file}" \
        || { tail -n 100 "${log_file}" >&2; fail "${display_name} did not load for ${label}"; }
    if grep -Eqi "(Skipping disabled plugin.*${display_name}|Failed to load assembly.*${assembly_name}|Error creating.*${assembly_name})" "${log_file}"; then
        tail -n 100 "${log_file}" >&2
        fail "${display_name} emitted a load, skip or instantiation failure for ${label}"
    fi
}

assert_load_order() { # <label> <first-name> <second-name> <third-name>
    local label="$1"
    shift
    local previous=0
    local display_name
    for display_name in "$@"; do
        local line
        line="$(grep -nF -m1 "Loaded plugin: ${display_name} " "${LOGS}/${label}.log" | cut -d: -f1)"
        [ -n "${line}" ] || fail "missing ${display_name} load evidence for ${label}"
        [ "${line}" -gt "${previous}" ] \
            || fail "unexpected plugin load order for ${label} at ${display_name}"
        previous="${line}"
    done
}

canonical_fixture_records() {
    # Assembly-set identity intentionally incorporates descriptor/inode facts, so
    # two clean hosts cannot share it. Compare the canonical registry projection
    # that load ordering owns: identity, generation, lifecycle inputs, semantic
    # fingerprint, requested scope and durable disposition.
    jq -cS --arg alpha "${ALPHA_ID}" --arg omega "${OMEGA_ID}" \
        '[.records[] | select(.pluginId == $alpha or .pluginId == $omega) | del(.lastAssemblyIdentity)] | sort_by(.pluginId)' \
        "${STATE_FILE}"
}

record() { # <plugin-id> <jq-filter>
    local plugin_id="$1"
    local filter="$2"
    jq -e --arg id "${plugin_id}" \
        ".records | map(select((.pluginId | ascii_downcase) == (\$id | ascii_downcase))) | length == 1 and (.[0] | ${filter})" \
        "${STATE_FILE}" >/dev/null
}

dump_record() { # <plugin-id>
    local plugin_id="$1"
    jq -c --arg id "${plugin_id}" \
        '.records[] | select((.pluginId | ascii_downcase) == ($id | ascii_downcase))' \
        "${STATE_FILE}" >&2 || true
}

scenario 'baseline'
scenario 'load-order-alpha-canopy-omega'
stage_canopy
stage_package Jellyfin.Plugin.CanopyConformance.Alpha "${CONFIG}/plugins/AAA_alpha"
stage_package Jellyfin.Plugin.CanopyConformance.Omega "${CONFIG}/plugins/ZZZ_omega"
start_server baseline true
record "${ALPHA_ID}" '.lastHostVersion == "1.0.0.0" and .lastHostStatus == 1 and .lastOutcome == 0' \
    || fail 'baseline Alpha record is not exact and active'
record "${OMEGA_ID}" '.lastHostVersion == "1.0.0.0" and .lastHostStatus == 1 and .lastOutcome == 0' \
    || fail 'baseline Omega record is not exact and active'
[ "$(jq '.records | length' "${STATE_FILE}")" -ge 2 ] \
    || fail 'baseline registry must contain both independent fixtures'
BASE_FINGERPRINT="$(jq -er --arg id "${ALPHA_ID}" '.records[] | select(.pluginId == $id) | .lastFingerprint' "${STATE_FILE}")"
BASE_ASSEMBLY="$(jq -er --arg id "${ALPHA_ID}" '.records[] | select(.pluginId == $id) | .lastAssemblyIdentity' "${STATE_FILE}")"
BASE_GENERATION="$(jq -er --arg id "${ALPHA_ID}" '.records[] | select(.pluginId == $id) | .generation' "${STATE_FILE}")"
FORWARD_CANONICAL="$(canonical_fixture_records)"
stop_server
assert_fixture_loaded baseline 'AAA Canopy Conformance Alpha' 'Jellyfin.Plugin.CanopyConformance.Alpha'
assert_fixture_loaded baseline 'ZZZ Canopy Conformance Omega' 'Jellyfin.Plugin.CanopyConformance.Omega'
assert_fixture_loaded baseline 'Jellyfin Canopy' 'Jellyfin.Plugin.JellyfinCanopy'
assert_load_order baseline \
    'AAA Canopy Conformance Alpha' 'Jellyfin Canopy' 'ZZZ Canopy Conformance Omega'

scenario 'upgrade'
stage_package Jellyfin.Plugin.CanopyConformance.Alpha.Upgrade "${CONFIG}/plugins/AAA_alpha"
start_server upgrade true
record "${ALPHA_ID}" '.lastHostVersion == "1.1.0.0" and .lastOutcome == 0' \
    || fail 'upgrade did not bind exact Alpha 1.1.0.0'
UPGRADE_GENERATION="$(jq -er --arg id "${ALPHA_ID}" '.records[] | select(.pluginId == $id) | .generation' "${STATE_FILE}")"
[ "${UPGRADE_GENERATION}" -gt "${BASE_GENERATION}" ] \
    || fail 'upgrade did not advance Alpha generation'
stop_server

scenario 'aba'
stage_package Jellyfin.Plugin.CanopyConformance.Alpha "${CONFIG}/plugins/AAA_alpha"
start_server aba true
record "${ALPHA_ID}" ".lastHostVersion == \"1.0.0.0\" and .lastFingerprint == \"${BASE_FINGERPRINT}\" and .lastOutcome == 0" \
    || fail 'A-to-B-to-A did not restore the exact baseline observation'
ABA_GENERATION="$(jq -er --arg id "${ALPHA_ID}" '.records[] | select(.pluginId == $id) | .generation' "${STATE_FILE}")"
[ "${ABA_GENERATION}" -gt "${UPGRADE_GENERATION}" ] \
    || fail 'A-to-B-to-A did not advance Alpha generation on the return to A'
stop_server

scenario 'downgrade'
stage_package Jellyfin.Plugin.CanopyConformance.Alpha.Downgrade "${CONFIG}/plugins/AAA_alpha"
start_server downgrade true
record "${ALPHA_ID}" '.lastHostVersion == "0.9.0.0" and .lastOutcome == 0' \
    || fail 'downgrade did not bind exact Alpha 0.9.0.0'
stop_server

scenario 'assembly-drift'
stage_package Jellyfin.Plugin.CanopyConformance.Alpha.AssemblyDrift "${CONFIG}/plugins/AAA_alpha"
start_server assembly-drift true
DRIFT_FINGERPRINT="$(jq -er --arg id "${ALPHA_ID}" '.records[] | select(.pluginId == $id) | .lastFingerprint' "${STATE_FILE}")"
DRIFT_ASSEMBLY="$(jq -er --arg id "${ALPHA_ID}" '.records[] | select(.pluginId == $id) | .lastAssemblyIdentity' "${STATE_FILE}")"
[ "${DRIFT_FINGERPRINT}" = "${BASE_FINGERPRINT}" ] \
    || fail 'same-manifest assembly drift changed semantic fingerprint'
[ "${DRIFT_ASSEMBLY}" != "${BASE_ASSEMBLY}" ] \
    || fail 'assembly drift did not change verified assembly identity'
stop_server

scenario 'requested-scope-drift'
stage_package Jellyfin.Plugin.CanopyConformance.Alpha "${CONFIG}/plugins/AAA_alpha"
cp -- "${FIXTURES}/variants/alpha-scope-drift/jellyfin-canopy-extension.json" \
    "${CONFIG}/plugins/AAA_alpha/jellyfin-canopy-extension.json"
start_server scope-drift true
record "${ALPHA_ID}" '.lastRequestedCapabilityIds | length == 3' \
    || fail 'scope drift did not publish the exact requested set'
stop_server

scenario 'malformed-manifest'
stage_package Jellyfin.Plugin.CanopyConformance.Alpha "${CONFIG}/plugins/AAA_alpha"
cp -- "${FIXTURES}/variants/alpha-malformed/jellyfin-canopy-extension.json" \
    "${CONFIG}/plugins/AAA_alpha/jellyfin-canopy-extension.json"
start_server malformed-manifest true
record "${ALPHA_ID}" '.lastHostStatus == 1 and .lastOutcome == 13 and .wasAbsent == false' \
    || { dump_record "${ALPHA_ID}"; fail 'malformed Alpha did not fail closed as an observed rejection'; }
record "${OMEGA_ID}" '.lastHostStatus == 1 and .lastOutcome == 0 and .wasAbsent == false' \
    || { dump_record "${OMEGA_ID}"; fail 'malformed Alpha suppressed the honest Omega peer'; }
stop_server
assert_fixture_loaded malformed-manifest 'AAA Canopy Conformance Alpha' 'Jellyfin.Plugin.CanopyConformance.Alpha'
assert_fixture_loaded malformed-manifest 'ZZZ Canopy Conformance Omega' 'Jellyfin.Plugin.CanopyConformance.Omega'

scenario 'disabled'
stage_package Jellyfin.Plugin.CanopyConformance.Alpha "${CONFIG}/plugins/AAA_alpha"
jq '.status = "Disabled"' "${CONFIG}/plugins/AAA_alpha/meta.json" \
    > "${CONFIG}/plugins/AAA_alpha/meta.json.tmp"
mv -- "${CONFIG}/plugins/AAA_alpha/meta.json.tmp" "${CONFIG}/plugins/AAA_alpha/meta.json"
start_server disabled true
# Jellyfin 12 filters a plugin that is already Disabled on disk out of its
# discovered inventory because no DLL list is retained. The registry must treat
# that host fact exactly like a whole-inventory omission: absent and inert.
record "${ALPHA_ID}" '.wasAbsent == true and .disposition == 0' \
    || { dump_record "${ALPHA_ID}"; fail 'disabled-on-disk Alpha did not become inert absence'; }
stop_server

scenario 'removed'
reset_owned_directory "${CONFIG}/plugins/AAA_alpha"
rmdir -- "${CONFIG}/plugins/AAA_alpha"
start_server removed true
record "${ALPHA_ID}" '.wasAbsent == true' || fail 'removed Alpha was not marked absent'
stop_server

scenario 'same-guid-reinstall'
stage_package Jellyfin.Plugin.CanopyConformance.Alpha "${CONFIG}/plugins/reinstalled_alpha_fresh_root"
start_server same-guid-reinstall true
record "${ALPHA_ID}" '.wasAbsent == false and .disposition == 0 and .lastOutcome == 0' \
    || fail 'same-GUID reinstall was not inert and pending'
stop_server

# A fresh Canopy-present host reverses the manifest-name load ordering and must
# produce a byte-identical canonical fixture projection.
scenario 'load-order-omega-canopy-alpha'
CONFIG="${RUN_ROOT}/reverse-order-config"
CACHE="${RUN_ROOT}/reverse-order-cache"
STATE_FILE="${CONFIG}/plugins/configurations/Jellyfin.Plugin.JellyfinCanopy.platform-provider-registry-v1.json"
mkdir -p -- "${CONFIG}/plugins" "${CACHE}"
stage_canopy
stage_package Jellyfin.Plugin.CanopyConformance.Alpha "${CONFIG}/plugins/ZZZ_alpha"
stage_package Jellyfin.Plugin.CanopyConformance.Omega "${CONFIG}/plugins/AAA_omega"
jq '.name = "ZZZZ Canopy Conformance Alpha"' "${CONFIG}/plugins/ZZZ_alpha/meta.json" \
    > "${CONFIG}/plugins/ZZZ_alpha/meta.json.tmp"
mv -- "${CONFIG}/plugins/ZZZ_alpha/meta.json.tmp" "${CONFIG}/plugins/ZZZ_alpha/meta.json"
jq '.name = "AAAA Canopy Conformance Omega"' "${CONFIG}/plugins/AAA_omega/meta.json" \
    > "${CONFIG}/plugins/AAA_omega/meta.json.tmp"
mv -- "${CONFIG}/plugins/AAA_omega/meta.json.tmp" "${CONFIG}/plugins/AAA_omega/meta.json"
start_server reverse-order true
REVERSE_CANONICAL="$(canonical_fixture_records)"
[ "${REVERSE_CANONICAL}" = "${FORWARD_CANONICAL}" ] \
    || fail 'reversed Jellyfin load order changed canonical fixture registry records'
stop_server
assert_fixture_loaded reverse-order 'AAA Canopy Conformance Alpha' 'Jellyfin.Plugin.CanopyConformance.Alpha'
assert_fixture_loaded reverse-order 'ZZZ Canopy Conformance Omega' 'Jellyfin.Plugin.CanopyConformance.Omega'
assert_fixture_loaded reverse-order 'Jellyfin Canopy' 'Jellyfin.Plugin.JellyfinCanopy'
assert_load_order reverse-order \
    'ZZZ Canopy Conformance Omega' 'Jellyfin Canopy' 'AAA Canopy Conformance Alpha'

# A second clean host proves both fixtures are ordinary Jellyfin plugins and boot
# without Canopy. Reverse their manifest names to exercise the other Jellyfin
# manifest-name load ordering without changing GUID/version/assembly identity.
ABSENT_CONFIG="${RUN_ROOT}/without-canopy-config"
CONFIG="${ABSENT_CONFIG}"
CACHE="${RUN_ROOT}/without-canopy-cache"
STATE_FILE="${CONFIG}/plugins/configurations/Jellyfin.Plugin.JellyfinCanopy.platform-provider-registry-v1.json"
mkdir -p -- "${CONFIG}/plugins" "${CACHE}"
stage_package Jellyfin.Plugin.CanopyConformance.Alpha "${CONFIG}/plugins/ZZZ_alpha"
stage_package Jellyfin.Plugin.CanopyConformance.Omega "${CONFIG}/plugins/AAA_omega"
jq '.name = "ZZZZ Canopy Conformance Alpha"' "${CONFIG}/plugins/ZZZ_alpha/meta.json" \
    > "${CONFIG}/plugins/ZZZ_alpha/meta.json.tmp"
mv -- "${CONFIG}/plugins/ZZZ_alpha/meta.json.tmp" "${CONFIG}/plugins/ZZZ_alpha/meta.json"
jq '.name = "AAAA Canopy Conformance Omega"' "${CONFIG}/plugins/AAA_omega/meta.json" \
    > "${CONFIG}/plugins/AAA_omega/meta.json.tmp"
mv -- "${CONFIG}/plugins/AAA_omega/meta.json.tmp" "${CONFIG}/plugins/AAA_omega/meta.json"
start_server fixtures-without-canopy false
[ ! -e "${STATE_FILE}" ] || fail 'Canopy registry state exists on the Canopy-absent host'
stop_server
assert_fixture_loaded fixtures-without-canopy 'AAA Canopy Conformance Alpha' 'Jellyfin.Plugin.CanopyConformance.Alpha'
assert_fixture_loaded fixtures-without-canopy 'ZZZ Canopy Conformance Omega' 'Jellyfin.Plugin.CanopyConformance.Omega'

log 'all disposable Jellyfin 12 provider conformance scenarios passed'
