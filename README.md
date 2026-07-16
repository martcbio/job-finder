# jobfinder

Local, Postgres-backed job-search pipeline for source fanout across ATS and career surfaces.

The current fork stores runs/results/jobs in a schema-isolated local Postgres database, uses cheap/direct source paths before any third-party search provider, ingests job pages with structured paths before Reader fallback, classifies jobs into review categories, and keeps all application actions human-gated.

Notion support still exists in legacy modules and can be brought back as an export/review integration later, but it is not the source of truth for the current pipeline.

## Prerequisites

- Bun
- Local Postgres

No Docker is required.

## Database Setup

The job-search schema is isolated under `job_search` in a local `jobs` database.

```bash
bun install
bun run db:create
export DATABASE_URL=postgres://mcb@localhost:5432/jobs
bun run db:migrate
bun run db:check
```

`db:migrate` applies plain SQL migrations and records checksums in `job_search.schema_migrations`. `db:check` verifies the effective connection, schema, server version, applied migration count, and pending migration count.

More setup detail lives in [docs/local-postgres.md](docs/local-postgres.md).

## Frontend/API Handoff

For a frontend-oriented agent, start with [AGENTS.md](AGENTS.md), then
[docs/frontend-agent-handoff.md](docs/frontend-agent-handoff.md), then
[docs/api.md](docs/api.md).

Run the local JSON API with:

```bash
export DATABASE_URL=postgres://mcb@localhost:5432/jobs
bun run api
```

The API is the supported boundary for UI work. It uses Postgres-backed domain
modules and does not require Notion, OpenRouter, Brave, or Jina credentials.
Legacy Notion-first scripts and `src/index.ts` remain available as
reference/integration code, but new UI work should not depend on them.

## Refresh jobs (day-to-day)

Re-fetch from configured native sources (JobServe, linear-careers), ingest pages, and classify — no saved sweep required:

```bash
export DATABASE_URL=postgres://mcb@localhost:5432/jobs
bun run jobs:fast-refresh
```

Same path via API:

```bash
curl -X POST http://127.0.0.1:3737/api/refresh/fast \
  -H 'content-type: application/json' \
  -d '{}'
```

**Fast refresh** = cheap native sources, bounded limits. **Pipeline run** (below) = full saved-sweep fanout with explicit confirm.

## Common Commands

Run a DB-backed search across selected sources:

```bash
DATABASE_URL=postgres://mcb@localhost:5432/jobs \
  bun run search:db -- -k "Agentic" --site greenhouse --site lever --limit 5
```

Save and rerun a repeatable sweep:

```bash
DATABASE_URL=postgres://mcb@localhost:5432/jobs \
  bun run sweeps:save -- --name daily-agentic -k "Agentic" --site greenhouse --site lever

DATABASE_URL=postgres://mcb@localhost:5432/jobs \
  bun run pipeline:run -- --sweep daily-agentic
```

Inspect source quality and token usage:

```bash
DATABASE_URL=postgres://mcb@localhost:5432/jobs bun run source:health
DATABASE_URL=postgres://mcb@localhost:5432/jobs bun run pipeline:history
```

Run the explicit source coverage smoke. This is the command that tests
the broad claim source-by-source and writes a report that separates confirmed,
partial, blocked, and untested sources:

```bash
DATABASE_URL=postgres://mcb@localhost:5432/jobs \
  bun run source:coverage -- --execute -k "Agentic" --time 24hours --limit-per-source 1
```

Review jobs and record human decisions:

```bash
DATABASE_URL=postgres://mcb@localhost:5432/jobs bun run jobs:queue -- --limit 25
DATABASE_URL=postgres://mcb@localhost:5432/jobs bun run jobs:review -- --job-id 42 --state shortlisted --reason strong_match
```

Close active queue rows that have stopped appearing at their source. This is
never scheduled automatically and defaults to a dry run; only `--apply` writes:

```bash
DATABASE_URL=postgres://mcb@localhost:5432/jobs bun run jobs:expire
DATABASE_URL=postgres://mcb@localhost:5432/jobs bun run jobs:expire -- --days 21 --apply
```

Generate and review CV/application support:

```bash
DATABASE_URL=postgres://mcb@localhost:5432/jobs bun run cv:add-bullet -- --theme agentic_engineer --title "Agent systems" --bullet "..." --evidence "..."
DATABASE_URL=postgres://mcb@localhost:5432/jobs bun run cv:draft -- --job-id 42
DATABASE_URL=postgres://mcb@localhost:5432/jobs bun run cv:review-draft -- --draft-id 1 --status approved
DATABASE_URL=postgres://mcb@localhost:5432/jobs bun run applications:record -- --job-id 42 --status waiting
```

Export a durable Markdown proof/review artifact:

```bash
DATABASE_URL=postgres://mcb@localhost:5432/jobs \
  bun run jobs:export -- --limit 25 --output docs/job-search-export.md
```

## Pipeline Shape

The main dry-runnable pipeline is:

1. `db_check` validates local Postgres and pending migrations.
2. `search` fans out over configured sources and persists every query/result/error.
3. `ingest_pages` captures richer page text.
4. `classify` writes category/focus labels and advances untouched jobs to `ready_for_review`.
5. `duplicates` records possible duplicate relationships without suppressing jobs.
6. `queue` prints the human review queue.

Use `bun run pipeline:run -- --dry-run ...` to inspect commands before executing them, and `--skip <step>` to run a partial pipeline.

## Ingestion Cost Control

Discovery prefers source-specific adapters and direct/public endpoints. Search-provider APIs are optional accelerators; when no search key is configured, the default provider records an explicit keyless zero-result state rather than failing the run.

Full-page ingestion uses this order:

1. Native ATS API clients where available: Lever, Ashby, Greenhouse, Workable.
2. Plain HTTP fetch plus readable HTML/text extraction.
3. Jina Reader fallback, attempted without Authorization when no key is configured, with reported token usage recorded when available.
4. Browser automation is intentionally deferred as a last resort.

Timeouts and failed calls are persisted as first-class attempts. Unknown token usage is recorded as unknown, not zero.

## Data Model

Core data lives under the `job_search` schema:

- `search_runs`, `search_queries`, `search_results`
- `jobs`, `job_observations`, `job_pages`
- `job_classification_labels`
- `duplicate_candidates`
- `review_events`
- `cv_bullet_blocks`, `job_cv_drafts`
- `job_applications`
- `saved_sweeps`, `pipeline_runs`, `pipeline_run_steps`

Exact canonical URL dedupe is supported, and common ATS-native identities are persisted for Greenhouse, Lever, Ashby, and Workable so URL-shape changes can still point at the same advertised posting. Fuzzy/cross-source matches become reviewable duplicate candidates rather than automatic suppressions.

## Human Gates

The system can classify, draft, and recommend, but it does not apply to jobs or send externally visible messages. Review states and review events are stored locally so the pipeline can improve from structured feedback without pretending to be trusted too early.

## Tests

```bash
bun run lint
bun run typecheck
bun test src/**/__tests__/
```

Integration fixtures for evaluation behavior are under `src/pipeline/__integration__/`.
