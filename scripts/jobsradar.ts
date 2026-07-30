import { runJobIngest, type JobIngestOptionsInput } from "../src/pipeline/jobIngest";

interface CliOptions {
  command: "ingest";
  json: boolean;
  help: boolean;
  ingest: JobIngestOptionsInput;
}

function usage(): string {
  return [
    "Usage:",
    "  jobsradar ingest [--source <id>] [--jobserve] [--json]",
    "",
    "Raw acquisition only: fetch, preserve evidence, normalize, and persist.",
    "Default sources: lab-ats, linear-careers, google-careers.",
    "JobServe is opt-in and remains bounded to its fair-use envelope.",
  ].join("\n");
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  let command: CliOptions["command"] = "ingest";
  let json = false;
  let help = false;
  let includeJobServe = false;
  const sourceIds: string[] = [];
  const jobserveQueries: string[] = [];
  const ingest: JobIngestOptionsInput = {};

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "ingest") {
      command = "ingest";
      continue;
    }
    if (argument === "--source") {
      sourceIds.push(requiredValue(argv, index, argument));
      index++;
      continue;
    }
    if (argument === "--jobserve") {
      includeJobServe = true;
      continue;
    }
    if (argument === "--jobserve-query") {
      jobserveQueries.push(requiredValue(argv, index, argument));
      index++;
      continue;
    }
    if (argument === "--jobserve-max-pages") {
      ingest.jobserveMaxPages = positiveInteger(requiredValue(argv, index, argument), argument);
      index++;
      continue;
    }
    if (argument === "--jobserve-detail-limit") {
      ingest.jobserveImportLimitPerQuery = positiveInteger(
        requiredValue(argv, index, argument),
        argument,
      );
      index++;
      continue;
    }
    if (argument === "--direct-limit") {
      ingest.directLimit = positiveInteger(requiredValue(argv, index, argument), argument);
      index++;
      continue;
    }
    if (argument === "--timeout-ms") {
      ingest.timeoutMs = positiveInteger(requiredValue(argv, index, argument), argument);
      index++;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
  }

  if (sourceIds.length > 0) ingest.sourceIds = sourceIds;
  if (jobserveQueries.length > 0) ingest.jobserveQueries = jobserveQueries;
  if (includeJobServe) ingest.includeJobServe = true;
  return { command, json, help, ingest };
}

function renderResult(result: Awaited<ReturnType<typeof runJobIngest>>): string {
  const lines = [`jobsradar ingest: ${result.status}`];
  for (const source of result.sources) {
    lines.push(
      `${source.id}: ${source.status}; discovered=${source.discovered}; imported=${source.imported}`,
    );
    for (const error of source.errors) lines.push(`  ${error}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await runJobIngest(options.ingest);
  console.log(options.json ? JSON.stringify(result, null, 2) : renderResult(result));
  process.exitCode = result.status === "complete" ? 0 : 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
