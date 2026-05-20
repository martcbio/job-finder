import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JOB_SEARCH_SCHEMA, quoteSqlLiteral } from "./config";
import { runPsql, runPsqlJson } from "./psql";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/migrations", import.meta.url));
const MIGRATION_FILENAME_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;

export interface Migration {
  version: string;
  filename: string;
  checksum: string;
  sql: string;
}

export interface AppliedMigration {
  version: string;
  filename: string;
  checksum: string;
  appliedAt: string;
}

export interface MigrationPlan {
  applied: Migration[];
  pending: Migration[];
}

export function parseMigrationVersion(filename: string): string {
  const match = MIGRATION_FILENAME_RE.exec(filename);
  if (!match?.[1]) {
    throw new Error(`Invalid migration filename "${filename}". Expected 001_description.sql`);
  }
  return match[1];
}

export function checksumSql(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export async function loadMigrations(migrationsDir = MIGRATIONS_DIR): Promise<Migration[]> {
  const filenames = (await readdir(migrationsDir))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  const migrations: Migration[] = [];
  const seenVersions = new Set<string>();
  for (const filename of filenames) {
    const version = parseMigrationVersion(filename);
    if (seenVersions.has(version)) {
      throw new Error(`Duplicate migration version "${version}"`);
    }
    seenVersions.add(version);

    const sql = await Bun.file(join(migrationsDir, filename)).text();
    migrations.push({
      version,
      filename,
      checksum: checksumSql(sql),
      sql,
    });
  }

  return migrations;
}

export async function getAppliedMigrations(): Promise<AppliedMigration[]> {
  const exists = await runPsqlJson<boolean>(
    `SELECT to_json(to_regclass(${quoteSqlLiteral(`${JOB_SEARCH_SCHEMA}.schema_migrations`)}) IS NOT NULL);`,
    { setSearchPath: false },
  );
  if (!exists) return [];

  return runPsqlJson<AppliedMigration[]>(
    `SELECT COALESCE(
       json_agg(
         json_build_object(
           'version', version,
           'filename', filename,
           'checksum', checksum,
           'appliedAt', applied_at
         )
         ORDER BY version
       ),
       '[]'::json
     )
     FROM ${JOB_SEARCH_SCHEMA}.schema_migrations;`,
    { setSearchPath: false },
  );
}

export async function planMigrations(migrations?: Migration[]): Promise<MigrationPlan> {
  const localMigrations = migrations ?? (await loadMigrations());
  const appliedRows = await getAppliedMigrations();
  const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row]));
  const applied: Migration[] = [];
  const pending: Migration[] = [];

  for (const migration of localMigrations) {
    const appliedRow = appliedByVersion.get(migration.version);
    if (!appliedRow) {
      pending.push(migration);
      continue;
    }

    if (appliedRow.checksum !== migration.checksum) {
      throw new Error(
        `Migration checksum drift for ${migration.filename}: database has ${appliedRow.checksum}, file has ${migration.checksum}`,
      );
    }
    if (appliedRow.filename !== migration.filename) {
      throw new Error(
        `Migration filename drift for version ${migration.version}: database has ${appliedRow.filename}, file is ${migration.filename}`,
      );
    }
    applied.push(migration);
  }

  return { applied, pending };
}

export function buildMigrationTransaction(migration: Migration): string {
  return `BEGIN;
${migration.sql}
INSERT INTO ${JOB_SEARCH_SCHEMA}.schema_migrations (version, filename, checksum)
VALUES (${quoteSqlLiteral(migration.version)}, ${quoteSqlLiteral(migration.filename)}, ${quoteSqlLiteral(migration.checksum)});
COMMIT;`;
}

export async function applyPendingMigrations(): Promise<MigrationPlan> {
  const migrations = await loadMigrations();
  const plan = await planMigrations(migrations);

  for (const migration of plan.pending) {
    await runPsql(buildMigrationTransaction(migration), { setSearchPath: false });
  }

  return plan;
}

export function migrationDisplayName(migration: Pick<Migration, "filename" | "checksum">): string {
  return `${basename(migration.filename)} (${migration.checksum.slice(0, 12)})`;
}
