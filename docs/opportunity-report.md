# Opportunity list and CLI

The normal reading surface is the **Latest 50** view at
`http://127.0.0.1:32002/`. It calls `GET /api/opportunities`, which reads local
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

`opps update` syncs the latest fresh, complete Modal lab-ATS run—including full
job bodies—then refreshes direct careers, bookmark company signals, and bounded
JobServe contracts. If the cloud snapshot is stale, unavailable, or
inconsistent, it reports that failure and runs the Mac lab scanner. No source
toggle is required for the normal update.

Without a refresh flag, this reads only the latest complete lab-opening
generation and stored JobServe rows. It does not contact JobServe.

## Fresh run

```bash
bun run jobs:opportunities -- --refresh-cloud-labs
bun run jobs:opportunities -- --refresh-labs
```

The first command uses Modal with a visible Mac fallback. The second forces a
native Mac ATS scan. These lower-level diagnostic commands can isolate sources;
the normal `opps update` always fetches all configured sources and fails
immediately if any required refresh fails.

JobServe safety is enforced below the CLI: at most three queries, two result
pages per query, five detail pages per query, paced requests, and immediate
abort when the fair-usage restriction page appears.

## Automation

```bash
bun run jobs:opportunities -- \
  --refresh-cloud-labs \
  --strict-source-health \
  --format json \
  --output artifacts/opportunities/latest.json
```

`--strict-source-health` exits with status 2 when an expected source is missing
or its acquisition snapshot is older than the configured threshold. Freshness
uses acquisition timestamps, not the newest job's posting date.

`opps doctor` also fails when the scheduled `jobsradar` Modal task is
stale or unhealthy. Cloud output becomes reusable only after a complete run and
row-count validation; parity uses the full `org:ats:id` digest.

All output paths must stay inside the repository. The CLI creates parent
directories and fails loudly on malformed policy, missing database
configuration, missing lab artifacts, failed refresh commands, or unhealthy
sources in strict mode.

## Output contract

Every displayed opportunity contains:

- source-reported posting date;
- source, company, and location;
- literal URL;
- `QUALIFIED (provisional)`, `CAVEAT`, or `DISQUALIFIED`;
- plain-English reasons;
- employment/contract/IR35 terms;
- `⭐ ChatGPT Pick` when selected across the full current window.

Picks are chosen before recency fills the remaining slots, so a high-quality
current Anthropic/OpenAI/Cohere role cannot be crowded out merely by JobServe
volume. The final selected set is then ordered by posting date. Duplicate title
variants do not consume multiple Pick slots.

The report also includes source acquisition health and Pick distribution.
Machine-readable JSON contains the same rows, decisions, URLs, health data, and
Pick URLs.

## Policy and overrides

Defaults are versioned in `config/opportunity-report.json`:

- result limit;
- current-window age;
- Pick count;
- acquisition-staleness threshold;
- expected source families.

CLI flags override the numeric report settings:

```bash
bun run jobs:opportunities -- \
  --limit 30 \
  --max-age-days 21 \
  --pick-count 8 \
  --stale-after-hours 36
```

Use `--policy path/to/policy.json` to supply another versioned policy file.
