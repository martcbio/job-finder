#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/scheduled-run-policy.sh
source "${SCRIPT_DIR}/lib/scheduled-run-policy.sh"

notes="$(scheduled_run_notes 0 17 0 complete)"
jq -e '.scanner_status == 0 and .company_signals_status == 17 and .parity_status == 0' \
  <<<"${notes}" >/dev/null
[[ "$(scheduled_effective_exit_status 0 0)" == "0" ]]
[[ "$(scheduled_effective_exit_status 9 0)" == "9" ]]
[[ "$(scheduled_effective_exit_status 0 22)" == "22" ]]
should_publish_parity 0 complete scanner-run scanner-run
! should_publish_parity 0 retained old-run scanner-run

printf 'scheduled-run-policy: ok\n'
