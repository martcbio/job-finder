import { applyPendingMigrations, migrationDisplayName } from "../src/db/migrations";

async function run(): Promise<void> {
  const plan = await applyPendingMigrations();

  if (plan.pending.length === 0) {
    console.log("No pending migrations.");
    return;
  }

  for (const migration of plan.pending) {
    console.log(`Applied ${migrationDisplayName(migration)}`);
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});

