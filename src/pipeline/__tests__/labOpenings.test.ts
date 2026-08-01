import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AtsOrgAcquisition, AtsOrgJob } from "../../services/ats/types";
import { exitCodeForRecordStatus } from "../labBoards";
import { createLabOpeningsModule, resolveLabOpeningsPaths } from "../labOpenings";

const temporaryDirectories: string[] = [];

async function temporaryMarket(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lab-openings-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function writeTargets(marketDir: string, targets: unknown): Promise<void> {
  await writeFile(join(marketDir, "targets.json"), `${JSON.stringify(targets, null, 2)}\n`);
}

function job(
  source: AtsOrgJob["source"],
  org: string,
  id: string,
  overrides: Partial<AtsOrgJob> = {},
): AtsOrgJob {
  return {
    source,
    org,
    id,
    title: "AI Engineer",
    location: "Remote",
    locations: ["Remote"],
    url: `https://example.test/${org}/${id}`,
    postedAt: "2026-07-12T08:00:00.000Z",
    raw: { id },
    ...overrides,
  };
}

function success(endpoint: string, jobs: AtsOrgJob[] = []): AtsOrgAcquisition {
  return {
    status: "success",
    endpoint,
    attempts: 1,
    durationMs: 10,
    jobs,
  };
}

function failure(endpoint: string): AtsOrgAcquisition {
  return {
    status: "failure",
    attempts: 1,
    durationMs: 10,
    failure: {
      kind: "transport",
      endpoint,
      message: "network down",
      errorName: "Error",
      errorCode: "ENETDOWN",
      retryable: false,
    },
  };
}

function clock(start = "2026-07-12T08:15:00.000Z"): () => Date {
  let tick = 0;
  const base = new Date(start).getTime();
  return () => new Date(base + tick++ * 1000);
}

describe("lab openings freshness", () => {
  test("discovers the nearest market marker for both checkout layouts and preserves overrides", async () => {
    const fixtureDir = await temporaryMarket();
    const careersDir = join(fixtureDir, "careers");
    const nestedProjectDir = join(careersDir, "resume2", "projects", "jobsradar");
    const directProjectDir = join(careersDir, "jobsradar");
    const marketDir = join(careersDir, "market");
    const missingProjectDir = join(fixtureDir, "elsewhere", "jobsradar");
    await Promise.all([
      mkdir(nestedProjectDir, { recursive: true }),
      mkdir(directProjectDir, { recursive: true }),
      mkdir(marketDir, { recursive: true }),
      mkdir(missingProjectDir, { recursive: true }),
    ]);
    await writeTargets(marketDir, {});

    for (const projectDir of [nestedProjectDir, directProjectDir]) {
      expect(resolveLabOpeningsPaths({ CAREERS_PROJECT_DIR: projectDir })).toEqual({
        marketDir,
        projectDir,
      });
    }
    expect(
      resolveLabOpeningsPaths({ CAREERS_PROJECT_DIR: nestedProjectDir, CAREERS_MARKET_DIR: "" }),
    ).toEqual({ marketDir, projectDir: nestedProjectDir });
    expect(
      resolveLabOpeningsPaths({ CAREERS_PROJECT_DIR: "", CAREERS_MARKET_DIR: "/scratch/market" }),
    ).toEqual({
      marketDir: "/scratch/market",
      projectDir: resolve(import.meta.dir, "..", "..", ".."),
    });
    expect(() =>
      resolveLabOpeningsPaths({ CAREERS_PROJECT_DIR: missingProjectDir, CAREERS_MARKET_DIR: "" }),
    ).toThrow("Cannot find market/targets.json");

    const targetsPath = join(marketDir, "targets.json");
    await chmod(targetsPath, 0o000);
    try {
      expect(() => resolveLabOpeningsPaths({ CAREERS_PROJECT_DIR: nestedProjectDir })).toThrow(
        "Cannot find market/targets.json",
      );
    } finally {
      await chmod(targetsPath, 0o600);
    }
  });

  test("fails when the target configuration is missing", async () => {
    const marketDir = await temporaryMarket();
    const module = createLabOpeningsModule({ marketDir });

    await expect(module.record()).rejects.toThrow();
    expect(await Bun.file(join(marketDir, "targets.json")).exists()).toBe(false);
  });

  test("publishes a complete generation when valid boards return zero jobs", async () => {
    const marketDir = await temporaryMarket();
    await writeTargets(marketDir, {
      empty: { ats: "lever", company: "Empty Board" },
    });
    const module = createLabOpeningsModule({
      marketDir,
      projectDir: "/repo",
      now: clock(),
      makeRunId: () => "run-empty-success",
      listers: {
        ashby: async () => success("https://example.test/ashby"),
        greenhouse: async () => success("https://example.test/greenhouse"),
        lever: async () => success("https://example.test/lever", []),
      },
    });

    const result = await module.record();
    expect(result.status).toBe("complete");
    if (result.status === "locked") throw new Error("expected the run to acquire the lock");
    expect(result.record.status).toBe("complete");
    expect(result.record.outputs.map((output) => output.mediaType)).toEqual([
      "application/json",
      "text/markdown",
      "application/x-ndjson",
    ]);
    expect(await readFile(join(result.generationDir, "openings.jsonl"), "utf8")).toBe("");

    const report = await module.inspect(["lab-openings"]);
    const inspection = report.projections[0];
    expect(inspection?.diagnosis.code).toBe("healthy");
    expect(inspection?.current?.runId).toBe("run-empty-success");
    expect(inspection?.lastHealthy?.runId).toBe("run-empty-success");
    expect(inspection?.repair).toEqual({
      cwd: "/repo",
      argv: ["bun", "run", "labs:openings", "--", "record"],
    });
  });

  test("publishes every acquired opening with explicit, fully-accounted decisions", async () => {
    const marketDir = await temporaryMarket();
    await writeTargets(marketDir, {
      openai: { ats: "greenhouse", company: "OpenAI" },
    });
    const fixtureJobs = [
      job("greenhouse", "openai", "eu-codex", {
        title: "Software Engineer, Codex Enterprise",
        location: "London, UK",
        locations: ["London, UK"],
      }),
      job("greenhouse", "openai", "eu-inference", {
        title: "Senior Software Engineer, Inference",
        location: "London, UK",
        locations: ["London, UK"],
      }),
      job("greenhouse", "openai", "eu-deployment", {
        title: "AI Deployment Engineer",
        location: "Paris, France",
        locations: ["Paris, France"],
      }),
      job("greenhouse", "openai", "us-ai", {
        title: "AI Engineer",
        location: "San Francisco, CA",
        locations: ["San Francisco, CA"],
      }),
      job("greenhouse", "openai", "us-remote", {
        title: "Agent Engineer",
        location: "Remote - US",
        locations: ["Remote - US"],
      }),
      job("greenhouse", "openai", "eu-marketing", {
        title: "Field Marketing Lead",
        location: "London, UK",
        locations: ["London, UK"],
      }),
      job("greenhouse", "openai", "eu-support", {
        title: "AI Support Engineer",
        location: "Dublin, Ireland",
        locations: ["Dublin, Ireland"],
      }),
    ];
    const module = createLabOpeningsModule({
      marketDir,
      now: clock(),
      makeRunId: () => "run-accounting",
      listers: {
        ashby: async () => success("https://example.test/ashby"),
        greenhouse: async () => success("https://example.test/greenhouse", fixtureJobs),
        lever: async () => success("https://example.test/lever"),
      },
    });

    const result = await module.record();
    if (result.status === "locked") throw new Error("expected the run to acquire the lock");
    const rows = (await readFile(join(result.generationDir, "openings.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            id: string;
            locationEligibility: { status: string; reasonCodes: string[] };
            roleRelevance: { status: string; reasonCodes: string[] };
            disposition: string;
          },
      );
    const status = JSON.parse(
      await readFile(join(result.generationDir, "status.json"), "utf8"),
    ) as {
      summary: {
        acquiredJobs: number;
        rawOpenings: number;
        eligibleOpenings: number;
        suitableOpenings: number;
        unsuitableLocationOpenings: number;
        unsuitableRoleOpenings: number;
        undecidedOpenings: number;
      };
    };

    expect(status.summary).toMatchObject({
      acquiredJobs: 7,
      rawOpenings: 7,
      eligibleOpenings: 5,
      suitableOpenings: 3,
      unsuitableLocationOpenings: 2,
      unsuitableRoleOpenings: 2,
      undecidedOpenings: 0,
    });
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row.id).sort()).toEqual([
      "eu-codex",
      "eu-deployment",
      "eu-inference",
      "eu-marketing",
      "eu-support",
      "us-ai",
      "us-remote",
    ]);
    expect(
      rows
        .filter((row) => row.disposition === "suitable")
        .map((row) => row.id)
        .sort(),
    ).toEqual(["eu-codex", "eu-deployment", "eu-inference"]);
    expect(rows.find((row) => row.id === "us-remote")).toMatchObject({
      locationEligibility: { status: "ineligible", reasonCodes: ["location.us_only"] },
      disposition: "unsuitable_location",
    });
    expect(rows.find((row) => row.id === "eu-marketing")).toMatchObject({
      roleRelevance: { status: "irrelevant", reasonCodes: ["role.marketing"] },
      disposition: "unsuitable_role",
    });
    expect(rows.find((row) => row.id === "eu-support")).toMatchObject({
      roleRelevance: { status: "irrelevant", reasonCodes: ["role.support"] },
      disposition: "unsuitable_role",
    });

    const accounted =
      status.summary.suitableOpenings +
      status.summary.unsuitableLocationOpenings +
      status.summary.unsuitableRoleOpenings +
      status.summary.undecidedOpenings;
    expect(accounted).toBe(status.summary.rawOpenings);
  });

  test("keeps the previous generation current when every configured board fails", async () => {
    const marketDir = await temporaryMarket();
    await writeTargets(marketDir, {
      one: { ats: "ashby", company: "One" },
      two: { ats: "lever", company: "Two" },
    });
    const now = clock();
    const healthy = createLabOpeningsModule({
      marketDir,
      now,
      makeRunId: () => "run-healthy",
      listers: {
        ashby: async (org) => success("https://example.test/ashby", [job("ashby", org, "1")]),
        greenhouse: async () => success("https://example.test/greenhouse"),
        lever: async (org) => success("https://example.test/lever", [job("lever", org, "2")]),
      },
    });
    await healthy.record();
    const legacyBefore = await readFile(join(marketDir, "openings-2026-07-12.md"), "utf8");

    const failed = createLabOpeningsModule({
      marketDir,
      now,
      makeRunId: () => "run-all-miss",
      listers: {
        ashby: async () => failure("https://example.test/ashby"),
        greenhouse: async () => failure("https://example.test/greenhouse"),
        lever: async () => failure("https://example.test/lever"),
      },
    });
    const failedResult = await failed.record();
    expect(failedResult.status).toBe("failed");
    const legacyAfter = await readFile(join(marketDir, "openings-2026-07-12.md"), "utf8");
    expect(legacyAfter).toBe(legacyBefore);
    const failedLegacyStatus = JSON.parse(
      await readFile(join(marketDir, "openings-2026-07-12.status.json"), "utf8"),
    );
    expect(failedLegacyStatus).toMatchObject({
      runId: "run-all-miss",
      health: "failed",
      publication: "retained",
      publishedRunId: "run-healthy",
    });

    const inspection = (await failed.inspect(["lab-openings"])).projections[0];
    expect(inspection?.diagnosis.code).toBe("latest_attempt_failed");
    expect(inspection?.latestAttempt?.runId).toBe("run-all-miss");
    expect(inspection?.current?.runId).toBe("run-healthy");
    expect(inspection?.lastHealthy?.runId).toBe("run-healthy");
  });

  test("records partial success without replacing the complete generation", async () => {
    const marketDir = await temporaryMarket();
    await writeTargets(marketDir, {
      one: { ats: "ashby", company: "One" },
      two: { ats: "lever", company: "Two" },
    });
    const now = clock();
    const healthy = createLabOpeningsModule({
      marketDir,
      now,
      makeRunId: () => "run-healthy",
      listers: {
        ashby: async (org) => success("https://example.test/ashby", [job("ashby", org, "1")]),
        greenhouse: async () => success("https://example.test/greenhouse"),
        lever: async (org) => success("https://example.test/lever", [job("lever", org, "2")]),
      },
    });
    await healthy.record();

    const degraded = createLabOpeningsModule({
      marketDir,
      now,
      makeRunId: () => "run-degraded",
      listers: {
        ashby: async (org) => success("https://example.test/ashby", [job("ashby", org, "3")]),
        greenhouse: async () => success("https://example.test/greenhouse"),
        lever: async () => failure("https://example.test/lever"),
      },
    });
    const legacyBefore = await readFile(join(marketDir, "openings-2026-07-12.md"), "utf8");
    const degradedResult = await degraded.record();
    expect(degradedResult.status).toBe("degraded");
    expect(await readFile(join(marketDir, "openings-2026-07-12.md"), "utf8")).toBe(legacyBefore);

    const inspection = (await degraded.inspect(["lab-openings"])).projections[0];
    expect(inspection?.diagnosis.code).toBe("degraded");
    expect(inspection?.latestAttempt?.runId).toBe("run-degraded");
    expect(inspection?.current?.runId).toBe("run-healthy");
    expect(inspection?.lastHealthy?.runId).toBe("run-healthy");
    const degradedLegacyStatus = JSON.parse(
      await readFile(join(marketDir, "openings-2026-07-12.status.json"), "utf8"),
    );
    expect(degradedLegacyStatus).toMatchObject({
      runId: "run-degraded",
      health: "degraded",
      publication: "retained",
      publishedRunId: "run-healthy",
    });
  });

  test("blocks a concurrent invocation before the second acquisition starts", async () => {
    const marketDir = await temporaryMarket();
    await writeTargets(marketDir, {
      one: { ats: "ashby", company: "One" },
    });
    let releaseFirst: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let acquisitionCalls = 0;
    const module = createLabOpeningsModule({
      marketDir,
      now: clock(),
      listers: {
        ashby: async (org) => {
          acquisitionCalls++;
          await firstCanFinish;
          return success("https://example.test/ashby", [job("ashby", org, "1")]);
        },
        greenhouse: async () => success("https://example.test/greenhouse"),
        lever: async () => success("https://example.test/lever"),
      },
      processState: () => "alive",
    });

    const first = module.record();
    while (acquisitionCalls === 0) await Bun.sleep(1);
    const second = await module.record();
    expect(second.status).toBe("locked");
    expect(acquisitionCalls).toBe(1);
    releaseFirst?.();
    await first;
  });

  test("reclaims an old heartbeat even when the recorded PID has been reused", async () => {
    const marketDir = await temporaryMarket();
    await writeTargets(marketDir, {
      one: { ats: "lever", company: "One" },
    });
    const lockDir = join(marketDir, "lab-openings", ".record.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "owner.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        ownerToken: "00000000-0000-4000-8000-000000000000",
        runId: "crashed-run",
        pid: 999,
        hostname: "test-host",
        acquiredAt: "2026-07-12T08:00:00.000Z",
        heartbeatAt: "2026-07-12T08:00:00.000Z",
        cwd: "/repo",
        argv: ["bun", "run", "labs:openings"],
      })}\n`,
    );
    const module = createLabOpeningsModule({
      marketDir,
      now: () => new Date("2026-07-12T09:00:00.000Z"),
      hostname: "test-host",
      processState: () => "alive",
      makeRunId: () => "replacement-run",
      listers: {
        ashby: async () => success("https://example.test/ashby"),
        greenhouse: async () => success("https://example.test/greenhouse"),
        lever: async () => success("https://example.test/lever"),
      },
    });

    const result = await module.record();
    expect(result.status).toBe("complete");
    expect(result.runId).toBe("replacement-run");
  });

  test("keeps the previous state when publication stops before the state commit", async () => {
    const marketDir = await temporaryMarket();
    await writeTargets(marketDir, {
      one: { ats: "ashby", company: "One" },
    });
    const now = clock();
    const first = createLabOpeningsModule({
      marketDir,
      now,
      makeRunId: () => "run-before-interruption",
      listers: {
        ashby: async (org) => success("https://example.test/ashby", [job("ashby", org, "1")]),
        greenhouse: async () => success("https://example.test/greenhouse"),
        lever: async () => success("https://example.test/lever"),
      },
    });
    await first.record();

    const interrupted = createLabOpeningsModule({
      marketDir,
      now,
      makeRunId: () => "run-interrupted",
      listers: {
        ashby: async (org) => success("https://example.test/ashby", [job("ashby", org, "2")]),
        greenhouse: async () => success("https://example.test/greenhouse"),
        lever: async () => success("https://example.test/lever"),
      },
      beforeStateCommit: () => {
        throw new Error("forced interruption");
      },
    });

    await expect(interrupted.record()).rejects.toThrow("forced interruption");
    const inspection = (await first.inspect(["lab-openings"])).projections[0];
    expect(inspection?.current?.runId).toBe("run-before-interruption");
    expect(inspection?.lastHealthy?.runId).toBe("run-before-interruption");
  });

  test("does not commit state when the legacy success marker cannot be completed", async () => {
    const marketDir = await temporaryMarket();
    await writeTargets(marketDir, {
      one: { ats: "ashby", company: "One" },
    });
    const now = clock();
    const first = createLabOpeningsModule({
      marketDir,
      now,
      makeRunId: () => "run-before-legacy-failure",
      listers: {
        ashby: async (org) => success("https://example.test/ashby", [job("ashby", org, "1")]),
        greenhouse: async () => success("https://example.test/greenhouse"),
        lever: async () => success("https://example.test/lever"),
      },
    });
    await first.record();

    const legacyMarkdown = join(marketDir, "openings-2026-07-12.md");
    await rm(legacyMarkdown, { force: true });
    await mkdir(legacyMarkdown);
    const second = createLabOpeningsModule({
      marketDir,
      now,
      makeRunId: () => "run-legacy-failure",
      listers: {
        ashby: async (org) => success("https://example.test/ashby", [job("ashby", org, "2")]),
        greenhouse: async () => success("https://example.test/greenhouse"),
        lever: async () => success("https://example.test/lever"),
      },
    });

    await expect(second.record()).rejects.toThrow();
    const inspection = (await first.inspect(["lab-openings"])).projections[0];
    expect(inspection?.current?.runId).toBe("run-before-legacy-failure");
    const legacyStatus = JSON.parse(
      await readFile(join(marketDir, "openings-2026-07-12.status.json"), "utf8"),
    );
    expect(legacyStatus).toMatchObject({
      runId: "run-legacy-failure",
      publication: "publishing",
      publishedRunId: "run-before-legacy-failure",
    });
  });

  test("creates unique run IDs for invocations with the same timestamp", async () => {
    const marketDir = await temporaryMarket();
    await writeTargets(marketDir, {
      one: { ats: "lever", company: "One" },
    });
    const fixedNow = () => new Date("2026-07-12T08:15:00.000Z");
    const module = createLabOpeningsModule({
      marketDir,
      now: fixedNow,
      listers: {
        ashby: async () => success("https://example.test/ashby"),
        greenhouse: async () => success("https://example.test/greenhouse"),
        lever: async () => success("https://example.test/lever"),
      },
    });

    const first = await module.record();
    const second = await module.record();
    expect(first.runId).not.toBe(second.runId);
    expect(first.startedAt).toBe(second.startedAt);
    expect(first.completedAt).toBe(second.completedAt);
  });

  test("maps every non-complete result to a nonzero CLI exit", () => {
    expect(exitCodeForRecordStatus("complete")).toBe(0);
    expect(exitCodeForRecordStatus("degraded")).toBe(1);
    expect(exitCodeForRecordStatus("failed")).toBe(1);
    expect(exitCodeForRecordStatus("locked")).toBe(1);
  });

  test("inspection does not call an ATS adapter", async () => {
    const marketDir = await temporaryMarket();
    let calls = 0;
    const module = createLabOpeningsModule({
      marketDir,
      listers: {
        ashby: async () => {
          calls++;
          return failure("https://example.test/ashby");
        },
        greenhouse: async () => {
          calls++;
          return failure("https://example.test/greenhouse");
        },
        lever: async () => {
          calls++;
          return failure("https://example.test/lever");
        },
      },
    });

    const inspection = (await module.inspect(["lab-openings"])).projections[0];
    expect(inspection?.diagnosis.code).toBe("never_published");
    expect(calls).toBe(0);
  });
});
