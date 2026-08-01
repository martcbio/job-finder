import { serveJobFinderApi } from "../src/api/server";
import { applyPendingMigrations } from "../src/db/migrations";

interface ApiStartupDependencies {
  applyPendingMigrations(): Promise<unknown>;
  serveJobFinderApi(): { hostname: string; port: number };
  log(message: string): void;
}

export async function startApi(
  dependencies: Partial<ApiStartupDependencies> = {},
): Promise<void> {
  await (dependencies.applyPendingMigrations ?? applyPendingMigrations)();
  const server = (dependencies.serveJobFinderApi ?? serveJobFinderApi)();
  const log = dependencies.log ?? console.log;
  log(`jobsradar API listening on http://${server.hostname}:${server.port}`);
  log("Routes are under /api. Stop with Ctrl-C.");
}

if (import.meta.main) {
  await startApi();
}
