# Source Adapter Contract

This is the backend contract for adding a new refresh source without changing the
API or UI response shape.

## Adapter Shape

A refresh source implements `FastRefreshSourceAdapter` from
`src/pipeline/sourceAdapterContract.ts`.

The adapter owns source-specific discovery and returns a `SourceDiscoveryResult`.
The pipeline owns persistence, classification, dedupe, review state, and API
presentation.

Required adapter metadata:

- `id`: stable machine id such as `jobserve`, `linear-careers`, or `greenhouse`.
- `label`: human display label.
- `kind`: `direct_employer`, `ats`, `recruiter`, `aggregator`, `search`, or `protected`.
- `quality`: `high`, `medium`, `low`, or `opportunistic`.
- `defaultKeyword`: the source-scoped refresh keyword.
- `discover(input)`: bounded discovery function.

## Discovery Result

Every discovery result must include:

- source metadata;
- keyword actually used;
- detailed outcome;
- discovered candidate count;
- normalized jobs where available;
- pages fetched when discovery itself paginates;
- token/cost usage, using `0` only for true zero-cost paths and `null` for unknown usage;
- explicit errors;
- explicit blocked reason when blocked.

`success` must include at least one normalized job. Empty successful searches
must use `zero_results`, and `zero_results` must not include normalized jobs.

Detailed outcomes are preserved for diagnostics. The API also exposes the smaller
UI status vocabulary:

- `success`
- `zero_results`
- `partial`
- `blocked`
- `timeout`
- `parser_error`
- `rate_limited`
- `auth_required`

## Normalized Candidate Fields

Each returned job must be a `NormalizedJobInput` with:

- source id and label;
- candidate URL through `sourceUrl` or `url`;
- canonical/readable URL through `url`;
- title;
- company when known;
- location and remote hints when known;
- search term or source query when known;
- raw source payload or metadata.

Adapters should include these raw metadata keys when known:

- `discoveredAt`
- `fetchStrategy`
- `remoteHint`
- `failureReason`

These are intentionally generic. Source-specific payloads can keep extra fields
inside `raw` without leaking into API consumers.

## Adding A Source

1. Implement a small adapter that returns `SourceDiscoveryResult`.
2. Run `assertSourceDiscoveryResultContract` in a deterministic fixture test.
3. Add one entry to `REGISTERED_JOB_SOURCES` in
   `src/pipeline/sourceRegistry.ts`, referencing the adapter factory.
4. Add or update `/api/sources` tests if it should be available for source-scoped refresh.
5. Do not change `JobSummary`, `/api/jobs/latest`, `/api/jobs/:id/full-text`, or UI code unless the shared API contract itself is intentionally changing.

The fixture test in `src/pipeline/__tests__/sourceAdapterContract.test.ts`
demonstrates the minimum shape expected from a new source.

The registry is the single source of truth for ingest allowlists, default source
sets, adapter construction, source metadata, queue lane membership, and API
source exposure. Do not add source-id lists elsewhere.
