import { JOB_SEARCH_SCHEMA, getDatabaseUrl, quoteSqlLiteral } from "../src/db/config";
import { loadMigrations, migrationDisplayName, planMigrations } from "../src/db/migrations";
import { runPsqlJson } from "../src/db/psql";

interface DbInfo {
  database: string;
  user: string;
  schema: string;
  version: string;
}

async function run(): Promise<void> {
  getDatabaseUrl();

  const info = await runPsqlJson<DbInfo>(
    `SELECT json_build_object(
       'database', current_database(),
       'user', current_user,
       'schema', current_schema(),
       'version', version()
     );`,
  );

  const schemaExists = await runPsqlJson<boolean>(
    `SELECT to_json(EXISTS (
       SELECT 1
       FROM information_schema.schemata
       WHERE schema_name = ${quoteSqlLiteral(JOB_SEARCH_SCHEMA)}
     ));`,
    { setSearchPath: false },
  );

  console.log(`database: ${info.database}`);
  console.log(`user: ${info.user}`);
  console.log(`effective schema: ${info.schema}`);
  console.log(`server: ${info.version}`);
  console.log(`job schema: ${schemaExists ? "present" : "missing"}`);

  const migrations = await loadMigrations();
  const plan = await planMigrations(migrations);
  console.log(`migrations applied: ${plan.applied.length}`);
  console.log(`migrations pending: ${plan.pending.length}`);
  for (const migration of plan.pending) {
    console.log(`pending: ${migrationDisplayName(migration)}`);
  }

  if (!schemaExists || plan.pending.length > 0) {
    throw new Error("job_search schema is not ready. Run bun run db:migrate.");
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
