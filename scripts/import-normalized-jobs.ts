import { readFileSync } from "node:fs";
import {
  ingestNormalizedJobs,
  normalizeExternalJobPayload,
} from "../src/pipeline/normalizedJobIngest";

interface ImportOptions {
  file: string | null;
  sourceId: string;
  keyword: string;
  limit: number | null;
  timeoutMs: number;
  dryRun: boolean;
  json: boolean;
}

function readStringFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function readNumberFlag(args: string[], name: string, fallback: number | null): number | null {
  const value = readStringFlag(args, name);
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseOptions(args: string[]): ImportOptions {
  return {
    file: readStringFlag(args, "--file"),
    sourceId: readStringFlag(args, "--source") ?? "jobspy",
    keyword: readStringFlag(args, "--keyword") ?? "normalized-import",
    limit: readNumberFlag(args, "--limit", null),
    timeoutMs: readNumberFlag(args, "--timeout-ms", 30000) ?? 30000,
    dryRun: args.includes("--dry-run"),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run jobs:import-normalized -- --source jobspy --file /path/to/jobspy_snapshot.json

Options:
  --file          JSON file. If omitted, reads JSON from stdin.
  --source        Source ID for the import. Defaults to jobspy.
  --keyword       Stored search_run keyword. Defaults to normalized-import.
  --limit         Optional max jobs to import.
  --timeout-ms    Stored run timeout metadata. Defaults to 30000.
  --dry-run       Validate and summarize without writing Postgres.
  --json          Print machine-readable summary.`);
}

async function readInput(file: string | null): Promise<unknown> {
  const text = file === null ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  return JSON.parse(text) as unknown;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  const payload = await readInput(options.file);
  const allJobs = normalizeExternalJobPayload(payload, options.sourceId);
  const jobs = options.limit === null ? allJobs : allJobs.slice(0, options.limit);

  if (options.dryRun) {
    const summary = {
      sourceId: options.sourceId,
      jobsSeen: allJobs.length,
      jobsSelected: jobs.length,
      sample: jobs.slice(0, 3).map((job) => ({
        title: job.title,
        company: job.company,
        location: job.location,
        url: job.url,
        descriptionBytes: Buffer.byteLength(job.description, "utf8"),
      })),
    };
    console.log(options.json ? JSON.stringify(summary, null, 2) : `Validated ${jobs.length}/${allJobs.length} jobs.`);
    return;
  }

  const result = await ingestNormalizedJobs({
    sourceId: options.sourceId,
    sourceLabel: sourceLabel(options.sourceId),
    keyword: options.keyword,
    jobs,
    timeoutMs: options.timeoutMs,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Run ${result.runId} imported ${result.jobsPersisted}/${result.jobsSeen} jobs.`);
    console.log(`Full-text pages persisted: ${result.pagesPersisted}`);
    if (result.errors.length > 0) console.log(`Errors: ${result.errors.length}`);
  }

  if (result.jobsPersisted === 0) process.exitCode = 1;
}

function sourceLabel(sourceId: string): string {
  if (sourceId === "jobspy") return "JobSpy";
  if (sourceId === "jobserve") return "JobServe";
  return sourceId;
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
