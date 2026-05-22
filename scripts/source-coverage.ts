import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { planMigrations } from "../src/db/migrations";
import { runPsqlJson } from "../src/db/psql";
import {
  JOB_SOURCE_SITES,
  REQUIRED_JOB_SOURCE_SITES,
  type JobSourceSite,
  isDraftJobSourceSite,
  resolveJobSourceSites,
} from "../src/pipeline/sourceSites";
import {
  type SourceCoverageRow,
  type SourceCoverageRunContext,
  applySourceCoverageScreening,
  buildSourceCoverageRunContextSql,
  buildSourceCoverageSql,
  renderSourceCoverageMarkdown,
} from "../src/pipeline/sourceCoverage";
import {
  type DiscoveryProvider,
  fetchDiscoveryWithUsage,
  isDiscoveryProvider,
} from "../src/pipeline/discovery";
import { type TimeFilter, isTimeFilter } from "../src/pipeline/searchEngines";
import { validateCandidateBeforePersist } from "../src/pipeline/candidateValidation";
import {
  completeSearchQuery,
  completeSearchRun,
  createSearchQuery,
  createSearchRun,
  persistSearchResult,
} from "../src/pipeline/searchPersistence";
import { buildSearchTargets } from "../src/pipeline/searchTargets";

interface SourceCoverageOptions {
  keyword: string;
  siteValues: string[];
  timeFilter: TimeFilter;
  includeRemote: boolean;
  location: string | null;
  limitPerSource: number;
  timeoutMs: number;
  discoveryDelayMs: number;
  pageLimit: number | null;
  classifyLimit: number | null;
  reportPath: string;
  fromRunId: number | null;
  discoveryProvider: DiscoveryProvider;
  includeDraft: boolean;
  execute: boolean;
  json: boolean;
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

function readNumberFlag(args: string[], name: string, fallback: number | null): number | null {
  const value = readStringFlag(args, name);
  if (value === null) return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseOptions(args: string[]): SourceCoverageOptions {
  const timeFilterValue = readStringFlag(args, "--time") ?? "24hours";
  if (!isTimeFilter(timeFilterValue)) {
    throw new Error(`Unsupported time filter "${timeFilterValue}"`);
  }

  const keyword = readStringFlag(args, "--keyword") ?? readStringFlag(args, "-k") ?? "Agentic";
  const defaultReportPath = `docs/artifacts/source-coverage-${new Date().toISOString().slice(0, 10)}.md`;
  const provider = readStringFlag(args, "--discovery") ?? "auto";
  if (!isDiscoveryProvider(provider)) {
    throw new Error(`Unsupported discovery provider "${provider}"`);
  }

  return {
    keyword,
    siteValues: readRepeatedFlag(args, ["--site", "-s"]),
    timeFilter: timeFilterValue,
    includeRemote: !args.includes("--exclude-remote"),
    location: readStringFlag(args, "--location"),
    limitPerSource: readNumberFlag(args, "--limit-per-source", 1) ?? 1,
    timeoutMs: readNumberFlag(args, "--timeout-ms", 30000) ?? 30000,
    discoveryDelayMs: readNumberFlag(args, "--discovery-delay-ms", 1000) ?? 1000,
    pageLimit: readNumberFlag(args, "--page-limit", null),
    classifyLimit: readNumberFlag(args, "--classify-limit", null),
    reportPath: readStringFlag(args, "--report") ?? defaultReportPath,
    fromRunId: readNumberFlag(args, "--from-run-id", null),
    discoveryProvider: provider,
    includeDraft: args.includes("--include-draft"),
    execute: args.includes("--execute"),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run source:coverage -- --execute -k "Agentic" --time 24hours
  bun run source:coverage -- --execute -k "Agentic" --site greenhouse --site lever --limit-per-source 2

Options:
  -k, --keyword          Search keyword. Defaults to Agentic.
  -s, --site             source ID/label/site. Repeatable. Defaults to all configured sources.
  --time                 source-style time filter. Defaults to 24hours.
  --location             Optional location text for search queries.
  --exclude-remote       Do not append remote to source-style site queries.
  --limit-per-source     Search result cap per source. Defaults to 1.
  --timeout-ms           Per-Jina-query timeout. Defaults to 30000.
  --discovery-delay-ms   Delay between discovery calls. Defaults to 1000.
  --page-limit           Page ingest cap. Defaults to persisted result count.
  --classify-limit       Classification cap. Defaults to page ingest cap.
  --report               Markdown report path. Defaults to docs/artifacts/source-coverage-YYYY-MM-DD.md.
  --from-run-id          Regenerate a coverage report from an existing search run without live calls.
  --discovery            Discovery provider: auto, brave, or jina. Defaults to auto.
  --include-draft        Include draft/opportunistic sources in the run.
  --execute              Required for live network/database writes.
  --json                 Print machine-readable summary.

Requires DATABASE_URL and applied job_search migrations. Auto discovery prefers BRAVE_API_KEY, then JINA_API_KEY.`);
}

async function assertMigrationsReady(): Promise<void> {
  const plan = await planMigrations();
  if (plan.pending.length > 0) {
    throw new Error(`Database has ${plan.pending.length} pending migration(s). Run bun run db:migrate.`);
  }
}

function errorStatus(message: string): "timeout" | "error" {
  return message.toLowerCase().includes("timed out") ? "timeout" : "error";
}

async function runCommand(command: string[]): Promise<void> {
  console.error(command.join(" "));
  const proc = Bun.spawn(command, {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
  }
}

async function runSearch(options: SourceCoverageOptions, sites: JobSourceSite[]): Promise<{
  runId: number;
  totalResults: number;
  totalReportedTokens: number;
  errors: Array<{ label: string; error: string }>;
}> {
  const targets = buildSearchTargets({
    keywords: [options.keyword],
    domains: [],
    sites,
    timeFilter: options.timeFilter,
    includeRemote: options.includeRemote,
    location: options.location,
  });

  const runId = await createSearchRun({
    keyword: options.keyword,
    sourceSet: sites.map((site) => site.id),
    timeFilter: options.timeFilter,
    includeRemote: options.includeRemote,
    location: options.location,
    limitPerQuery: options.limitPerSource,
    timeoutMs: options.timeoutMs,
  });

  const errors: Array<{ label: string; error: string }> = [];
  let successfulQueries = 0;
  let totalResults = 0;
  let totalReportedTokens = 0;

  for (const [index, target] of targets.entries()) {
    const queryId = await createSearchQuery({ runId, target });

    if (target.kind === "direct-url") {
      await persistSearchResult({
        queryId,
        rank: 1,
        sourceLabel: target.label,
        item: {
          title: target.label,
          url: target.url,
          description: "",
        },
      });
      successfulQueries += 1;
      totalResults += 1;
      console.error(`[${index + 1}/${targets.length}] Stored direct URL for ${target.label}`);
      continue;
    }

    try {
      console.error(`[${index + 1}/${targets.length}] Searching ${target.label}`);
      const call = await fetchDiscoveryWithUsage(
        target.query,
        {
          braveApiKey: process.env.BRAVE_API_KEY ?? "",
          jinaApiKey: process.env.JINA_API_KEY ?? "",
        },
        {
          timeoutMs: options.timeoutMs,
          provider: options.discoveryProvider,
          count: options.limitPerSource,
        },
      );
      const items = target.filter(call.results).slice(0, options.limitPerSource);

      let persistedRank = 1;
      for (const item of items) {
        const validation = await validateCandidateBeforePersist(item);
        if (!validation.accepted) {
          console.error(`Skipping ${target.label} candidate: ${validation.reason}`);
          continue;
        }
        await persistSearchResult({
          queryId,
          rank: persistedRank,
          sourceLabel: target.label,
          item,
        });
        persistedRank += 1;
      }

      await completeSearchQuery({
        queryId,
        status: "success",
        usageTokens: call.usage.tokens,
        decompressedBytes: call.usage.decompressedContentLength,
        error: null,
      });

      if (call.usage.tokens !== null) totalReportedTokens += call.usage.tokens;
      totalResults += persistedRank - 1;
      successfulQueries += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ label: target.label, error: message });
      await completeSearchQuery({
        queryId,
        status: errorStatus(message),
        usageTokens: null,
        decompressedBytes: null,
        error: message,
      });
      console.error(`Search failed for ${target.label}: ${message}`);
    }

    if (options.discoveryDelayMs > 0 && index < targets.length - 1) {
      await Bun.sleep(options.discoveryDelayMs);
    }
  }

  const status =
    errors.length === 0 ? "completed" : successfulQueries > 0 ? "completed_with_errors" : "failed";
  await completeSearchRun({
    runId,
    status,
    totalReportedTokens,
    errorSummary: errors.length > 0 ? errors.map((error) => `${error.label}: ${error.error}`).join("\n") : null,
  });

  return { runId, totalResults, totalReportedTokens, errors };
}

async function writeReport(
  rows: SourceCoverageRow[],
  context: SourceCoverageRunContext,
  reportPath: string,
): Promise<void> {
  const screenedRows = applySourceCoverageScreening(rows);
  const markdown = renderSourceCoverageMarkdown(screenedRows, {
    generatedAt: new Date(),
    runId: context.runId,
    keyword: context.keyword,
    timeFilter: context.timeFilter,
    includeRemote: context.includeRemote,
    location: context.location,
  });

  await mkdir(dirname(reportPath), { recursive: true });
  await Bun.write(reportPath, markdown);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);

  if (options.fromRunId !== null) {
    const reportSites =
      options.siteValues.length > 0
        ? resolveJobSourceSites(options.siteValues)
        : options.includeDraft
          ? JOB_SOURCE_SITES
          : REQUIRED_JOB_SOURCE_SITES;
    const context = await runPsqlJson<SourceCoverageRunContext>(
      buildSourceCoverageRunContextSql(options.fromRunId),
    );
    const rows = applySourceCoverageScreening(
      await runPsqlJson<SourceCoverageRow[]>(
        buildSourceCoverageSql(options.fromRunId, reportSites),
      ),
    );
    await writeReport(rows, context, options.reportPath);

    if (options.json) {
      console.log(JSON.stringify({ reportPath: options.reportPath, rows }, null, 2));
      return;
    }

    console.log(`Report: ${options.reportPath}`);
    return;
  }

  const sites =
    options.siteValues.length > 0
      ? resolveJobSourceSites(options.siteValues)
      : options.includeDraft
        ? [...JOB_SOURCE_SITES]
        : [...REQUIRED_JOB_SOURCE_SITES];
  const draftSites = sites.filter(isDraftJobSourceSite);
  if (draftSites.length > 0 && !options.includeDraft) {
    throw new Error(
      `Draft/opportunistic sources require --include-draft: ${draftSites.map((site) => site.id).join(", ")}`,
    );
  }
  const targets = buildSearchTargets({
    keywords: [options.keyword],
    domains: [],
    sites,
    timeFilter: options.timeFilter,
    includeRemote: options.includeRemote,
    location: options.location,
  });

  if (!options.execute) {
    console.log(`Source coverage dry plan: ${targets.length} source target(s).`);
    console.log("Add --execute to run live search, page ingestion, classification, and report writing.");
    console.log(`Report path: ${options.reportPath}`);
    return;
  }

  await assertMigrationsReady();

  const needsDiscovery = targets.some((target) => target.kind === "search-query");
  if (
    needsDiscovery &&
    options.discoveryProvider !== "auto" &&
    options.discoveryProvider === "brave" &&
    !(process.env.BRAVE_API_KEY ?? "")
  ) {
    throw new Error("BRAVE_API_KEY is required for Brave discovery");
  }
  if (
    needsDiscovery &&
    options.discoveryProvider !== "auto" &&
    options.discoveryProvider === "jina" &&
    !(process.env.JINA_API_KEY ?? "")
  ) {
    throw new Error("JINA_API_KEY is required for Jina Search discovery");
  }

  const search = await runSearch(options, sites);
  const pageLimit = options.pageLimit ?? Math.max(search.totalResults, 1);
  const classifyLimit = options.classifyLimit ?? pageLimit;

  if (search.totalResults > 0) {
    await runCommand([
      "bun",
      "run",
      "jobs:ingest-pages",
      "--",
      "--limit",
      String(pageLimit),
      "--run-id",
      String(search.runId),
    ]);
    await runCommand([
      "bun",
      "run",
      "jobs:classify",
      "--",
      "--limit",
      String(classifyLimit),
      "--run-id",
      String(search.runId),
    ]);
  }

  const rows = applySourceCoverageScreening(
    await runPsqlJson<SourceCoverageRow[]>(buildSourceCoverageSql(search.runId, sites)),
  );
  await writeReport(
    rows,
    {
      runId: search.runId,
      keyword: options.keyword,
      timeFilter: options.timeFilter,
      includeRemote: options.includeRemote,
      location: options.location,
    },
    options.reportPath,
  );

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          runId: search.runId,
          reportPath: options.reportPath,
          totalResults: search.totalResults,
          totalReportedTokens: search.totalReportedTokens,
          errors: search.errors,
          rows,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Source coverage search run ${search.runId} complete.`);
  console.log(`Results persisted: ${search.totalResults}`);
  console.log(`Reported Jina tokens: ${search.totalReportedTokens}`);
  console.log(`Report: ${options.reportPath}`);

  if (search.errors.length > 0) {
    console.log(`Search errors: ${search.errors.length}`);
  }

  if (search.errors.length > 0 && search.totalResults === 0) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
