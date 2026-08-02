#!/usr/bin/env bash
set -euo pipefail

if (( $# != 1 )); then
  echo "usage: pull-pinned-image.sh <image@sha256:digest>" >&2
  exit 64
fi

readonly image="$1"
readonly max_attempts=3

if [[ ! "${image}" =~ @sha256:[0-9a-fA-F]{64}$ ]]; then
  echo "Refusing to pull an image without an immutable sha256 digest" >&2
  exit 64
fi

for (( attempt = 1; attempt <= max_attempts; attempt++ )); do
  echo "Pulling pinned container image (attempt ${attempt}/${max_attempts})" >&2
  if docker pull -q "${image}"; then
    exit 0
  else
    pull_status=$?
  fi

  if (( attempt == max_attempts )); then
    echo "Pinned container image pull failed after ${max_attempts} attempts" >&2
    exit "${pull_status}"
  fi

  delay_seconds=$(( attempt * 2 ))
  echo "Pinned container image pull failed; retrying in ${delay_seconds}s" >&2
  sleep "${delay_seconds}"
done
