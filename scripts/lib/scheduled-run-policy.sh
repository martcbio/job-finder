#!/usr/bin/env bash

scheduled_run_notes() {
  local scanner_status="${1:?scanner status is required}"
  local signals_status="${2:?signals status is required}"
  local parity_status="${3:?parity status is required}"
  local publication_status="${4:?publication status is required}"
  local report_status="${5:?report status is required}"

  jq -cn \
    --argjson scanner_status "${scanner_status}" \
    --argjson signals_status "${signals_status}" \
    --argjson parity_status "${parity_status}" \
    --arg publication "${publication_status}" \
    --argjson report_status "${report_status}" \
    '{scanner_status: $scanner_status, company_signals_status: $signals_status, parity_status: $parity_status, publication: $publication, daily_report_status: $report_status}'
}

should_publish_parity() {
  local scanner_status="${1:?scanner status is required}"
  local publication_status="${2:?publication status is required}"
  local published_run_id="${3:?published run id is required}"
  local run_id="${4:?run id is required}"

  ((scanner_status == 0)) &&
    [[ "${publication_status}" == "complete" ]] &&
    [[ "${published_run_id}" == "${run_id}" ]]
}

scheduled_effective_exit_status() {
  local scanner_status="${1:?scanner status is required}"
  local signals_status="${2:?signals status is required}"
  local parity_status="${3:?parity status is required}"
  local report_status="${4:?report status is required}"

  if ((scanner_status != 0)); then
    printf '%d\n' "${scanner_status}"
  elif ((signals_status != 0)); then
    printf '%d\n' "$((signals_status > 0 ? signals_status : 1))"
  elif ((parity_status != 0)); then
    printf '%d\n' "$((parity_status > 0 ? parity_status : 1))"
  elif ((report_status != 0)); then
    printf '%d\n' "$((report_status > 0 ? report_status : 1))"
  else
    printf '0\n'
  fi
}
