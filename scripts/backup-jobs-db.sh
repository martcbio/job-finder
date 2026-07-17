#!/usr/bin/env bash
# Nightly pg_dump of the local jobs DB with a control-plane beacon.
set -euo pipefail

BACKUP_DIR="${HOME}/Claudelocal/careers/market/backups"
KEEP=14
mkdir -p "${BACKUP_DIR}"

ENV_FILE="${HOME}/.config/estate-control-plane.env"
set -a; source "${ENV_FILE}"; set +a
: "${SUPABASE_URL:?}" "${SUPABASE_SERVICE_KEY:?}"
SUPABASE_URL="${SUPABASE_URL%/}"

beacon() { # exit_status
  curl --silent --fail -X POST "${SUPABASE_URL}/rest/v1/runs" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
    -H "Content-Type: application/json" -H "Prefer: return=minimal" \
    --data "{\"task\":\"jobs-db-backup\",\"substrate\":\"mac\",\"started_at\":\"${STARTED}\",\"finished_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"exit_status\":${1}}" || true
}

STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OUT="${BACKUP_DIR}/jobs-$(date +%Y-%m-%d).dump"
if /opt/homebrew/bin/pg_dump --format=custom --file="${OUT}" "postgres://mcb@localhost:5432/jobs"; then
  ls -t "${BACKUP_DIR}"/jobs-*.dump | tail -n +$((KEEP + 1)) | xargs rm -f 2>/dev/null || true
  beacon 0
else
  rc=$?
  beacon "${rc}"
  exit "${rc}"
fi
