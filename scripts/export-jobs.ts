import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runPsqlJson, withPsqlClientCleanup } from "../src/db/psql";
import {
  type JobExportFilters,
  type JobExportRow,
  buildJobsExportSql,
  renderJobsMarkdown,
} from "../src/pipeline/jobExport";

type ExportFormat = "json" | "markdown";

interface ExportJobsOptions extends JobExportFilters {
  format: ExportFormat;
  output: string | null;
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

function readNumberFlag(args: string[], name: string, fallback: number | null): number | null {
  const value = readStringFlag(args, name);
  if (value === null) return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseOptions(args: string[]): ExportJobsOptions {
  const formatValue = readStringFlag(args, "--format") ?? "markdown";
  if (formatValue !== "markdown" && formatValue !== "json") {
    throw new Error('--format must be "markdown" or "json"');
  }

  const limit = readNumberFlag(args, "--limit", 50);
  if (limit === null) {
    throw new Error("--limit must resolve to a positive integer");
  }

  return {
    limit,
    reviewState: readStringFlag(args, "--state"),
    runId: readNumberFlag(args, "--run-id", null),
    format: formatValue,
    output: readStringFlag(args, "--output"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run jobs:export -- --limit 25
  bun run jobs:export -- --run-id 12 --format json
  bun run jobs:export -- --state new --output docs/job-search-export.md

Options:
  --limit      Maximum jobs to export. Defaults to 50.
  --state      Filter by jobs.review_state.
  --run-id     Filter to jobs observed in a specific search run.
  --format     markdown or json. Defaults to markdown.
  --output     Optional repo-local output path. Refuses /tmp and paths outside this project.

Requires DATABASE_URL and the job_search schema.`);
}

function assertRepoLocalOutput(output: string): string {
  const resolved = resolve(output);
  const root = process.cwd();
  const inRepo = resolved === root || resolved.startsWith(`${root}/`);
  if (!inRepo) {
    throw new Error(`--output must stay inside this project: ${output}`);
  }
  if (resolved.startsWith("/tmp/") || resolved.startsWith("/private/tmp/")) {
    throw new Error("--output must not write artifacts under /tmp");
  }
  return resolved;
}

async function writeOrPrint(content: string, output: string | null): Promise<void> {
  if (output === null) {
    console.log(content.endsWith("\n") ? content.slice(0, -1) : content);
    return;
  }

  const resolved = assertRepoLocalOutput(output);
  await mkdir(dirname(resolved), { recursive: true });
  await Bun.write(resolved, content);
  console.error(`Wrote ${resolved}`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  const rows = await runPsqlJson<JobExportRow[]>(buildJobsExportSql(options));
  const content =
    options.format === "json"
      ? `${JSON.stringify(rows, null, 2)}\n`
      : renderJobsMarkdown(rows, { generatedAt: new Date(), filters: options });

  await writeOrPrint(content, options.output);
}

withPsqlClientCleanup(run).catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
