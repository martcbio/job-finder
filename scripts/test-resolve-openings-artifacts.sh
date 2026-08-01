#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/resolve-openings-artifacts.sh
source "${SCRIPT_DIR}/lib/resolve-openings-artifacts.sh"

fixture_dir="$(mktemp -d)"
trap 'rm -rf "${fixture_dir}"' EXIT

run_date="2026-07-16"
run_id="degraded-run"
status_path="${fixture_dir}/openings-${run_date}.status.json"
generation_path="${fixture_dir}/lab-openings/runs/${run_id}/openings.jsonl"
mkdir -p "$(dirname "${generation_path}")"
printf '%s\n' '{"cursor":{"ats":null,"company":"Cursor / Anysphere"},"anthropic":{"ats":"greenhouse","company":"Anthropic"}}' >"${fixture_dir}/targets.json"
printf '{"runId":"%s","health":"degraded"}\n' "${run_id}" >"${status_path}"
printf '%s\n' '{"org":"openai","ats":"ashby","id":"generation"}' >"${generation_path}"

resolve_openings_artifacts "${fixture_dir}" "${run_date}"
[[ "${OPENINGS_STATUS_PATH}" == "${status_path}" ]]
[[ "${OPENINGS_JSONL_PATH}" == "${generation_path}" ]]
[[ "${OPENINGS_RUN_ID}" == "${run_id}" ]]
[[ "${OPENINGS_TARGETS_SHA256}" == "c344ef949e7b5268a4dc322af671b8097d13eb4079df4f972c356c0f67ac2b77" ]]

date_path="${fixture_dir}/openings-${run_date}.jsonl"
printf '%s\n' '{"org":"openai","ats":"ashby","id":"date"}' >"${date_path}"
resolve_openings_artifacts "${fixture_dir}" "${run_date}"
[[ "${OPENINGS_JSONL_PATH}" == "${generation_path}" ]]

printf 'resolve-openings-artifacts: ok\n'
