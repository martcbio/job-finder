#!/bin/bash
# Scheduled fast-refresh wrapper, run by launchd (com.mcb.jobsradar.fast-refresh).
# Reads the explicit control-plane environment; it does not require login-shell dotfiles.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/logs/scheduled"
KEEP_RUNS=60

CONTROL_PLANE_ENV="${HOME}/.config/estate-control-plane.env"
if [[ -r "$CONTROL_PLANE_ENV" ]]; then
  set -a
  source "$CONTROL_PLANE_ENV"
  set +a
fi

source "$PROJECT_DIR/scripts/lib/jobsradar-runtime.sh"
jobsradar_configure_database_url
jobsradar_configure_loopback_no_proxy

mkdir -p "$LOG_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$LOG_DIR/fast-refresh-$STAMP.md"

cd "$PROJECT_DIR"

if ! pg_isready -q; then
  echo "postgres not ready; skipping run" > "$OUT"
  exit 0
fi

if bun scripts/fast-refresh.ts > "$OUT" 2>&1 \
  && bun scripts/list-latest-opportunities.ts --quiet --limit 30 >> "$OUT" 2>&1; then
  ln -sf "$OUT" "$LOG_DIR/latest.md"
  # Refresh skill signals/clusters over whatever the run brought in.
  bun scripts/skill-clusters.ts > "$LOG_DIR/skill-clusters.md" 2>>"$LOG_DIR/skill-clusters.err.log" || true
else
  mv "$OUT" "${OUT%.md}.failed.md"
  ln -sf "${OUT%.md}.failed.md" "$LOG_DIR/latest.md"
  exit 1
fi

# Prune old run logs beyond the most recent $KEEP_RUNS.
/bin/ls -1t "$LOG_DIR"/fast-refresh-*.md 2>/dev/null | tail -n +$((KEEP_RUNS + 1)) | while read -r old; do
  rm -f "$old"
done
