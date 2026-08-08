# Scheduled Fast Refresh

Ongoing ingestion runs `scripts/scheduled-fast-refresh.sh` every 6 hours via a
launchd agent. The wrapper sources the login profile (for `JINA_API_KEY` /
`OPENROUTER_API_KEY`), defaults `DATABASE_URL` to the local `jobs` database,
skips cleanly when Postgres is down, and writes each run's markdown report to
`logs/scheduled/` (last 60 kept, `latest.md` symlink).

## Install (one-time)

```bash
./scripts/install-jobsradar-launchd.sh fast-refresh
```

## Operate

```bash
# run now, without waiting for the interval
launchctl kickstart gui/$(id -u)/com.mcb.jobsradar.fast-refresh

# check last run
cat logs/scheduled/latest.md

# uninstall
launchctl bootout gui/$(id -u)/com.mcb.jobsradar.fast-refresh
rm ~/Library/LaunchAgents/com.mcb.jobsradar.fast-refresh.plist
```

The run uses the default `bun scripts/fast-refresh.ts` profile: three JobServe
queries (2 pages, 5 imports per query) plus the other default direct sources,
then classification of up to 250 pending jobs. It next live-verifies the 30
highest-ranked current opportunities. Dead URLs move safe queue states to
`stale`; protected states receive a durable `source_url_dead` flag instead.
JobServe checks are paced at 1.5 seconds. Failed runs are kept as `*.failed.md`
and exit non-zero so launchd records the failure.
