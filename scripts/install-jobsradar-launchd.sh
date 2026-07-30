#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly CANONICAL_ROOT="${HOME:?HOME is required}/Claudelocal/careers/jobsradar"
readonly TARGET="${1:-all}"
readonly BUN_EXECUTABLE="$(command -v bun)"
readonly CODEX_EXECUTABLE="$(command -v codex)"
readonly GIT_EXECUTABLE="$(command -v git)"

if [[ "${ROOT}" != "${CANONICAL_ROOT}" ]]; then
  printf 'refusing: move the checkout to %s before installing services; current root is %s\n' \
    "${CANONICAL_ROOT}" "${ROOT}" >&2
  exit 1
fi

case "${TARGET}" in
  api|ui|fast-refresh|doctor|all) ;;
  *) printf 'usage: %s [api|ui|fast-refresh|doctor|all]\n' "$0" >&2; exit 2 ;;
esac

install_agent() {
  local component="$1"
  local template="$2"
  local label="$3"
  local retired_label="$4"
  local destination="${HOME}/Library/LaunchAgents/${label}.plist"
  local retired_destination="${HOME}/Library/LaunchAgents/${retired_label}.plist"

  "${BUN_EXECUTABLE}" "${ROOT}/scripts/render-jobsradar-launchd.ts" \
    "${template}" "${destination}" "${ROOT}" \
    "${CODEX_EXECUTABLE}" "${GIT_EXECUTABLE}" "${BUN_EXECUTABLE}"
  launchctl bootout "gui/$(id -u)/${retired_label}" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
  rm -f "${retired_destination}"
  launchctl bootstrap "gui/$(id -u)" "${destination}"
  launchctl enable "gui/$(id -u)/${label}"
  launchctl kickstart -k "gui/$(id -u)/${label}"
  printf 'installed jobsradar %s as %s\n' "${component}" "${label}"
}

printf 'This replaces retired job-finder launch agents with jobsradar agents from %s.\n' "${ROOT}"
read -r -p "Type 'install' to continue: " answer
[[ "${answer}" == "install" ]] || { printf 'aborted\n' >&2; exit 1; }

if [[ "${TARGET}" == "api" || "${TARGET}" == "all" ]]; then
  install_agent \
    "API" \
    "${ROOT}/scripts/com.mcb.jobsradar-api.plist.template" \
    "com.mcb.jobsradar-api" \
    "com.mcb.job-finder-api"
fi
if [[ "${TARGET}" == "ui" || "${TARGET}" == "all" ]]; then
  install_agent \
    "UI" \
    "${ROOT}/prototypes/ui/scripts/com.mcb.jobsradar-ui.plist.template" \
    "com.mcb.jobsradar-ui" \
    "com.mcb.job-finder-ui"
fi
if [[ "${TARGET}" == "fast-refresh" || "${TARGET}" == "all" ]]; then
  install_agent \
    "fast refresh" \
    "${ROOT}/launchd/com.mcb.jobsradar.fast-refresh.plist.template" \
    "com.mcb.jobsradar.fast-refresh" \
    "com.mcb.job-finder.fast-refresh"
fi
if [[ "${TARGET}" == "doctor" || "${TARGET}" == "all" ]]; then
  mkdir -p "${ROOT}/logs/doctor"
  install_agent \
    "Doctor" \
    "${ROOT}/launchd/com.mcb.jobsradar.doctor.plist.template" \
    "com.mcb.jobsradar.doctor" \
    "com.mcb.job-finder.doctor"
fi
