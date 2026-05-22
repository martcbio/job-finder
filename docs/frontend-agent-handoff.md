# Frontend Agent Handoff

This document is the quickest orientation path for an agent dropped into this
repo to prototype or build a UI.

## What This System Is

`job-finder` is a local job-search pipeline. It fans out across configured job
sources, persists search evidence in local Postgres, ingests job pages, classifies
jobs, keeps conservative duplicate candidates, and leaves human review in charge
of applications.

The frontend should treat the local JSON API as its backend. The API wraps the
Postgres-backed domain modules and deliberately avoids the legacy Notion-first
scraper path.

## What To Read First

1. [docs/api.md](api.md): route contract, request/response shape, safety gates.
2. [README.md](../README.md): pipeline shape, data model, common commands.
3. [docs/local-postgres.md](local-postgres.md): DB setup and schema boundary.
4. [docs/job-search-db-prd.md](job-search-db-prd.md): broader product intent.

You do not need to understand every scraper before building a review UI. Start
from the API surfaces and only drill into `src/pipeline/*` when a route needs
new data.

## Local Startup

```bash
bun install
export DATABASE_URL=postgres://mcb@localhost:5432/jobs
bun run db:check
bun run api
```

The API listens at:

```text
http://127.0.0.1:3737/api
```

The most useful smoke checks are:

```bash
curl 'http://127.0.0.1:3737/api/health'
curl 'http://127.0.0.1:3737/api/meta'
curl 'http://127.0.0.1:3737/api/jobs/queue?limit=25'
```

If the UI is a separate local app, use `/api/meta` to populate enum-like controls
instead of copying state lists into the frontend.

## Build The First UI Around These Screens

### Review Queue

Use `GET /api/jobs/queue`.

Show:

- title, company, source labels
- review state
- classification category/focus labels
- duplicate candidate warning, if present
- latest review event
- short snippet

Primary actions:

- shortlist
- mark not relevant
- send to CV tailoring
- mark stale
- open job URL

Persist actions through `POST /api/jobs/:jobId/review`.

### Job Detail

Use `GET /api/jobs/:jobId`.

Show:

- normalized job fields
- ATS identity, when present
- observations and source evidence
- page snapshots/snippets
- classification labels and confidence
- review event history

The detail view should make it clear what came from search metadata versus page
ingest.

### Source Health

Use `GET /api/source-health`.

Show:

- attempts
- success rate
- timeouts/errors
- average reported tokens
- average/total results
- unknown usage calls

This is how the user decides which sources are worth running more often.

### Pipeline Runs

Use `GET /api/pipeline-runs`.

Use `POST /api/pipeline-runs` without `execute` to preview a run plan. Treat that
as the default UX. Do not put a one-click live sweep button in the first UI.

Starting a run requires:

```json
{
  "execute": true,
  "confirm": "run-local-pipeline"
}
```

That gate is intentional because live runs can consume Jina tokens and hit
external sources.

### CV And Applications

CV draft routes exist, but they should stay behind human review:

- `POST /api/cv/bullets`
- `POST /api/jobs/:jobId/cv-drafts`
- `POST /api/cv-drafts/:draftId/review`
- `GET /api/applications`
- `POST /api/applications`

`POST /api/applications` records local state only. It must not submit an external
application.

## Notion Boundary

Notion is optional. It is not the source of truth.

Do not make new UI/API code depend on:

- `NOTION_TOKEN`
- `NOTION_DATABASE_ID`
- `src/config`
- `src/index.ts`
- legacy scripts such as `scripts/find-candidates.ts`,
  `scripts/list-to-review.ts`, or `scripts/mark-status.ts`

Those paths are still useful as upstream reference/legacy integration code, but
they are not the route for a frontend prototype.

The API reports Notion configuration as metadata only:

```bash
curl 'http://127.0.0.1:3737/api/meta'
```

Look for:

```json
{
  "integrations": {
    "notion": {
      "mode": "optional",
      "requiredForApiStartup": false,
      "requiredForPostgresPipeline": false
    }
  }
}
```

## Where To Change Backend Shape

If the UI needs more data, prefer adding to the API layer rather than querying
Postgres from frontend code.

Useful files:

- `src/api/server.ts`: route definitions and JSON envelopes
- `src/api/__tests__/server.test.ts`: mocked API contract tests
- `src/pipeline/jobReviewQueue.ts`: queue query shape
- `src/pipeline/jobExport.ts`: list/export query shape
- `src/pipeline/sourceHealth.ts`: source metrics
- `src/pipeline/pipelineRun.ts`: run history
- `src/pipeline/savedSweeps.ts`: saved sweep definitions

Keep route handlers injectable/testable. New route tests should mock the
`ApiQuery` function rather than requiring local Postgres.

## Safety Rules For UI

- Human review remains mandatory.
- Never submit external job applications.
- Never send outreach.
- Never auto-delete, auto-merge, or auto-hide duplicate candidates.
- Prefer polling over websockets/SSE for the first UI pass.
- Show dry-run pipeline plans before offering execution.
- Preserve raw evidence links and snippets so the user can audit why a job exists.

## Current Smoke Data Caveat

The local DB may contain smoke rows, including deliberate test debris. Do not
treat the current row count or exact job set as product truth. Build the UI
around states, evidence, and review flows rather than around the small current
sample.
