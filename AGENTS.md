# Agent Orientation

Start with [docs/frontend-agent-handoff.md](docs/frontend-agent-handoff.md), then
[docs/api.md](docs/api.md).

This repo is now a local Postgres-backed job-search pipeline with a JSON API for
frontend work. Treat Postgres as the source of truth. Notion code still exists
from the upstream project, but it is legacy/optional and must not be required for
new API or UI work.

## First Commands

```bash
bun install
export DATABASE_URL=postgres://mcb@localhost:5432/jobs
bun run db:check
bun run api
```

The API listens on `127.0.0.1:3737` by default. Use `GET /api/meta` before
hardcoding review states, application statuses, duplicate states, or run
confirmation strings.

## Boundaries

- Do not make Notion required for API startup, UI startup, Postgres ingestion, or
  review workflows.
- Do not import `src/config` from new API/frontend code unless deliberately
  working on the legacy Notion-first scraper. `src/config` validates Notion
  credentials by design.
- Do not submit applications, send outreach, or perform externally visible
  actions. Record local application state only.
- Do not auto-merge/delete/suppress duplicate jobs. Duplicate candidates are
  review feedback, not destructive operations.
- Do not use Docker. Local Postgres is the supported path.
- Do not write review artifacts under `/tmp`.

## Frontend Path

Build UI against `bun run api`, not by shelling out to CLI scripts. The useful
first surfaces are:

- `GET /api/jobs/queue` for the review list
- `GET /api/jobs/:jobId` for detail pages/drawers
- `GET /api/source-health` for source/cost visibility
- `GET /api/pipeline-runs` for run history
- `POST /api/pipeline-runs` without `execute` for dry planning
- `POST /api/jobs/:jobId/review` for local review transitions

Pipeline execution is intentionally gated. A UI may show the dry plan freely, but
starting a run requires `execute: true` and `confirm: "run-local-pipeline"`.

## Verification

Before handing off changes, run:

```bash
bun run typecheck
bun run lint
bun test src/**/__tests__/
```

For live API smoke checks, use local Postgres:

```bash
export DATABASE_URL=postgres://mcb@localhost:5432/jobs
bun run db:check
bun run api
```

