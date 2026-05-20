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
