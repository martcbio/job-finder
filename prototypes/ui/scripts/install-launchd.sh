#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$ROOT/scripts/com.mcb.job-finder-ui.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.mcb.job-finder-ui.plist"
LABEL="com.mcb.job-finder-ui"

case "$ROOT" in
  /Users/mcb/Claudelocal/careers/*) ;;
  *) echo "refusing: installer must run from the canonical careers tree, got $ROOT" >&2; exit 1 ;;
esac
echo "About to bootout+restart launchd agent $LABEL from $ROOT"
read -r -p "Type 'install' to continue: " ANSWER
[[ "$ANSWER" == "install" ]] || { echo "aborted" >&2; exit 1; }

cp "$PLIST_SRC" "$PLIST_DST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed $LABEL"
echo "URL: https://job-finder.test:8443/ (or https://job-finder.auto.test:8443/)"
echo "Logs: ~/Library/Logs/job-finder-ui.{out,err}.log"
