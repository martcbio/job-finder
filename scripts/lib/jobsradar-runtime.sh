#!/bin/sh

# Shared runtime defaults for launchd and interactive Jobsradar entrypoints.
# Callers may supply DATABASE_URL, NO_PROXY, or no_proxy explicitly.

jobsradar_default_database_url() {
  jobsradar_runtime_user="${USER:-$(id -un)}"
  printf 'postgres://%s@localhost:5432/jobs\n' "$jobsradar_runtime_user"
}

jobsradar_configure_database_url() {
  if [ -z "${DATABASE_URL:-}" ]; then
    DATABASE_URL="$(jobsradar_default_database_url)"
  fi
  export DATABASE_URL
}

jobsradar_loopback_no_proxy() {
  jobsradar_runtime_no_proxy="${1:-}"
  for jobsradar_runtime_host in 127.0.0.1 localhost ::1; do
    case ",$jobsradar_runtime_no_proxy," in
      *",$jobsradar_runtime_host,"*) ;;
      *) jobsradar_runtime_no_proxy="${jobsradar_runtime_no_proxy:+$jobsradar_runtime_no_proxy,}$jobsradar_runtime_host" ;;
    esac
  done
  printf '%s\n' "$jobsradar_runtime_no_proxy"
}

jobsradar_configure_loopback_no_proxy() {
  NO_PROXY="$(jobsradar_loopback_no_proxy "${NO_PROXY:-}")"
  no_proxy="$(jobsradar_loopback_no_proxy "${no_proxy:-}")"
  export NO_PROXY no_proxy
}
