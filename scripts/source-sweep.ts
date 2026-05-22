import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

interface SourceSweepOptions {
  keywords: string[];
  sites: string[];
  timeFilter: string;
  includeRemote: boolean;
  location: string | null;
  limitPerSource: number;
  timeoutMs: number;
  discoveryDelayMs: number;
  discoveryProvider: string;
  includeDraft: boolean;
  includeRejected: boolean;
  outputDir: string;
  slug: string;
  execute: boolean;
}

interface CompletedCoverageRun {
  keyword: string;
  runId: number;
  reportPath: string;
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
    if (!flag) continue;
    if (!names.includes(flag)) continue;
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

function parseOptions(args: string[]): SourceSweepOptions {
  const keywords = readRepeatedFlag(args, ["--keyword", "-k"]);
  if (keywords.length === 0) {
    throw new Error("At least one --keyword is required");
  }

  return {
    keywords,
    sites: readRepeatedFlag(args, ["--site", "-s"]),
    timeFilter: readStringFlag(args, "--time") ?? "week",
    includeRemote: !args.includes("--exclude-remote"),
    location: readStringFlag(args, "--location"),
    limitPerSource: readNumberFlag(args, "--limit-per-source", 3),
    timeoutMs: readNumberFlag(args, "--timeout-ms", 20000),
    discoveryDelayMs: readNumberFlag(args, "--discovery-delay-ms", 700),
    discoveryProvider: readStringFlag(args, "--discovery") ?? "brave",
    includeDraft: args.includes("--include-draft"),
    includeRejected: args.includes("--include-rejected"),
    outputDir: readStringFlag(args, "--output-dir") ?? "docs/artifacts",
    slug: readStringFlag(args, "--slug") ?? new Date().toISOString().slice(0, 10),
    execute: args.includes("--execute"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run source:sweep -- --execute -k "senior AI engineer" -k "agentic engineer"

Options:
  -k, --keyword          Keyword to sweep. Repeatable, comma-separated values accepted.
  -s, --site             Source ID/label/site. Repeatable. Defaults to non-draft sources.
  --time                 Source-style time filter. Defaults to week.
  --location             Optional location text for search queries.
  --exclude-remote       Do not append remote to source-style site queries.
  --limit-per-source     Search result cap per source per keyword. Defaults to 3.
  --timeout-ms           Per-discovery-query timeout. Defaults to 20000.
  --discovery-delay-ms   Delay between discovery calls. Defaults to 700.
  --discovery            Discovery provider: auto, brave, or jina. Defaults to brave.
  --include-draft        Include draft/opportunistic sources in each run.
  --include-rejected     Include full rejected bodies in the combined full-text export.
  --output-dir           Repo-local artifact directory. Defaults to docs/artifacts.
  --slug                 Artifact slug. Defaults to YYYY-MM-DD.
  --execute              Required for live network/database writes.`);
}

function assertRepoLocalPath(path: string, flagName: string): string {
  const resolved = resolve(path);
  const root = process.cwd();
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`${flagName} must stay inside this project: ${path}`);
  }
  if (resolved.startsWith("/tmp/") || resolved.startsWith("/private/tmp/")) {
    throw new Error(`${flagName} must not write artifacts under /tmp`);
  }
  return resolved;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

async function runCommand(command: string[]): Promise<string> {
  console.error(command.join(" "));
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "inherit",
    stdin: "inherit",
  });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (output.trim()) console.log(output.trim());
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
  }
  return output;
}

async function runCoverageForKeyword(
  keyword: string,
  options: SourceSweepOptions,
  outputDir: string,
): Promise<CompletedCoverageRun> {
  const reportPath = `${outputDir}/source-coverage-${slugify(keyword)}-${options.timeFilter}-${options.discoveryProvider}-limit${options.limitPerSource}-${options.slug}.md`;
  const command = [
    "bun",
    "run",
    "source:coverage",
    "--",
    "--execute",
    "-k",
    keyword,
    "--time",
    options.timeFilter,
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
  ];

  if (!options.includeRemote) command.push("--exclude-remote");
  if (options.location) command.push("--location", options.location);
  if (options.includeDraft) command.push("--include-draft");
  for (const site of options.sites) {
    command.push("--site", site);
  }

  const output = await runCommand(command);
  const match = output.match(/Source coverage search run (\d+) complete\./);
  if (!match) {
    throw new Error(`Could not parse source coverage run ID for keyword "${keyword}"`);
  }
  const runIdValue = match[1];
  if (!runIdValue) {
    throw new Error(`Parsed empty source coverage run ID for keyword "${keyword}"`);
  }

  return {
    keyword,
    runId: Number.parseInt(runIdValue, 10),
    reportPath,
  };
}

async function exportFullText(
  runs: CompletedCoverageRun[],
  options: SourceSweepOptions,
  outputDir: string,
): Promise<string> {
  const output = `${outputDir}/screened-full-text-jobs-sweep-${options.timeFilter}-${options.discoveryProvider}-limit${options.limitPerSource}-${options.slug}.md`;
  const command = ["bun", "scripts/export-full-text-jobs.ts"];
  for (const run of runs) {
    command.push("--run-id", String(run.runId));
  }
  command.push("--output", output);
  if (options.includeRejected) command.push("--include-rejected");
  await runCommand(command);
  return output;
}

function renderIndex(
  runs: CompletedCoverageRun[],
  fullTextPath: string,
  options: SourceSweepOptions,
): string {
  const lines = [
    "# Source Sweep",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Keywords: ${options.keywords.join(", ")}`,
    `Time filter: ${options.timeFilter}`,
    `Remote filter: ${options.includeRemote ? "included" : "excluded"}`,
    `Location: ${options.location ?? "none"}`,
    `Discovery: ${options.discoveryProvider}`,
    `Limit per source: ${options.limitPerSource}`,
    `Draft sources included: ${options.includeDraft ? "yes" : "no"}`,
    "",
    "## Outputs",
    "",
    `- Combined full-text export: ${relative(process.cwd(), fullTextPath)}`,
    "",
    "## Runs",
    "",
    "| Keyword | Run ID | Coverage Report |",
    "|---|---:|---|",
  ];

  for (const run of runs) {
    lines.push(
      `| ${escapeTableCell(run.keyword)} | ${run.runId} | ${escapeTableCell(relative(process.cwd(), run.reportPath))} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  if (!options.execute) {
    console.log(`Source sweep dry plan: ${options.keywords.length} keyword run(s).`);
    console.log("Add --execute to run live search, page ingestion, classification, and export.");
    return;
  }

  const outputDir = assertRepoLocalPath(options.outputDir, "--output-dir");
  await mkdir(outputDir, { recursive: true });

  const runs: CompletedCoverageRun[] = [];
  for (const keyword of options.keywords) {
    runs.push(await runCoverageForKeyword(keyword, options, outputDir));
  }

  const fullTextPath = await exportFullText(runs, options, outputDir);
  const indexPath = `${outputDir}/source-sweep-${options.timeFilter}-${options.discoveryProvider}-limit${options.limitPerSource}-${options.slug}.md`;
  await mkdir(dirname(indexPath), { recursive: true });
  await Bun.write(indexPath, renderIndex(runs, fullTextPath, options));

  console.log(`Sweep index: ${indexPath}`);
  console.log(`Full-text export: ${fullTextPath}`);
  console.log(`Run IDs: ${runs.map((run) => run.runId).join(", ")}`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
