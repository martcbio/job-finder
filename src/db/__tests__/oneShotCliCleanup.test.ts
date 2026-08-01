import { expect, test } from "bun:test";
import { resolve } from "node:path";

const scriptsDirectory = resolve(import.meta.dir, "../../../scripts");
const databaseModuleImport = /from "\.\.\/src\/db\/(?:psql|migrations)"/;
const longLivedScripts = new Set(["api.ts"]);

async function databaseOneShotScripts(): Promise<Map<string, string>> {
  const databaseScripts = new Map<string, string>();

  for await (const script of new Bun.Glob("*.ts").scan({ cwd: scriptsDirectory })) {
    if (longLivedScripts.has(script)) continue;

    const source = await Bun.file(resolve(scriptsDirectory, script)).text();
    if (!databaseModuleImport.test(source)) continue;
    databaseScripts.set(script, source);
  }

  return databaseScripts;
}

test("every one-shot database script closes the pooled clients", async () => {
  const databaseScripts = await databaseOneShotScripts();

  for (const source of databaseScripts.values()) {
    expect(source).toMatch(/withPsqlClientCleanup|closePsqlClients/);
  }

  expect(databaseScripts.size).toBeGreaterThan(0);
});

test("database one-shots use the shared URL fallback rather than require an environment variable", async () => {
  const databaseScripts = await databaseOneShotScripts();

  expect(databaseScripts.get("db-migrate.ts")).toContain("applyPendingMigrations");
  expect(databaseScripts.get("db-check.ts")).toContain("getDatabaseUrl");
  for (const source of databaseScripts.values()) {
    expect(source).not.toContain("process.env.DATABASE_URL");
  }
});
