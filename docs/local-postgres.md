# Local Postgres Setup

This project uses local Postgres as the canonical store for job search data. The schema is isolated under `job_search` so it can share a database server with unrelated local workloads without sharing tables.

No Docker is required.

## Commands

```bash
bun run db:create
export DATABASE_URL=postgres://mcb@localhost:5432/jobs
bun run db:migrate
bun run db:check
```

`bun run db:create` is idempotent: it creates the `jobs` database only when it is missing. It defaults to `postgres://$USER@localhost:5432/jobs`, or uses `DATABASE_URL` when set.

The Jobsradar API launch agent runs this same `db:migrate` command before it
starts the API. A pending migration therefore blocks the API rather than leaving
it serving an older schema; running the command directly remains the normal way
to prepare or verify a checkout outside launchd.

To be explicit:

```bash
bun run db:create -- --database-url postgres://mcb@localhost:5432/jobs
DATABASE_URL=postgres://mcb@localhost:5432/jobs bun run db:migrate
DATABASE_URL=postgres://mcb@localhost:5432/jobs bun run db:check
```

After the schema is ready, the DB-backed search and export commands are:

```bash
DATABASE_URL=postgres://mcb@localhost:5432/jobs bun run search:db -- -k "Agentic" --site greenhouse --site lever --limit 5
DATABASE_URL=postgres://mcb@localhost:5432/jobs bun run jobs:export -- --limit 25 --output docs/job-search-export.md
```

## Default raw ingest

Run the normal local raw pull with:

```bash
DATABASE_URL=postgres://mcb@localhost:5432/jobs bun run jobsradar -- ingest
```

Its default source composition is Lab ATS, bounded JobServe contracts, Linear
Careers, and Google Careers. JobServe is mandatory in this default pull, with at
most three queries, two result pages per query, and five detail pages per query.
It is not an opt-in source.

`--source <id>` is a source-isolation diagnostic override: it replaces the
default composition, so a scoped run must not be described as a normal pull.
Inspect the JSON or terminal receipt for every source. A JobServe failure is
reported as that source's `failed` receipt with its errors; if another source
succeeds, the overall result is `degraded` and exits non-zero.

The ingest boundary is fetch, evidence preservation, deterministic normalization,
and Postgres persistence. The live inputs can change between runs. It does not
rank, classify, report, email, or request tokenized search/Reader/model work, so
it emits no token accounting. Token metrics belong to later search or Reader
steps; a known unused provider is `0`, while an unavailable usage value is
`unknown` rather than zero.
