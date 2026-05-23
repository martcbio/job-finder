# API Hardening Goal Contract

## Outcome

Harden the job refresh API into a fast, source-extensible backend contract for UI and agent consumers.

The backend should make it cheap and quick to:

- refresh known sources;
- inspect the latest jobs from Postgres;
- inspect full text for a job;
- see classification, dedupe, screening, and review state;
- add a new source without leaking source-specific weirdness into the UI;
- explain source failures without silent degradation.

## Verification Surface

Completion requires deterministic tests plus live smoke evidence showing:

- `GET` latest jobs is DB-only and fast for the latest 20 jobs;
- keyless `POST /api/refresh/fast` still works;
- source-scoped refresh works for at least JobServe and Linear Careers;
- every refresh run exposes per-source status, candidate counts, imported counts, full-text counts, classification counts, failure reasons, and cost/token usage;
- a full-text job endpoint returns the stored job body and provenance;
- a source adapter contract is documented and tested with at least one fixture adapter;
- source failure states are explicit: `success`, `zero_results`, `partial`, `blocked`, `timeout`, `parser_error`, `rate_limited`, or `auth_required`;
- adding a new source requires a small adapter and does not require UI/API response-shape changes.

## API Shape

The API should either provide these routes or a clearly documented equivalent:

- `GET /api/jobs/latest?limit=20`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/full-text`
- `POST /api/refresh/fast`
- `POST /api/refresh/source/:source`
- `GET /api/runs/latest`
- `GET /api/runs/:id`
- `GET /api/sources`
- `GET /api/review-queue`
- `POST /api/jobs/:id/review`

## Source Adapter Contract

Each source should normalize into a shared candidate shape before ingest:

- source id and display name;
- candidate URL;
- canonical URL if known;
- title, company, location, and remote hints if known;
- discovered timestamp;
- source query or search term;
- raw source metadata;
- fetch strategy used;
- explicit failure reason when discovery or ingest fails.

The implementation contract lives in `src/pipeline/sourceAdapterContract.ts`,
with operator-facing notes in `docs/source-adapter-contract.md`.

## Constraints

- Postgres remains the source of truth.
- No Docker.
- Notion remains optional and legacy-compatible, not part of the required path.
- The default path must not require Brave, Jina, OpenRouter, Notion, or other paid/search API keys.
- Prefer source-specific adapters, direct ATS/public endpoints, plain HTTP, and stored DB reads before paid/search/API fallbacks.
- Fail loudly with clear reason codes rather than silent fallback.
- Keep human-gated review/application flows.
- Preserve best-effort dedupe; do not over-collapse jobs that may be reposts, agencies, or distinct listings.
- Do not build the UI yet except for smoke surfaces needed to inspect API output.

## Blocked Stop Condition

If a source cannot meet the contract cheaply, record which fields or routes are blocked, why they are blocked, and what would unblock them. Demote the source rather than weakening the shared API contract.
