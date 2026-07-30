import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtsOrgAcquisition } from "../../services/ats/types";
import { type JobIngestSourceReceipt, normalizeJobIngestOptions, runJobIngest } from "../jobIngest";
import { runLabRawIngest } from "../labRawIngest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function completeReceipt(id: string): JobIngestSourceReceipt {
  return {
    id,
    label: id,
    status: "complete",
    runId: 1,
    discovered: 1,
    imported: 1,
    evidencePath: null,
    errors: [],
    elapsedMs: 1,
  };
}

describe("jobsradar raw ingestion boundary", () => {
  test("defaults to every configured source, including bounded JobServe", () => {
    expect(normalizeJobIngestOptions().sourceIds).toEqual([
      "lab-ats",
      "linear-careers",
      "google-careers",
      "jobserve",
    ]);
  });

  test("orchestrates only raw source ingestion and returns health receipts", async () => {
    const calls: string[] = [];
    const result = await runJobIngest(
      { sourceIds: ["lab-ats", "linear-careers"] },
      {
        ensureReady: async () => {
          calls.push("ready");
        },
        runLab: async () => {
          calls.push("lab");
          return completeReceipt("lab-ats");
        },
        runSources: async () => {
          calls.push("sources");
          return [completeReceipt("linear-careers")];
        },
      },
    );

    expect(calls).toEqual(["ready", "lab", "sources"]);
    expect(result.status).toBe("complete");
    expect(result.sources.map((source) => source.id)).toEqual(["lab-ats", "linear-careers"]);
    expect("classified" in result).toBe(false);
    expect("latest" in result).toBe(false);
  });

  test("continues other sources when lab setup fails", async () => {
    const calls: string[] = [];
    const result = await runJobIngest(
      { sourceIds: ["lab-ats", "linear-careers"] },
      {
        ensureReady: async () => {
          calls.push("ready");
        },
        runLab: async () => {
          calls.push("lab");
          throw new Error("targets.json is invalid");
        },
        runSources: async () => {
          calls.push("sources");
          return [completeReceipt("linear-careers")];
        },
      },
    );

    expect(calls).toEqual(["ready", "lab", "sources"]);
    expect(result.status).toBe("degraded");
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toMatchObject({
      id: "lab-ats",
      label: "Lab ATS",
      status: "failed",
      runId: null,
      discovered: 0,
      imported: 0,
      evidencePath: null,
      errors: ["targets.json is invalid"],
    });
    expect(result.sources[1]?.id).toBe("linear-careers");
  });

  test("writes independent lab raw evidence without screening fields", async () => {
    const marketDir = await mkdtemp(join(tmpdir(), "lab-raw-ingest-test-"));
    temporaryDirectories.push(marketDir);
    await writeFile(
      join(marketDir, "targets.json"),
      `${JSON.stringify({
        anthropic: { ats: "greenhouse", company: "Anthropic" },
      })}\n`,
    );
    const acquisition: AtsOrgAcquisition = {
      status: "success",
      endpoint: "https://example.test/anthropic",
      attempts: 1,
      durationMs: 4,
      jobs: [
        {
          source: "greenhouse",
          org: "anthropic",
          id: "job-1",
          title: "AI Infrastructure Engineer",
          location: "London, UK",
          locations: ["London, UK"],
          url: "https://example.test/anthropic/job-1",
          postedAt: "2026-07-30T08:00:00.000Z",
          raw: { id: "job-1", content: "Build reliable AI infrastructure." },
        },
      ],
    };
    let persistedJobs: unknown[] = [];

    const result = await runLabRawIngest({
      marketDir,
      now: () => new Date("2026-07-30T09:00:00.000Z"),
      makeRunId: () => "raw-run-1",
      listers: {
        ashby: async () => acquisition,
        greenhouse: async () => acquisition,
        lever: async () => acquisition,
      },
      persist: async (input) => {
        persistedJobs = input.jobs;
        return {
          runId: 7,
          queryId: 8,
          jobsSeen: input.jobs.length,
          jobsPersisted: input.jobs.length,
          pagesPersisted: input.jobs.length,
          errors: [],
        };
      },
    });

    expect(result.status).toBe("complete");
    expect(result.imported).toBe(1);
    expect(persistedJobs).toHaveLength(1);
    const rows = (await readFile(result.evidencePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.raw).toEqual({
      id: "job-1",
      content: "Build reliable AI infrastructure.",
    });
    expect(rows[0]).not.toHaveProperty("disposition");
    expect(rows[0]).not.toHaveProperty("locationEligibility");
    expect(rows[0]).not.toHaveProperty("roleRelevance");
  });

  test("preserves staged evidence when final publication collides", async () => {
    const marketDir = await mkdtemp(join(tmpdir(), "lab-raw-collision-test-"));
    temporaryDirectories.push(marketDir);
    await writeFile(
      join(marketDir, "targets.json"),
      '{"anthropic":{"ats":"greenhouse","company":"Anthropic"}}\n',
    );
    const evidenceRunId = "raw-run-collision";
    const existingGeneration = join(marketDir, "lab-raw-ingest", "runs", evidenceRunId);
    const stagingDir = join(marketDir, "lab-raw-ingest", ".staging", evidenceRunId);
    await mkdir(existingGeneration, { recursive: true });
    await writeFile(join(existingGeneration, "sentinel"), "existing generation\n");
    const acquisition: AtsOrgAcquisition = {
      status: "success",
      endpoint: "https://example.test/anthropic",
      attempts: 1,
      durationMs: 4,
      jobs: [
        {
          source: "greenhouse",
          org: "anthropic",
          id: "job-collision",
          title: "AI Infrastructure Engineer",
          location: "London, UK",
          locations: ["London, UK"],
          url: "https://example.test/anthropic/job-collision",
          postedAt: "2026-07-30T08:00:00.000Z",
          raw: { id: "job-collision", content: "Build reliable AI infrastructure." },
        },
      ],
    };

    await expect(
      runLabRawIngest({
        marketDir,
        makeRunId: () => evidenceRunId,
        listers: {
          ashby: async () => acquisition,
          greenhouse: async () => acquisition,
          lever: async () => acquisition,
        },
        persist: async (input) => ({
          runId: 7,
          queryId: 8,
          jobsSeen: input.jobs.length,
          jobsPersisted: input.jobs.length,
          pagesPersisted: input.jobs.length,
          errors: [],
        }),
      }),
    ).rejects.toThrow(`staged evidence preserved at ${stagingDir}`);

    expect(await readFile(join(stagingDir, "openings.jsonl"), "utf8")).toContain(
      '"id":"job-collision"',
    );
    expect(await readFile(join(stagingDir, "receipt.json"), "utf8")).toContain(
      '"evidenceRunId": "raw-run-collision"',
    );
    expect(await readFile(join(existingGeneration, "sentinel"), "utf8")).toBe(
      "existing generation\n",
    );
  });
});

test("jobsradar CLI exposes raw ingest without report or email behavior", async () => {
  const child = Bun.spawn(["bash", "scripts/jobsradar", "--help"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toContain("jobsradar ingest");
  expect(stdout).toContain("Default sources include bounded JobServe");
  expect(stdout).not.toContain("email");
  expect(stdout).not.toContain("rank");
});

test("jobsradar wrapper supplies the standard local database without flags", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "jobsradar-wrapper-test-"));
  temporaryDirectories.push(fakeBin);
  const databasePath = join(fakeBin, "database-url");
  const fakeBun = join(fakeBin, "bun");
  await writeFile(fakeBun, `#!/bin/sh\nprintf '%s' "$DATABASE_URL" > "${databasePath}"\n`);
  await chmod(fakeBun, 0o755);

  const child = Bun.spawn(["sh", "scripts/jobsradar", "ingest"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: "", PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await child.exited;

  expect(exitCode).toBe(0);
  expect(await readFile(databasePath, "utf8")).toBe("postgres://mcb@localhost:5432/jobs");
});
