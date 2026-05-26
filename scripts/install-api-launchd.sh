#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$ROOT/scripts/com.mcb.job-finder-api.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.mcb.job-finder-api.plist"
LABEL="com.mcb.job-finder-api"

cp "$PLIST_SRC" "$PLIST_DST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed $LABEL"
echo "API: http://127.0.0.1:3737/api"
echo "Logs: ~/Library/Logs/job-finder-api.{out,err}.log"
