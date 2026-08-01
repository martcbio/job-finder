import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JOB_SEARCH_SCHEMA, quoteSqlLiteral } from "./config";
import { type PsqlResult, type PsqlSession, runPsql, runPsqlJson, withPsqlSession } from "./psql";

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

export interface MigrationExecutor {
  runPsql(sql: string, options?: { setSearchPath?: boolean }): Promise<PsqlResult>;
  runPsqlJson<T>(sql: string, options?: { setSearchPath?: boolean }): Promise<T>;
}

export interface ApplyMigrationsOptions {
  loadMigrations?: () => Promise<Migration[]>;
  withSession?: <T>(callback: (session: PsqlSession) => Promise<T>) => Promise<T>;
}

const systemMigrationExecutor: MigrationExecutor = { runPsql, runPsqlJson };
const MIGRATION_ADVISORY_LOCK = "job_search.schema_migrations";

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

export async function getAppliedMigrations(
  executor: MigrationExecutor = systemMigrationExecutor,
): Promise<AppliedMigration[]> {
  const exists = await executor.runPsqlJson<boolean>(
    `SELECT to_json(to_regclass(${quoteSqlLiteral(`${JOB_SEARCH_SCHEMA}.schema_migrations`)}) IS NOT NULL);`,
    { setSearchPath: false },
  );
  if (!exists) return [];

  return executor.runPsqlJson<AppliedMigration[]>(
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

export function assertAppliedMigrationsKnown(
  appliedRows: AppliedMigration[],
  localMigrations: Migration[],
): void {
  const localByVersion = new Map(
    localMigrations.map((migration) => [migration.version, migration]),
  );
  for (const applied of appliedRows) {
    if (!localByVersion.has(applied.version)) {
      throw new Error(
        `Database contains migration ${applied.version} (${applied.filename}) unknown to this checkout; refusing to migrate a newer schema`,
      );
    }
  }
}

export async function planMigrations(
  migrations?: Migration[],
  executor: MigrationExecutor = systemMigrationExecutor,
): Promise<MigrationPlan> {
  const localMigrations = migrations ?? (await loadMigrations());
  const appliedRows = await getAppliedMigrations(executor);
  assertAppliedMigrationsKnown(appliedRows, localMigrations);
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

export function migrationAdvisoryLockSql(): string {
  return `SELECT pg_advisory_lock(hashtext(${quoteSqlLiteral(MIGRATION_ADVISORY_LOCK)}));`;
}

export function migrationAdvisoryUnlockSql(): string {
  return `SELECT pg_advisory_unlock(hashtext(${quoteSqlLiteral(MIGRATION_ADVISORY_LOCK)}));`;
}

export async function applyPendingMigrations(
  options: ApplyMigrationsOptions = {},
): Promise<MigrationPlan> {
  const load = options.loadMigrations ?? loadMigrations;
  const withSession = options.withSession ?? withPsqlSession;

  return withSession(async (session) => {
    let lockHeld = false;
    let primaryFailure: unknown;
    let didFail = false;
    let result: MigrationPlan | undefined;
    try {
      await session.runPsql(migrationAdvisoryLockSql(), { setSearchPath: false });
      lockHeld = true;

      const migrations = await load();
      const plan = await planMigrations(migrations, session);
      for (const migration of plan.pending) {
        await session.runPsql(buildMigrationTransaction(migration), { setSearchPath: false });
      }

      result = plan;
    } catch (err) {
      didFail = true;
      primaryFailure = err;
    }

    if (lockHeld) {
      try {
        await session.runPsql(migrationAdvisoryUnlockSql(), { setSearchPath: false });
      } catch (unlockError) {
        if (!didFail) throw unlockError;
      }
    }

    if (didFail) throw primaryFailure;
    if (!result) throw new Error("Migration application completed without a plan");
    return result;
  });
}

export function migrationDisplayName(migration: Pick<Migration, "filename" | "checksum">): string {
  return `${basename(migration.filename)} (${migration.checksum.slice(0, 12)})`;
}
