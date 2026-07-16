#!/usr/bin/env bash
set -euo pipefail

readonly REPO_ROOT="/Users/mcb/Claudelocal/careers/resume2/projects/job-finder-cursor-party"
readonly CONTROL_PLANE_ENV="${HOME:?HOME is required}/.config/estate-control-plane.env"

if [[ ! -r "${CONTROL_PLANE_ENV}" ]]; then
  printf 'lab-openings-scheduled: cannot read %s\n' "${CONTROL_PLANE_ENV}" >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "${CONTROL_PLANE_ENV}"
set +a

: "${SUPABASE_URL:?lab-openings-scheduled: SUPABASE_URL is required}"
: "${SUPABASE_SERVICE_KEY:?lab-openings-scheduled: SUPABASE_SERVICE_KEY is required}"
SUPABASE_URL="${SUPABASE_URL%/}"

readonly MARKET_DIR="${CAREERS_MARKET_DIR:-/Users/mcb/Claudelocal/careers/market}"
readonly SCHEDULED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
readonly RUN_DATE="${SCHEDULED_AT%%T*}"
readonly AUTHORIZATION="Authorization: Bearer ${SUPABASE_SERVICE_KEY}"

start_payload="$(jq -cn \
  --arg task "careers-lab-openings" \
  --arg substrate "mac" \
  --arg scheduled_at "${SCHEDULED_AT}" \
  '{task: $task, substrate: $substrate, scheduled_at: $scheduled_at, started_at: $scheduled_at}')"
start_response="$(curl --fail-with-body --silent --show-error \
  -X POST "${SUPABASE_URL}/rest/v1/runs" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "${AUTHORIZATION}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  --data "${start_payload}")"
beacon_run_id="$(jq -er 'if type == "array" and length == 1 then .[0].id else error("expected one run row") end | select(. != null)' <<<"${start_response}")"

finish_beacon() {
  local exit_status=$?
  local patch_response
  local patch_status
  local finish_payload
  trap - EXIT
  finish_payload="$(jq -cn \
    --arg finished_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson exit_status "${exit_status}" \
    '{finished_at: $finished_at, exit_status: $exit_status}')"
  set +e
  patch_response="$(curl --fail-with-body --silent --show-error \
    -X PATCH "${SUPABASE_URL}/rest/v1/runs?id=eq.${beacon_run_id}" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" \
    -H "${AUTHORIZATION}" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    --data "${finish_payload}")"
  patch_status=$?
  if ((patch_status == 0)); then
    jq -e --arg id "${beacon_run_id}" \
      'type == "array" and length == 1 and (.[0].id | tostring) == $id' \
      <<<"${patch_response}" >/dev/null
    patch_status=$?
  fi
  set -e
  if ((patch_status != 0)); then
    printf 'lab-openings-scheduled: beacon finish failed with status %d\n' "${patch_status}" >&2
    if ((exit_status == 0)); then
      exit "${patch_status}"
    fi
  fi
  exit "${exit_status}"
}
trap finish_beacon EXIT

set +e
(cd "${REPO_ROOT}" && PATH="/opt/homebrew/bin:${PATH}" /opt/homebrew/bin/bun run labs:openings -- record --scheduled-at "${SCHEDULED_AT}")
scanner_status=$?
set -e

status_path="${MARKET_DIR}/openings-${RUN_DATE}.status.json"
jsonl_path="${MARKET_DIR}/openings-${RUN_DATE}.jsonl"
if [[ ! -r "${status_path}" || ! -r "${jsonl_path}" ]]; then
  printf 'lab-openings-scheduled: missing artifacts: %s or %s\n' "${status_path}" "${jsonl_path}" >&2
  exit 1
fi

scanner_run_id="$(jq -er '.runId | strings | select(length > 0)' "${status_path}")"
openings_count="$(jq -s 'length' "${jsonl_path}")"
ids_payload="$(jq -r '[.org, .ats, .id] | if all(.[]; type == "string" and length > 0) then join(":") else error("org, ats, and id must be non-empty strings") end' "${jsonl_path}" | LC_ALL=C sort)"
ids_sha256="$(printf '%s' "${ids_payload}" | shasum -a 256 | cut -d ' ' -f 1)"

parity_payload="$(jq -cn \
  --arg run_date "${RUN_DATE}" \
  --arg substrate "mac" \
  --arg run_id "${scanner_run_id}" \
  --argjson openings_count "${openings_count}" \
  --arg ids_sha256 "${ids_sha256}" \
  '{run_date: $run_date, substrate: $substrate, run_id: $run_id, openings_count: $openings_count, ids_sha256: $ids_sha256}')"
curl --fail-with-body --silent --show-error \
  -X POST "${SUPABASE_URL}/rest/v1/parity_runs?on_conflict=run_date%2Csubstrate" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "${AUTHORIZATION}" \
  -H "Content-Type: application/json" \
  -H "Accept-Profile: careers" \
  -H "Content-Profile: careers" \
  -H "Prefer: resolution=merge-duplicates,return=minimal" \
  --data "${parity_payload}"

exit "${scanner_status}"
