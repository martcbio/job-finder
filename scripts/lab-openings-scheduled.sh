#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
PROJECT_DIR="${CAREERS_PROJECT_DIR:-${REPO_ROOT}}"
readonly PROJECT_DIR
CONTROL_PLANE_ENV="${HOME:?HOME is required}/.config/estate-control-plane.env"
readonly CONTROL_PLANE_ENV

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

find_market_dir() {
  local ancestor
  local parent

  ancestor="$(cd "$1" && pwd)" || {
    printf 'lab-openings-scheduled: cannot resolve project directory %s\n' "$1" >&2
    return 1
  }
  while true; do
    if [[ -f "${ancestor}/market/targets.json" && -r "${ancestor}/market/targets.json" ]]; then
      printf '%s\n' "${ancestor}/market"
      return 0
    fi
    parent="$(dirname "${ancestor}")"
    [[ "${parent}" != "${ancestor}" ]] || break
    ancestor="${parent}"
  done

  printf 'lab-openings-scheduled: cannot find market/targets.json from project directory %s; set CAREERS_MARKET_DIR explicitly\n' \
    "$1" >&2
  return 1
}

if [[ -n "${CAREERS_MARKET_DIR:-}" ]]; then
  MARKET_DIR="${CAREERS_MARKET_DIR}"
else
  MARKET_DIR="$(find_market_dir "${PROJECT_DIR}")"
fi
readonly MARKET_DIR
BUN_BIN="${CAREERS_BUN_BIN:-/opt/homebrew/bin/bun}"
readonly BUN_BIN
OPPS_BIN="${CAREERS_OPPS_BIN:-${PROJECT_DIR}/scripts/opps}"
readonly OPPS_BIN
SCHEDULED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
readonly SCHEDULED_AT
AUTHORIZATION="Authorization: Bearer ${SUPABASE_SERVICE_KEY}"
readonly AUTHORIZATION
BEACON_FILTER="task=eq.jobsradar&substrate=eq.mac&scheduled_at=eq.$(
  jq -rn --arg scheduled_at "${SCHEDULED_AT}" '$scheduled_at | @uri'
)"
readonly BEACON_FILTER
scanner_status=1
signals_status=-1
parity_status=-1
report_status=-1
publication_status="unknown"
published_run_id=""
beacon_run_id=""
run_date=""

# shellcheck source=lib/resolve-openings-artifacts.sh
source "${REPO_ROOT}/scripts/lib/resolve-openings-artifacts.sh"
# shellcheck source=lib/scheduled-run-policy.sh
source "${REPO_ROOT}/scripts/lib/scheduled-run-policy.sh"

find_scheduled_status_path() {
  local status_path

  for status_path in "${MARKET_DIR}"/openings-*.status.json; do
    [[ -r "${status_path}" ]] || continue
    if jq -e --arg scheduled_at "${SCHEDULED_AT}" '
      def normalize_scheduled_at: sub("\\.[0-9]+Z$"; "Z");
      .date as $date
      | .completedAt as $completed_at
      | (.scheduledAt | type == "string")
        and ((.scheduledAt | normalize_scheduled_at) == ($scheduled_at | normalize_scheduled_at))
        and ($date | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$"))
        and ($completed_at | type == "string" and startswith($date))
    ' "${status_path}" >/dev/null; then
      printf '%s\n' "${status_path}"
      return 0
    fi
  done

  printf 'lab-openings-scheduled: missing status artifact for scheduled_at=%s under %s\n' \
    "${SCHEDULED_AT}" "${MARKET_DIR}" >&2
  return 1
}

start_payload="$(jq -cn \
  --arg task "jobsradar" \
  --arg substrate "mac" \
  --arg scheduled_at "${SCHEDULED_AT}" \
  '{task: $task, substrate: $substrate, scheduled_at: $scheduled_at, started_at: $scheduled_at}')"

finish_beacon() {
  local exit_status=$?
  local patch_response
  local patch_status
  local finish_payload
  local notes
  local patch_url
  trap - EXIT
  notes="$(scheduled_run_notes \
    "${scanner_status}" "${signals_status}" "${parity_status}" "${publication_status}" "${report_status}")"
  finish_payload="$(jq -cn \
    --arg finished_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson exit_status "${exit_status}" \
    --arg notes "${notes}" \
    '{finished_at: $finished_at, exit_status: $exit_status, notes: $notes}')"
  if [[ -n "${beacon_run_id}" ]]; then
    patch_url="${SUPABASE_URL}/rest/v1/runs?id=eq.${beacon_run_id}"
  else
    patch_url="${SUPABASE_URL}/rest/v1/runs?${BEACON_FILTER}"
  fi
  set +e
  patch_response="$(curl --fail-with-body --silent --show-error \
    -X PATCH "${patch_url}" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" \
    -H "${AUTHORIZATION}" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    --data "${finish_payload}")"
  patch_status=$?
  if ((patch_status == 0)); then
    jq -e --arg id "${beacon_run_id}" '
      type == "array"
      and length == 1
      and (.[0].id != null)
      and ($id == "" or (.[0].id | tostring) == $id)
    ' \
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

start_response="$(curl --fail-with-body --silent --show-error \
  -X POST "${SUPABASE_URL}/rest/v1/runs" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "${AUTHORIZATION}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  --data "${start_payload}")"
beacon_run_id="$(jq -er 'if type == "array" and length == 1 then .[0].id else error("expected one run row") end | select(. != null)' <<<"${start_response}")"

set +e
(cd "${PROJECT_DIR}" && PATH="/opt/homebrew/bin:${PATH}" "${BUN_BIN}" run labs:openings -- record --scheduled-at "${SCHEDULED_AT}")
scanner_status=$?
set -e

set +e
status_path="$(find_scheduled_status_path)"
status_lookup_status=$?
if ((status_lookup_status == 0)); then
  run_date="$(jq -er '.date | strings | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$"))' "${status_path}")"
  artifact_status=$?
  if ((artifact_status == 0)); then
    resolve_openings_artifacts "${MARKET_DIR}" "${run_date}"
    artifact_status=$?
  fi
else
  artifact_status=${status_lookup_status}
fi
set -e
if ((artifact_status == 0)); then
  publication_status="$(jq -r '.publication // "unknown"' "${OPENINGS_STATUS_PATH}")"
  published_run_id="$(jq -r '.publishedRunId // ""' "${OPENINGS_STATUS_PATH}")"
  openings_count="$(jq -s 'length' "${OPENINGS_JSONL_PATH}")"
  ids_payload="$(jq -r '[.org, .ats, .id] | if all(.[]; type == "string" and length > 0) then join(":") else error("org, ats, and id must be non-empty strings") end' "${OPENINGS_JSONL_PATH}" | LC_ALL=C sort)"
  ids_sha256="$(printf '%s' "${ids_payload}" | shasum -a 256 | cut -d ' ' -f 1)"

  parity_payload="$(jq -cn \
    --arg run_date "${run_date}" \
    --arg substrate "mac" \
    --arg run_id "${OPENINGS_RUN_ID}" \
    --argjson openings_count "${openings_count}" \
    --arg ids_sha256 "${ids_sha256}" \
    --arg targets_sha256 "${OPENINGS_TARGETS_SHA256}" \
    '{run_date: $run_date, substrate: $substrate, run_id: $run_id, openings_count: $openings_count, ids_sha256: $ids_sha256, targets_sha256: $targets_sha256}')"
  if should_publish_parity \
    "${scanner_status}" "${publication_status}" "${published_run_id}" "${OPENINGS_RUN_ID}"; then
    parity_status=0
    curl --fail-with-body --silent --show-error \
      -X POST "${SUPABASE_URL}/rest/v1/parity_runs?on_conflict=run_date%2Csubstrate%2Crun_id" \
      -H "apikey: ${SUPABASE_SERVICE_KEY}" \
      -H "${AUTHORIZATION}" \
      -H "Content-Type: application/json" \
      -H "Accept-Profile: careers" \
      -H "Content-Profile: careers" \
      -H "Prefer: resolution=merge-duplicates,return=minimal" \
      --data "${parity_payload}" || parity_status=$?
  else
    printf 'lab-openings-scheduled: parity skipped for scanner=%d publication=%s published_run_id=%s run_id=%s\n' \
      "${scanner_status}" "${publication_status}" "${published_run_id}" "${OPENINGS_RUN_ID}" >&2
  fi
else
  if ((scanner_status == 0)); then
    scanner_status="${artifact_status}"
  fi
  publication_status="artifact_unavailable"
  printf 'lab-openings-scheduled: artifact resolution failed with status %d; parity skipped\n' \
    "${artifact_status}" >&2
fi

signals_status=0
(cd "${PROJECT_DIR}" && PATH="/opt/homebrew/bin:${HOME}/.local/bin:${PATH}" "${BUN_BIN}" run company:signals) || signals_status=$?

if ((scanner_status == 0 && signals_status == 0 && parity_status == 0)); then
  report_status=0
  (
    cd "${PROJECT_DIR}" &&
      PATH="/opt/homebrew/bin:${HOME}/.local/bin:${PATH}" \
        "${OPPS_BIN}" list \
          --refresh-direct \
          --refresh-jobserve \
          --strict-source-health \
          --quiet
  ) || report_status=$?
else
  printf 'lab-openings-scheduled: daily report skipped for scanner=%d signals=%d parity=%d\n' \
    "${scanner_status}" "${signals_status}" "${parity_status}" >&2
fi

exit "$(scheduled_effective_exit_status \
  "${scanner_status}" "${signals_status}" "${parity_status}" "${report_status}")"
