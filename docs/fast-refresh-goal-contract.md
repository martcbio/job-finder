# Fast Refresh Goal Contract

This document is the detailed completion contract for the fast-refresh/API hardening goal. The `/goal` should stay short and refer here rather than carrying every requirement inline.

## Outcome

Build a cheap-first, UI-ready refresh API that can ingest jobs from JobServe, direct ATS/careers sources, and future sources without the UI needing to know scraper-specific details.

The API should let a UI prototype trigger a refresh, inspect the latest ranked jobs, open a job detail record, and inspect refresh/source-run status using structured JSON rather than CLI markdown.

## Required API Surface

- `POST /api/refresh/fast`
  - Starts or runs the fast refresh path.
  - Returns run identity, source counts, imported counts, classification counts, full-text ingest counts, explicit blocked/error states, cost/token usage, and elapsed time.
- `GET /api/jobs/latest`
  - Returns the latest ranked/reviewable jobs in a normalized UI-facing shape.
- `GET /api/jobs/:id`
  - Returns one job with raw source evidence, normalized fields, links, full text, classification, eligibility, ranking, dedupe/review state, and source provenance.
- `GET /api/runs/:id`
  - Returns source-level status for a refresh run, including counts, errors, blocked reasons, latency, and cost/token usage.

## UI-Facing Job Shape

Each job returned by the API should expose:

- `id`
- `title`
- `company`
- `location`
- `workplace`
- `postedAt`
- `source`
  - stable source id
  - source label
  - source kind, for example `job_board`, `ats`, `company_careers`, `aggregator`, `search`, `manual`
- `links`
  - canonical job link where possible
  - apply link where possible
  - source/origin link
  - avoid Indeed links when a better employer or ATS link exists
- `fullText`
  - status: `available`, `snippet_only`, `blocked`, `missing`, or `not_attempted`
  - text or excerpt when available
  - fetch/error metadata when blocked
- `classification`
  - category labels such as agentic engineer, architect, RAG-heavy, FDE, inference, other
  - confidence/reasoning metadata where available
  - evolving labels should be supported without schema churn
- `eligibility`
  - passport/region/work-location implications
  - US remote problem flag
  - EU-based problem flag, while EU-remote with occasional meetings remains reviewable
  - Switzerland in-situ concern
  - inside-IR35 concern
  - security-clearance concern
  - remote-friendliness / locality notes for Singapore, UAE, London, and other interesting locations
- `ranking`
  - score
  - reasons
  - softened-criteria marker where padding is used
- `dedupe`
  - best-effort duplicate group
  - do not discard plausible duplicates just because two shops advertise the same role
- `review`
  - human review state and events
- `cost`
  - Jina token usage
  - LLM token usage
  - search API calls

## Source Adapter Contract

New sources should plug in through an adapter boundary rather than a one-off script path.

Each source adapter should produce:

- source identity and source kind
- query/date inputs accepted by the source
- candidate URLs or an explicit zero-results state
- raw response/evidence metadata
- normalized job candidates where possible
- full-text fetch attempt status
- explicit failure/blocked reason when candidates or full text cannot be obtained
- cost/token usage
- elapsed time

If a source can be cleanly normalized into the existing job model, normalize it. If it cannot, preserve raw evidence and extracted facts separately rather than flattening it into a vague job. Awkward sources should degrade into explicit `blocked`, `snippet_only`, `redirect_only`, `captcha_gated`, `stale`, or `missing_identity` states.

## Source Strategy

Prefer cheap and direct paths first:

1. Source-specific public APIs or pages.
2. Direct ATS/careers endpoints.
3. Search API results, such as Brave, when available.
4. Plain HTTP fetches.
5. Jina Reader only as a fallback for full-text extraction or difficult pages.

Do not use Jina Search as the universal discovery layer.

LinkedIn, Glassdoor, Wellfound, and Remote Rocketship remain draft/opportunistic unless later evidence shows reliable cheap access.

## Design Constraints

- Postgres is the source of truth.
- Use local Postgres, schema-separated from other workloads.
- No Docker.
- Notion must remain optional, not a forced dependency.
- Fail loudly with clear errors; do not silently drop source failures.
- Human-gated review remains mandatory for application decisions.
- Dedupe is conservative and best-effort.
- The CLI may continue to exist, but the UI must consume the API, not parse CLI output.
- Secrets must be traced through source, effective process environment, and runtime identity before diagnosing missing credentials.

## Verification

Completion requires both deterministic tests and live proof.

Deterministic tests must cover:

- source adapter success
- explicit zero-results state
- explicit blocked/error state
- dedupe behavior
- classification output shape
- eligibility output shape
- API response shape for all required endpoints

Live proof must include:

- a timed CLI fast-refresh run
- a timed API-triggered fast-refresh run
- equivalent or explainably different counts between CLI and API
- latest jobs with non-Indeed links where better links are available
- full-text status for discovered jobs
- classification labels
- eligibility flags
- review state
- per-source candidate/import/full-text/classification counts
- per-stage token/cost usage
- explicit failures or blocked states
- total latency

The API is not done until a UI prototype can use it without knowing source-specific scraper internals.

## Blocked Criteria

A source or feature may be marked blocked only with evidence:

- which command or endpoint was attempted
- what response/error was observed
- whether the problem is credentials, network access, CAPTCHA/anti-bot, paywall, malformed data, missing identity, redirect-only data, or another concrete cause
- what key, account, endpoint, schema change, or manual decision would unblock it

Blocked sources should not prevent progress on the rest of the pipeline, but they must appear explicitly in run output.
