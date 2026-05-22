import { describe, expect, test } from "bun:test";
import {
  buildPipelinePlan,
  isPipelineStepName,
  type PipelinePlanOptions,
  shellQuoteArgs,
} from "../pipelinePlan";

function options(overrides: Partial<PipelinePlanOptions> = {}): PipelinePlanOptions {
  return {
    keywords: ["Agentic Engineer"],
    sites: ["greenhouse", "lever"],
    timeFilter: "24hours",
    includeRemote: true,
    location: null,
    maxQueries: 12,
    searchLimit: 5,
    searchTimeoutMs: 30000,
    pageLimit: 10,
    pageTimeoutMs: 45000,
    classifyLimit: 25,
    duplicateLimit: 250,
    duplicateThreshold: 0.82,
    queueLimit: 25,
    skipSteps: [],
    ...overrides,
  };
}

describe("pipeline plan", () => {
  test("builds the default command sequence", () => {
    const plan = buildPipelinePlan(options());

    expect(plan.map((step) => step.name)).toEqual([
      "db_check",
      "search",
      "ingest_pages",
      "classify",
      "duplicates",
      "queue",
    ]);
    expect(plan[1]?.command).toEqual([
      "bun",
      "run",
      "search:db",
      "--",
      "-k",
      "Agentic Engineer",
      "--site",
      "greenhouse",
      "--site",
      "lever",
      "--time",
      "24hours",
      "--max-queries",
      "12",
      "--limit",
      "5",
      "--timeout-ms",
      "30000",
    ]);
  });

  test("supports skipped steps and location flags", () => {
    const plan = buildPipelinePlan(
      options({
        includeRemote: false,
        location: "Europe",
        skipSteps: ["search", "duplicates"],
      }),
    );

    expect(plan.map((step) => step.name)).toEqual([
      "db_check",
      "ingest_pages",
      "classify",
      "queue",
    ]);

    const fullPlan = buildPipelinePlan(options({ includeRemote: false, location: "Europe" }));
    const search = fullPlan.find((step) => step.name === "search");
    expect(search?.command).toContain("--exclude-remote");
    expect(search?.command).toContain("--location");
    expect(search?.command).toContain("Europe");
  });

  test("runs source search alongside JobServe normalized import when both lanes are selected", () => {
    const plan = buildPipelinePlan(
      options({
        sourceLanes: ["source_search", "jobserve"],
        jobserveFile: "/data/jobserve.json",
      }),
    );
    const search = plan.find((step) => step.name === "search");
    const imports = plan.filter((step) => step.name === "import_normalized");

    expect(search?.description).toContain("Source search");
    expect(search?.command[0]).toBe("bun");
    expect(search?.command).not.toContain("jobserve");
    expect(imports).toHaveLength(1);
    expect(imports[0]?.command).toContain("jobserve");
    expect(imports[0]?.command).toContain("/data/jobserve.json");
  });

  test("adds normalized import step for JobSpy snapshots", () => {
    const plan = buildPipelinePlan(
      options({
        sourceLanes: ["jobspy"],
        jobspyFile: "/data/jobspy.json",
      }),
    );

    expect(plan.map((step) => step.name)).toEqual([
      "db_check",
      "import_normalized",
      "ingest_pages",
      "classify",
      "duplicates",
      "queue",
    ]);
    expect(plan[1]?.command).toContain("jobs:import-normalized");
    expect(plan[1]?.command).toContain("--file");
    expect(plan[1]?.command).toContain("/data/jobspy.json");
  });

  test("fails loudly when JobSpy is selected without a snapshot file", () => {
    expect(() => buildPipelinePlan(options({ sourceLanes: ["jobspy"] }))).toThrow(
      "JobSpy source lane requires --jobspy-file",
    );
  });

  test("fails loudly when JobServe is selected without a snapshot file", () => {
    expect(() => buildPipelinePlan(options({ sourceLanes: ["jobserve"] }))).toThrow(
      "JobServe source lane requires --jobserve-file",
    );
  });

  test("quotes commands for dry-run display", () => {
    expect(shellQuoteArgs(["bun", "run", "search:db", "--", "-k", "Agentic Engineer"])).toBe(
      "bun run search:db -- -k 'Agentic Engineer'",
    );
  });

  test("validates step names", () => {
    expect(isPipelineStepName("queue")).toBe(true);
    expect(isPipelineStepName("not_a_step")).toBe(false);
  });
});
