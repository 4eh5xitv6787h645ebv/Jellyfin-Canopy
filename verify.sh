#!/usr/bin/env bash

# Repository-owned verification entry point.
#
# Policy: ESLint findings (including a warning-cap breach) are advisory. An
# ESLint configuration/internal failure and every non-lint check remain
# blocking. CI, release automation, and pre-commit all enter the advisory
# boundary through this script so that policy cannot drift. The broader local
# fast/full verifier remains responsible for orchestrating every other gate.

set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

append_lint_summary() {
    local result=$1
    local status=$2
    local totals=$3

    [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] || return 0
    {
        printf '## ESLint (advisory)\n\n'
        printf -- '- Result: **%s**\n' "$result"
        printf -- '- Raw ESLint exit code: `%s`\n' "$status"
        printf -- '- ESLint totals: %s\n' "$totals"
        printf -- '- Full output: this step\047s job log\n'
        printf -- '- Policy: findings and warning-cap breaches are advisory; execution/configuration failures block.\n'
    } >> "$GITHUB_STEP_SUMMARY" || {
        printf 'verify: could not append the ESLint result to GITHUB_STEP_SUMMARY\n' >&2
        return 2
    }
}

run_lint() {
    local counts error_count lint_log output_mode problem_count status=0 totals warning_count

    command -v npm >/dev/null 2>&1 || {
        printf 'verify: npm is required to run ESLint\n' >&2
        return 127
    }
    command -v node >/dev/null 2>&1 || {
        printf 'verify: node is required to validate the lint command\n' >&2
        return 127
    }

    output_mode="${JC_LINT_OUTPUT:-full}"
    [[ "$output_mode" == 'full' || "$output_mode" == 'compact' ]] || {
        printf 'verify: JC_LINT_OUTPUT must be full or compact\n' >&2
        return 2
    }

    # Distinguish a missing/malformed npm script from ESLint findings. npm
    # itself can use exit 1 for a missing script, while ESLint reserves 1 for
    # findings and 2 for configuration/internal failures.
    node -e "const p=require('./package.json'); if (typeof p.scripts?.lint !== 'string' || !p.scripts.lint.trim()) process.exit(2)" || {
        status=$?
        printf 'verify: package.json does not define a usable lint script\n' >&2
        return "$status"
    }

    lint_log="$(mktemp "${TMPDIR:-/tmp}/jc-eslint.XXXXXX")"
    LINT_TEMP=$lint_log
    trap '[[ -z "${LINT_TEMP:-}" ]] || rm -f -- "$LINT_TEMP"' EXIT

    if npm run lint >"$lint_log" 2>&1; then
        status=0
    else
        status=$?
    fi

    # Only numeric totals cross into the summary/workflow-command surfaces.
    # The complete untrusted ESLint output is copied verbatim only to the job
    # log; pre-commit opts into a compact tail to avoid printing ~1 MiB on every
    # JS/TS commit while still showing the final counts and advisory annotation.
    counts="$(sed -nE 's/^✖[[:space:]]+([0-9]+) problems? \(([0-9]+) errors?, ([0-9]+) warnings?\)$/\1 \2 \3/p' "$lint_log" | tail -n 1)"
    if [[ -n "$counts" ]]; then
        read -r problem_count error_count warning_count <<< "$counts"
        totals="problems=$problem_count; errors=$error_count; warnings=$warning_count"
    else
        problem_count=0
        totals='not reported by ESLint; inspect the log'
    fi
    if [[ "$output_mode" == 'compact' ]]; then
        tail -n 8 "$lint_log"
        printf 'verify: compact pre-commit output; run npm run lint for the complete ESLint log\n' >&2
    else
        cat "$lint_log"
    fi
    rm -f -- "$lint_log"
    LINT_TEMP=''

    case "$status" in
        0)
            append_lint_summary 'passed (no blocking effect)' 0 "$totals"
            printf 'verify: ESLint completed successfully (advisory signal)\n' >&2
            ;;
        1)
            # ESLint 1 plus its canonical numeric result = lint findings or
            # --max-warnings exceeded. A bare 1 can instead come from npm's
            # lifecycle/prelint machinery, so fail closed unless ESLint proved
            # it completed and actually reported findings.
            if (( problem_count == 0 )); then
                printf '::error title=ESLint execution failed::The lint command exited 1 without a valid ESLint result footer; treating it as a blocking invocation failure.\n' >&2
                append_lint_summary 'BLOCKING — unverified exit 1' 1 "$totals"
                return 2
            fi
            printf '::warning title=ESLint advisory::ESLint reported findings or exceeded the warning cap (exit 1). See this step\047s log; all non-lint gates still run.\n' >&2
            append_lint_summary 'ADVISORY — findings reported' 1 "$totals"
            ;;
        *)
            # ESLint 2 is a configuration/internal failure. Shell invocation
            # failures (126/127) and signal exits (128+) are also infrastructure
            # failures, not lint findings, so they remain blocking.
            printf '::error title=ESLint execution failed::ESLint did not complete normally (exit %s); this is a blocking tooling/configuration failure.\n' "$status" >&2
            append_lint_summary 'BLOCKING — execution/configuration failure' "$status" "$totals"
            return "$status"
            ;;
    esac
}

[[ "${1:-}" == 'lint' ]] || {
    printf 'usage: %s lint\n' "$0" >&2
    exit 2
}
shift
(( $# == 0 )) || {
    printf 'usage: %s lint\n' "$0" >&2
    exit 2
}
run_lint
