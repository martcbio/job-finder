import { describe, expect, test } from "bun:test";
import {
  buildCreateDatabaseSql,
  buildDatabaseExistsSql,
  quoteSqlIdentifier,
  resolveLocalDatabaseConfig,
} from "../localSetup";

describe("resolveLocalDatabaseConfig", () => {
  test("defaults to a local jobs database for the current user", () => {
    const config = resolveLocalDatabaseConfig({
      databaseUrl: null,
      maintenanceUrl: null,
      env: { USER: "mcb" },
    });

    expect(config.targetUrl).toBe("postgres://mcb@localhost:5432/jobs");
    expect(config.maintenanceUrl).toBe("postgres://mcb@localhost:5432/postgres");
    expect(config.databaseName).toBe("jobs");
    expect(config.owner).toBe("mcb");
  });

  test("refuses non-local database hosts", () => {
    expect(() =>
      resolveLocalDatabaseConfig({
        databaseUrl: "postgres://mcb@example.com:5432/jobs",
        maintenanceUrl: null,
        env: { USER: "mcb" },
      }),
    ).toThrow("must point at local Postgres");
  });
});

describe("local setup SQL builders", () => {
  test("quotes database identifiers", () => {
    expect(quoteSqlIdentifier('jobs"test')).toBe('"jobs""test"');
  });

  test("builds existence and create statements", () => {
    expect(buildDatabaseExistsSql("jobs")).toContain("WHERE datname = 'jobs'");
    expect(buildCreateDatabaseSql("jobs", "mcb")).toBe('CREATE DATABASE "jobs" OWNER "mcb";');
  });
});
