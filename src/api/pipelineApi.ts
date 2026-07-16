import {
  buildPipelinePlan,
  type PipelinePlanOptions,
  shellQuoteArgs,
} from "../pipeline/pipelinePlan";
import {
  buildGetSavedSweepSql,
  type SavedSweepRow,
  savedSweepToPipelineOptions,
} from "../pipeline/savedSweeps";
import { RUN_CONFIRMATION } from "./constants";
import type { ApiContext } from "./context";
import { ApiError } from "./errors";
import {
  nonEmptyStringArray,
  nullableString,
  optionalTimeFilter,
  parseApiSourceLaneIds,
  pipelineSteps,
  positiveFloatValue,
  positiveIntValue,
} from "./parse";

export interface PipelineRunRequest {
  sweepName?: string;
  keywords?: string[];
  sites?: string[];
  timeFilter?: string;
  sourceLanes?: string[];
  jobspyFile?: string;
  includeRemote?: boolean;
  location?: string | null;
  maxQueries?: number;
  searchLimit?: number;
  searchTimeoutMs?: number;
  pageLimit?: number;
  pageTimeoutMs?: number;
  classifyLimit?: number;
  duplicateLimit?: number;
  duplicateThreshold?: number;
  queueLimit?: number;
  skipSteps?: string[];
  execute?: boolean;
  confirm?: string;
}

interface PlannedStep {
  name: string;
  description: string;
  command: string[];
  display: string;
}

export async function planOrStartPipeline(
  body: PipelineRunRequest,
  context: ApiContext,
): Promise<{ started: boolean; plan: PlannedStep[]; command?: string[]; display?: string }> {
  const options = await pipelineOptionsFromBody(body, context);
  const plan = buildPipelinePlan(options);
  const plannedSteps = plan.map((step) => ({
    name: step.name,
    description: step.description,
    command: step.command,
    display: shellQuoteArgs(step.command),
  }));

  if (body.execute !== true) {
    return { started: false, plan: plannedSteps };
  }

  if (body.confirm !== RUN_CONFIRMATION) {
    throw new ApiError(
      409,
      "confirmation_required",
      `Set confirm to "${RUN_CONFIRMATION}" to start a local pipeline run from the API.`,
      {
        plan: plannedSteps,
      },
    );
  }

  const command = pipelineCommandFromRequest(body);
  Bun.spawn(command, {
    cwd: process.cwd(),
    env: context.env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });

  return {
    started: true,
    plan: plannedSteps,
    command,
    display: shellQuoteArgs(command),
  };
}

export async function pipelineOptionsFromBody(
  body: PipelineRunRequest,
  context: ApiContext,
): Promise<PipelinePlanOptions> {
  const skipSteps = pipelineSteps(body.skipSteps ?? []);
  if (body.sweepName) {
    const row = await context.query<SavedSweepRow | null>(buildGetSavedSweepSql(body.sweepName));
    if (row === null)
      throw new ApiError(404, "sweep_not_found", `No saved sweep found named "${body.sweepName}"`);
    if (!row.enabled)
      throw new ApiError(409, "sweep_disabled", `Saved sweep "${body.sweepName}" is disabled`);
    return savedSweepToPipelineOptions(row, skipSteps);
  }

  return {
    keywords: nonEmptyStringArray(body.keywords, "keywords", ["Agentic"]),
    sites: nonEmptyStringArray(body.sites, "sites", ["greenhouse", "lever", "ashby"]),
    timeFilter: optionalTimeFilter(body.timeFilter, "24hours"),
    sourceLanes: parseApiSourceLaneIds(body.sourceLanes),
    jobspyFile: nullableString(body.jobspyFile, "jobspyFile"),
    includeRemote: body.includeRemote ?? true,
    location: nullableString(body.location, "location"),
    maxQueries: positiveIntValue(body.maxQueries, "maxQueries", 12, 500),
    searchLimit: positiveIntValue(body.searchLimit, "searchLimit", 5, 50),
    searchTimeoutMs: positiveIntValue(body.searchTimeoutMs, "searchTimeoutMs", 30000, 300000),
    pageLimit: positiveIntValue(body.pageLimit, "pageLimit", 10, 500),
    pageTimeoutMs: positiveIntValue(body.pageTimeoutMs, "pageTimeoutMs", 45000, 300000),
    classifyLimit: positiveIntValue(body.classifyLimit, "classifyLimit", 50, 1000),
    duplicateLimit: positiveIntValue(body.duplicateLimit, "duplicateLimit", 250, 5000),
    duplicateThreshold: positiveFloatValue(body.duplicateThreshold, "duplicateThreshold", 0.82),
    queueLimit: positiveIntValue(body.queueLimit, "queueLimit", 25, 250),
    skipSteps,
  };
}

export function pipelineCommandFromRequest(body: PipelineRunRequest): string[] {
  const command = ["bun", "run", "pipeline:run", "--"];
  if (body.sweepName) command.push("--sweep", body.sweepName);
  for (const step of body.skipSteps ?? []) command.push("--skip", step);
  if (!body.sweepName) {
    for (const keyword of body.keywords ?? ["Agentic"]) command.push("--keyword", keyword);
    for (const site of body.sites ?? ["greenhouse", "lever", "ashby"]) command.push("--site", site);
    for (const lane of body.sourceLanes ?? []) command.push("--lane", lane);
    if (body.jobspyFile) command.push("--jobspy-file", body.jobspyFile);
    if (body.timeFilter) command.push("--time", body.timeFilter);
    if (body.includeRemote === false) command.push("--exclude-remote");
    if (body.location) command.push("--location", body.location);
    if (body.maxQueries) command.push("--max-queries", String(body.maxQueries));
    if (body.searchLimit) command.push("--search-limit", String(body.searchLimit));
    if (body.searchTimeoutMs) command.push("--search-timeout-ms", String(body.searchTimeoutMs));
    if (body.pageLimit) command.push("--page-limit", String(body.pageLimit));
    if (body.pageTimeoutMs) command.push("--page-timeout-ms", String(body.pageTimeoutMs));
    if (body.classifyLimit) command.push("--classify-limit", String(body.classifyLimit));
    if (body.duplicateLimit) command.push("--duplicate-limit", String(body.duplicateLimit));
    if (body.duplicateThreshold)
      command.push("--duplicate-threshold", String(body.duplicateThreshold));
    if (body.queueLimit) command.push("--queue-limit", String(body.queueLimit));
  }
  return command;
}
