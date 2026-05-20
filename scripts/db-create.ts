import {
  buildCreateDatabaseSql,
  buildDatabaseExistsSql,
  resolveLocalDatabaseConfig,
} from "../src/db/localSetup";

interface DbCreateOptions {
  databaseUrl: string | null;
  maintenanceUrl: string | null;
}

function readStringFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

function parseOptions(args: string[]): DbCreateOptions {
  return {
    databaseUrl: readStringFlag(args, "--database-url"),
    maintenanceUrl: readStringFlag(args, "--maintenance-url"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run db:create
  bun run db:create -- --database-url postgres://mcb@localhost:5432/jobs

Options:
  --database-url     Target local Postgres database URL. Defaults to DATABASE_URL or postgres://$USER@localhost:5432/jobs.
  --maintenance-url  Local maintenance database URL used for CREATE DATABASE. Defaults to the same server's postgres database.

Creates the database only when missing. Refuses non-local Postgres hosts.`);
}

async function runPsql(url: string, sql: string): Promise<string> {
  const proc = Bun.spawn(["psql", url, "-X", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-q", "-c", sql], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `psql exited with code ${exitCode}`);
  }

  return stdout.trim();
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  const config = resolveLocalDatabaseConfig({
    databaseUrl: options.databaseUrl ?? process.env.DATABASE_URL ?? null,
    maintenanceUrl: options.maintenanceUrl,
    env: process.env,
  });

  const exists = await runPsql(config.maintenanceUrl, buildDatabaseExistsSql(config.databaseName));
  if (exists === "true") {
    console.log(`database already exists: ${config.databaseName}`);
  } else if (exists === "false") {
    await runPsql(
      config.maintenanceUrl,
      buildCreateDatabaseSql(config.databaseName, config.owner),
    );
    console.log(`database created: ${config.databaseName}`);
  } else {
    throw new Error(`Unexpected database existence result from psql: ${exists}`);
  }

  console.log(`DATABASE_URL=${config.targetUrl}`);
  console.log("Next: bun run db:migrate && bun run db:check");
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
