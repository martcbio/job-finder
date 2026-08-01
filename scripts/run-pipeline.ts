import { runPsqlJson, withPsqlClientCleanup } from "../src/db/psql";
import {
  type PipelinePlanOptions,
  type PipelineStep,
  type PipelineStepName,
  buildPipelinePlan,
  isPipelineStepName,
  shellQuoteArgs,
} from "../src/pipeline/pipelinePlan";
import {
  type PipelineRunRow,
  type PipelineStepStartRow,
  buildCompletePipelineRunSql,
  buildCompletePipelineRunStepSql,
  buildCreatePipelineRunSql,
  buildInsertPipelineRunStepsSql,
  buildStartPipelineRunStepSql,
} from "../src/pipeline/pipelineRun";
import {
  type SavedSweepRow,
  buildGetSavedSweepSql,
  savedSweepToPipelineOptions,
} from "../src/pipeline/savedSweeps";
import { type TimeFilter, isTimeFilter } from "../src/pipeline/searchEngines";
import { parseSourceLaneIds } from "../src/pipeline/sourceLanes";

interface RunPipelineOptions extends PipelinePlanOptions {
  dryRun: boolean;
  json: boolean;
  sweepName: string | null;
}

interface RuntimeOptions {
  dryRun: boolean;
  json: boolean;
  sweepName: string | null;
  skipSteps: PipelineStepName[];
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readRepeatedFlag(args: string[], names: string[]): string[] {
  const values: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flag || !names.includes(flag)) continue;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    values.push(...splitList(value));
    i++;
  }

  return values;
}

function readStringFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

function readNumberFlag(args: string[], name: string, fallback: number): number {
  const value = readStringFlag(args, name);
  if (value === null) return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readFloatFlag(args: string[], name: string, fallback: number): number {
  const value = readStringFlag(args, name);
  if (value === null) return fallback;

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${name} must be a number greater than 0 and less than or equal to 1`);
  }

  return parsed;
}

function parseTimeFilter(value: string | null): TimeFilter {
  const timeFilter = value ?? "24hours";
  if (!isTimeFilter(timeFilter)) {
    throw new Error(`Unsupported time filter "${timeFilter}"`);
  }
  return timeFilter;
}

function parseSkipSteps(values: string[]): PipelineStepName[] {
  const steps: PipelineStepName[] = [];
  for (const value of values) {
    if (!isPipelineStepName(value)) {
      throw new Error(`Unsupported pipeline step "${value}"`);
    }
    steps.push(value);
  }
  return [...new Set(steps)];
}

function parseRuntimeOptions(args: string[]): RuntimeOptions {
  return {
    dryRun: args.includes("--dry-run"),
    json: args.includes("--json"),
    sweepName: readStringFlag(args, "--sweep"),
    skipSteps: parseSkipSteps(readRepeatedFlag(args, ["--skip"])),
  };
}

async function parseOptions(args: string[]): Promise<RunPipelineOptions> {
  const runtime = parseRuntimeOptions(args);
  if (runtime.sweepName !== null) {
    const row = await runPsqlJson<SavedSweepRow | null>(buildGetSavedSweepSql(runtime.sweepName));
    if (row === null) {
      throw new Error(`No saved sweep found named "${runtime.sweepName}"`);
    }
    if (!row.enabled) {
      throw new Error(`Saved sweep "${runtime.sweepName}" is disabled`);
    }

    return {
      ...savedSweepToPipelineOptions(row, runtime.skipSteps),
      dryRun: runtime.dryRun,
      json: runtime.json,
      sweepName: runtime.sweepName,
    };
  }

  const keywords = readRepeatedFlag(args, ["--keyword", "-k"]);
  const sites = readRepeatedFlag(args, ["--site", "-s"]);
  const defaultKeyword = "Agentic";

  return {
    keywords: keywords.length > 0 ? keywords : [defaultKeyword],
    sites: sites.length > 0 ? sites : ["greenhouse", "lever", "ashby"],
    timeFilter: parseTimeFilter(readStringFlag(args, "--time")),
    sourceLanes: parseSourceLaneIds(readRepeatedFlag(args, ["--lane"])),
    jobspyFile: readStringFlag(args, "--jobspy-file"),
    jobserveFile: readStringFlag(args, "--jobserve-file"),
    includeRemote: !args.includes("--exclude-remote"),
    location: readStringFlag(args, "--location"),
    maxQueries: readNumberFlag(args, "--max-queries", 12),
    searchLimit: readNumberFlag(args, "--search-limit", 5),
    searchTimeoutMs: readNumberFlag(args, "--search-timeout-ms", 30000),
    pageLimit: readNumberFlag(args, "--page-limit", 10),
    pageTimeoutMs: readNumberFlag(args, "--page-timeout-ms", 45000),
    classifyLimit: readNumberFlag(args, "--classify-limit", 50),
    duplicateLimit: readNumberFlag(args, "--duplicate-limit", 250),
    duplicateThreshold: readFloatFlag(args, "--duplicate-threshold", 0.82),
    queueLimit: readNumberFlag(args, "--queue-limit", 25),
    skipSteps: runtime.skipSteps,
    dryRun: runtime.dryRun,
    json: runtime.json,
    sweepName: null,
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run pipeline:run -- --dry-run -k "Agentic" --site greenhouse --site lever
  bun run pipeline:run -- --dry-run --sweep daily-agentic
  bun run pipeline:run -- -k "Agentic" --site all --max-queries 50 --search-limit 3
  bun run pipeline:run -- --skip search --skip ingest_pages

Options:
  --sweep                  Saved sweep name from job_search.saved_sweeps.
  -k, --keyword            Search keyword. Repeatable. Defaults to Agentic.
  -s, --site               source ID/label/site. Repeatable. Defaults to greenhouse, lever, ashby.
  --time                   source-style time filter. Defaults to 24hours.
  --lane                   Source lane. Repeatable. Defaults to source_search.
  --jobspy-file            JobSpy normalized JSON snapshot when --lane jobspy is selected.
  --jobserve-file          JobServe JSON snapshot when --lane jobserve is selected.
  --location               Optional location text for search queries.
  --exclude-remote         Do not append remote to search queries.
  --max-queries            Search target cap. Defaults to 12.
  --search-limit           Result cap per search query. Defaults to 5.
  --search-timeout-ms      Per-search timeout. Defaults to 30000.
  --page-limit             Page ingest cap. Defaults to 10.
  --page-timeout-ms        Page ingest timeout. Defaults to 45000.
  --classify-limit         Classification cap. Defaults to 50.
  --duplicate-limit        Duplicate comparison cap. Defaults to 250.
  --duplicate-threshold    Duplicate confidence threshold. Defaults to 0.82.
  --queue-limit            Review queue cap. Defaults to 25.
  --skip                   Pipeline step to skip. Repeatable.
  --dry-run                Print planned commands without executing them.
  --json                   Print machine-readable plan in dry-run mode.

Steps: db_check, search, import_normalized, ingest_pages, classify, duplicates, queue.`);
}

async function runStep(step: PipelineStep): Promise<number> {
  console.error(`\n==> ${step.name}: ${step.description}`);
  console.error(shellQuoteArgs(step.command));

  const proc = Bun.spawn(step.command, {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const exitCode = await proc.exited;
  return exitCode;
}

async function createAuditedRun(
  options: RunPipelineOptions,
  plan: PipelineStep[],
  args: string[],
): Promise<PipelineRunRow> {
  const runRow = await runPsqlJson<PipelineRunRow>(
    buildCreatePipelineRunSql({
      sweepName: options.sweepName,
      commandArgs: args,
    }),
  );
  await runPsqlJson(buildInsertPipelineRunStepsSql(runRow.id, plan));
  return runRow;
}

async function executeAuditedPlan(runId: string, plan: PipelineStep[]): Promise<void> {
  for (const [index, step] of plan.entries()) {
    const position = index + 1;
    const startedAt = Date.now();
    await runPsqlJson<PipelineStepStartRow>(buildStartPipelineRunStepSql(runId, position));

    const exitCode = await runStep(step);
    const durationMs = Date.now() - startedAt;
    if (exitCode !== 0) {
      const message = `Pipeline step ${step.name} failed with exit code ${exitCode}`;
      await runPsqlJson(
        buildCompletePipelineRunStepSql({
          runId,
          position,
          status: "failed",
          durationMs,
          exitCode,
          error: message,
        }),
      );
      await runPsqlJson(
        buildCompletePipelineRunSql({
          runId,
          status: "failed",
          errorSummary: message,
        }),
      );
      throw new Error(message);
    }

    await runPsqlJson(
      buildCompletePipelineRunStepSql({
        runId,
        position,
        status: "completed",
        durationMs,
        exitCode,
        error: null,
      }),
    );
  }

  await runPsqlJson(
    buildCompletePipelineRunSql({
      runId,
      status: "completed",
      errorSummary: null,
    }),
  );
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = await parseOptions(args);
  const plan = buildPipelinePlan(options);

  if (options.dryRun) {
    const output = plan.map((step) => ({
      name: step.name,
      description: step.description,
      command: step.command,
      display: shellQuoteArgs(step.command),
    }));

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    for (const [index, step] of output.entries()) {
      console.log(`${index + 1}. ${step.name}: ${step.display}`);
    }
    return;
  }

  const runRow = await createAuditedRun(options, plan, args);
  console.error(`Pipeline run ${runRow.id} started.`);
  await executeAuditedPlan(runRow.id, plan);
  console.error(`Pipeline run ${runRow.id} completed.`);
}

withPsqlClientCleanup(run).catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
