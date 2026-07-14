#!/usr/bin/env bash
# Run the dockerized Jellyfin E2E suite across isolated local Playwright shards.
#
# This is deliberately opt-in. Each shard owns a fresh Compose project, dynamic
# loopback port, state tree and Playwright output directory. Stateful specs stay
# serial inside their server; concurrency exists only between clean servers.
set -uo pipefail

umask 077

MIN_SHARDS=1
MAX_SHARDS=16
MAX_CPUS_PER_SERVER=64
MEMORY_MIB_PER_SHARD_WARNING=2048
SHARDS=4
CPUS_PER_SERVER=2
ALLOW_EXTERNAL_INTEGRATIONS=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SEED_SCRIPT="${REPO_ROOT}/e2e/docker/seed.sh"
COMPOSE_FILE="${REPO_ROOT}/e2e/docker/compose.yml"
PROJECT_FILE="${REPO_ROOT}/Jellyfin.Plugin.JellyfinCanopy/JellyfinCanopy.csproj"
PLUGIN_DLL="${REPO_ROOT}/Jellyfin.Plugin.JellyfinCanopy/bin/Release/net10.0/Jellyfin.Plugin.JellyfinCanopy.dll"

RUN_ID=''
STATE_ROOT=''
RESULT_ROOT=''
ADMIN_USER=''
ADMIN_PASS=''
USER_NAME=''
USER_PASS=''
INVENTORY_HEAD_SHA=''
INVENTORY_RUN_ID=''
CLEANUP_STARTED=0

declare -a PROJECTS=()
declare -a STATE_DIRS=()
declare -a RESULT_DIRS=()
declare -a BASE_URLS=()
declare -a SEED_PIDS=()
declare -a TEST_PIDS=()
declare -a SEED_STATUS=()
declare -a TEST_STATUS=()
declare -a CLEANUP_STATUS=()

log() {
    printf '[local-e2e] %s\n' "$*"
}

warn() {
    printf '[local-e2e] WARNING: %s\n' "$*" >&2
}

die() {
    printf '[local-e2e] ERROR: %s\n' "$*" >&2
    exit 2
}

usage() {
    cat <<'EOF'
Usage: npm run e2e:local -- [options]

Run the complete Playwright inventory across isolated local Jellyfin servers.

Options:
  --shards N                    Native Playwright shard count (1..16; default 4)
  --cpus-per-server N           CPU quota for each Jellyfin server (1..64; default 2)
  --allow-external-integrations Forward TMDB_* and SEERR_* environment variables
  -h, --help                    Show this help

The 2-CPU default is the official local parity profile. Higher CPU quotas are
exploratory and make timing evidence less comparable to constrained runners.
Results and logs are retained under e2e/test-results/local-<run-id>/.
Treat retained failure logs, screenshots and results as sensitive local-only artifacts.
Runner credentials are random per run and become unusable after successful teardown.
Playwright traces are disabled; password-bearing files are removed and random
usernames are redacted from text diagnostics before the runner exits.

This runner is Linux-only and requires host ffmpeg plus GNU setsid and timeout
for process-group signal handling and bounded Docker cleanup.
EOF
}

require_option_value() {
    local option="$1"
    local count="$2"
    (( count >= 2 )) || die "${option} requires a value"
}

parse_args() {
    while (( $# > 0 )); do
        case "$1" in
            --shards)
                require_option_value "$1" "$#"
                SHARDS="$2"
                shift 2
                ;;
            --shards=*)
                SHARDS="${1#*=}"
                shift
                ;;
            --cpus-per-server)
                require_option_value "$1" "$#"
                CPUS_PER_SERVER="$2"
                shift 2
                ;;
            --cpus-per-server=*)
                CPUS_PER_SERVER="${1#*=}"
                shift
                ;;
            --allow-external-integrations)
                ALLOW_EXTERNAL_INTEGRATIONS=1
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                die "unknown option: $1"
                ;;
        esac
    done

    [[ "${SHARDS}" =~ ^[0-9]+$ ]] || die "--shards must be an integer from ${MIN_SHARDS} to ${MAX_SHARDS}"
    SHARDS=$((10#${SHARDS}))
    (( SHARDS >= MIN_SHARDS && SHARDS <= MAX_SHARDS )) \
        || die "--shards must be an integer from ${MIN_SHARDS} to ${MAX_SHARDS}"

    [[ "${CPUS_PER_SERVER}" =~ ^[0-9]+$ ]] \
        || die "--cpus-per-server must be an integer from 1 to ${MAX_CPUS_PER_SERVER}"
    CPUS_PER_SERVER=$((10#${CPUS_PER_SERVER}))
    (( CPUS_PER_SERVER >= 1 && CPUS_PER_SERVER <= MAX_CPUS_PER_SERVER )) \
        || die "--cpus-per-server must be an integer from 1 to ${MAX_CPUS_PER_SERVER}"
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

preflight() {
    local command_name
    for command_name in awk cat date docker dotnet ffmpeg find git grep jq mktemp node npm od openssl realpath sed setsid stat timeout tr uname; do
        require_command "${command_name}"
    done
    [[ "$(uname -s)" == Linux ]] || die "local sharding is Linux-only (GNU setsid/timeout are required)"
    [[ -f "${SEED_SCRIPT}" ]] || die "seed script not found: ${SEED_SCRIPT}"
    [[ -f "${COMPOSE_FILE}" ]] || die "Compose file not found: ${COMPOSE_FILE}"
    [[ -f "${PROJECT_FILE}" ]] || die "plugin project not found: ${PROJECT_FILE}"
    docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
    docker info >/dev/null 2>&1 || die "Docker daemon is unavailable"
}

random_hex() {
    local byte_count="$1"
    od -An -N "${byte_count}" -tx1 /dev/urandom | tr -d ' \n'
}

initialize_run() {
    local timestamp token attempt
    timestamp="$(date -u +%Y%m%dt%H%M%Sz)"
    mkdir -p "${REPO_ROOT}/e2e/test-results" \
        || die "could not create the local E2E result parent"

    for attempt in 1 2 3 4 5; do
        token="$(random_hex 6)" || die "could not generate a random run id"
        [[ "${#token}" -eq 12 ]] || die "random run id generation returned incomplete data"
        RUN_ID="${timestamp}-${token}"
        RESULT_ROOT="${REPO_ROOT}/e2e/test-results/local-${RUN_ID}"
        if mkdir "${RESULT_ROOT}" 2>/dev/null; then
            break
        fi
        RUN_ID=''
    done
    [[ -n "${RUN_ID}" ]] || die "could not allocate a unique result directory"
    INVENTORY_HEAD_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null)" \
        || die "could not resolve the local E2E source SHA"
    [[ "${INVENTORY_HEAD_SHA}" =~ ^[0-9a-f]{40}$ ]] \
        || die "local E2E source SHA is not a full commit id"
    INVENTORY_RUN_ID="$(date -u +%s%N)"
    [[ "${INVENTORY_RUN_ID}" =~ ^[1-9][0-9]*$ ]] \
        || die "could not allocate a numeric inventory run id"

    STATE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jc-e2e-${RUN_ID}.XXXXXX")" \
        || die "could not allocate an isolated state root"
    STATE_ROOT="$(realpath -e -- "${STATE_ROOT}")" \
        || die "could not canonicalize the isolated state root"
    printf '%s\n' "${RUN_ID}" > "${STATE_ROOT}/.jc-local-e2e-owner" \
        || die "could not write the runner ownership marker"

    local credential_token username_token
    credential_token="$(random_hex 12)" || die "could not generate runner credentials"
    [[ "${#credential_token}" -eq 24 ]] \
        || die "runner credential generation returned incomplete data"
    username_token="$(random_hex 8)" || die "could not generate runner usernames"
    [[ "${#username_token}" -eq 16 ]] \
        || die "runner username generation returned incomplete data"
    ADMIN_USER="jc_admin_${username_token}"
    USER_NAME="jc_user_${username_token}"
    ADMIN_PASS="Jc-${credential_token}-A9!"
    USER_PASS="Jc-$(random_hex 12)-U9!" || die "could not generate runner credentials"
    [[ "${#USER_PASS}" -eq 31 ]] \
        || die "runner credential generation returned incomplete data"

    local shard
    for (( shard = 1; shard <= SHARDS; shard++ )); do
        PROJECTS[shard]="jc-e2e-${RUN_ID}-s${shard}"
        STATE_DIRS[shard]="${STATE_ROOT}/shard-${shard}"
        RESULT_DIRS[shard]="${RESULT_ROOT}/shard-${shard}"
        SEED_STATUS[shard]=125
        TEST_STATUS[shard]=125
        mkdir -p "${STATE_DIRS[shard]}" "${RESULT_DIRS[shard]}/playwright" \
            || die "could not allocate state/results for shard ${shard}"
    done
}

sanitize_external_environment() {
    # Local parity always uses the same digest-pinned containers as required
    # CI. Mutable-image probing has its own isolated compatibility workflow.
    unset JF_IMAGE JF_MOCK_IMAGE
    (( ALLOW_EXTERNAL_INTEGRATIONS == 0 )) || return 0

    local name
    while IFS= read -r name; do
        unset "${name}"
    done < <(compgen -A variable TMDB_; compgen -A variable SEERR_; compgen -A variable RADARR_)
}

host_cpu_count() {
    local count=''
    count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
    if [[ ! "${count}" =~ ^[1-9][0-9]*$ ]] && command -v nproc >/dev/null 2>&1; then
        count="$(nproc 2>/dev/null || true)"
    fi
    [[ "${count}" =~ ^[1-9][0-9]*$ ]] && printf '%s\n' "${count}"
}

host_memory_mib() {
    [[ -r /proc/meminfo ]] || return 0
    awk '$1 == "MemAvailable:" { print int($2 / 1024); exit }' /proc/meminfo 2>/dev/null || true
}

host_swap_used_mib() {
    [[ -r /proc/meminfo ]] || return 0
    awk '
        $1 == "SwapTotal:" { total = $2 }
        $1 == "SwapFree:" { free = $2 }
        END { if (total > free) print int((total - free) / 1024) }
    ' /proc/meminfo 2>/dev/null || true
}

print_resource_plan() {
    local total_cpus host_cpus available_mib planned_mib swap_used_mib
    total_cpus=$((SHARDS * CPUS_PER_SERVER))
    host_cpus="$(host_cpu_count)"
    available_mib="$(host_memory_mib)"
    planned_mib=$((SHARDS * MEMORY_MIB_PER_SHARD_WARNING))
    swap_used_mib="$(host_swap_used_mib)"

    log "plan: ${SHARDS} isolated server(s) x ${CPUS_PER_SERVER} CPU(s) = ${total_cpus} maximum Jellyfin server CPU threads"
    log "the build, Chromium and bounded host ffmpeg work run outside those server quotas"
    log "memory guard: ${planned_mib} MiB suggested available (${MEMORY_MIB_PER_SHARD_WARNING} MiB per server/browser shard)"
    if (( CPUS_PER_SERVER != 2 )); then
        warn "${CPUS_PER_SERVER} CPUs/server is exploratory; official parity evidence uses exactly 2"
    fi
    if (( SHARDS > 4 )); then
        warn "${SHARDS} shards start ${SHARDS} complete Jellyfin servers; monitor memory as well as CPU"
    fi
    if [[ -n "${host_cpus}" ]] && (( total_cpus > host_cpus )); then
        warn "planned CPU quota (${total_cpus}) exceeds ${host_cpus} detected logical host CPUs"
    fi
    if [[ "${available_mib}" =~ ^[0-9]+$ ]] && (( available_mib < planned_mib )); then
        warn "only ${available_mib} MiB MemAvailable; ${planned_mib} MiB is suggested for ${SHARDS} server/browser shards"
    fi
    if [[ "${swap_used_mib}" =~ ^[1-9][0-9]*$ ]]; then
        warn "host already has ${swap_used_mib} MiB of swap in use; parallel E2E may increase swap pressure"
    fi
    if (( ALLOW_EXTERNAL_INTEGRATIONS == 1 )); then
        warn "external TMDB/Seerr integration variables are explicitly enabled for this run"
    else
        log "external TMDB_* and SEERR_* variables are removed from the runner environment"
    fi
}

terminate_active_jobs() {
    local pid attempt alive
    for pid in "${SEED_PIDS[@]:-}" "${TEST_PIDS[@]:-}"; do
        [[ "${pid}" =~ ^[1-9][0-9]*$ ]] || continue
        if kill -0 -- "-${pid}" >/dev/null 2>&1; then
            kill -TERM -- "-${pid}" >/dev/null 2>&1 || true
        fi
    done

    for (( attempt = 1; attempt <= 20; attempt++ )); do
        alive=0
        for pid in "${SEED_PIDS[@]:-}" "${TEST_PIDS[@]:-}"; do
            [[ "${pid}" =~ ^[1-9][0-9]*$ ]] || continue
            if kill -0 -- "-${pid}" >/dev/null 2>&1; then
                alive=1
            fi
        done
        (( alive == 1 )) || break
        sleep 0.1
    done

    for pid in "${SEED_PIDS[@]:-}" "${TEST_PIDS[@]:-}"; do
        [[ "${pid}" =~ ^[1-9][0-9]*$ ]] || continue
        if kill -0 -- "-${pid}" >/dev/null 2>&1; then
            kill -KILL -- "-${pid}" >/dev/null 2>&1 || true
        fi
        wait "${pid}" >/dev/null 2>&1 || true
    done
}

collect_and_teardown_shard() {
    local shard="$1"
    local result_dir="${RESULT_DIRS[shard]}"
    local cleanup_tmp="${result_dir}/cleanup-result.json.tmp"
    local cleanup_result="${result_dir}/cleanup-result.json"
    local logs_status down_status marker_status=0

    timeout --signal=KILL 20s env \
        JF_E2E_PROJECT="${PROJECTS[shard]}" \
        JF_E2E_STATE_DIR="${STATE_DIRS[shard]}" \
        JF_CONFIG_DIR="${STATE_DIRS[shard]}/config" \
        JF_CACHE_DIR="${STATE_DIRS[shard]}/cache" \
        JF_MEDIA_DIR="${STATE_DIRS[shard]}/media" \
        JF_BIND_ADDRESS=127.0.0.1 \
        JF_PORT=0 \
        JF_CPUS="${CPUS_PER_SERVER}" \
        docker compose -f "${COMPOSE_FILE}" --project-name "${PROJECTS[shard]}" \
        logs --no-color jellyfin \
        > "${result_dir}/jellyfin.log" 2>&1
    logs_status=$?

    run_compose_down() {
        timeout --signal=KILL 30s env \
            JF_E2E_PROJECT="${PROJECTS[shard]}" \
            JF_E2E_STATE_DIR="${STATE_DIRS[shard]}" \
            JF_CONFIG_DIR="${STATE_DIRS[shard]}/config" \
            JF_CACHE_DIR="${STATE_DIRS[shard]}/cache" \
            JF_MEDIA_DIR="${STATE_DIRS[shard]}/media" \
            JF_BIND_ADDRESS=127.0.0.1 \
            JF_PORT=0 \
            JF_CPUS="${CPUS_PER_SERVER}" \
            docker compose -f "${COMPOSE_FILE}" --project-name "${PROJECTS[shard]}" \
            down -v --remove-orphans --timeout 10
    }
    run_compose_down >> "${result_dir}/cleanup.log" 2>&1
    down_status=$?
    if (( down_status != 0 )); then
        printf 'first Compose teardown exited %s; retrying once\n' "${down_status}" \
            >> "${result_dir}/cleanup.log"
        run_compose_down >> "${result_dir}/cleanup.log" 2>&1
        down_status=$?
    fi

    jq -n \
        --arg runId "${RUN_ID}" \
        --arg project "${PROJECTS[shard]}" \
        --argjson shard "${shard}" \
        --argjson total "${SHARDS}" \
        --argjson logsExit "${logs_status}" \
        --argjson downExit "${down_status}" \
        '{
            runId: $runId,
            shard: $shard,
            total: $total,
            project: $project,
            logsExit: $logsExit,
            downExit: $downExit
        }' > "${cleanup_tmp}" \
        && mv "${cleanup_tmp}" "${cleanup_result}" \
        || marker_status=1

    (( down_status == 0 && marker_status == 0 ))
}

write_cleanup_summary_atomic() {
    local summary_tmp="${RESULT_ROOT}/cleanup-summary.txt.tmp"
    local summary="${RESULT_ROOT}/cleanup-summary.txt"
    local shard cleanup_result logs_status down_status result_dir

    {
        printf 'Cleanup results for local Jellyfin E2E run %s\n' "${RUN_ID}"
        printf '\n%-10s %-12s %-12s %s\n' 'Shard' 'Logs exit' 'Down exit' 'Marker'
        for (( shard = 1; shard <= SHARDS; shard++ )); do
            result_dir="${RESULT_DIRS[shard]:-}"
            cleanup_result="${result_dir}/cleanup-result.json"
            if [[ -n "${result_dir}" && -f "${cleanup_result}" ]]; then
                logs_status="$(jq -r '.logsExit' "${cleanup_result}" 2>/dev/null || printf invalid)"
                down_status="$(jq -r '.downExit' "${cleanup_result}" 2>/dev/null || printf invalid)"
                printf '%-10s %-12s %-12s %s\n' \
                    "${shard}/${SHARDS}" "${logs_status}" "${down_status}" "${cleanup_result}"
            else
                printf '%-10s %-12s %-12s %s\n' \
                    "${shard}/${SHARDS}" 'missing' 'missing' 'missing'
            fi
        done
    } > "${summary_tmp}" && mv "${summary_tmp}" "${summary}"
}

scrub_runner_credentials() {
    local file password username status password_found username_found
    local removed=0 redacted=0 redacted_tmp
    local summary_tmp="${RESULT_ROOT}/credential-scrub-summary.txt.tmp"
    local summary="${RESULT_ROOT}/credential-scrub-summary.txt"
    local file_list="${RESULT_ROOT}/.credential-scrub-files.tmp"
    local -a passwords=("${ADMIN_PASS}" "${USER_PASS}")
    local -a usernames=("${ADMIN_USER}" "${USER_NAME}")
    local -a sed_args=()

    for username in "${usernames[@]}"; do
        [[ -n "${username}" ]] || continue
        sed_args+=(-e "s|${username}|[REDACTED-RUNNER-USER]|g")
    done

    : > "${summary_tmp}" || return 1
    find "${RESULT_ROOT}" -type f -print0 > "${file_list}" || return 1
    while IFS= read -r -d '' file; do
        [[ "${file}" != "${summary_tmp}" && "${file}" != "${file_list}" ]] || continue
        password_found=0
        for password in "${passwords[@]}"; do
            [[ -n "${password}" ]] || continue
            if LC_ALL=C grep -aFq -- "${password}" "${file}"; then
                password_found=1
                break
            else
                status=$?
                (( status == 1 )) || return 1
            fi
        done
        if (( password_found == 1 )); then
            printf 'removed %s\n' "${file#"${RESULT_ROOT}/"}" >> "${summary_tmp}" \
                || return 1
            rm -f -- "${file}" || return 1
            removed=$((removed + 1))
            continue
        fi

        username_found=0
        for username in "${usernames[@]}"; do
            [[ -n "${username}" ]] || continue
            if LC_ALL=C grep -aFq -- "${username}" "${file}"; then
                username_found=1
                break
            else
                status=$?
                (( status == 1 )) || return 1
            fi
        done
        if (( username_found == 1 )); then
            if LC_ALL=C grep -Iq . "${file}"; then
                redacted_tmp="${file}.redacted.tmp"
                if ! LC_ALL=C sed "${sed_args[@]}" -- "${file}" > "${redacted_tmp}"; then
                    rm -f -- "${redacted_tmp}" "${file}"
                    return 1
                fi
                mv -- "${redacted_tmp}" "${file}" || {
                    rm -f -- "${redacted_tmp}" "${file}"
                    return 1
                }
                printf 'redacted %s\n' "${file#"${RESULT_ROOT}/"}" >> "${summary_tmp}" \
                    || return 1
                redacted=$((redacted + 1))
            else
                printf 'removed-binary %s\n' "${file#"${RESULT_ROOT}/"}" \
                    >> "${summary_tmp}" || return 1
                rm -f -- "${file}" || return 1
                removed=$((removed + 1))
            fi
        fi
    done < "${file_list}"
    rm -f -- "${file_list}" || return 1
    if (( removed == 0 && redacted == 0 )); then
        printf 'No retained file contained a runner username or password.\n' \
            >> "${summary_tmp}" || return 1
    elif (( removed > 0 )); then
        warn "removed ${removed} retained artifact(s) containing a runner password or binary username"
    fi
    if (( redacted > 0 )); then
        log "redacted runner usernames from ${redacted} retained diagnostic artifact(s)"
    fi
    mv "${summary_tmp}" "${summary}"
}

cleanup() {
    local original_status=$?
    (( CLEANUP_STARTED == 0 )) || return
    CLEANUP_STARTED=1
    trap - EXIT
    trap '' INT TERM

    terminate_active_jobs

    if [[ -n "${RESULT_ROOT}" ]]; then
        log "collecting server logs and tearing down runner-owned Compose projects"
    fi

    local shard result_dir cleanup_failed=0
    local -a cleanup_pids=()
    for (( shard = 1; shard <= SHARDS; shard++ )); do
        [[ -n "${PROJECTS[shard]:-}" ]] || continue
        result_dir="${RESULT_DIRS[shard]}"
        mkdir -p "${result_dir}"
        collect_and_teardown_shard "${shard}" &
        cleanup_pids[shard]=$!
    done
    for (( shard = 1; shard <= SHARDS; shard++ )); do
        [[ -n "${cleanup_pids[shard]:-}" ]] || continue
        if wait "${cleanup_pids[shard]}"; then
            CLEANUP_STATUS[shard]=0
        else
            CLEANUP_STATUS[shard]=$?
            cleanup_failed=1
            warn "cleanup failed for shard ${shard}/${SHARDS}; see ${RESULT_DIRS[shard]}/cleanup.log"
            warn "manual recovery: docker compose --project-name '${PROJECTS[shard]}' --file '${COMPOSE_FILE}' down -v --remove-orphans"
        fi
    done
    if (( ${#cleanup_pids[@]} > 0 )); then
        write_cleanup_summary_atomic || cleanup_failed=1
    fi
    if [[ -n "${RESULT_ROOT}" ]]; then
        scrub_runner_credentials || {
            cleanup_failed=1
            warn "could not verify retained artifacts are free of runner credentials"
        }
    fi

    if [[ -n "${STATE_ROOT}" ]]; then
        local owner_marker="${STATE_ROOT}/.jc-local-e2e-owner"
        local owner_value=''
        if [[ ! -f "${owner_marker}" ]] \
            || ! owner_value="$(cat -- "${owner_marker}" 2>/dev/null)" \
            || [[ "${owner_value}" != "${RUN_ID}" ]]; then
            cleanup_failed=1
            warn "retaining state because the runner ownership marker is missing, unreadable or mismatched: ${STATE_ROOT}"
        elif (( cleanup_failed != 0 )); then
            warn "retaining state after cleanup failure: ${STATE_ROOT}"
        elif ! rm -rf -- "${STATE_ROOT}"; then
            cleanup_failed=1
            warn "could not fully remove runner-owned state: ${STATE_ROOT}"
        fi
    fi

    if [[ -n "${RESULT_ROOT}" ]]; then
        log "retained results: ${RESULT_ROOT}"
    fi
    if (( cleanup_failed != 0 && original_status == 0 )); then
        original_status=1
    fi
    exit "${original_status}"
}

handle_signal() {
    local exit_code="$1"
    local signal_name="$2"
    warn "received ${signal_name}; stopping runner-owned shard processes"
    exit "${exit_code}"
}

build_plugin_once() {
    log "building the Release plugin once for all shards"
    (
        cd "${REPO_ROOT}"
        dotnet build "${PROJECT_FILE}" -c Release
    ) 2>&1 | tee "${RESULT_ROOT}/build.log"
    local build_status=${PIPESTATUS[0]}
    (( build_status == 0 )) || return "${build_status}"
    [[ -f "${PLUGIN_DLL}" ]] || {
        warn "build succeeded but plugin DLL is missing: ${PLUGIN_DLL}"
        return 1
    }
}

start_seed_jobs() {
    local shard
    log "starting ${SHARDS} isolated seed jobs in parallel"
    for (( shard = 1; shard <= SHARDS; shard++ )); do
        (
            export JF_E2E_PROJECT="${PROJECTS[shard]}"
            export JF_E2E_STATE_DIR="${STATE_DIRS[shard]}"
            export JF_BIND_ADDRESS=127.0.0.1
            export JF_PORT=0
            export JF_CPUS="${CPUS_PER_SERVER}"
            export JF_FFMPEG_THREADS=2
            export JF_E2E_SEED_ID="${RUN_ID}-shard-${shard}"
            export JF_ADMIN_USER="${ADMIN_USER}"
            export JF_ADMIN_PASS="${ADMIN_PASS}"
            export JF_USER_NAME="${USER_NAME}"
            export JF_USER_PASS="${USER_PASS}"
            export PLUGIN_DLL="${PLUGIN_DLL}"
            exec setsid --wait bash "${SEED_SCRIPT}"
        ) > "${RESULT_DIRS[shard]}/seed.log" 2>&1 &
        SEED_PIDS[shard]=$!
        log "seed shard ${shard}/${SHARDS} started (project ${PROJECTS[shard]})"
    done
}

validate_seed_result() {
    local shard="$1"
    local result_file="${STATE_DIRS[shard]}/seed-result.json"
    local base_url port project cpus actual_nano_cpus expected_nano_cpus

    [[ -f "${result_file}" ]] || {
        warn "shard ${shard} did not write ${result_file}"
        return 1
    }
    cp "${result_file}" "${RESULT_DIRS[shard]}/seed-result.json"

    base_url="$(jq -er '.baseUrl | select(type == "string" and length > 0)' "${result_file}" 2>/dev/null)" || return 1
    port="$(jq -er '.port | tostring' "${result_file}" 2>/dev/null)" || return 1
    project="$(jq -er '.project | select(type == "string" and length > 0)' "${result_file}" 2>/dev/null)" || return 1
    cpus="$(jq -er '.cpus | tostring' "${result_file}" 2>/dev/null)" || return 1
    actual_nano_cpus="$(jq -er '.actualNanoCpus | tostring' "${result_file}" 2>/dev/null)" || return 1
    expected_nano_cpus="$(jq -nr --arg cpus "${CPUS_PER_SERVER}" '$cpus | tonumber * 1000000000 | round')" \
        || return 1

    [[ "${port}" =~ ^[1-9][0-9]*$ ]] && (( port <= 65535 )) || return 1
    [[ "${project}" == "${PROJECTS[shard]}" ]] || return 1
    [[ "${cpus}" == "${CPUS_PER_SERVER}" ]] || return 1
    [[ "${actual_nano_cpus}" == "${expected_nano_cpus}" ]] || return 1
    [[ "${base_url}" == "http://127.0.0.1:${port}" ]] || return 1

    BASE_URLS[shard]="${base_url}"
}

wait_for_seed_jobs() {
    local shard pid status
    for (( shard = 1; shard <= SHARDS; shard++ )); do
        pid="${SEED_PIDS[shard]}"
        if wait "${pid}"; then
            status=0
        else
            status=$?
        fi
        SEED_PIDS[shard]=''

        if (( status == 0 )) && validate_seed_result "${shard}"; then
            SEED_STATUS[shard]=0
            log "seed shard ${shard}/${SHARDS} ready at ${BASE_URLS[shard]}"
        else
            (( status != 0 )) || status=1
            SEED_STATUS[shard]="${status}"
            warn "seed shard ${shard}/${SHARDS} failed (exit ${status}); see ${RESULT_DIRS[shard]}/seed.log"
        fi
    done
}

start_test_jobs() {
    local shard output_dir
    log "starting Playwright for every successfully seeded shard"
    for (( shard = 1; shard <= SHARDS; shard++ )); do
        (( SEED_STATUS[shard] == 0 )) || continue
        output_dir="${RESULT_DIRS[shard]}/playwright"
        (
            export JF_BASE_URL="${BASE_URLS[shard]}"
            export JF_ADMIN_USER="${ADMIN_USER}"
            export JF_ADMIN_PASS="${ADMIN_PASS}"
            export JF_USER_NAME="${USER_NAME}"
            export JF_USER_PASS="${USER_PASS}"
            export JF_E2E_PROJECT="${PROJECTS[shard]}"
            export JF_E2E_STATE_DIR="${STATE_DIRS[shard]}"
            export JF_E2E_OUTPUT_DIR="${output_dir}"
            export JF_E2E_TRACE=off
            if (( ALLOW_EXTERNAL_INTEGRATIONS == 0 )); then
                export JF_E2E_REQUIRED=true
                export JF_E2E_INVENTORY_FILE="${RESULT_DIRS[shard]}/shard-${shard}.inventory"
                export JF_E2E_SHARD="${shard}"
                export JF_E2E_SHARD_TOTAL="${SHARDS}"
                export JF_E2E_HEAD_SHA="${INVENTORY_HEAD_SHA}"
                export JF_E2E_RUN_ID="${INVENTORY_RUN_ID}"
                export JF_E2E_RUN_ATTEMPT=1
            fi
            exec setsid --wait npm --prefix "${REPO_ROOT}" run e2e -- \
                --shard="${shard}/${SHARDS}" --output="${output_dir}"
        ) > "${RESULT_DIRS[shard]}/playwright.log" 2>&1 &
        TEST_PIDS[shard]=$!
        log "test shard ${shard}/${SHARDS} started"
    done
}

wait_for_test_jobs() {
    local shard pid status
    for (( shard = 1; shard <= SHARDS; shard++ )); do
        pid="${TEST_PIDS[shard]:-}"
        if [[ -z "${pid}" ]]; then
            TEST_STATUS[shard]=125
            continue
        fi
        if wait "${pid}"; then
            status=0
        else
            status=$?
        fi
        TEST_PIDS[shard]=''
        TEST_STATUS[shard]="${status}"
        if (( status == 0 )); then
            log "test shard ${shard}/${SHARDS} passed"
        else
            warn "test shard ${shard}/${SHARDS} failed (exit ${status}); see ${RESULT_DIRS[shard]}/playwright.log"
        fi
    done
}

write_shard_marker() {
    local shard="$1"
    local marker="${RESULT_DIRS[shard]}/shard-result.json"
    local marker_tmp="${marker}.tmp"

    jq -n \
        --arg runId "${RUN_ID}" \
        --arg project "${PROJECTS[shard]}" \
        --arg baseUrl "${BASE_URLS[shard]:-}" \
        --argjson shard "${shard}" \
        --argjson total "${SHARDS}" \
        --argjson cpusPerServer "${CPUS_PER_SERVER}" \
        --argjson seedExit "${SEED_STATUS[shard]}" \
        --argjson testExit "${TEST_STATUS[shard]}" \
        '{
            runId: $runId,
            shard: $shard,
            total: $total,
            project: $project,
            baseUrl: $baseUrl,
            cpusPerServer: $cpusPerServer,
            seedExit: $seedExit,
            testExit: $testExit
        }' > "${marker_tmp}" \
        && mv "${marker_tmp}" "${marker}"
}

write_shard_markers() {
    local shard failed=0
    for (( shard = 1; shard <= SHARDS; shard++ )); do
        if ! write_shard_marker "${shard}"; then
            failed=1
            warn "could not write atomic result marker for shard ${shard}/${SHARDS}"
        fi
    done
    return "${failed}"
}

validate_shard_markers() {
    local shard marker
    local -a markers=()
    mapfile -t markers < <(
        find "${RESULT_ROOT}" -mindepth 2 -maxdepth 2 -type f -name shard-result.json -print
    )
    if (( ${#markers[@]} != SHARDS )); then
        warn "expected exactly ${SHARDS} shard result markers, found ${#markers[@]}"
        return 1
    fi

    for (( shard = 1; shard <= SHARDS; shard++ )); do
        marker="${RESULT_DIRS[shard]}/shard-result.json"
        [[ -f "${marker}" ]] || {
            warn "missing shard result marker: ${marker}"
            return 1
        }
        jq -e \
            --arg runId "${RUN_ID}" \
            --arg project "${PROJECTS[shard]}" \
            --argjson shard "${shard}" \
            --argjson total "${SHARDS}" \
            --argjson cpusPerServer "${CPUS_PER_SERVER}" \
            --argjson seedExit "${SEED_STATUS[shard]}" \
            --argjson testExit "${TEST_STATUS[shard]}" \
            '.runId == $runId
             and .project == $project
             and .shard == $shard
             and .total == $total
             and .cpusPerServer == $cpusPerServer
             and .seedExit == $seedExit
             and .testExit == $testExit' \
            "${marker}" >/dev/null || {
                warn "invalid or stale shard result marker: ${marker}"
                return 1
            }
    done
}

validate_required_inventory() {
    (( ALLOW_EXTERNAL_INTEGRATIONS == 0 )) || return 0
    node "${REPO_ROOT}/scripts/e2e/required-inventory.js" aggregate \
        --directory "${RESULT_ROOT}" \
        --expected "${REPO_ROOT}/e2e/required-test-inventory.json" \
        --total "${SHARDS}" \
        --sha "${INVENTORY_HEAD_SHA}" \
        --run-id "${INVENTORY_RUN_ID}" \
        --run-attempt 1
}

write_summary() {
    local overall=0 shard test_display
    local summary_tmp="${RESULT_ROOT}/summary.txt.tmp"
    local summary="${RESULT_ROOT}/summary.txt"
    validate_shard_markers || overall=1
    validate_required_inventory || {
        overall=1
        warn "required E2E inventory was skipped, incomplete, duplicated, or different from the committed contract"
    }
    for (( shard = 1; shard <= SHARDS; shard++ )); do
        if (( SEED_STATUS[shard] != 0 || TEST_STATUS[shard] != 0 )); then
            overall=1
        fi
    done

    {
        printf 'Local Jellyfin E2E run %s\n' "${RUN_ID}"
        printf 'Shards: %s; CPUs/server: %s; maximum Jellyfin server CPU threads: %s\n' \
            "${SHARDS}" "${CPUS_PER_SERVER}" "$((SHARDS * CPUS_PER_SERVER))"
        printf '\n%-10s %-10s %-10s %s\n' 'Shard' 'Seed' 'Tests' 'Base URL'
        for (( shard = 1; shard <= SHARDS; shard++ )); do
            test_display="${TEST_STATUS[shard]}"
            if (( SEED_STATUS[shard] != 0 )); then
                test_display='not-run'
            fi
            printf '%-10s %-10s %-10s %s\n' \
                "${shard}/${SHARDS}" "${SEED_STATUS[shard]}" "${test_display}" "${BASE_URLS[shard]:-—}"
        done
    } > "${summary_tmp}" && mv "${summary_tmp}" "${summary}" || overall=1
    [[ -f "${summary}" ]] && cat "${summary}"
    return "${overall}"
}

main() {
    parse_args "$@"
    preflight
    # Job-control process groups would make setsid fork away from the PID we
    # track. Disable them so each --wait process owns the exact negative PGID.
    set +m
    trap 'cleanup' EXIT
    trap 'handle_signal 130 INT' INT
    trap 'handle_signal 143 TERM' TERM
    initialize_run

    sanitize_external_environment
    print_resource_plan
    log "run id: ${RUN_ID}"
    log "results: ${RESULT_ROOT}"

    build_plugin_once || {
        warn "plugin build failed; no shard servers were started"
        return 1
    }

    start_seed_jobs
    wait_for_seed_jobs
    start_test_jobs
    wait_for_test_jobs
    write_shard_markers || true
    write_summary
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
