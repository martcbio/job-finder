# Radar Ingest Ledger Contract

## Status

This is an inert persistence and deterministic-domain foundation. Migration
`016_add_ingest_ledger.sql` creates ledger tables and guards;
`src/pipeline/ingestLedger.ts` defines the matching pure state machine and
content hashes. Nothing invokes either path from live discovery, normalization,
the API, or existing job readers yet.

## Ledger model

A run is durable and declares at least one explicit source scope before work
starts. A scope identifies a source plus a stable coverage key such as an ATS
organization/query/page. The request is stored as JSON evidence.

The append path is:

1. Create or reuse a run by `run_hash`, storing its sorted immutable
   `scope_plan`.
2. Create or reuse each scope by `(run_id, scope_hash)`.
3. Append immutable raw observations by `(scope_id, observation_hash)`.
4. While its producing scope is `pending` or `running`, create or reuse
   immutable normalized versions by `version_hash`; the TypeScript constructor
   returns both the version and a new run aggregate that records its hash.
5. Append observation-to-version provenance edges.
6. Complete every scope with its exact persisted observation count.
7. Mark the run `ready`.
8. Call `job_search.commit_ingest_run(...)` to insert the manifest and transition
   the run to `committed` in one database transaction.

The migration grants no runtime role access to the hardened `SECURITY DEFINER`
commit function and removes PostgreSQL's default `PUBLIC` execute privilege.
Deployment must grant `EXECUTE` on
`job_search.commit_ingest_run(bigint, text, jsonb, text)` only to a dedicated
ledger writer, alongside the writer's explicit schema, table, and sequence
privileges. Read-only and ambient API roles must remain denied. The database
owner or an administrator retains PostgreSQL's inherent authority to bypass
table grants; that is administrative authority, not a runtime path, and direct
administrator inserts still pass the manifest validation trigger.

Zero results are evidence, not absence. A successful empty source attempt is a
real `ingest_source_scopes` row with `status = 'complete'` and
`result_count = 0`.

## Legal transitions

Run transitions:

```text
collecting -> ready -> committed
     |          |
     +----------+-> failed
```

Scope transitions:

```text
pending -> running -> complete
   |          |
   +----------+-> failed
   |
   +-> complete
```

A run can become ready only when every declared scope row exists, every scope is
complete, and every observation has at least one normalized-version provenance
edge. Every listing version produced by one of the run's scopes must also be
referenced by provenance from an observation in that run, so it appears in the
manifest. Child inserts and all mutations lock the parent run; they are rejected
once it is no longer `collecting`. Terminal rows cannot be changed or deleted.
Observations, listing versions, provenance edges, and manifests are immutable.

## Deterministic identity

Hashes are lowercase SHA-256 digests of canonical JSON. PostgreSQL installs
`pgcrypto`, resolves its installed schema from PostgreSQL's extension catalog,
and calls it through a schema-qualified, search-path-hardened `SECURITY DEFINER`
wrapper. That wrapper exposes only fixed SHA-256 over caller-provided bytes, so
writers need no privilege on the extension schema. This works when hosted
PostgreSQL has already installed it in `extensions` as well as when it lives in
`public`. PostgreSQL independently reconstructs and hashes every run, scope,
observation, listing-version, and manifest identity before insertion. A
64-character caller-supplied value is never accepted on shape alone.

Canonical JSON:

- recursively sorts object keys by UTF-8 bytes;
- preserves array order;
- renders finite numbers as plain normalized decimals, including exponent
  boundaries and negative zero;
- admits PostgreSQL JSON numbers only when they recursively round-trip exactly
  through TypeScript's finite IEEE-754 number domain, rejecting overflow,
  underflow, and extra database-only decimal precision; the database conversion
  pins its float rendering independently of session `extra_float_digits`;
- accepts only finite JSON values and plain objects, and rejects lone UTF-16
  surrogates and null characters in values or keys before UTF-8 key sorting;
- accepts only exact UTC ISO-8601 timestamps with three millisecond digits and
  rejects sub-millisecond database observation values;
- includes `contractVersion: 1` in run, scope, observation, and version identity.

The identities are:

- scope: contract version, source id, scope key, request;
- run: contract version, producer, sorted scope identities;
- observation: contract version, scope hash, source record key, observed time,
  raw payload;
- listing version: contract version, listing key, normalizer, normalized payload;
- manifest: run hash, sorted complete scopes and observation hashes, referenced
  version hashes, and deduplicated provenance edges.

Replaying the same data therefore resolves to the same hashes and unique keys.
Duplicate observations, versions, and edges collapse by hash. Different raw or
normalized content creates a new immutable version rather than updating history.

## Atomic and idempotent commit

`job_search.commit_ingest_run(run_id, manifest_hash, manifest_payload,
committed_at)` accepts `committed_at` only as exact UTC `.sssZ` text, locks the
run, requires `ready`, reconstructs the canonical payload from persisted ledger
rows, cryptographically verifies the supplied hash, payload, and counts, inserts
one immutable manifest, and changes the run to `committed`. PostgreSQL rolls the
function call back as a unit on error. The TypeScript core produces opaque,
privately branded ledger records through authoritative constructors; the
database remains the final cryptographic authority at persistence. TypeScript
commit callers supply provenance edges, not an optional version list: the run
aggregate's registered version hashes are the authoritative completeness set.

Calling it again with the identical manifest returns the existing manifest id.
Calling it again with different content is rejected. Replaying the exact
`collecting -> ready` transition is likewise a no-op; changing `readyAt` is
rejected. Direct state updates are also guarded, so a run cannot be committed
without a manifest, while any source scope is incomplete, or while a listing
version produced by the run is absent from same-run provenance. A manifest's
`committed_at` cannot precede the run's `ready_at`, and the committed run and
manifest timestamps must be identical even under privileged direct DML.

Replay is idempotent only when its evidence and lifecycle timestamps agree.
Contradictory `startedAt`, `completedAt`, `failedAt`, `readyAt`, or `committedAt`
values are rejected, and `committedAt` cannot precede `readyAt`. Contract
version is exactly `1`; stored identity strings are nonempty, trimmed, contain
no null characters, and each run may declare a source-id/scope-key pair only
once.
`readyAt` cannot precede `completedAt` for any required source scope.
Failure directly from `collecting` preserves a null `readyAt`. Failure from
`ready` preserves the existing immutable `readyAt`, and its `failedAt` cannot
precede that timestamp. Exact failed-run replays are no-ops; changing either
failure timestamp or code is rejected.
Once a source scope starts, its `started_at` value is immutable and terminal
timestamps cannot precede it. A direct pending-to-complete or pending-to-failed
transition preserves a null `started_at`. Observations cannot precede a
non-null scope start or follow its completion, and scope/run failure timestamps
cannot precede lifecycle or evidence timestamps already recorded beneath them.
Failed scopes preserve their deduplicated observations, including on exact
replay, and reject evidence observed after `failedAt`.
All ledger timestamps are millisecond-aligned in PostgreSQL. The various
`created_at` columns are database-owned audit timestamps: insert triggers
overwrite supplied values with the database clock, column privileges are
revoked from ambient roles, and provenance-edge audit time cannot precede
either parent row. Runtime writers should omit them.

## Deliberate non-goals

- No live source adapter writes to this ledger.
- Existing `search_runs`, `jobs`, and readers are unchanged.
- No projection from listing versions into the current mutable jobs model exists.
- No retention or deletion path exists; durability is intentional.
