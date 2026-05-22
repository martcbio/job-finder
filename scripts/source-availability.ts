import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  type SourceAvailabilityAttempt,
  buildSourceAvailabilitySummary,
  renderSourceAvailabilityMarkdown,
} from "../src/pipeline/sourceAvailability";
import type { SourceCoverageRow } from "../src/pipeline/sourceCoverage";
import { isDiscoveryProvider, type DiscoveryProvider } from "../src/pipeline/discovery";

interface SourceAvailabilityOptions {
  keywords: string[];
  runs: number;
  discoveryProvider: DiscoveryProvider;
  limitPerSource: number;
  timeoutMs: number;
  discoveryDelayMs: number;
  reportPath: string;
  execute: boolean;
  json: boolean;
}

interface CoverageJson {
  runId: number;
  reportPath: string;
  rows: SourceCoverageRow[];
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

function parseOptions(args: string[]): SourceAvailabilityOptions {
  const discoveryProvider = readStringFlag(args, "--discovery") ?? "auto";
  if (!isDiscoveryProvider(discoveryProvider)) {
    throw new Error(`Unsupported discovery provider "${discoveryProvider}"`);
  }

  return {
    keywords: readRepeatedFlag(args, ["--keyword", "-k"]),
    runs: readNumberFlag(args, "--runs", 3),
    discoveryProvider,
    limitPerSource: readNumberFlag(args, "--limit-per-source", 1),
    timeoutMs: readNumberFlag(args, "--timeout-ms", 15000),
    discoveryDelayMs: readNumberFlag(args, "--discovery-delay-ms", 1000),
    reportPath:
      readStringFlag(args, "--report") ??
      `docs/artifacts/source-availability-${new Date().toISOString().slice(0, 10)}.md`,
    execute: args.includes("--execute"),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run source:availability -- --execute -k Agentic -k RAG -k Inference --runs 3

Options:
  -k, --keyword          Representative keyword. Repeatable.
  --runs                 Number of runs per keyword. Defaults to 3.
  --discovery            Discovery provider: auto, brave, or jina. Defaults to auto.
  --limit-per-source     Search result cap per source. Defaults to 1.
  --timeout-ms           Per-discovery timeout. Defaults to 15000.
  --discovery-delay-ms   Delay between discovery calls in each coverage run. Defaults to 1000.
  --report               Aggregate markdown report path.
  --execute              Required for live network/database writes.
  --json                 Print machine-readable aggregate summary.

Defaults to required non-draft configured sources via source:coverage.`);
}

async function runCoverageAttempt(
  options: SourceAvailabilityOptions,
  keyword: string,
  runIndex: number,
): Promise<CoverageJson> {
  const reportDir = dirname(options.reportPath);
  const stem = basename(options.reportPath).replace(/\.md$/, "");
  const reportPath = `${reportDir}/${stem}-${slug(keyword)}-run-${runIndex}.md`;
  const command = [
    "bun",
    "run",
    "source:coverage",
    "--",
    "--execute",
    "-k",
    keyword,
    "--discovery",
    options.discoveryProvider,
    "--limit-per-source",
    String(options.limitPerSource),
    "--timeout-ms",
    String(options.timeoutMs),
    "--discovery-delay-ms",
    String(options.discoveryDelayMs),
    "--report",
    reportPath,
    "--json",
  ];

  console.error(command.join(" "));
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "inherit",
    stdin: "inherit",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
  }

  return parseCoverageJson(stdout);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  const keywords = options.keywords.length > 0 ? options.keywords : ["Agentic", "RAG", "Inference"];

  if (!options.execute) {
    console.log(
      `Source availability dry plan: ${keywords.length} keyword(s) x ${options.runs} run(s).`,
    );
    console.log("Add --execute to run live coverage attempts and aggregate the report.");
    console.log(`Report path: ${options.reportPath}`);
    return;
  }

  const attempts: SourceAvailabilityAttempt[] = [];
  for (const keyword of keywords) {
    for (let runIndex = 1; runIndex <= options.runs; runIndex++) {
      const coverage = await runCoverageAttempt(options, keyword, runIndex);
      attempts.push({
        keyword,
        runIndex,
        runId: coverage.runId,
        rows: coverage.rows,
      });
    }
  }

  const summary = buildSourceAvailabilitySummary(attempts);
  const markdown = renderSourceAvailabilityMarkdown(summary);
  await mkdir(dirname(options.reportPath), { recursive: true });
  await Bun.write(options.reportPath, markdown);

  if (options.json) {
    console.log(JSON.stringify({ reportPath: options.reportPath, summary }, null, 2));
    return;
  }

  console.log(`Availability report: ${options.reportPath}`);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseCoverageJson(stdout: string): CoverageJson {
  const start = stdout.lastIndexOf("\n{");
  const jsonText = (start === -1 ? stdout : stdout.slice(start + 1)).trim();
  if (!jsonText.startsWith("{")) {
    throw new Error(`source:coverage did not emit JSON output. stdout began: ${stdout.slice(0, 200)}`);
  }

  return JSON.parse(jsonText) as CoverageJson;
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
