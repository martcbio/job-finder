#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="all"
TARGET_SET=0
ASSUME_YES=0
readonly BUN_EXECUTABLE="$(command -v bun)"
CODEX_EXECUTABLE=""
GIT_EXECUTABLE=""

usage() {
  printf 'usage: %s [--yes] [api|ui|fast-refresh|doctor|all]\n' "$0" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)
      ASSUME_YES=1
      ;;
    api|ui|fast-refresh|doctor|all)
      if [[ "$TARGET_SET" -eq 1 ]]; then
        usage
        exit 2
      fi
      TARGET="$1"
      TARGET_SET=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
  shift
done

if [[ "${TARGET}" == "doctor" ]]; then
  CODEX_EXECUTABLE="$(command -v codex)"
  GIT_EXECUTABLE="$(command -v git)"
fi

install_agent() {
  local component="$1"
  local template="$2"
  local label="$3"
  local retired_label="$4"
  local destination="${HOME}/Library/LaunchAgents/${label}.plist"
  local retired_destination="${HOME}/Library/LaunchAgents/${retired_label}.plist"

  mkdir -p "${HOME}/Library/Logs"
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
if [[ "$ASSUME_YES" -eq 0 ]]; then
  read -r -p "Type 'install' to continue: " answer
  [[ "${answer}" == "install" ]] || { printf 'aborted\n' >&2; exit 1; }
fi

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
  mkdir -p "${ROOT}/logs/scheduled"
  install_agent \
    "fast refresh" \
    "${ROOT}/launchd/com.mcb.jobsradar.fast-refresh.plist.template" \
    "com.mcb.jobsradar.fast-refresh" \
    "com.mcb.job-finder.fast-refresh"
fi
if [[ "${TARGET}" == "doctor" ]]; then
  mkdir -p "${ROOT}/logs/doctor"
  chmod 700 "${ROOT}/logs/doctor"
  install_agent \
    "Doctor" \
    "${ROOT}/launchd/com.mcb.jobsradar.doctor.plist.template" \
    "com.mcb.jobsradar.doctor" \
    "com.mcb.job-finder.doctor"
fi
