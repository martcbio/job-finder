import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  commitIngestRun,
  completeIngestScope,
  createIngestObservation,
  createIngestRun,
  createNormalizedListingVersion,
  linkObservationToVersion,
  prepareIngestRun,
} from "../../pipeline/ingestLedger";
import { buildMigrationTransaction, loadMigrations } from "../migrations";

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const postgresTools = {
  initdb: Bun.which("initdb"),
  pgCtl: Bun.which("pg_ctl"),
  psql: Bun.which("psql"),
};

async function runCommand(command: ReadonlyArray<string>, input?: string): Promise<CommandResult> {
  const child = Bun.spawn([...command], {
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LC_ALL: "C" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function requireSuccess(
  command: ReadonlyArray<string>,
  input?: string,
): Promise<CommandResult> {
  const result = await runCommand(command, input);
  if (result.exitCode !== 0) {
    throw new Error(
      `${basename(command[0] ?? "command")} exited ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  return result;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function unwrap<T>(result: { _tag: "ok"; value: T } | { _tag: "err"; error: unknown }): T {
  if (result._tag === "err") {
    throw new Error(`Expected fixture construction to succeed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

describe("required PostgreSQL integration", () => {
  test("migration 016 enforces ledger state, immutability, provenance, and atomic commit guards", async () => {
    const root = await mkdtemp(join(tmpdir(), "jobsradar-ledger-postgres-"));
    const dataDirectory = join(root, "data");
    const initdb = postgresTools.initdb;
    const pgCtl = postgresTools.pgCtl;
    const psql = postgresTools.psql;
    if (initdb === null || pgCtl === null || psql === null) {
      throw new Error("PostgreSQL integration test requires initdb, pg_ctl, and psql");
    }
    const psqlCommand = [psql, "-X", "-v", "ON_ERROR_STOP=1", "-h", root, "-d", "postgres"];
    let started = false;

    const executeSql = async (sql: string): Promise<CommandResult> => runCommand(psqlCommand, sql);
    const queryScalar = async (sql: string): Promise<string> => {
      const result = await requireSuccess([...psqlCommand, "-At"], sql);
      return result.stdout.trim();
    };
    const expectSqlFailure = async (sql: string, message: string): Promise<void> => {
      const result = await executeSql(sql);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(message);
    };

    try {
      await requireSuccess([
        initdb,
        "-D",
        dataDirectory,
        "--no-locale",
        "--encoding=UTF8",
        "--auth=trust",
      ]);
      await requireSuccess([
        pgCtl,
        "-D",
        dataDirectory,
        "-o",
        `-F -c listen_addresses='' -k ${root}`,
        "-l",
        join(root, "postgres.log"),
        "-w",
        "start",
      ]);
      started = true;

      await requireSuccess(
        psqlCommand,
        `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE ROLE ledger_reader LOGIN;
CREATE ROLE ledger_runtime LOGIN;
ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
`,
      );
      const migrations = await loadMigrations();
      expect(
        migrations.some((migration) => migration.filename === "016_add_ingest_ledger.sql"),
      ).toBe(true);
      const migrationSql = migrations.map(buildMigrationTransaction).join("\n");
      await requireSuccess(psqlCommand, migrationSql);
      await requireSuccess(
        psqlCommand,
        `
REVOKE USAGE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA job_search TO ledger_reader, ledger_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA job_search TO ledger_reader, ledger_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA job_search TO ledger_runtime;
GRANT INSERT, UPDATE ON
  job_search.ingest_runs,
  job_search.ingest_source_scopes
TO ledger_runtime;
GRANT INSERT ON
  job_search.ingest_observations,
  job_search.ingest_listing_versions,
  job_search.ingest_run_listing_versions,
  job_search.ingest_observation_versions
TO ledger_runtime;
GRANT EXECUTE ON FUNCTION job_search.commit_ingest_run(bigint, text, jsonb, text)
  TO ledger_runtime;
`,
      );
      const runtimePsqlCommand = [...psqlCommand, "-U", "ledger_runtime"];
      const readerPsqlCommand = [...psqlCommand, "-U", "ledger_reader"];
      const queryRuntimeScalar = async (sql: string): Promise<string> => {
        const result = await requireSuccess([...runtimePsqlCommand, "-At"], sql);
        return result.stdout.trim();
      };
      const expectRuntimeSqlFailure = async (sql: string, message: string): Promise<void> => {
        const result = await runCommand(runtimePsqlCommand, sql);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain(message);
      };
      const expectReaderSqlFailure = async (sql: string, message: string): Promise<void> => {
        const result = await runCommand(readerPsqlCommand, sql);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain(message);
      };
      expect(
        await queryScalar(`
SELECT
  has_function_privilege(
    'ledger_runtime',
    'job_search.commit_ingest_run(bigint, text, jsonb, text)',
    'EXECUTE'
  )::text
  || ':'
  || has_function_privilege(
    'ledger_reader',
    'job_search.commit_ingest_run(bigint, text, jsonb, text)',
    'EXECUTE'
  )::text
  || ':'
  || has_function_privilege(
    'anon',
    'job_search.commit_ingest_run(bigint, text, jsonb, text)',
    'EXECUTE'
  )::text
  || ':'
  || has_function_privilege(
    'authenticated',
    'job_search.commit_ingest_run(bigint, text, jsonb, text)',
    'EXECUTE'
  )::text
  || ':'
  || has_function_privilege(
    'service_role',
    'job_search.commit_ingest_run(bigint, text, jsonb, text)',
    'EXECUTE'
  )::text
  || ':'
  || NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) privilege
    WHERE function_row.oid =
      'job_search.commit_ingest_run(bigint, text, jsonb, text)'::regprocedure
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  );
`),
      ).toBe("true:false:false:false:false:true");
      await expectReaderSqlFailure(
        `
SELECT job_search.commit_ingest_run(
  0,
  ${sqlLiteral("0".repeat(64))},
  '{}'::jsonb,
  '2026-07-30T10:03:00.000Z'
);
`,
        "permission denied for function commit_ingest_run",
      );
      expect(
        await queryRuntimeScalar(`
SELECT job_search.canonical_json_sha256(
  '{"large":1e21,"small":1e-7,"negativeZero":-0}'::jsonb
);
`),
      ).toBe("0b84b7d37b125a0d276554fcabbc329066829ec10a48fac01f8ee683b216dbb5");
      expect(
        await queryRuntimeScalar(`
SELECT
  job_search.json_numbers_fit_typescript(
    '{"nested":[1e21,0.1,5e-324,1.7976931348623157e308]}'::jsonb
  )::text
  || ':'
  || job_search.json_numbers_fit_typescript('9007199254740993'::jsonb)::text
  || ':'
  || job_search.json_numbers_fit_typescript(
    '0.12345678901234567890123456789'::jsonb
  )::text
  || ':'
  || job_search.json_numbers_fit_typescript('1e400'::jsonb)::text;
`),
      ).toBe("false:false:false:false");
      expect(
        await queryRuntimeScalar(`
WITH hostile AS MATERIALIZED (
  SELECT set_config('extra_float_digits', '-15', false) AS setting
)
SELECT
  hostile.setting
  || ':'
  || job_search.json_numbers_fit_typescript(
    '{"nested":[0.12345678901234568]}'::jsonb
  )::text
  || ':'
  || job_search.json_numbers_fit_typescript(
    '{"nested":[0.12345678901234567890123456789]}'::jsonb
  )::text
FROM hostile;
`),
      ).toBe("-15:true:false");
      await requireSuccess(psqlCommand, "CREATE DATABASE extensions_layout;");
      const extensionsPsqlCommand = [
        psql,
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-h",
        root,
        "-d",
        "extensions_layout",
      ];
      await requireSuccess(
        extensionsPsqlCommand,
        "CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;",
      );
      await requireSuccess(extensionsPsqlCommand, migrationSql);
      await requireSuccess(
        extensionsPsqlCommand,
        "GRANT USAGE ON SCHEMA job_search TO ledger_runtime;",
      );
      const extensionsRuntimePsqlCommand = [...extensionsPsqlCommand, "-U", "ledger_runtime"];
      expect(
        (
          await requireSuccess(
            [...extensionsPsqlCommand, "-At"],
            `
SELECT extension_namespace.nspname
  || ':' || job_search.canonical_json_text(
    '{"large":1e21,"small":1e-7,"negativeZero":-0}'::jsonb
  )
  || ':' || job_search.canonical_json_sha256(
    '{"large":1e21,"small":1e-7,"negativeZero":-0}'::jsonb
  )
FROM pg_catalog.pg_extension extension
JOIN pg_catalog.pg_namespace extension_namespace
  ON extension_namespace.oid = extension.extnamespace
WHERE extension.extname = 'pgcrypto';
`,
          )
        ).stdout.trim(),
      ).toBe(
        'extensions:{"large":1000000000000000000000,"negativeZero":0,"small":0.0000001}:0b84b7d37b125a0d276554fcabbc329066829ec10a48fac01f8ee683b216dbb5',
      );
      expect(
        (
          await requireSuccess(
            [...extensionsRuntimePsqlCommand, "-At"],
            `
SELECT has_schema_privilege('ledger_runtime', 'extensions', 'USAGE')::text
  || ':'
  || job_search.canonical_json_sha256(
    '{"large":1e21,"small":1e-7,"negativeZero":-0}'::jsonb
  );
`,
          )
        ).stdout.trim(),
      ).toBe("false:0b84b7d37b125a0d276554fcabbc329066829ec10a48fac01f8ee683b216dbb5");

      const observedAt = "2026-07-30T10:00:00.000Z";
      const collecting = unwrap(
        createIngestRun({
          producer: "postgres-integration",
          scopes: [
            {
              sourceId: "greenhouse",
              scopeKey: "openai:all",
              request: { page: 1 },
            },
          ],
        }),
      );
      const scope = collecting.scopes[0];
      if (scope === undefined) throw new Error("Expected one ingest scope");
      const observation = unwrap(
        createIngestObservation({
          scopeHash: scope.scopeHash,
          sourceRecordKey: "openai:123",
          observedAt,
          raw: { title: "Engineer" },
        }),
      );
      const microsecondObservation = unwrap(
        createIngestObservation({
          scopeHash: scope.scopeHash,
          sourceRecordKey: "openai:microsecond",
          observedAt,
          raw: { title: "Microsecond boundary" },
        }),
      );
      const versionCreation = unwrap(
        createNormalizedListingVersion(collecting, scope.scopeHash, {
          listingKey: "greenhouse:openai:123",
          normalizer: "radar-v1",
          normalized: { title: "Engineer" },
        }),
      );
      const version = versionCreation.version;
      const edge = linkObservationToVersion(observation, version);
      const complete = unwrap(
        completeIngestScope(versionCreation.run, scope.scopeHash, "2026-07-30T10:01:00.000Z", [
          observation,
        ]),
      );
      const ready = unwrap(prepareIngestRun(complete, "2026-07-30T10:02:00.000Z"));
      const committed = unwrap(commitIngestRun(ready, "2026-07-30T10:03:00.000Z", [edge]));
      const scopePlan = collecting.scopes.map((plannedScope) => ({
        sourceId: plannedScope.sourceId,
        scopeKey: plannedScope.scopeKey,
        scopeHash: plannedScope.scopeHash,
        request: plannedScope.request,
      }));

      await requireSuccess(
        runtimePsqlCommand,
        `
INSERT INTO job_search.ingest_runs
  (run_hash, producer, contract_version, scope_plan, created_at)
VALUES (
  ${sqlLiteral(collecting.runHash)},
  'postgres-integration',
  1,
  ${sqlLiteral(JSON.stringify(scopePlan))}::jsonb,
  '2000-01-01T00:00:00.000Z'
);
INSERT INTO job_search.ingest_source_scopes
  (run_id, scope_hash, source_id, scope_key, request_payload)
SELECT id, ${sqlLiteral(scope.scopeHash)}, 'greenhouse', 'openai:all', '{"page":1}'::jsonb
FROM job_search.ingest_runs WHERE run_hash = ${sqlLiteral(collecting.runHash)};
INSERT INTO job_search.ingest_observations
  (scope_id, observation_hash, source_record_key, observed_at, raw_payload, created_at)
SELECT
  id,
  ${sqlLiteral(observation.observationHash)},
  'openai:123',
  ${sqlLiteral(observedAt)},
  '{"title":"Engineer"}'::jsonb,
  '2001-01-01T00:00:00.000Z'
FROM job_search.ingest_source_scopes WHERE scope_hash = ${sqlLiteral(scope.scopeHash)};
INSERT INTO job_search.ingest_listing_versions
  (created_by_scope_id, contract_version, version_hash, listing_key, normalizer, normalized_payload, created_at)
SELECT
  id,
  1,
  ${sqlLiteral(version.versionHash)},
  'greenhouse:openai:123',
  'radar-v1',
  '{"title":"Engineer"}'::jsonb,
  '2002-01-01T00:00:00.000Z'
FROM job_search.ingest_source_scopes WHERE scope_hash = ${sqlLiteral(scope.scopeHash)};
INSERT INTO job_search.ingest_observation_versions
  (observation_id, listing_version_id, created_at)
SELECT observation.id, listing_version.id, '1999-01-01T00:00:00.000Z'
FROM job_search.ingest_observations observation
CROSS JOIN job_search.ingest_listing_versions listing_version
WHERE observation.observation_hash = ${sqlLiteral(observation.observationHash)}
  AND listing_version.version_hash = ${sqlLiteral(version.versionHash)};
`,
      );
      expect(
        await queryScalar(`
SELECT
  (ingest_run.created_at <> '2000-01-01T00:00:00.000Z')::text
  || ':'
  || (observation.created_at <> '2001-01-01T00:00:00.000Z')::text
  || ':'
  || (listing_version.created_at <> '2002-01-01T00:00:00.000Z')::text
  || ':'
  || (provenance.created_at <> '1999-01-01T00:00:00.000Z')::text
  || ':'
  || (
    provenance.created_at >= observation.created_at
    AND provenance.created_at >= listing_version.created_at
  )::text
FROM job_search.ingest_runs ingest_run
JOIN job_search.ingest_source_scopes source_scope ON source_scope.run_id = ingest_run.id
JOIN job_search.ingest_observations observation ON observation.scope_id = source_scope.id
JOIN job_search.ingest_observation_versions provenance
  ON provenance.observation_id = observation.id
JOIN job_search.ingest_listing_versions listing_version
  ON listing_version.id = provenance.listing_version_id
WHERE ingest_run.run_hash = ${sqlLiteral(collecting.runHash)};
`),
      ).toBe("true:true:true:true:true");

      await expectSqlFailure(
        `
INSERT INTO job_search.ingest_observations
  (scope_id, observation_hash, source_record_key, observed_at, raw_payload)
SELECT
  id,
  ${sqlLiteral(microsecondObservation.observationHash)},
  'openai:microsecond',
  '2026-07-30T10:00:00.000001Z',
  '{"title":"Microsecond boundary"}'::jsonb
FROM job_search.ingest_source_scopes
WHERE scope_hash = ${sqlLiteral(scope.scopeHash)};
`,
        "ingest_observations_observed_at_millisecond",
      );
      await expectSqlFailure(
        `
INSERT INTO job_search.ingest_observations
  (scope_id, observation_hash, source_record_key, observed_at, raw_payload)
SELECT
  id,
  job_search.canonical_json_sha256(jsonb_build_object(
    'contractVersion', 1,
    'scopeHash', scope_hash,
    'sourceRecordKey', ' padded-record ',
    'observedAt', '2026-07-30T10:00:00.000Z',
    'raw', '{}'::jsonb
  )),
  ' padded-record ',
  '2026-07-30T10:00:00.000Z',
  '{}'::jsonb
FROM job_search.ingest_source_scopes
WHERE scope_hash = ${sqlLiteral(scope.scopeHash)};
`,
        "ingest_observations_source_record_key_canonical",
      );
      await expectSqlFailure(
        `
INSERT INTO job_search.ingest_listing_versions
  (created_by_scope_id, contract_version, version_hash, listing_key, normalizer, normalized_payload)
SELECT
  id,
  1,
  job_search.canonical_json_sha256(jsonb_build_object(
    'contractVersion', 1,
    'listingKey', ' padded-listing ',
    'normalizer', 'radar-v1',
    'normalized', '{}'::jsonb
  )),
  ' padded-listing ',
  'radar-v1',
  '{}'::jsonb
FROM job_search.ingest_source_scopes
WHERE scope_hash = ${sqlLiteral(scope.scopeHash)};
`,
        "ingest_listing_versions_listing_key_canonical",
      );
      await expectSqlFailure(
        `
INSERT INTO job_search.ingest_listing_versions
  (created_by_scope_id, contract_version, version_hash, listing_key, normalizer, normalized_payload)
SELECT
  id,
  1,
  job_search.canonical_json_sha256(jsonb_build_object(
    'contractVersion', 1,
    'listingKey', 'greenhouse:test',
    'normalizer', ' padded-normalizer ',
    'normalized', '{}'::jsonb
  )),
  'greenhouse:test',
  ' padded-normalizer ',
  '{}'::jsonb
FROM job_search.ingest_source_scopes
WHERE scope_hash = ${sqlLiteral(scope.scopeHash)};
`,
        "ingest_listing_versions_normalizer_canonical",
      );
      await expectSqlFailure(
        `
INSERT INTO job_search.ingest_listing_versions
  (created_by_scope_id, contract_version, version_hash, listing_key, normalizer, normalized_payload)
SELECT
  id,
  2,
  job_search.canonical_json_sha256(jsonb_build_object(
    'contractVersion', 2,
    'listingKey', 'greenhouse:contract-v2',
    'normalizer', 'radar-v2',
    'normalized', '{}'::jsonb
  )),
  'greenhouse:contract-v2',
  'radar-v2',
  '{}'::jsonb
FROM job_search.ingest_source_scopes
WHERE scope_hash = ${sqlLiteral(scope.scopeHash)};
`,
        "contract_version does not match its parent run",
      );
      await expectSqlFailure(
        `
UPDATE job_search.ingest_source_scopes
SET status = 'complete', completed_at = '2026-07-30T10:01:00.000001Z', result_count = 1
WHERE scope_hash = ${sqlLiteral(scope.scopeHash)};
`,
        "ingest_source_scopes_completed_at_millisecond",
      );
      await expectRuntimeSqlFailure(
        `
UPDATE job_search.ingest_source_scopes
SET status = 'running', started_at = '2026-07-30T10:00:00.001Z'
WHERE scope_hash = ${sqlLiteral(scope.scopeHash)};
`,
        "source scope started_at cannot follow a persisted observation observed_at",
      );
      await expectRuntimeSqlFailure(
        `
UPDATE job_search.ingest_source_scopes
SET status = 'complete', completed_at = '2026-07-30T09:59:59.999Z', result_count = 1
WHERE scope_hash = ${sqlLiteral(scope.scopeHash)};
`,
        "source scope completed_at cannot precede a persisted observation observed_at",
      );
      await requireSuccess(
        psqlCommand,
        `
UPDATE job_search.ingest_source_scopes
SET status = 'complete', completed_at = '2026-07-30T10:01:00.000Z', result_count = 1
WHERE scope_hash = ${sqlLiteral(scope.scopeHash)};
`,
      );
      await expectRuntimeSqlFailure(
        `
UPDATE job_search.ingest_runs
SET status = 'ready', ready_at = '2026-07-30T10:00:59.999Z'
WHERE run_hash = ${sqlLiteral(collecting.runHash)};
`,
        "ingest run ready_at cannot precede a source scope completed_at",
      );
      expect(
        await queryScalar(
          `SELECT status FROM job_search.ingest_runs WHERE run_hash = ${sqlLiteral(collecting.runHash)};`,
        ),
      ).toBe("collecting");
      await expectSqlFailure(
        `
UPDATE job_search.ingest_runs
SET status = 'ready', ready_at = '2026-07-30T10:02:00.000001Z'
WHERE run_hash = ${sqlLiteral(collecting.runHash)};
`,
        "ingest_runs_ready_at_millisecond",
      );
      await requireSuccess(
        psqlCommand,
        `
UPDATE job_search.ingest_runs
SET status = 'ready', ready_at = '2026-07-30T10:02:00.000Z'
WHERE run_hash = ${sqlLiteral(collecting.runHash)};
`,
      );

      await expectSqlFailure(
        `
BEGIN;
ALTER TABLE job_search.ingest_runs DISABLE TRIGGER ingest_runs_guard_transition;
UPDATE job_search.ingest_runs
SET status = 'committed', committed_at = '2026-07-30T10:01:59.999Z'
WHERE run_hash = ${sqlLiteral(collecting.runHash)};
`,
        "ingest_runs_committed_after_ready",
      );
      await expectRuntimeSqlFailure(
        `
SELECT job_search.commit_ingest_run(
  (SELECT id FROM job_search.ingest_runs WHERE run_hash = ${sqlLiteral(collecting.runHash)}),
  ${sqlLiteral(committed.manifest.manifestHash)},
  ${sqlLiteral(JSON.stringify(committed.manifest.payload))}::jsonb,
  '2026-07-30T10:01:59.999Z'
);
`,
        "ingest run committed_at cannot precede ready_at",
      );
      await expectSqlFailure(
        `
INSERT INTO job_search.ingest_commit_manifests (
  run_id,
  manifest_hash,
  manifest_payload,
  scope_count,
  observation_count,
  listing_version_count,
  edge_count,
  committed_at
)
SELECT
  id,
  ${sqlLiteral(committed.manifest.manifestHash)},
  ${sqlLiteral(JSON.stringify(committed.manifest.payload))}::jsonb,
  1,
  1,
  1,
  1,
  '2026-07-30T10:01:59.999Z'
FROM job_search.ingest_runs
WHERE run_hash = ${sqlLiteral(collecting.runHash)};
`,
        "ingest manifest committed_at cannot precede ingest run ready_at",
      );
      await expectSqlFailure(
        `
SELECT job_search.commit_ingest_run(
  (SELECT id FROM job_search.ingest_runs WHERE run_hash = ${sqlLiteral(collecting.runHash)}),
  ${sqlLiteral(committed.manifest.manifestHash)},
  ${sqlLiteral(JSON.stringify(committed.manifest.payload))}::jsonb,
  '2026-07-30T10:03:00.000001Z'
);
`,
        "committed_at must be an exact UTC ISO-8601 millisecond timestamp",
      );
      await expectSqlFailure(
        `
SELECT job_search.commit_ingest_run(
  (SELECT id FROM job_search.ingest_runs WHERE run_hash = ${sqlLiteral(collecting.runHash)}),
  ${sqlLiteral(committed.manifest.manifestHash)},
  '{"tampered":true}'::jsonb,
  ${sqlLiteral(committed.committedAt)}
);
`,
        "ingest manifest payload does not match persisted ledger rows",
      );
      expect(
        await queryScalar(`
SELECT status || ':' || (
  SELECT count(*) FROM job_search.ingest_commit_manifests manifest
  WHERE manifest.run_id = ingest_run.id
)::text
FROM job_search.ingest_runs ingest_run
WHERE run_hash = ${sqlLiteral(collecting.runHash)};
`),
      ).toBe("ready:0");

      await expectRuntimeSqlFailure(
        `
INSERT INTO job_search.ingest_commit_manifests (
  run_id,
  manifest_hash,
  manifest_payload,
  scope_count,
  observation_count,
  listing_version_count,
  edge_count
)
SELECT
  id,
  ${sqlLiteral(committed.manifest.manifestHash)},
  ${sqlLiteral(JSON.stringify(committed.manifest.payload))}::jsonb,
  1,
  1,
  1,
  1
FROM job_search.ingest_runs
WHERE run_hash = ${sqlLiteral(collecting.runHash)};
`,
        "permission denied for table ingest_commit_manifests",
      );
      expect(
        await queryScalar(`
SELECT status || ':' || (
  SELECT count(*) FROM job_search.ingest_commit_manifests manifest
  WHERE manifest.run_id = ingest_run.id
)::text
FROM job_search.ingest_runs ingest_run
WHERE run_hash = ${sqlLiteral(collecting.runHash)};
`),
      ).toBe("ready:0");

      await expectSqlFailure(
        `
SELECT job_search.commit_ingest_run(
  (SELECT id FROM job_search.ingest_runs WHERE run_hash = ${sqlLiteral(collecting.runHash)}),
  ${sqlLiteral("0".repeat(64))},
  ${sqlLiteral(JSON.stringify(committed.manifest.payload))}::jsonb,
  ${sqlLiteral(committed.committedAt)}
);
`,
        "ingest manifest hash does not match canonical payload",
      );
      expect(
        await queryScalar(`
SELECT status || ':' || (
  SELECT count(*) FROM job_search.ingest_commit_manifests manifest
  WHERE manifest.run_id = ingest_run.id
)::text
FROM job_search.ingest_runs ingest_run
WHERE run_hash = ${sqlLiteral(collecting.runHash)};
`),
      ).toBe("ready:0");

      await expectSqlFailure(
        `
BEGIN;
INSERT INTO job_search.ingest_commit_manifests (
  run_id,
  manifest_hash,
  manifest_payload,
  scope_count,
  observation_count,
  listing_version_count,
  edge_count,
  committed_at
)
SELECT
  id,
  ${sqlLiteral(committed.manifest.manifestHash)},
  ${sqlLiteral(JSON.stringify(committed.manifest.payload))}::jsonb,
  1,
  1,
  1,
  1,
  ${sqlLiteral(committed.committedAt)}
FROM job_search.ingest_runs
WHERE run_hash = ${sqlLiteral(collecting.runHash)};
UPDATE job_search.ingest_runs
SET status = 'committed', committed_at = '2026-07-30T10:03:00.001Z'
WHERE run_hash = ${sqlLiteral(collecting.runHash)};
`,
        "ingest run committed_at must equal its manifest committed_at",
      );
      const firstManifestId = await queryRuntimeScalar(`
SELECT job_search.commit_ingest_run(
  ingest_run.id,
  ${sqlLiteral(committed.manifest.manifestHash)},
  ${sqlLiteral(JSON.stringify(committed.manifest.payload))}::jsonb,
  ${sqlLiteral(committed.committedAt)}
)
FROM job_search.ingest_runs ingest_run
WHERE run_hash = ${sqlLiteral(collecting.runHash)};
`);
      const replayManifestId = await queryRuntimeScalar(`
SELECT job_search.commit_ingest_run(
  ingest_run.id,
  ${sqlLiteral(committed.manifest.manifestHash)},
  ${sqlLiteral(JSON.stringify(committed.manifest.payload))}::jsonb,
  ${sqlLiteral(committed.committedAt)}
)
FROM job_search.ingest_runs ingest_run
WHERE run_hash = ${sqlLiteral(collecting.runHash)};
      `);
      expect(replayManifestId).toBe(firstManifestId);
      await expectRuntimeSqlFailure(
        `
SELECT job_search.commit_ingest_run(
  ingest_run.id,
  ${sqlLiteral(committed.manifest.manifestHash)},
  ${sqlLiteral(JSON.stringify(committed.manifest.payload))}::jsonb,
  '2026-07-30T10:03:00.001Z'
)
FROM job_search.ingest_runs ingest_run
WHERE run_hash = ${sqlLiteral(collecting.runHash)};
`,
        "different manifest or committed_at",
      );
      expect(
        await queryScalar(
          `SELECT status FROM job_search.ingest_runs WHERE run_hash = ${sqlLiteral(collecting.runHash)};`,
        ),
      ).toBe("committed");
      expect(
        await queryScalar(`
SELECT
  to_char(ingest_run.committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  || ':'
  || to_char(manifest.committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM job_search.ingest_runs ingest_run
JOIN job_search.ingest_commit_manifests manifest ON manifest.run_id = ingest_run.id
WHERE ingest_run.run_hash = ${sqlLiteral(collecting.runHash)};
`),
      ).toBe(`${committed.committedAt}:${committed.committedAt}`);

      await expectSqlFailure(
        `
UPDATE job_search.ingest_observations
SET raw_payload = '{"title":"Changed"}'::jsonb
WHERE observation_hash = ${sqlLiteral(observation.observationHash)};
`,
        "is committed, not collecting",
      );
      await expectSqlFailure(
        `
DELETE FROM job_search.ingest_commit_manifests
WHERE manifest_hash = ${sqlLiteral(committed.manifest.manifestHash)};
`,
        "ingest ledger rows are immutable",
      );

      await expectSqlFailure(
        `
INSERT INTO job_search.ingest_source_scopes
  (run_id, scope_hash, source_id, scope_key, request_payload)
SELECT id, ${sqlLiteral("f".repeat(64))}, 'ashby', 'late-scope', '{}'::jsonb
FROM job_search.ingest_runs WHERE run_hash = ${sqlLiteral(collecting.runHash)};
`,
        "is committed, not collecting",
      );

      const lifecycleRun = unwrap(
        createIngestRun({
          producer: "scope-lifecycle-integration",
          scopes: [
            { sourceId: "fixture", scopeKey: "running-terminal", request: {} },
            { sourceId: "fixture", scopeKey: "pending-terminal", request: {} },
          ],
        }),
      );
      const runningTerminalScope = lifecycleRun.scopes.find(
        (candidate) => candidate.scopeKey === "running-terminal",
      );
      const pendingTerminalScope = lifecycleRun.scopes.find(
        (candidate) => candidate.scopeKey === "pending-terminal",
      );
      if (runningTerminalScope === undefined || pendingTerminalScope === undefined) {
        throw new Error("Expected both lifecycle scopes");
      }
      const lifecycleScopePlan = lifecycleRun.scopes.map((plannedScope) => ({
        sourceId: plannedScope.sourceId,
        scopeKey: plannedScope.scopeKey,
        scopeHash: plannedScope.scopeHash,
        request: plannedScope.request,
      }));
      await requireSuccess(
        runtimePsqlCommand,
        `
INSERT INTO job_search.ingest_runs (run_hash, producer, contract_version, scope_plan)
VALUES (
  ${sqlLiteral(lifecycleRun.runHash)},
  'scope-lifecycle-integration',
  1,
  ${sqlLiteral(JSON.stringify(lifecycleScopePlan))}::jsonb
);
INSERT INTO job_search.ingest_source_scopes
  (run_id, scope_hash, source_id, scope_key, request_payload)
SELECT id, ${sqlLiteral(runningTerminalScope.scopeHash)}, 'fixture', 'running-terminal', '{}'::jsonb
FROM job_search.ingest_runs WHERE run_hash = ${sqlLiteral(lifecycleRun.runHash)};
INSERT INTO job_search.ingest_source_scopes
  (run_id, scope_hash, source_id, scope_key, request_payload)
SELECT id, ${sqlLiteral(pendingTerminalScope.scopeHash)}, 'fixture', 'pending-terminal', '{}'::jsonb
FROM job_search.ingest_runs WHERE run_hash = ${sqlLiteral(lifecycleRun.runHash)};
UPDATE job_search.ingest_source_scopes
SET status = 'running', started_at = '2026-07-30T12:00:00.000Z'
WHERE scope_hash = ${sqlLiteral(runningTerminalScope.scopeHash)};
`,
      );
      await expectRuntimeSqlFailure(
        `
INSERT INTO job_search.ingest_observations
  (scope_id, observation_hash, source_record_key, observed_at, raw_payload)
SELECT
  id,
  ${sqlLiteral("0".repeat(64))},
  'before-running-start',
  '2026-07-30T11:59:59.999Z',
  '{}'::jsonb
FROM job_search.ingest_source_scopes
WHERE scope_hash = ${sqlLiteral(runningTerminalScope.scopeHash)};
`,
        "ingest observation observed_at cannot precede source scope started_at",
      );
      await expectRuntimeSqlFailure(
        `
UPDATE job_search.ingest_source_scopes
SET
  status = 'complete',
  started_at = '2026-07-30T12:00:00.001Z',
  completed_at = '2026-07-30T12:01:00.000Z',
  result_count = 0
WHERE scope_hash = ${sqlLiteral(runningTerminalScope.scopeHash)};
`,
        "started_at is immutable once set",
      );
      await expectRuntimeSqlFailure(
        `
UPDATE job_search.ingest_source_scopes
SET
  status = 'complete',
  started_at = '2026-07-30T12:00:00.000Z',
  completed_at = '2026-07-30T11:59:59.999Z',
  result_count = 0
WHERE scope_hash = ${sqlLiteral(runningTerminalScope.scopeHash)};
`,
        "completed_at cannot precede started_at",
      );
      await expectRuntimeSqlFailure(
        `
UPDATE job_search.ingest_source_scopes
SET
  status = 'failed',
  started_at = '2026-07-30T12:00:00.000Z',
  failed_at = '2026-07-30T11:59:59.999Z',
  failure_code = 'fixture'
WHERE scope_hash = ${sqlLiteral(runningTerminalScope.scopeHash)};
`,
        "failed_at cannot precede started_at",
      );
      await requireSuccess(
        runtimePsqlCommand,
        `
UPDATE job_search.ingest_source_scopes
SET
  status = 'complete',
  started_at = '2026-07-30T12:00:00.000Z',
  completed_at = '2026-07-30T12:01:00.000Z',
  result_count = 0
WHERE scope_hash = ${sqlLiteral(runningTerminalScope.scopeHash)};
`,
      );
      await expectRuntimeSqlFailure(
        `
INSERT INTO job_search.ingest_listing_versions (
  created_by_scope_id,
  contract_version,
  version_hash,
  listing_key,
  normalizer,
  normalized_payload
)
SELECT
  id,
  1,
  ${sqlLiteral("0".repeat(64))},
  'fixture:late-version',
  'radar-v1',
  '{}'::jsonb
FROM job_search.ingest_source_scopes
WHERE scope_hash = ${sqlLiteral(runningTerminalScope.scopeHash)};
`,
        "cannot create a listing version from source scope",
      );
      await expectRuntimeSqlFailure(
        `
UPDATE job_search.ingest_source_scopes
SET
  status = 'failed',
  started_at = '2026-07-30T12:00:00.000Z',
  failed_at = '2026-07-30T12:01:00.000Z',
  failure_code = 'fixture'
WHERE scope_hash = ${sqlLiteral(pendingTerminalScope.scopeHash)};
`,
        "terminal transition must preserve null started_at",
      );
      await requireSuccess(
        runtimePsqlCommand,
        `
UPDATE job_search.ingest_source_scopes
SET
  status = 'failed',
  failed_at = '2026-07-30T12:01:00.000Z',
  failure_code = 'fixture'
WHERE scope_hash = ${sqlLiteral(pendingTerminalScope.scopeHash)};
`,
      );
      expect(
        await queryScalar(`
SELECT string_agg(
  scope_key || ':' || status || ':' || COALESCE(
    to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'null'
  ),
  ',' ORDER BY scope_key
)
FROM job_search.ingest_source_scopes
WHERE run_id = (
  SELECT id FROM job_search.ingest_runs
  WHERE run_hash = ${sqlLiteral(lifecycleRun.runHash)}
);
`),
      ).toBe("pending-terminal:failed:null,running-terminal:complete:2026-07-30T12:00:00.000Z");
      await expectRuntimeSqlFailure(
        `
UPDATE job_search.ingest_runs
SET status = 'failed', failed_at = '2026-07-30T12:00:59.999Z', failure_code = 'fixture'
WHERE run_hash = ${sqlLiteral(lifecycleRun.runHash)};
`,
        "ingest run failed_at cannot precede recorded scope or evidence lifecycle timestamps",
      );
      await requireSuccess(
        runtimePsqlCommand,
        `
UPDATE job_search.ingest_runs
SET status = 'failed', failed_at = '2026-07-30T12:01:00.000Z', failure_code = 'fixture'
WHERE run_hash = ${sqlLiteral(lifecycleRun.runHash)};
`,
      );

      const collectingFailureRun = unwrap(
        createIngestRun({
          producer: "collecting-failure-integration",
          scopes: [{ sourceId: "fixture", scopeKey: "collecting-failure", request: {} }],
        }),
      );
      const collectingFailureScopePlan = collectingFailureRun.scopes.map((plannedScope) => ({
        sourceId: plannedScope.sourceId,
        scopeKey: plannedScope.scopeKey,
        scopeHash: plannedScope.scopeHash,
        request: plannedScope.request,
      }));
      const collectingFailureScope = collectingFailureRun.scopes[0];
      if (collectingFailureScope === undefined) {
        throw new Error("Expected collecting-failure scope");
      }
      await requireSuccess(
        runtimePsqlCommand,
        `
INSERT INTO job_search.ingest_runs (run_hash, producer, contract_version, scope_plan)
VALUES (
  ${sqlLiteral(collectingFailureRun.runHash)},
  'collecting-failure-integration',
  1,
  ${sqlLiteral(JSON.stringify(collectingFailureScopePlan))}::jsonb
);
INSERT INTO job_search.ingest_source_scopes
  (run_id, scope_hash, source_id, scope_key, request_payload)
SELECT
  id,
  ${sqlLiteral(collectingFailureScope.scopeHash)},
  'fixture',
  'collecting-failure',
  '{}'::jsonb
FROM job_search.ingest_runs
WHERE run_hash = ${sqlLiteral(collectingFailureRun.runHash)};
INSERT INTO job_search.ingest_observations
  (scope_id, observation_hash, source_record_key, observed_at, raw_payload)
SELECT
  id,
  job_search.canonical_json_sha256(jsonb_build_object(
    'contractVersion', 1,
    'scopeHash', scope_hash,
    'sourceRecordKey', 'failure-evidence',
    'observedAt', '2026-07-30T13:00:30.000Z',
    'raw', '{}'::jsonb
  )),
  'failure-evidence',
  '2026-07-30T13:00:30.000Z',
  '{}'::jsonb
FROM job_search.ingest_source_scopes
WHERE scope_hash = ${sqlLiteral(collectingFailureScope.scopeHash)};
`,
      );
      await expectRuntimeSqlFailure(
        `
UPDATE job_search.ingest_runs
SET
  status = 'failed',
  ready_at = '2026-07-30T13:00:00.000Z',
  failed_at = '2026-07-30T13:01:00.000Z',
  failure_code = 'fixture'
WHERE run_hash = ${sqlLiteral(collectingFailureRun.runHash)};
`,
        "collecting ingest run failure must preserve null ready_at",
      );
      await expectRuntimeSqlFailure(
        `
UPDATE job_search.ingest_source_scopes
SET status = 'failed', failed_at = '2026-07-30T13:00:29.999Z', failure_code = 'fixture'
WHERE scope_hash = ${sqlLiteral(collectingFailureScope.scopeHash)};
`,
        "source scope failed_at cannot precede a persisted observation observed_at",
      );
      await requireSuccess(
        runtimePsqlCommand,
        `
UPDATE job_search.ingest_source_scopes
SET status = 'failed', failed_at = '2026-07-30T13:00:30.000Z', failure_code = 'fixture'
WHERE scope_hash = ${sqlLiteral(collectingFailureScope.scopeHash)};
`,
      );
      await expectRuntimeSqlFailure(
        `
UPDATE job_search.ingest_runs
SET status = 'failed', failed_at = '2026-07-30T13:00:29.999Z', failure_code = 'fixture'
WHERE run_hash = ${sqlLiteral(collectingFailureRun.runHash)};
`,
        "ingest run failed_at cannot precede recorded scope or evidence lifecycle timestamps",
      );
      await requireSuccess(
        runtimePsqlCommand,
        `
UPDATE job_search.ingest_runs
SET status = 'failed', failed_at = '2026-07-30T13:01:00.000Z', failure_code = 'fixture'
WHERE run_hash = ${sqlLiteral(collectingFailureRun.runHash)};
UPDATE job_search.ingest_runs
SET status = 'failed', ready_at = NULL, failed_at = '2026-07-30T13:01:00.000Z', failure_code = 'fixture'
WHERE run_hash = ${sqlLiteral(collectingFailureRun.runHash)};
`,
      );
      await expectRuntimeSqlFailure(
        `
UPDATE job_search.ingest_runs
SET failed_at = '2026-07-30T13:01:00.001Z'
WHERE run_hash = ${sqlLiteral(collectingFailureRun.runHash)};
`,
        "state fields cannot change without a legal transition",
      );
      expect(
        await queryScalar(`
SELECT ingest_run.status || ':' || COALESCE(
  to_char(ingest_run.ready_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'null'
) || ':' || to_char(ingest_run.failed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  || ':' || source_scope.status
  || ':' || count(observation.id)::text
FROM job_search.ingest_runs ingest_run
JOIN job_search.ingest_source_scopes source_scope ON source_scope.run_id = ingest_run.id
LEFT JOIN job_search.ingest_observations observation ON observation.scope_id = source_scope.id
WHERE ingest_run.run_hash = ${sqlLiteral(collectingFailureRun.runHash)}
GROUP BY ingest_run.id, source_scope.id;
`),
      ).toBe("failed:null:2026-07-30T13:01:00.000Z:failed:1");

      const readyFailureRun = unwrap(
        createIngestRun({
          producer: "ready-failure-integration",
          scopes: [{ sourceId: "fixture", scopeKey: "ready-failure", request: {} }],
        }),
      );
      const readyFailureScope = readyFailureRun.scopes[0];
      if (readyFailureScope === undefined) throw new Error("Expected ready-failure scope");
      const readyFailureScopePlan = readyFailureRun.scopes.map((plannedScope) => ({
        sourceId: plannedScope.sourceId,
        scopeKey: plannedScope.scopeKey,
        scopeHash: plannedScope.scopeHash,
        request: plannedScope.request,
      }));
      await requireSuccess(
        runtimePsqlCommand,
        `
INSERT INTO job_search.ingest_runs (run_hash, producer, contract_version, scope_plan)
VALUES (
  ${sqlLiteral(readyFailureRun.runHash)},
  'ready-failure-integration',
  1,
  ${sqlLiteral(JSON.stringify(readyFailureScopePlan))}::jsonb
);
INSERT INTO job_search.ingest_source_scopes
  (run_id, scope_hash, source_id, scope_key, request_payload)
SELECT id, ${sqlLiteral(readyFailureScope.scopeHash)}, 'fixture', 'ready-failure', '{}'::jsonb
FROM job_search.ingest_runs WHERE run_hash = ${sqlLiteral(readyFailureRun.runHash)};
UPDATE job_search.ingest_source_scopes
SET status = 'complete', completed_at = '2026-07-30T13:59:00.000Z', result_count = 0
WHERE scope_hash = ${sqlLiteral(readyFailureScope.scopeHash)};
UPDATE job_search.ingest_runs
SET status = 'ready', ready_at = '2026-07-30T14:00:00.000Z'
WHERE run_hash = ${sqlLiteral(readyFailureRun.runHash)};
`,
      );
      await expectRuntimeSqlFailure(
        `
UPDATE job_search.ingest_runs
SET
  status = 'failed',
  ready_at = '2026-07-30T14:00:00.001Z',
  failed_at = '2026-07-30T14:01:00.000Z',
  failure_code = 'fixture'
WHERE run_hash = ${sqlLiteral(readyFailureRun.runHash)};
`,
        "ingest run ready_at is immutable once set",
      );
      await expectRuntimeSqlFailure(
        `
UPDATE job_search.ingest_runs
SET status = 'failed', failed_at = '2026-07-30T13:59:59.999Z', failure_code = 'fixture'
WHERE run_hash = ${sqlLiteral(readyFailureRun.runHash)};
`,
        "ingest run failed_at cannot precede ready_at",
      );
      await requireSuccess(
        runtimePsqlCommand,
        `
UPDATE job_search.ingest_runs
SET status = 'failed', failed_at = '2026-07-30T14:01:00.000Z', failure_code = 'fixture'
WHERE run_hash = ${sqlLiteral(readyFailureRun.runHash)};
UPDATE job_search.ingest_runs
SET
  status = 'failed',
  ready_at = '2026-07-30T14:00:00.000Z',
  failed_at = '2026-07-30T14:01:00.000Z',
  failure_code = 'fixture'
WHERE run_hash = ${sqlLiteral(readyFailureRun.runHash)};
`,
      );
      await expectRuntimeSqlFailure(
        `
UPDATE job_search.ingest_runs
SET ready_at = '2026-07-30T14:00:00.001Z'
WHERE run_hash = ${sqlLiteral(readyFailureRun.runHash)};
`,
        "state fields cannot change without a legal transition",
      );
      expect(
        await queryScalar(`
SELECT status || ':'
  || to_char(ready_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  || ':' || to_char(failed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM job_search.ingest_runs
WHERE run_hash = ${sqlLiteral(readyFailureRun.runHash)};
`),
      ).toBe("failed:2026-07-30T14:00:00.000Z:2026-07-30T14:01:00.000Z");

      const unreferencedRun = unwrap(
        createIngestRun({
          producer: "unreferenced-version-integration",
          scopes: [{ sourceId: "fixture", scopeKey: "unreferenced-version", request: {} }],
        }),
      );
      const unreferencedScope = unreferencedRun.scopes[0];
      if (unreferencedScope === undefined) throw new Error("Expected unreferenced-version scope");
      const unreferencedObservation = unwrap(
        createIngestObservation({
          scopeHash: unreferencedScope.scopeHash,
          sourceRecordKey: "fixture:observation",
          observedAt,
          raw: { title: "Referenced version" },
        }),
      );
      const referencedVersionCreation = unwrap(
        createNormalizedListingVersion(unreferencedRun, unreferencedScope.scopeHash, {
          listingKey: "fixture:referenced",
          normalizer: "radar-v1",
          normalized: { title: "Referenced version" },
        }),
      );
      const referencedVersion = referencedVersionCreation.version;
      const orphanedVersionCreation = unwrap(
        createNormalizedListingVersion(referencedVersionCreation.run, unreferencedScope.scopeHash, {
          listingKey: "fixture:orphaned",
          normalizer: "radar-v1",
          normalized: { title: "Orphaned version" },
        }),
      );
      const orphanedVersion = orphanedVersionCreation.version;
      const unreferencedScopePlan = unreferencedRun.scopes.map((plannedScope) => ({
        sourceId: plannedScope.sourceId,
        scopeKey: plannedScope.scopeKey,
        scopeHash: plannedScope.scopeHash,
        request: plannedScope.request,
      }));
      await requireSuccess(
        runtimePsqlCommand,
        `
INSERT INTO job_search.ingest_runs (run_hash, producer, contract_version, scope_plan)
VALUES (
  ${sqlLiteral(unreferencedRun.runHash)},
  'unreferenced-version-integration',
  1,
  ${sqlLiteral(JSON.stringify(unreferencedScopePlan))}::jsonb
);
INSERT INTO job_search.ingest_source_scopes
  (run_id, scope_hash, source_id, scope_key, request_payload)
SELECT id, ${sqlLiteral(unreferencedScope.scopeHash)}, 'fixture', 'unreferenced-version', '{}'::jsonb
FROM job_search.ingest_runs WHERE run_hash = ${sqlLiteral(unreferencedRun.runHash)};
INSERT INTO job_search.ingest_observations
  (scope_id, observation_hash, source_record_key, observed_at, raw_payload)
SELECT
  id,
  ${sqlLiteral(unreferencedObservation.observationHash)},
  'fixture:observation',
  ${sqlLiteral(observedAt)},
  '{"title":"Referenced version"}'::jsonb
FROM job_search.ingest_source_scopes
WHERE scope_hash = ${sqlLiteral(unreferencedScope.scopeHash)};
INSERT INTO job_search.ingest_listing_versions
  (created_by_scope_id, contract_version, version_hash, listing_key, normalizer, normalized_payload)
SELECT
  id,
  1,
  ${sqlLiteral(referencedVersion.versionHash)},
  'fixture:referenced',
  'radar-v1',
  '{"title":"Referenced version"}'::jsonb
FROM job_search.ingest_source_scopes
WHERE scope_hash = ${sqlLiteral(unreferencedScope.scopeHash)};
INSERT INTO job_search.ingest_listing_versions
  (created_by_scope_id, contract_version, version_hash, listing_key, normalizer, normalized_payload)
SELECT
  id,
  1,
  ${sqlLiteral(orphanedVersion.versionHash)},
  'fixture:orphaned',
  'radar-v1',
  '{"title":"Orphaned version"}'::jsonb
FROM job_search.ingest_source_scopes
WHERE scope_hash = ${sqlLiteral(unreferencedScope.scopeHash)};
INSERT INTO job_search.ingest_observation_versions (observation_id, listing_version_id)
SELECT observation.id, listing_version.id
FROM job_search.ingest_observations observation
CROSS JOIN job_search.ingest_listing_versions listing_version
WHERE observation.observation_hash = ${sqlLiteral(unreferencedObservation.observationHash)}
  AND listing_version.version_hash = ${sqlLiteral(referencedVersion.versionHash)};
UPDATE job_search.ingest_source_scopes
SET status = 'complete', completed_at = '2026-07-30T12:30:00.000Z', result_count = 1
WHERE scope_hash = ${sqlLiteral(unreferencedScope.scopeHash)};
`,
      );
      await expectRuntimeSqlFailure(
        `
UPDATE job_search.ingest_runs
SET status = 'ready', ready_at = '2026-07-30T12:31:00.000Z'
WHERE run_hash = ${sqlLiteral(unreferencedRun.runHash)};
`,
        "contains listing versions without same-run provenance",
      );
      await expectSqlFailure(
        `
BEGIN;
ALTER TABLE job_search.ingest_runs DISABLE TRIGGER ingest_runs_guard_transition;
UPDATE job_search.ingest_runs
SET status = 'ready', ready_at = '2026-07-30T12:31:00.000Z'
WHERE run_hash = ${sqlLiteral(unreferencedRun.runHash)};
ALTER TABLE job_search.ingest_runs ENABLE TRIGGER ingest_runs_guard_transition;
SELECT job_search.commit_ingest_run(
  (SELECT id FROM job_search.ingest_runs WHERE run_hash = ${sqlLiteral(unreferencedRun.runHash)}),
  ${sqlLiteral("0".repeat(64))},
  '{}'::jsonb,
  '2026-07-30T12:32:00.000Z'
);
`,
        "contains listing versions without same-run provenance",
      );
      expect(
        await queryScalar(
          `SELECT status FROM job_search.ingest_runs WHERE run_hash = ${sqlLiteral(unreferencedRun.runHash)};`,
        ),
      ).toBe("collecting");

      const incompleteRun = unwrap(
        createIngestRun({
          producer: "postgres-integration",
          scopes: [{ sourceId: "lever", scopeKey: "incomplete", request: {} }],
        }),
      );
      const incompleteScope = incompleteRun.scopes[0];
      if (incompleteScope === undefined) throw new Error("Expected one incomplete scope");
      const incompleteScopePlan = incompleteRun.scopes.map((plannedScope) => ({
        sourceId: plannedScope.sourceId,
        scopeKey: plannedScope.scopeKey,
        scopeHash: plannedScope.scopeHash,
        request: plannedScope.request,
      }));
      await requireSuccess(
        psqlCommand,
        `
INSERT INTO job_search.ingest_runs (run_hash, producer, contract_version, scope_plan)
VALUES (
  ${sqlLiteral(incompleteRun.runHash)},
  'postgres-integration',
  1,
  ${sqlLiteral(JSON.stringify(incompleteScopePlan))}::jsonb
);
INSERT INTO job_search.ingest_source_scopes
  (run_id, scope_hash, source_id, scope_key, request_payload)
SELECT id, ${sqlLiteral(incompleteScope.scopeHash)}, 'lever', 'incomplete', '{}'::jsonb
FROM job_search.ingest_runs WHERE run_hash = ${sqlLiteral(incompleteRun.runHash)};
`,
      );
      await expectSqlFailure(
        `
UPDATE job_search.ingest_runs
SET status = 'ready', ready_at = '2026-07-30T11:00:00Z'
WHERE run_hash = ${sqlLiteral(incompleteRun.runHash)};
`,
        "has incomplete source scopes",
      );
      expect(
        await queryScalar(
          `SELECT status FROM job_search.ingest_runs WHERE run_hash = ${sqlLiteral(incompleteRun.runHash)};`,
        ),
      ).toBe("collecting");

      await expectSqlFailure(
        `
UPDATE job_search.ingest_source_scopes
SET status = 'complete', completed_at = '2026-07-30T11:01:00Z', result_count = 1
WHERE scope_hash = ${sqlLiteral(incompleteScope.scopeHash)};
`,
        "result_count",
      );

      await expectSqlFailure(
        `
WITH scope_identity AS (
  SELECT jsonb_build_object(
    'scopeHash', job_search.canonical_json_sha256(jsonb_build_object(
      'contractVersion', 2,
      'sourceId', 'fixture',
      'scopeKey', 'contract-v2',
      'request', '{}'::jsonb
    )),
    'sourceId', 'fixture',
    'scopeKey', 'contract-v2',
    'request', '{}'::jsonb
  ) AS value
),
scope_plan AS (
  SELECT jsonb_build_array(value) AS value FROM scope_identity
)
INSERT INTO job_search.ingest_runs (run_hash, producer, contract_version, scope_plan)
SELECT
  job_search.canonical_json_sha256(jsonb_build_object(
    'contractVersion', 2,
    'producer', 'contract-v2',
    'scopes', scope_plan.value
  )),
  'contract-v2',
  2,
  scope_plan.value
FROM scope_plan;
`,
        "ingest_runs_contract_version",
      );

      await expectSqlFailure(
        `
WITH scope_identity AS (
  SELECT jsonb_build_object(
    'scopeHash', job_search.canonical_json_sha256(jsonb_build_object(
      'contractVersion', 1,
      'sourceId', 'fixture',
      'scopeKey', 'padded-producer',
      'request', '{}'::jsonb
    )),
    'sourceId', 'fixture',
    'scopeKey', 'padded-producer',
    'request', '{}'::jsonb
  ) AS value
),
scope_plan AS (
  SELECT jsonb_build_array(value) AS value FROM scope_identity
)
INSERT INTO job_search.ingest_runs (run_hash, producer, contract_version, scope_plan)
SELECT
  job_search.canonical_json_sha256(jsonb_build_object(
    'contractVersion', 1,
    'producer', ' padded-producer ',
    'scopes', scope_plan.value
  )),
  ' padded-producer ',
  1,
  scope_plan.value
FROM scope_plan;
`,
        "ingest_runs_producer_canonical",
      );

      await expectSqlFailure(
        `
WITH identities AS (
  SELECT
    request,
    job_search.canonical_json_sha256(jsonb_build_object(
      'contractVersion', 1,
      'sourceId', 'fixture',
      'scopeKey', 'duplicate',
      'request', request
    )) AS scope_hash
  FROM (VALUES ('{"page":1}'::jsonb), ('{"page":2}'::jsonb)) requests(request)
),
scope_plan AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'scopeHash', scope_hash,
      'sourceId', 'fixture',
      'scopeKey', 'duplicate',
      'request', request
    )
    ORDER BY scope_hash
  ) AS value
  FROM identities
)
INSERT INTO job_search.ingest_runs (run_hash, producer, contract_version, scope_plan)
SELECT
  job_search.canonical_json_sha256(jsonb_build_object(
    'contractVersion', 1,
    'producer', 'duplicate-source',
    'scopes', scope_plan.value
  )),
  'duplicate-source',
  1,
  scope_plan.value
FROM scope_plan;
`,
        "contains duplicate source identities",
      );

      await expectSqlFailure(
        `
WITH scope_identity AS (
  SELECT jsonb_build_object(
    'scopeHash', job_search.canonical_json_sha256(jsonb_build_object(
      'contractVersion', 1,
      'sourceId', 'fixture',
      'scopeKey', 'database-only-number',
      'request', '{"nested":[9007199254740993]}'::jsonb
    )),
    'sourceId', 'fixture',
    'scopeKey', 'database-only-number',
    'request', '{"nested":[9007199254740993]}'::jsonb
  ) AS value
),
scope_plan AS (
  SELECT jsonb_build_array(value) AS value FROM scope_identity
)
INSERT INTO job_search.ingest_runs (run_hash, producer, contract_version, scope_plan)
SELECT
  job_search.canonical_json_sha256(jsonb_build_object(
    'contractVersion', 1,
    'producer', 'database-only-number',
    'scopes', scope_plan.value
  )),
  'database-only-number',
  1,
  scope_plan.value
FROM scope_plan;
`,
        "ingest_runs_scope_plan_typescript_numbers",
      );

      await expectSqlFailure(
        `
WITH scope_identity AS (
  SELECT jsonb_build_object(
    'scopeHash', job_search.canonical_json_sha256(jsonb_build_object(
      'contractVersion', 1,
      'sourceId', ' padded-source ',
      'scopeKey', ' padded-scope ',
      'request', '{}'::jsonb
    )),
    'sourceId', ' padded-source ',
    'scopeKey', ' padded-scope ',
    'request', '{}'::jsonb
  ) AS value
),
scope_plan AS (
  SELECT jsonb_build_array(value) AS value FROM scope_identity
)
INSERT INTO job_search.ingest_runs (run_hash, producer, contract_version, scope_plan)
SELECT
  job_search.canonical_json_sha256(jsonb_build_object(
    'contractVersion', 1,
    'producer', 'padded-scope-plan',
    'scopes', scope_plan.value
  )),
  'padded-scope-plan',
  1,
  scope_plan.value
FROM scope_plan;
`,
        "scope_plan contains an invalid scope identity",
      );
    } finally {
      if (started) {
        await runCommand([pgCtl, "-D", dataDirectory, "-m", "immediate", "-w", "stop"]);
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
