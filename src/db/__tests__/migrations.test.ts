import { describe, expect, test } from "bun:test";
import {
  buildMigrationTransaction,
  checksumSql,
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
