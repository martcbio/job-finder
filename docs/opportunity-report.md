# Opportunity list and CLI

The normal reading surface is the **Recent 50** view at
`https://jobsradar.test:8443/`. It calls `GET /api/opportunities`, which reads local
Postgres and the latest completed lab artifact without contacting external
sources. The CLI and API share the same loader and ranking implementation.

The installed wrapper works from any directory and supplies the local database
default:

```bash
opps update
opps open
```

Other useful commands:

```bash
opps list
opps json --limit 10
opps doctor
```

`opps update` performs the deterministic local raw update only: direct Lab ATS,
mandatory bounded JobServe contracts, Linear Careers, and Google Careers. It
does not use Modal, refresh bookmark signals, send email, or fall through from
Modal to a Mac scan. No source toggle is required for this normal update.

Without a refresh flag, this reads only the latest complete lab-opening
generation and stored JobServe rows. It does not contact JobServe.

## Legacy/manual lanes

```bash
bun run jobs:opportunities -- --refresh-cloud-labs # legacy/manual Modal lane
bun run jobs:opportunities -- --refresh-labs       # explicit local Lab ATS lane
```

These literal lower-level commands are non-default diagnostic or maintenance
lanes. The Modal command never falls through to the Mac scanner; the local Lab
ATS command is separately invoked. Neither changes the deterministic raw source
composition of normal `opps update`.

JobServe safety is enforced below the CLI: at most three queries, two result
pages per query, five detail pages per query, paced requests, and immediate
abort when the fair-usage restriction page appears.

## Legacy/manual artifact automation

```bash
bun run jobs:opportunities -- \
  --refresh-cloud-labs \
  --strict-source-health \
  --format json \
  --output artifacts/opportunities/latest.json
```

This is a non-default legacy/manual Modal artifact command; it does not fall back
to a Mac scan. `--strict-source-health` exits with status 2 when an expected
source is missing or its acquisition snapshot is older than the configured
threshold. Freshness uses acquisition timestamps, not the newest job's posting
date.

`opps doctor` probes only the local database, local JSON API, and local browser
UI, failing when any is unavailable. It does not inspect or require Modal. Cloud
parity is a separate explicit legacy/manual diagnostic; use the workflow in
[`cloud/README.md`](../cloud/README.md) when maintaining that lane.

All output paths must stay inside the repository. The CLI creates parent
directories and fails loudly on malformed policy, missing database
configuration, missing lab artifacts, failed refresh commands, or unhealthy
sources in strict mode.

## Output contract

Every displayed opportunity contains:

- source-reported posting date, or an explicit first-seen date when unavailable;
- source, company, and location;
- literal URL;
- `QUALIFIED (provisional)`, `CAVEAT`, or `DISQUALIFIED`;
- plain-English reasons;
- employment/contract/IR35 terms;
- `⭐ Pick` when its deterministic score meets the configured threshold.

Recent is a pure chronological view ordered by source posting date, falling back
to first-seen date. Picks is a filter over those displayed recent rows; it does
not inject older jobs into the list and it has no fixed item count. The label does
not claim that ChatGPT selected the jobs.

The report also includes source acquisition health and Pick
distribution. Machine-readable JSON contains the same rows, decisions, URLs,
health data, and recommended URLs.

## Policy and overrides

Defaults are versioned in `config/opportunity-report.json`:

- result limit;
- current-window age;
- minimum recommendation score;
- acquisition-staleness threshold;
- expected source families.

CLI flags override the numeric report settings:

```bash
bun run jobs:opportunities -- \
  --limit 30 \
  --max-age-days 21 \
  --recommendation-min-score 12 \
  --stale-after-hours 36
```

Use `--policy path/to/policy.json` to supply another versioned policy file.
