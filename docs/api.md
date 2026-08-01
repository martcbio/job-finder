# Jobsradar Local API

This API is the frontend-facing boundary for the local Postgres job-search pipeline.
It is intended for local UI prototyping and agent-assisted frontend work. The API
does not use Notion as a persistence dependency; Postgres is the source of truth.

## Run

```bash
export DATABASE_URL=postgres://mcb@localhost:5432/jobs
bun run api
```

By default the API listens on `127.0.0.1:3737`.

```bash
JOB_FINDER_API_PORT=3740 bun run api
```

All routes live under `/api` and return JSON. The default response envelope is:

```json
{
  "ok": true,
  "data": {}
}
```

Errors are explicit and machine-readable:

```json
{
  "ok": false,
  "error": {
    "code": "invalid_review_state",
    "message": "Unsupported review state \"auto_apply\"",
    "details": {}
  }
}
```

The API currently allows CORS for `http://localhost:3000` and
`http://localhost:5173`. If a frontend is served elsewhere, add that origin in
`createJobFinderApiHandler({ allowOrigins: [...] })` or proxy through the local
dev router.

## Integration Boundary

Postgres is required. Jina, OpenRouter, Brave, and Notion are optional: the
supported API/fast-refresh path must run without their keys. Search-provider
keys can improve coverage, and legacy evaluation/export paths can still use
OpenRouter or Notion when explicitly invoked.

`GET /api/meta` reports this explicitly:

```json
{
  "integrations": {
    "postgres": {
      "required": true,
      "configured": true
    },
    "jina": {
      "mode": "optional",
      "requiredForSearch": false,
      "configured": false
    },
    "openrouter": {
      "mode": "optional_legacy",
      "requiredForApiStartup": false,
      "requiredForFastRefresh": false,
      "configured": false
    },
    "notion": {
      "mode": "optional",
      "requiredForApiStartup": false,
      "requiredForPostgresPipeline": false,
      "configured": false
    }
  }
}
```

Do not import `src/config` from frontend/API code unless you intentionally want
legacy scrape behavior. The API layer intentionally does not import it.

## Routes

### Health And Metadata

`GET /api/health`

Checks database connectivity, current database/user/schema/version, applied
migration count, latest migration, and integration status.

`GET /api/meta`

Returns enum-like values a UI should use for controls:

- `reviewStates`
- `reviewActors`
- `applicationStatuses`
- `duplicateCandidateStates`
- `pipeline.runConfirmation`
- integration status

`GET /api/sources`

Returns refresh-capable sources, source lanes, and the normalized source-attempt
status vocabulary a UI should use. JobServe has `defaultIncluded: true`; the
routine refresh must not present it as a per-source opt-in:

- `success`
- `zero_results`
- `partial`
- `blocked`
- `timeout`
- `parser_error`
- `rate_limited`
- `auth_required`

### Jobs

`GET /api/opportunities`

Returns the mixed JobServe and lab-ATS opportunity report used by the browser:
posting date, source, URL, verdict evidence, terms, ChatGPT Picks, Pick-source
distribution, and acquisition freshness. It reads local Postgres and the latest
completed lab artifact only; it never refreshes an external source.

Query parameters:

- `limit`: positive integer, default `50`, max `250`

`GET /api/jobs`

Returns the general job export rows used by the Markdown export.

Query parameters:

- `limit`: positive integer, default `50`, max `250`
- `state`: optional review state
- `run_id`: optional pipeline/search run id

Example:

```bash
curl 'http://127.0.0.1:3737/api/jobs?state=ready_for_review&limit=25'
```

`GET /api/jobs/queue`

Returns the human review queue with latest event, labels, duplicate candidates,
source labels, and a page/search snippet.

Query parameters:

- `limit`: positive integer, default `25`, max `250`
- `state`: repeatable or comma-separated review state filter

Example:

```bash
curl 'http://127.0.0.1:3737/api/jobs/queue?state=ready_for_review,duplicate_candidate'
```

`GET /api/review-queue`

Alias for `GET /api/jobs/queue`, provided for consumers that want a route named
after the workflow rather than the underlying job collection.

`GET /api/jobs/latest`

Returns UI-facing job summaries from Postgres only. This route must not trigger
network calls or refresh work.

Query parameters:

- `limit`: positive integer, default `20`, max `250`

`GET /api/jobs/:jobId`

Returns a job detail payload:

- normalized job fields
- classification labels
- observations and source evidence
- page snapshots
- review events
- ATS identity fields

`GET /api/jobs/:jobId/full-text`

Returns the latest stored page snapshot for a job, including markdown,
fetch/source provenance, usage tokens when known, decompressed byte count, and
the latest source observation. This is the detail route for inspecting the actual
job text the classifier and reviewer are judging.

`GET /api/jobs/:jobId/events`

Returns review events for one job.

Query parameters:

- `limit`: positive integer, default `50`, max `250`

`POST /api/jobs/:jobId/review`

Moves a job through local review state and appends a review event. This never
submits an external application.

Body:

```json
{
  "state": "shortlisted",
  "reasonCodes": ["strong_match"],
  "note": "Worth tailoring",
  "actor": "human"
}
```

### Duplicate Candidates

`POST /api/duplicates/:candidateId/review`

Records feedback on a possible duplicate. This does not merge, delete, suppress,
or discard either job.

Body:

```json
{
  "state": "confirmed_distinct",
  "reasonCodes": ["different_team"],
  "note": "Same title, different product group",
  "actor": "human"
}
```

### Source Health

`GET /api/source-health`

Returns source-level cost and yield metrics from persisted query rows.

Query parameters:

- `days`: optional positive integer
- `min_attempts`: positive integer, default `1`, max `1000`

Example:

```bash
curl 'http://127.0.0.1:3737/api/source-health?days=14&min_attempts=2'
```

### Saved Sweeps

`GET /api/sweeps`

Returns saved sweep definitions.

Query parameters:

- `enabled=true`: only return enabled sweeps

`POST /api/sweeps`

Creates or updates a saved sweep. Omitted fields use conservative defaults.

Body:

```json
{
  "name": "daily-agentic",
  "keywords": ["Agentic"],
  "sites": ["greenhouse", "lever", "ashby"],
  "timeFilter": "24hours",
  "includeRemote": true,
  "maxQueries": 12,
  "searchLimit": 5,
  "enabled": true
}
```

### Pipeline Runs

`GET /api/pipeline-runs`

Returns audited pipeline run history and step status.

Query parameters:

- `limit`: positive integer, default `25`, max `250`

`POST /api/pipeline-runs`

By default this returns the planned local command sequence without executing it.
This is the safest endpoint for a UI to call while building controls.

Body for a saved sweep plan:

```json
{
  "sweepName": "daily-agentic",
  "skipSteps": ["search"]
}
```

Body for an inline plan:

```json
{
  "keywords": ["Agentic"],
  "sites": ["greenhouse", "lever"],
  "timeFilter": "24hours",
  "includeRemote": true,
  "maxQueries": 12,
  "searchLimit": 5
}
```

Starting a local pipeline run is intentionally gated because it can hit external
sources, even when no paid API key is configured. To execute from the API, send:

```json
{
  "sweepName": "daily-agentic",
  "execute": true,
  "confirm": "run-local-pipeline"
}
```

Without the confirmation string the API returns `409 confirmation_required` and
includes the plan in the error details.

### Fast refresh

`POST /api/refresh/fast`

Runs the cheap-first queue-refresh path and returns elapsed time, effective
options, per-source status, candidate/import/full-text/classification counts,
latest job summaries, and cost/token totals. With `sourceIds` omitted, the API's
default composition includes a bounded JobServe contract attempt. JobServe is
therefore mandatory in the routine default pull, not a per-source opt-in.

`sourceIds` is a diagnostic override that replaces the default composition; do
not expose it as a normal source picker. Use `POST /api/refresh/source/:source`
only to isolate a source while diagnosing it.

Each source attempt includes `classification.classified` so UI and agent
consumers can display classification coverage without joining against the
top-level run summary. A `200` response means the refresh orchestration returned;
it does not mean each source succeeded. Always inspect `data.sources`: a JobServe
attempt can be `zero_results`, `partial`, `blocked`, `timeout`, `parser_error`,
`rate_limited`, or `auth_required`, with `errors` and `blockedReason` preserved.

Body fields are optional and bounded:

```json
{
  "limit": 20,
  "jobserveQueries": ["agentic", "langchain"],
  "jobserveMaxPages": 1,
  "jobserveImportLimitPerQuery": 5,
  "timeoutMs": 20000,
  "classifyLimit": 250
}
```

Raw direct-source acquisition persists every card returned by each direct source.
There is no `directLimit` or `direct-limit` request parameter.

The bounded JobServe limits are at most three queries, two result pages per
query, and five detail pages per query. Its native acquisition path makes no
tokenized search, Reader, or model call; those cost fields are known `0` for that
attempt. A later provider path may report `unknown` when usage is unavailable;
unknown is not zero.

`POST /api/refresh/source/:source`

Runs the same refresh path constrained to one source for diagnosis. It is not a
normal-pull configuration mechanism. Current source aliases:

- `jobserve`
- `linear` / `linear-careers`

Example:

```bash
curl -X POST 'http://127.0.0.1:3737/api/refresh/source/linear' \
  -H 'content-type: application/json' \
  -d '{"limit": 5, "timeoutMs": 20000}'
```

`GET /api/runs/latest`

Returns the newest persisted refresh/search run evidence using the same shape as
`GET /api/runs/:id`.

### Applications

`GET /api/applications`

Returns the cloud-durable application lifecycle from `careers.applications`, newest first. If
Supabase is unreachable, unconfigured, or the schema has not been applied/exposed, `data` is an
explicit `cloud_unavailable` result rather than a local fallback.

Query parameters:

- `status`: optional application status

`POST /api/applications`

Tracks an opening at `interested`. Creates are idempotent when `org`, `ats`, and `external_id` are
all present. This records lifecycle data only; it never submits externally.

Body:

```json
{
  "org": "acme",
  "ats": "greenhouse",
  "external_id": "12345",
  "source": "lab-openings",
  "title": "AI Engineer",
  "company": "Acme",
  "url": "https://job-boards.greenhouse.io/acme/jobs/12345"
}
```

`POST /api/applications/:id/transition`

Moves one application over a legal lifecycle edge and appends `{status, at, by}` to
`status_history`. Forward edges are
`interested → shortlisted → cv_staged → sent → response → interview → offer`; `closed` is reachable
from any active status and requires `note` as the closing reason.

```json
{
  "to": "shortlisted",
  "by": "agent",
  "note": "Strong match"
}
```

The `sent` transition is rejected unless `by` is `owner`. The endpoint only records a send the
owner already performed.

`POST /api/applications/:id/stage-cv`

Stages a shortlisted application into resume4 using the same deterministic core as
`bun run cv:stage -- <id>`. The route captures the stored job posting into resume4 (Markdown on
stdin to resume4's CLI; `--job-file` is forbidden there), runs resume4 `prepare` so classification
and retrieval exist, sets `cv_ref`, and transitions to `cv_staged` as `agent`.

It produces no CV and no PDF. resume4 is human-gated: composing, fact approval, council,
reconciliation, audits and the sealed render all require a human, so the response returns
`nextSteps` instead of artifact paths.

`cv_ref` is now `resume4:applications/<site>/<jobId>-<roleSlug>`. The `resume4:` prefix is the
discriminator; legacy rows written by the retired resume3 bridge are bare `pipeline/apply/...`
paths and stay readable via `parseCvRef` in `src/cv/stageApplicationCv.ts`. No data migration was
performed.

The route fails if the application is not shortlisted, if resume4 capture or prepare fails, or if
the job is already staged. Re-staging is refused by default: resume4's `new` will not reuse an
existing directory and `prepare` clears review artifacts, so a second run could destroy signed
human work. Response shape:

```json
{
  "cvRef": "resume4:applications/jobserve/2E38F0265A6FDFDBDC-agentic-ai-engineer",
  "cvRefKind": "resume4-staged",
  "applicationPath": "applications/jobserve/2E38F0265A6FDFDBDC-agentic-ai-engineer",
  "capture": { "mode": "job_markdown_stdin", "site": "jobserve", "jobId": "...", "role": "..." },
  "prepared": true,
  "humanGate": "compose_and_facts",
  "nextSteps": ["Human: compose into .../working.md from .../compose-packet.md (resume4)."]
}
```

See [CV staging](cv-staging.md) for job-source resolution and identity-safety details.

### CV Support

`POST /api/cv/bullets`

Adds an approved reusable CV bullet block. Only add claims backed by evidence.

Body:

```json
{
  "themeKey": "agentic_engineer",
  "title": "Agent systems",
  "bulletText": "Built ...",
  "evidenceNote": "Project/link/source"
}
```

`POST /api/jobs/:jobId/cv-drafts`

Generates a CV draft from approved bullet blocks matching the job labels. Drafts
default to stored `needs_human_review`; set `dryRun: true` to preview without
writing.

Body:

```json
{
  "maxBullets": 6,
  "dryRun": true
}
```

`POST /api/cv-drafts/:draftId/review`

Reviews a draft. Approving a draft moves the linked job toward `ready_to_apply`.

Body:

```json
{
  "status": "approved",
  "reasonCodes": ["accurate"],
  "note": "Checked against source material",
  "actor": "human"
}
```

## Frontend Agent Notes

Use `/api/meta` to populate state/status controls instead of hardcoding enums.
Use `/api/jobs/queue` for the main review surface and `/api/jobs/:jobId` for the
detail drawer/page. Use `/api/pipeline-runs` in dry-plan mode before exposing any
button that starts a sweep.

For the first UI pass, prefer polling:

- `/api/jobs/queue`
- `/api/pipeline-runs`
- `/api/source-health`

Websocket/SSE behavior is intentionally not required for the initial UI. The
database already records run and source state; push updates can be layered on
later with Postgres `LISTEN/NOTIFY` or a polling-to-SSE adapter.
