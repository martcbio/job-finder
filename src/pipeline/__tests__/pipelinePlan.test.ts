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

  test("annotates planned source lanes without executing them", () => {
    const plan = buildPipelinePlan(
      options({
        sourceLanes: ["source_search", "jobspy", "jobserve"],
      }),
    );
    const search = plan.find((step) => step.name === "search");

    expect(search?.description).toContain("Source search");
    expect(search?.description).toContain("JobSpy aggregators");
    expect(search?.description).toContain("JobServe");
    expect(search?.command[0]).toBe("bun");
    expect(search?.command).not.toContain("jobspy");
  });

  test("fails loudly when only planned source lanes are selected", () => {
    expect(() => buildPipelinePlan(options({ sourceLanes: ["jobspy"] }))).toThrow(
      "No implemented source lanes selected",
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
