#!/usr/bin/env bash

resolve_openings_artifacts() {
  local market_dir="${1:?market directory is required}"
  local run_date="${2:?run date is required}"
  local status_path="${market_dir}/openings-${run_date}.status.json"
  local targets_path="${market_dir}/targets.json"
  local jsonl_path
  local run_id

  if [[ ! -r "${status_path}" ]]; then
    printf 'resolve-openings-artifacts: missing status artifact: %s\n' "${status_path}" >&2
    return 1
  fi

  run_id="$(jq -er '.runId | strings | select(length > 0)' "${status_path}")" || {
    printf 'resolve-openings-artifacts: status has no valid runId: %s\n' "${status_path}" >&2
    return 1
  }

  jsonl_path="${market_dir}/lab-openings/runs/${run_id}/openings.jsonl"
  if [[ ! -r "${jsonl_path}" ]]; then
    printf 'resolve-openings-artifacts: missing JSONL artifact for run %s: %s\n' \
      "${run_id}" "${jsonl_path}" >&2
    return 1
  fi
  if [[ ! -r "${targets_path}" ]]; then
    printf 'resolve-openings-artifacts: missing targets artifact: %s\n' "${targets_path}" >&2
    return 1
  fi

  OPENINGS_STATUS_PATH="${status_path}"
  OPENINGS_JSONL_PATH="${jsonl_path}"
  OPENINGS_RUN_ID="${run_id}"
  OPENINGS_TARGETS_SHA256="$(
    jq -er 'to_entries[] | [.key, .value.ats, .value.company] | if all(.[]; type == "string" and length > 0) then join(":") else error("target entries require org, ats, and company") end' \
      "${targets_path}" |
      LC_ALL=C sort |
      awk 'BEGIN { first=1 } { if (!first) printf "\n"; printf "%s", $0; first=0 }' |
      shasum -a 256 |
      cut -d ' ' -f 1
  )"
}
