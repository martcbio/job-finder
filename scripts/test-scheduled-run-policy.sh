#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/scheduled-run-policy.sh
source "${SCRIPT_DIR}/lib/scheduled-run-policy.sh"

notes="$(scheduled_run_notes 0 17 0 complete 23)"
jq -e '.scanner_status == 0 and .company_signals_status == 17 and .parity_status == 0 and .daily_report_status == 23' \
  <<<"${notes}" >/dev/null
[[ "$(scheduled_effective_exit_status 0 0 0 0)" == "0" ]]
[[ "$(scheduled_effective_exit_status 9 0 0 0)" == "9" ]]
[[ "$(scheduled_effective_exit_status 0 17 0 0)" == "17" ]]
[[ "$(scheduled_effective_exit_status 0 0 22 0)" == "22" ]]
[[ "$(scheduled_effective_exit_status 0 0 -1 0)" == "1" ]]
[[ "$(scheduled_effective_exit_status 0 0 0 23)" == "23" ]]
should_publish_parity 0 complete scanner-run scanner-run
if should_publish_parity 1 complete scanner-run scanner-run; then
  printf 'should not publish parity when the scanner failed\n' >&2
  exit 1
fi
if should_publish_parity 0 complete published-run scanner-run; then
  printf 'should not publish parity for a mismatched published run id\n' >&2
  exit 1
fi
for publication in retained locked prepublish; do
  if should_publish_parity 0 "${publication}" scanner-run scanner-run; then
    printf 'should not publish parity for publication=%s\n' "${publication}" >&2
    exit 1
  fi
done
if should_publish_parity 0 locked '' scanner-run; then
  printf 'should not publish parity without a published run id\n' >&2
  exit 1
fi

printf 'scheduled-run-policy: ok\n'
