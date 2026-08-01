#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
fixture_dir="$(mktemp -d)"
trap 'rm -rf "${fixture_dir}"' EXIT

fake_bin="${fixture_dir}/bin"
project_dir="${fixture_dir}/careers/resume2/projects/job-finder-cursor-party"
market_dir="${fixture_dir}/careers/market"
home_dir="${fixture_dir}/home"
call_log="${fixture_dir}/calls.log"
output_path="${fixture_dir}/scheduled-output.log"
mkdir -p "${fake_bin}" "${home_dir}/.config"

prepare_project_and_market() {
  local selected_project_dir="$1"
  local selected_market_dir="$2"
  mkdir -p "${selected_project_dir}" "${selected_market_dir}"
  printf '%s\n' '{"openai":{"ats":"ashby","company":"OpenAI"}}' >"${selected_market_dir}/targets.json"
}

prepare_project_and_market "${project_dir}" "${market_dir}"
printf '%s\n' 'SUPABASE_URL=https://control-plane.example.test' 'SUPABASE_SERVICE_KEY=test-key' \
  >"${home_dir}/.config/estate-control-plane.env"

printf '%s\n' \
  '#!/bin/sh' \
  'printf "%s|%s\\n" "$PWD" "$*" >> "$CALL_LOG"' \
  'if [ "$2" = "labs:openings" ] && [ -n "${SCHEDULED_TEST_PUBLICATION:-}" ]; then' \
  '  run_date="${SCHEDULED_TEST_COMPLETED_DATE:-2026-08-02}"' \
  '  scheduled_at="${SCHEDULED_TEST_AT:-2026-08-01T23:59:59Z}"' \
  '  writer_scheduled_at="${scheduled_at%Z}.000Z"' \
  '  find_market_dir() {' \
  '    ancestor="$(cd "$1" && pwd)"' \
  '    [ -n "${ancestor}" ] || return 1' \
  '    while :; do' \
  '      if [ -f "${ancestor}/market/targets.json" ] && [ -r "${ancestor}/market/targets.json" ]; then printf "%s\\n" "${ancestor}/market"; return 0; fi' \
  '      parent="$(dirname "${ancestor}")"' \
  '      [ "${parent}" != "${ancestor}" ] || return 1' \
  '      ancestor="${parent}"' \
  '    done' \
  '  }' \
  '  if [ -n "${CAREERS_MARKET_DIR:-}" ]; then' \
  '    market_dir="${CAREERS_MARKET_DIR}"' \
  '  else' \
  '    market_dir="$(find_market_dir "${CAREERS_PROJECT_DIR}")"' \
  '    market_status=$?' \
  '    [ "${market_status}" -eq 0 ] || exit "${market_status}"' \
  '  fi' \
  '  mkdir -p "${market_dir}/lab-openings/runs/blocked-run"' \
  '  printf "%s\\n" "{\"openai\":{\"ats\":\"ashby\",\"company\":\"OpenAI\"}}" > "${market_dir}/targets.json"' \
  '  published_run_id=""' \
  '  if [ "$SCHEDULED_TEST_PUBLICATION" = "complete" ]; then published_run_id="blocked-run"; fi' \
  '  printf "{\"date\":\"%s\",\"runId\":\"blocked-run\",\"publication\":\"%s\",\"publishedRunId\":\"%s\",\"scheduledAt\":\"%s\",\"completedAt\":\"%sT00:00:01Z\"}\\n" "$run_date" "$SCHEDULED_TEST_PUBLICATION" "$published_run_id" "$writer_scheduled_at" "$run_date" > "${market_dir}/openings-${run_date}.status.json"' \
  '  printf "%s\\n" "{\"org\":\"openai\",\"ats\":\"ashby\",\"id\":\"job-1\"}" > "${market_dir}/lab-openings/runs/blocked-run/openings.jsonl"' \
  'fi' \
  'exit 0' \
  >"${fake_bin}/bun"
printf '%s\n' \
  '#!/bin/sh' \
  'printf "curl|%s\\n" "$*" >> "$CALL_LOG"' \
  'case "$*" in' \
  '  *"-X POST https://control-plane.example.test/rest/v1/runs"*)' \
  '    case "${CURL_START_MODE:-ok}" in' \
  '      invalid_response) printf "%s\\n" "[{\"unexpected\":true}]" ;;' \
  '      fetch_failure) printf "%s\\n" "[{\"id\":\"beacon-1\"}]"; exit 22 ;;' \
  '      *) printf "%s\\n" "[{\"id\":\"beacon-1\"}]" ;;' \
  '    esac ;;' \
  '  *"-X PATCH https://control-plane.example.test/rest/v1/runs"*) printf "%s\\n" "[{\"id\":\"beacon-1\"}]" ;;' \
  '  *) printf "%s\\n" "[]" ;;' \
  'esac' \
  >"${fake_bin}/curl"
printf '%s\n' \
  '#!/bin/sh' \
  'case "$*" in' \
  '  *"+%Y-%m-%dT%H:%M:%SZ"*) printf "%s\\n" "${SCHEDULED_TEST_AT:-2026-08-01T23:59:59Z}" ;;' \
  '  *) exec /bin/date "$@" ;;' \
  'esac' \
  >"${fake_bin}/date"
printf '%s\n' '#!/bin/sh' 'exit 0' >"${fake_bin}/opps"
chmod 700 "${fake_bin}/bun" "${fake_bin}/curl" "${fake_bin}/date" "${fake_bin}/opps"

set +e
env -u CAREERS_MARKET_DIR \
  HOME="${home_dir}" \
  PATH="${fake_bin}:${PATH}" \
  CALL_LOG="${call_log}" \
  CAREERS_PROJECT_DIR="${project_dir}" \
  CAREERS_BUN_BIN="${fake_bin}/bun" \
  bash "${SCRIPT_DIR}/lab-openings-scheduled.sh" >"${output_path}" 2>&1
exit_status=$?
set -e

[[ "${exit_status}" == "1" ]]
rg -Fq "${project_dir}|run labs:openings" "${call_log}"
rg -Fq "${project_dir}|run company:signals" "${call_log}"
rg -Fq "under ${market_dir}" "${output_path}"
[[ ! -e "${project_dir}/market/openings-2026-08-02.status.json" ]]
rg -q 'artifact resolution failed with status 1; parity skipped' "${output_path}"
rg -q 'daily report skipped for scanner=1 signals=0 parity=-1' "${output_path}"

run_blocked_publication_case() {
  local publication_status="$1"
  local case_dir="${fixture_dir}/${publication_status}"
  local case_project_dir="${case_dir}/careers/resume2/projects/job-finder-cursor-party"
  local case_market_dir="${case_dir}/careers/market"
  local case_call_log="${case_dir}/calls.log"
  local case_output_path="${case_dir}/scheduled-output.log"
  local case_exit_status
  prepare_project_and_market "${case_project_dir}" "${case_market_dir}"

  set +e
  env -u CAREERS_MARKET_DIR \
    HOME="${home_dir}" \
    PATH="${fake_bin}:${PATH}" \
    CALL_LOG="${case_call_log}" \
    CAREERS_PROJECT_DIR="${case_project_dir}" \
    CAREERS_BUN_BIN="${fake_bin}/bun" \
    CAREERS_OPPS_BIN="${fake_bin}/opps" \
    SCHEDULED_TEST_AT="2026-08-01T23:59:59Z" \
    SCHEDULED_TEST_COMPLETED_DATE="2026-08-02" \
    SCHEDULED_TEST_PUBLICATION="${publication_status}" \
    bash "${SCRIPT_DIR}/lab-openings-scheduled.sh" >"${case_output_path}" 2>&1
  case_exit_status=$?
  set -e

  if [[ "${case_exit_status}" != "1" ]]; then
    printf 'expected publication=%s to exit 1, got %s\n' \
      "${publication_status}" "${case_exit_status}" >&2
    exit 1
  fi
  rg -Fq "${case_project_dir}|run labs:openings" "${case_call_log}"
  rg -Fq "${case_project_dir}|run company:signals" "${case_call_log}"
  [[ -e "${case_market_dir}/openings-2026-08-02.status.json" ]]
  [[ ! -e "${case_project_dir}/market/openings-2026-08-02.status.json" ]]
  rg -q "parity skipped for scanner=0 publication=${publication_status}" "${case_output_path}"
  rg -q 'daily report skipped for scanner=0 signals=0 parity=-1' "${case_output_path}"
}

run_complete_midnight_case() {
  local case_dir="${fixture_dir}/complete"
  local case_project_dir="${case_dir}/careers/resume2/projects/job-finder-cursor-party"
  local case_market_dir="${case_dir}/careers/market"
  local case_call_log="${case_dir}/calls.log"
  local case_output_path="${case_dir}/scheduled-output.log"
  local case_exit_status
  prepare_project_and_market "${case_project_dir}" "${case_market_dir}"

  set +e
  env -u CAREERS_MARKET_DIR \
    HOME="${home_dir}" \
    PATH="${fake_bin}:${PATH}" \
    CALL_LOG="${case_call_log}" \
    CAREERS_PROJECT_DIR="${case_project_dir}" \
    CAREERS_BUN_BIN="${fake_bin}/bun" \
    CAREERS_OPPS_BIN="${fake_bin}/opps" \
    SCHEDULED_TEST_AT="2026-08-01T23:59:59Z" \
    SCHEDULED_TEST_COMPLETED_DATE="2026-08-02" \
    SCHEDULED_TEST_PUBLICATION="complete" \
    bash "${SCRIPT_DIR}/lab-openings-scheduled.sh" >"${case_output_path}" 2>&1
  case_exit_status=$?
  set -e

  if [[ "${case_exit_status}" != "0" ]]; then
    printf 'expected complete midnight publication to exit 0, got %s\n' "${case_exit_status}" >&2
    exit 1
  fi
  rg -Fq "${case_project_dir}|run labs:openings" "${case_call_log}"
  [[ -e "${case_market_dir}/openings-2026-08-02.status.json" ]]
  [[ ! -e "${case_project_dir}/market/openings-2026-08-02.status.json" ]]
  rg -Fq '/rest/v1/parity_runs?' "${case_call_log}"
  rg -Fq '"run_date":"2026-08-02"' "${case_call_log}"
  if rg -Fq '"run_date":"2026-08-01"' "${case_call_log}"; then
    printf 'parity payload used the stale scheduled date\n' >&2
    exit 1
  fi
}

run_planned_checkout_case() {
  local case_dir="${fixture_dir}/planned-checkout"
  local case_project_dir="${case_dir}/careers/jobsradar"
  local case_market_dir="${case_dir}/careers/market"
  local case_call_log="${case_dir}/calls.log"
  local case_output_path="${case_dir}/scheduled-output.log"
  local case_exit_status
  prepare_project_and_market "${case_project_dir}" "${case_market_dir}"

  set +e
  HOME="${home_dir}" \
    PATH="${fake_bin}:${PATH}" \
    CALL_LOG="${case_call_log}" \
    CAREERS_PROJECT_DIR="${case_project_dir}" \
    CAREERS_MARKET_DIR="" \
    CAREERS_BUN_BIN="${fake_bin}/bun" \
    CAREERS_OPPS_BIN="${fake_bin}/opps" \
    SCHEDULED_TEST_AT="2026-08-01T23:59:59Z" \
    SCHEDULED_TEST_COMPLETED_DATE="2026-08-02" \
    SCHEDULED_TEST_PUBLICATION="complete" \
    bash "${SCRIPT_DIR}/lab-openings-scheduled.sh" >"${case_output_path}" 2>&1
  case_exit_status=$?
  set -e

  if [[ "${case_exit_status}" != "0" ]]; then
    printf 'expected planned checkout to exit 0, got %s\n' "${case_exit_status}" >&2
    exit 1
  fi
  [[ -e "${case_market_dir}/openings-2026-08-02.status.json" ]]
  rg -Fq "${case_project_dir}|run labs:openings" "${case_call_log}"
}

run_explicit_market_override_case() {
  local case_dir="${fixture_dir}/explicit-market"
  local case_project_dir="${case_dir}/careers/resume2/projects/job-finder-cursor-party"
  local case_market_dir="${case_dir}/override-market"
  local default_market_dir="${case_dir}/careers/market"
  local case_call_log="${case_dir}/calls.log"
  local case_output_path="${case_dir}/scheduled-output.log"
  local case_exit_status
  prepare_project_and_market "${case_project_dir}" "${case_market_dir}"

  set +e
  HOME="${home_dir}" \
    PATH="${fake_bin}:${PATH}" \
    CALL_LOG="${case_call_log}" \
    CAREERS_PROJECT_DIR="${case_project_dir}" \
    CAREERS_MARKET_DIR="${case_market_dir}" \
    CAREERS_BUN_BIN="${fake_bin}/bun" \
    CAREERS_OPPS_BIN="${fake_bin}/opps" \
    SCHEDULED_TEST_AT="2026-08-01T23:59:59Z" \
    SCHEDULED_TEST_COMPLETED_DATE="2026-08-02" \
    SCHEDULED_TEST_PUBLICATION="complete" \
    bash "${SCRIPT_DIR}/lab-openings-scheduled.sh" >"${case_output_path}" 2>&1
  case_exit_status=$?
  set -e

  if [[ "${case_exit_status}" != "0" ]]; then
    printf 'expected explicit market override to exit 0, got %s\n' "${case_exit_status}" >&2
    exit 1
  fi
  [[ -e "${case_market_dir}/openings-2026-08-02.status.json" ]]
  [[ ! -e "${default_market_dir}/openings-2026-08-02.status.json" ]]
  rg -Fq "${case_project_dir}|run labs:openings" "${case_call_log}"
}

run_missing_market_case() {
  local case_dir="${fixture_dir}/missing-market"
  local case_project_dir="${case_dir}/careers/resume2/projects/jobsradar"
  local case_call_log="${case_dir}/calls.log"
  local case_output_path="${case_dir}/scheduled-output.log"
  local case_exit_status
  mkdir -p "${case_project_dir}"

  set +e
  env -u CAREERS_MARKET_DIR \
    HOME="${home_dir}" \
    PATH="${fake_bin}:${PATH}" \
    CALL_LOG="${case_call_log}" \
    CAREERS_PROJECT_DIR="${case_project_dir}" \
    CAREERS_BUN_BIN="${fake_bin}/bun" \
    bash "${SCRIPT_DIR}/lab-openings-scheduled.sh" >"${case_output_path}" 2>&1
  case_exit_status=$?
  set -e

  if [[ "${case_exit_status}" == "0" ]]; then
    printf 'expected missing market marker to fail\n' >&2
    exit 1
  fi
  rg -Fq 'cannot find market/targets.json from project directory' "${case_output_path}"
  [[ ! -e "${case_call_log}" ]]
}

run_fake_bun_discovery_failure_case() {
  local case_dir="${fixture_dir}/fake-bun-missing-market"
  local case_project_dir="${case_dir}/careers/jobsradar"
  local case_call_log="${case_dir}/calls.log"
  local case_output_path="${case_dir}/fake-bun-output.log"
  local case_exit_status
  mkdir -p "${case_project_dir}"

  set +e
  env -u CAREERS_MARKET_DIR \
    CALL_LOG="${case_call_log}" \
    CAREERS_PROJECT_DIR="${case_project_dir}" \
    SCHEDULED_TEST_PUBLICATION="complete" \
    "${fake_bin}/bun" run labs:openings >"${case_output_path}" 2>&1
  case_exit_status=$?
  set -e

  if [[ "${case_exit_status}" == "0" ]]; then
    printf 'expected fake bun marker discovery to fail\n' >&2
    exit 1
  fi
  [[ ! -e "${case_project_dir}/market/openings-2026-08-02.status.json" ]]
}

run_beacon_recovery_case() {
  local start_mode="$1"
  local case_dir="${fixture_dir}/beacon-${start_mode}"
  local case_project_dir="${case_dir}/careers/resume2/projects/job-finder-cursor-party"
  local case_market_dir="${case_dir}/careers/market"
  local case_call_log="${case_dir}/calls.log"
  local case_output_path="${case_dir}/scheduled-output.log"
  local case_exit_status
  prepare_project_and_market "${case_project_dir}" "${case_market_dir}"

  set +e
  env -u CAREERS_MARKET_DIR \
    HOME="${home_dir}" \
    PATH="${fake_bin}:${PATH}" \
    CALL_LOG="${case_call_log}" \
    CAREERS_PROJECT_DIR="${case_project_dir}" \
    CAREERS_BUN_BIN="${fake_bin}/bun" \
    CURL_START_MODE="${start_mode}" \
    SCHEDULED_TEST_AT="2026-08-01T23:59:59Z" \
    bash "${SCRIPT_DIR}/lab-openings-scheduled.sh" >"${case_output_path}" 2>&1
  case_exit_status=$?
  set -e

  if [[ "${case_exit_status}" == "0" ]]; then
    printf 'expected beacon start mode=%s to fail\n' "${start_mode}" >&2
    exit 1
  fi
  rg -Fq -- '-X POST https://control-plane.example.test/rest/v1/runs' "${case_call_log}"
  rg -Fq -- '-X PATCH https://control-plane.example.test/rest/v1/runs?task=eq.jobsradar&substrate=eq.mac&scheduled_at=eq.2026-08-01T23%3A59%3A59Z' \
    "${case_call_log}"
  if rg -Fq '|run labs:openings' "${case_call_log}"; then
    printf 'scanner ran after beacon start mode=%s failed\n' "${start_mode}" >&2
    exit 1
  fi
}

run_blocked_publication_case locked
run_blocked_publication_case prepublish
run_complete_midnight_case
run_planned_checkout_case
run_explicit_market_override_case
run_missing_market_case
run_fake_bun_discovery_failure_case
run_beacon_recovery_case invalid_response
run_beacon_recovery_case fetch_failure

printf 'lab-openings-scheduled: ok\n'
