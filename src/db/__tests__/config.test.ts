import { expect, test } from "bun:test";
import { defaultLocalDatabaseUrl, getDatabaseUrl } from "../config";

test("defaults database commands to deterministic local Postgres", () => {
  const databaseUrl = getDatabaseUrl({ USER: "mcb" });

  expect(databaseUrl).toBe("postgres://mcb@localhost:5432/jobs");
  expect(new URL(databaseUrl).hostname).toBe("localhost");
  expect(defaultLocalDatabaseUrl({ USER: "mcb" })).toBe(databaseUrl);
});

test("preserves an explicit DATABASE_URL", () => {
  const databaseUrl = "postgresql://custom-user@example.test:5432/custom_jobs";

  expect(getDatabaseUrl({ USER: "mcb", DATABASE_URL: databaseUrl })).toBe(databaseUrl);
});
