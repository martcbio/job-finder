import { describe, expect, test } from "bun:test";
import { startApi } from "../../../scripts/api";

describe("API startup", () => {
  test("applies pending migrations before binding the API", async () => {
    const events: string[] = [];

    await startApi({
      applyPendingMigrations: async () => {
        events.push("migrate");
      },
      serveJobFinderApi: () => {
        events.push("bind");
        return { hostname: "127.0.0.1", port: 3847 };
      },
      log: (message) => events.push(message),
    });

    expect(events).toEqual([
      "migrate",
      "bind",
      "jobsradar API listening on http://127.0.0.1:3847",
      "Routes are under /api. Stop with Ctrl-C.",
    ]);
  });

  test("does not bind the API when migration fails", async () => {
    let bound = false;

    await expect(
      startApi({
        applyPendingMigrations: async () => {
          throw new Error("migration failed");
        },
        serveJobFinderApi: () => {
          bound = true;
          return { hostname: "127.0.0.1", port: 3847 };
        },
      }),
    ).rejects.toThrow("migration failed");

    expect(bound).toBe(false);
  });
});
