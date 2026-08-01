import { SEARCH_DOMAINS, SEARCH_KEYWORDS } from "../src/config/search";
import { withPsqlClientCleanup } from "../src/db/psql";
import { resolveJobSourceSites } from "../src/pipeline/sourceSites";
import { planMigrations } from "../src/db/migrations";
import {
  type DiscoveryProvider,
  fetchDiscoveryWithUsage,
  isDiscoveryProvider,
} from "../src/pipeline/discovery";
import {
  completeSearchQuery,
  completeSearchRun,
  createSearchQuery,
  createSearchRun,
  persistSearchResult,
} from "../src/pipeline/searchPersistence";
import { buildSearchTargets } from "../src/pipeline/searchTargets";
import { type TimeFilter, isTimeFilter } from "../src/pipeline/searchEngines";

interface SearchDbOptions {
  keywords: string[];
  domains: string[];
  siteValues: string[];
  timeFilter: TimeFilter;
  includeRemote: boolean;
  location: string | null;
  maxQueries: number;
  limitPerQuery: number;
  timeoutMs: number;
  discoveryProvider: DiscoveryProvider;
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

function readNumberFlag(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index === -1) return fallback;

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a numeric value`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
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

function parseOptions(args: string[]): SearchDbOptions {
  const keywordArgs = readRepeatedFlag(args, ["--keyword", "-k"]);
  const domainArgs = readRepeatedFlag(args, ["--domain", "-d"]);
  const siteValues = readRepeatedFlag(args, ["--site", "-s"]);
  const timeFilterValue = readStringFlag(args, "--time") ?? "24hours";
  if (!isTimeFilter(timeFilterValue)) {
    throw new Error(`Unsupported time filter "${timeFilterValue}"`);
  }
  const discoveryProvider = readStringFlag(args, "--discovery") ?? "auto";
  if (!isDiscoveryProvider(discoveryProvider)) {
    throw new Error(`Unsupported discovery provider "${discoveryProvider}"`);
  }

  const defaultKeyword = SEARCH_KEYWORDS[0];
  if (!defaultKeyword) {
    throw new Error("SEARCH_KEYWORDS must contain at least one keyword");
  }

  return {
    keywords: keywordArgs.length > 0 ? keywordArgs : [defaultKeyword],
    domains: domainArgs.length > 0 ? domainArgs : SEARCH_DOMAINS,
    siteValues,
    timeFilter: timeFilterValue,
    includeRemote: !args.includes("--exclude-remote"),
    location: readStringFlag(args, "--location"),
    maxQueries: readNumberFlag(args, "--max-queries", 12),
    limitPerQuery: readNumberFlag(args, "--limit", 20),
    timeoutMs: readNumberFlag(args, "--timeout-ms", 45000),
    discoveryProvider,
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run search:db -- -k "Agentic" --site greenhouse --site lever --limit 5
  bun run search:db -- -k "Engineer" --site all --max-queries 50 --limit 3 --timeout-ms 25000

Options:
  -k, --keyword       Search keyword. Repeatable. Comma-separated values accepted.
  -d, --domain        Site domain. Repeatable. Comma-separated values accepted.
  -s, --site          source ID/label/site. Repeatable. Use "all" for the configured source list.
  --time              source-style time filter. Defaults to 24hours.
  --location          Optional location text to append to source-style site queries.
  --exclude-remote    Do not append "remote" to source-style site queries.
  --max-queries       Query cap. Defaults to 12 to avoid accidental broad runs.
  --limit             Result cap per query. Defaults to 20.
  --timeout-ms        Per-discovery-query timeout. Defaults to 45000.
  --discovery         Discovery provider: auto, brave, jina, or keyless. Defaults to auto.
  --json              Print machine-readable run summary.

Requires DATABASE_URL and applied job_search migrations. Auto discovery prefers BRAVE_API_KEY, then JINA_API_KEY, then a keyless zero-result state.`);
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

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  const sites = resolveJobSourceSites(options.siteValues);
  const targets = buildSearchTargets({
    keywords: options.keywords,
    domains: options.domains,
    sites,
    timeFilter: options.timeFilter,
    includeRemote: options.includeRemote,
    location: options.location,
  });
  const selectedTargets = targets.slice(0, options.maxQueries);
  const sourceSet = [...new Set(selectedTargets.map((target) => target.sourceId))];

  if (targets.length > selectedTargets.length) {
    console.error(
      `Capped at ${selectedTargets.length}/${targets.length} targets. Raise --max-queries to run more.`,
    );
  }

  await assertMigrationsReady();

  const needsDiscovery = selectedTargets.some((target) => target.kind === "search-query");
  if (
    needsDiscovery &&
    options.discoveryProvider === "brave" &&
    !(process.env.BRAVE_API_KEY ?? "")
  ) {
    throw new Error("BRAVE_API_KEY is required for Brave discovery");
  }
  if (
    needsDiscovery &&
    options.discoveryProvider === "jina" &&
    !(process.env.JINA_API_KEY ?? "")
  ) {
    throw new Error("JINA_API_KEY is required for Jina Search discovery");
  }

  const runId = await createSearchRun({
    keyword: options.keywords.join(", "),
    sourceSet,
    timeFilter: options.timeFilter,
    includeRemote: options.includeRemote,
    location: options.location,
    limitPerQuery: options.limitPerQuery,
    timeoutMs: options.timeoutMs,
  });

  const errors: Array<{ label: string; error: string }> = [];
  let successfulQueries = 0;
  let totalReportedTokens = 0;
  let totalResults = 0;

  for (const [index, target] of selectedTargets.entries()) {
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
      console.error(`[${index + 1}/${selectedTargets.length}] Stored direct URL for ${target.label}`);
      continue;
    }

    try {
      console.error(`[${index + 1}/${selectedTargets.length}] Searching ${target.label}`);
      const call = await fetchDiscoveryWithUsage(
        target.query,
        {
          braveApiKey: process.env.BRAVE_API_KEY ?? "",
          jinaApiKey: process.env.JINA_API_KEY ?? "",
        },
        {
          timeoutMs: options.timeoutMs,
          provider: options.discoveryProvider,
          count: options.limitPerQuery,
        },
      );
      const items = target.filter(call.results).slice(0, options.limitPerQuery);

      for (const [itemIndex, item] of items.entries()) {
        await persistSearchResult({
          queryId,
          rank: itemIndex + 1,
          sourceLabel: target.label,
          item,
        });
      }

      await completeSearchQuery({
        queryId,
        status: "success",
        usageTokens: call.usage.tokens,
        decompressedBytes: call.usage.decompressedContentLength,
        error: null,
      });

      if (call.usage.tokens !== null) {
        totalReportedTokens += call.usage.tokens;
      }
      totalResults += items.length;
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
  }

  const status =
    errors.length === 0 ? "completed" : successfulQueries > 0 ? "completed_with_errors" : "failed";
  await completeSearchRun({
    runId,
    status,
    totalReportedTokens,
    errorSummary: errors.length > 0 ? errors.map((error) => `${error.label}: ${error.error}`).join("\n") : null,
  });

  const summary = {
    runId,
    status,
    targets: selectedTargets.length,
    successfulQueries,
    errors,
    totalResults,
    totalReportedTokens,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Run ${runId} ${status}`);
    console.log(`Targets: ${selectedTargets.length}`);
    console.log(`Successful queries: ${successfulQueries}`);
    console.log(`Results persisted: ${totalResults}`);
    console.log(`Reported Jina tokens: ${totalReportedTokens}`);
    if (errors.length > 0) {
      console.log(`Errors: ${errors.length}`);
    }
  }

  if (status === "failed") {
    process.exitCode = 1;
  }
}

withPsqlClientCleanup(run).catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
