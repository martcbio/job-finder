import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveJobspySnapshotPath } from "../queueRefresh/jobspyRefresh";

describe("queue refresh configuration", () => {
  test("resolves JobSpy from the injected environment", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "jobspy-config-"));
    try {
      const snapshot = resolve(directory, "jobspy.json");
      await writeFile(snapshot, "[]");

      expect(resolveJobspySnapshotPath({ JOBSPY_SNAPSHOT_FILE: snapshot })).toBe(snapshot);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
