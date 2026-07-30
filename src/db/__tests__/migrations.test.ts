import { describe, expect, test } from "bun:test";
import {
  buildMigrationTransaction,
  checksumSql,
  loadMigrations,
  type Migration,
  parseMigrationVersion,
} from "../migrations";

describe("parseMigrationVersion", () => {
  test("extracts the numeric prefix", () => {
    expect(parseMigrationVersion("001_init_job_search.sql")).toBe("001");
  });

  test("rejects non-versioned filenames", () => {
    expect(() => parseMigrationVersion("init.sql")).toThrow("Invalid migration filename");
    expect(() => parseMigrationVersion("1_init.sql")).toThrow("Invalid migration filename");
    expect(() => parseMigrationVersion("001-init.sql")).toThrow("Invalid migration filename");
  });
});

describe("checksumSql", () => {
  test("hashes migration content deterministically", () => {
    expect(checksumSql("SELECT 1;\n")).toBe(checksumSql("SELECT 1;\n"));
    expect(checksumSql("SELECT 1;\n")).not.toBe(checksumSql("SELECT 2;\n"));
  });
});

describe("buildMigrationTransaction", () => {
  test("wraps migration SQL and records the applied checksum", () => {
    const migration: Migration = {
      version: "001",
      filename: "001_init_job_search.sql",
      checksum: "abc'123",
      sql: "CREATE TABLE job_search.example (id bigint);",
    };

    const sql = buildMigrationTransaction(migration);
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("CREATE TABLE job_search.example");
    expect(sql).toContain("INSERT INTO job_search.schema_migrations");
    expect(sql).toContain("'001'");
    expect(sql).toContain("'001_init_job_search.sql'");
    expect(sql).toContain("'abc''123'");
    expect(sql).toContain("COMMIT;");
  });
});

describe("ingest ledger migration", () => {
  test("loads the inert ledger schema with durable state and atomic commit guards", async () => {
    const migrations = await loadMigrations();
    const migration = migrations.find(
      (candidate) => candidate.filename === "016_add_ingest_ledger.sql",
    );

    expect(migration).toBeDefined();
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS job_search.ingest_runs");
    expect(migration?.sql).toContain("job_search.ingest_source_scopes");
    expect(migration?.sql).toContain("job_search.ingest_observations");
    expect(migration?.sql).toContain("job_search.ingest_listing_versions");
    expect(migration?.sql).toContain("job_search.ingest_observation_versions");
    expect(migration?.sql).toContain("job_search.ingest_commit_manifests");
    expect(migration?.sql).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    expect(migration?.sql).toContain("pg_catalog.pg_extension");
    expect(migration?.sql).toContain("job_search.pgcrypto_digest_sha256");
    expect(migration?.sql).toContain(
      "GRANT EXECUTE ON FUNCTION job_search.pgcrypto_digest_sha256(bytea) TO PUBLIC",
    );
    expect(migration?.sql).not.toContain("public.digest");
    expect(migration?.sql).toContain("job_search.canonical_json_sha256");
    expect(migration?.sql).toContain("job_search.json_numbers_fit_typescript");
    expect(migration?.sql).toContain("SET extra_float_digits = 3");
    expect(migration?.sql).toContain("ingest_runs_scope_plan_typescript_numbers");
    expect(migration?.sql).toContain("ingest_source_scopes_request_typescript_numbers");
    expect(migration?.sql).toContain("ingest_observations_raw_typescript_numbers");
    expect(migration?.sql).toContain("ingest_listing_versions_normalized_typescript_numbers");
    expect(migration?.sql).toContain("ingest_commit_manifests_payload_typescript_numbers");
    expect(migration?.sql).toContain("ingest run hash does not match canonical identity");
    expect(migration?.sql).toContain("ingest source scope hash does not match canonical identity");
    expect(migration?.sql).toContain("ingest observation hash does not match canonical identity");
    expect(migration?.sql).toContain(
      "ingest listing version hash does not match canonical identity",
    );
    expect(migration?.sql).toContain("job_search.require_collecting_ingest_run");
    expect(migration?.sql).toContain("FOR UPDATE");
    expect(migration?.sql).toContain("illegal ingest source scope transition");
    expect(migration?.sql).toContain("has incomplete source scopes");
    expect(migration?.sql).toContain("contains listing versions without same-run provenance");
    expect(
      migration?.sql.match(/contains listing versions without same-run provenance/g),
    ).toHaveLength(2);
    expect(migration?.sql).toContain("job_search.build_ingest_manifest_payload");
    expect(migration?.sql).toContain(
      "ingest manifest payload does not match persisted ledger rows",
    );
    expect(migration?.sql).toContain("job_search.commit_ingest_run");
    expect(migration?.sql).toContain("SECURITY DEFINER");
    expect(migration?.sql).toContain("SET search_path = pg_catalog, pg_temp");
    expect(migration?.sql).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE");
    expect(migration?.sql).toContain("REVOKE EXECUTE ON FUNCTION\n  job_search.commit_ingest_run");
    expect(migration?.sql).toContain("WHERE rolname IN ('anon', 'authenticated', 'service_role')");
    expect(migration?.sql).toContain("started_at is immutable once set");
    expect(migration?.sql).toContain("completed_at cannot precede started_at");
    expect(migration?.sql).toContain("failed_at cannot precede started_at");
    expect(migration?.sql).toContain(
      "cannot create a listing version from source scope % in state %",
    );
    expect(migration?.sql).toContain(
      "ingest observation observed_at cannot precede source scope started_at",
    );
    expect(migration?.sql).toContain(
      "source scope completed_at cannot precede a persisted observation observed_at",
    );
    expect(migration?.sql).toContain(
      "ingest run failed_at cannot precede recorded scope or evidence lifecycle timestamps",
    );
    expect(migration?.sql).toContain("collecting ingest run failure must preserve null ready_at");
    expect(migration?.sql).toContain("ingest run ready_at is immutable once set");
    expect(migration?.sql).toContain(
      "ingest run ready_at cannot precede a source scope completed_at",
    );
    expect(migration?.sql).toContain("ingest run failed_at cannot precede ready_at");
    expect(migration?.sql).toContain("ingest_runs_failed_after_ready");
    expect(migration?.sql).toContain("ingest run committed_at cannot precede ready_at");
    expect(migration?.sql).toContain("ingest_runs_committed_after_ready");
    expect(migration?.sql).toContain(
      "ingest manifest committed_at cannot precede ingest run ready_at",
    );
    expect(migration?.sql).toContain(
      "ingest run committed_at must equal its manifest committed_at",
    );
    expect(migration?.sql).toContain("requested_committed_at text");
    expect(migration?.sql).toContain("ingest_runs_created_at_millisecond");
    expect(migration?.sql).toContain("ingest_runs_ready_at_millisecond");
    expect(migration?.sql).toContain("ingest_source_scopes_completed_at_millisecond");
    expect(migration?.sql).toContain("ingest_commit_manifests_committed_at_millisecond");
    expect(migration?.sql).toContain("ingest_observations_observed_at_millisecond");
    expect(migration?.sql).toContain(
      "NEW.created_at := date_trunc('milliseconds', clock_timestamp())",
    );
    expect(migration?.sql).toContain("REVOKE INSERT (created_at)");
    expect(migration?.sql).toContain("observation.created_at");
    expect(migration?.sql).toContain("listing_version.created_at");
    expect(migration?.sql).toContain("ingest_runs_contract_version CHECK (contract_version = 1)");
    expect(migration?.sql).toContain(
      "ingest_listing_versions_contract_version CHECK (contract_version = 1)",
    );
    expect(migration?.sql).toContain("source_record_key = btrim(source_record_key)");
    expect(migration?.sql).toContain("listing_key = btrim(listing_key)");
    expect(migration?.sql).toContain("normalizer = btrim(normalizer)");
    expect(migration?.sql).toContain("contains duplicate source identities");
    expect(migration?.sql).toContain("ON CONFLICT (run_id) DO NOTHING");
    expect(migration?.sql).not.toContain("job_search.jobs");
    expect(migration?.sql).not.toContain("job_search.search_runs");
  });
});
