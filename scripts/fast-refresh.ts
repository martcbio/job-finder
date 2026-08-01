import {
  type FastRefreshOptions,
  DEFAULT_FAST_REFRESH_OPTIONS,
  renderFastRefreshMarkdown,
  runFastRefresh,
} from "../src/pipeline/fastRefresh";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closePsqlClients } from "../src/db/psql";

interface CliOptions extends FastRefreshOptions {
  json: boolean;
}

const KNOWN_FLAGS = new Set([
  "--source",
  "--source-id",
  "--jobserve-query",
  "-q",
  "--jobserve-max-pages",
  "--jobserve-import-limit-per-query",
  "--timeout-ms",
  "--classify-limit",
  "--limit",
  "--json",
]);

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
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    values.push(...splitList(value));
    i++;
  }
  return values;
}

function readStringFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function readNumberFlag(args: string[], name: string, fallback: number): number {
  const value = readStringFlag(args, name);
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseOptions(args: string[]): CliOptions {
  for (const argument of args) {
    if (argument.startsWith("-") && !KNOWN_FLAGS.has(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  const queries = readRepeatedFlag(args, ["--jobserve-query", "-q"]);
  const sources = readRepeatedFlag(args, ["--source", "--source-id"]);
  return {
    limit: readNumberFlag(args, "--limit", DEFAULT_FAST_REFRESH_OPTIONS.limit),
    sourceIds: sources.length > 0 ? sources : DEFAULT_FAST_REFRESH_OPTIONS.sourceIds,
    jobserveQueries: queries.length > 0 ? queries : DEFAULT_FAST_REFRESH_OPTIONS.jobserveQueries,
    jobserveMaxPages: readNumberFlag(
      args,
      "--jobserve-max-pages",
      DEFAULT_FAST_REFRESH_OPTIONS.jobserveMaxPages,
    ),
    jobserveImportLimitPerQuery: readNumberFlag(
      args,
      "--jobserve-import-limit-per-query",
      DEFAULT_FAST_REFRESH_OPTIONS.jobserveImportLimitPerQuery,
    ),
    timeoutMs: readNumberFlag(args, "--timeout-ms", DEFAULT_FAST_REFRESH_OPTIONS.timeoutMs),
    classifyLimit: readNumberFlag(
      args,
      "--classify-limit",
      DEFAULT_FAST_REFRESH_OPTIONS.classifyLimit,
    ),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run jobs:fast-refresh -- --limit 20
  bun run jobserve:refresh-contracts -- -q "AI engineer" -q "agentic AI" -q "LLM engineer" --jobserve-max-pages 2

Options:
  --source, --source-id   Source id to run. Repeatable. Defaults to JobServe, Linear, and Google.
  -q, --jobserve-query    JobServe query. Repeatable. Defaults to AI engineer, agentic AI, LLM engineer.
  --jobserve-max-pages    JobServe classic pages per query. Defaults to 2.
  --jobserve-import-limit-per-query
                           JobServe detail pages to persist per query. Defaults to 5.
  --timeout-ms            Per-request timeout. Defaults to 20000.
  --classify-limit        Max jobs to classify per run. Defaults to 250.
  --limit                 Latest ranked jobs to print. Defaults to 20.
  --json                  Print machine-readable summary.

Requires DATABASE_URL. Uses the shared fast-refresh pipeline module behind the CLI and API.`);
}

export interface FastRefreshCliDependencies {
  runFastRefresh: typeof runFastRefresh;
  closePsqlClients: typeof closePsqlClients;
}

const defaultDependencies: FastRefreshCliDependencies = { runFastRefresh, closePsqlClients };

export async function executeFastRefreshCli(
  args: string[],
  dependencies: FastRefreshCliDependencies = defaultDependencies,
): Promise<number> {
  try {
    if (args.includes("--help") || args.includes("-h")) {
      printUsage();
      return 0;
    }

    const { json, ...options } = parseOptions(args);
    const result = await dependencies.runFastRefresh(options);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(renderFastRefreshMarkdown(result).trimEnd());
    }

    const errors = result.sources.flatMap((source) => source.errors);
    const runIds = result.sources.flatMap((source) => (source.runId === null ? [] : [source.runId]));
    return runIds.length === 0 || errors.length > 0 ? 1 : 0;
  } finally {
    await dependencies.closePsqlClients();
  }
}

async function main(): Promise<void> {
  process.exitCode = await executeFastRefreshCli(process.argv.slice(2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  });
}
