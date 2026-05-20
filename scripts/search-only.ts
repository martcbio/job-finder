import { SEARCH_DOMAINS, SEARCH_KEYWORDS } from "../src/config/search";
import {
  type BrianJobSite,
  type BrianSiteSearchTarget,
  buildBrianSiteSearchTarget,
  resolveBrianJobSites,
} from "../src/pipeline/brianSites";
import {
  type JinaSearchResult,
  buildSearchQuery,
  fetchJinaSearchWithUsage,
  filterJobResults,
} from "../src/pipeline/search";
import {
  BRIAN_SEARCH_ENGINES,
  type BrianSearchEngine,
  type BrianTimeFilter,
  buildBrianSearchUrl,
  isBrianSearchEngine,
  isBrianTimeFilter,
} from "../src/pipeline/searchEngines";

interface SearchOnlyOptions {
  keywords: string[];
  domains: string[];
  sites: BrianJobSite[];
  engines: BrianSearchEngine[];
  timeFilter: BrianTimeFilter;
  includeRemote: boolean;
  location: string | null;
  maxQueries: number;
  limitPerQuery: number;
  timeoutMs: number;
  json: boolean;
  dryRun: boolean;
  links: boolean;
}

interface SearchOnlyResult {
  keyword: string;
  label: string;
  query: string | null;
  directUrl: string | null;
  items: SearchOnlyItem[];
  urls: string[];
  usage: {
    tokens: number | null;
    decompressedContentLength: number | null;
  };
}

interface SearchLinkResult {
  keyword: string;
  label: string;
  query: string | null;
  engine: BrianSearchEngine | "direct";
  timeFilter: BrianTimeFilter;
  url: string;
}

type SearchTarget =
  | {
      kind: "search-query";
      keyword: string;
      label: string;
      query: string;
      filter: (results: JinaSearchResult[]) => SearchOnlyItem[];
    }
  | {
      kind: "direct-url";
      keyword: string;
      label: string;
      url: string;
    };

interface SearchOnlyItem {
  title: string;
  url: string;
  description: string;
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

function parseEngines(args: string[]): BrianSearchEngine[] {
  const values = readRepeatedFlag(args, ["--engine", "-e"]);
  if (values.length === 0 || values.includes("all")) {
    return [...BRIAN_SEARCH_ENGINES];
  }

  const engines: BrianSearchEngine[] = [];
  for (const value of values) {
    if (!isBrianSearchEngine(value)) {
      throw new Error(`Unsupported engine "${value}". Supported engines: ${BRIAN_SEARCH_ENGINES.join(", ")}`);
    }
    engines.push(value);
  }

  return [...new Set(engines)];
}

function parseOptions(args: string[]): SearchOnlyOptions {
  const keywordArgs = readRepeatedFlag(args, ["--keyword", "-k"]);
  const domainArgs = readRepeatedFlag(args, ["--domain", "-d"]);
  const siteArgs = readRepeatedFlag(args, ["--site", "-s"]);
  const timeFilterValue = readStringFlag(args, "--time") ?? "24hours";
  if (!isBrianTimeFilter(timeFilterValue)) {
    throw new Error(`Unsupported time filter "${timeFilterValue}"`);
  }

  const envKeywords = process.env.SEARCH_ONLY_KEYWORDS
    ? splitList(process.env.SEARCH_ONLY_KEYWORDS)
    : [];
  const envDomains = process.env.SEARCH_ONLY_DOMAINS ? splitList(process.env.SEARCH_ONLY_DOMAINS) : [];

  const keywords = keywordArgs.length > 0 ? keywordArgs : envKeywords;
  const domains = domainArgs.length > 0 ? domainArgs : envDomains;
  const defaultKeyword = SEARCH_KEYWORDS[0];
  if (!defaultKeyword) {
    throw new Error("SEARCH_KEYWORDS must contain at least one keyword");
  }

  return {
    keywords: keywords.length > 0 ? keywords : [defaultKeyword],
    domains: domains.length > 0 ? domains : SEARCH_DOMAINS,
    sites: resolveBrianJobSites(siteArgs),
    engines: parseEngines(args),
    timeFilter: timeFilterValue,
    includeRemote: !args.includes("--exclude-remote"),
    location: readStringFlag(args, "--location"),
    maxQueries: readNumberFlag(args, "--max-queries", 12),
    limitPerQuery: readNumberFlag(args, "--limit", 20),
    timeoutMs: readNumberFlag(args, "--timeout-ms", 45000),
    json: args.includes("--json"),
    dryRun: args.includes("--dry-run"),
    links: args.includes("--links"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run search -- --keyword "senior engineer AI agents" --domain jobs.ashbyhq.com
  bun run search -- -k "Agentic" -d boards.greenhouse.io -d jobs.lever.co
  bun run search -- -k "Agentic" --site all --links --engine google --time 24hours --max-queries 50
  bun run search -- -k "Agentic" --site greenhouse --site lever --limit 5
  bun run search -- -k "Agentic" -d boards.greenhouse.io --links --engine all --time 24hours
  SEARCH_ONLY_KEYWORDS="Agentic,AI agents" SEARCH_ONLY_DOMAINS="boards.greenhouse.io" bun run search

Options:
  -k, --keyword       Search keyword. Repeatable. Comma-separated values accepted.
  -d, --domain        Site domain. Repeatable. Comma-separated values accepted.
  -s, --site          Brian site ID/label/site. Repeatable. Use "all" for Brian's full site list.
  -e, --engine        Brian-style link engine. Repeatable. Use "all" for all engines.
  --time              Brian-style time filter. Defaults to 24hours.
  --location          Optional location text to append to Brian-style site queries.
  --exclude-remote    Do not append "remote" to Brian-style site queries.
  --max-queries       Query cap. Defaults to 12 to avoid accidental broad runs.
  --limit             URL cap per query. Defaults to 20.
  --timeout-ms        Per-Jina-query timeout. Defaults to 45000.
  --json              Print machine-readable JSON.
  --dry-run           Print generated queries without calling Jina.
  --links             Generate Brian-style outbound search links instead of calling Jina.

Jina search is used only when --links and --dry-run are absent. Notion and OpenRouter are not loaded.`);
}

function filterResultsByTerms(results: JinaSearchResult[], terms: readonly string[]): SearchOnlyItem[] {
  const normalizedTerms = terms.map((term) => term.toLowerCase());
  const seen = new Set<string>();
  const filtered: SearchOnlyItem[] = [];

  for (const result of results) {
    const url = result.url.replace(/[.,;:!?]+$/, "");
    const normalizedUrl = url.toLowerCase();
    if (normalizedTerms.some((term) => normalizedUrl.includes(term)) && !seen.has(url)) {
      seen.add(url);
      filtered.push({ ...result, url });
    }
  }

  return filtered;
}

function buildTargets(options: SearchOnlyOptions): SearchTarget[] {
  if (options.sites.length > 0) {
    return options.keywords.flatMap((keyword) =>
      options.sites.map((site) => {
        const target = buildBrianSiteSearchTarget(site, {
          keyword,
          includeRemote: options.includeRemote,
          location: options.location,
          timeFilter: options.timeFilter,
        });

        return convertBrianTarget(keyword, target);
      }),
    );
  }

  return options.keywords.flatMap((keyword) =>
    options.domains.map((domain) => ({
      kind: "search-query" as const,
      keyword,
      label: domain,
      query: buildSearchQuery(keyword, domain),
      filter: (results: JinaSearchResult[]) => filterJobResults(results, domain),
    })),
  );
}

function convertBrianTarget(keyword: string, target: BrianSiteSearchTarget): SearchTarget {
  if (target.kind === "direct-url") {
    return {
      kind: "direct-url",
      keyword,
      label: target.site.label,
      url: target.url,
    };
  }

  return {
    kind: "search-query",
    keyword,
    label: target.site.label,
    query: target.query,
    filter: (results: JinaSearchResult[]) => filterResultsByTerms(results, target.filters),
  };
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  const targets = buildTargets(options);
  const selectedTargets = targets.slice(0, options.maxQueries);

  if (targets.length > selectedTargets.length) {
    console.error(
      `Capped at ${selectedTargets.length}/${targets.length} targets. Raise --max-queries to run more.`,
    );
  }

  if (options.links) {
    const links: SearchLinkResult[] = [];

    for (const target of selectedTargets) {
      if (target.kind === "direct-url") {
        links.push({
          keyword: target.keyword,
          label: target.label,
          query: null,
          engine: "direct",
          timeFilter: options.timeFilter,
          url: target.url,
        });
        if (!options.json) {
          console.log(`\n${target.label}`);
          console.log(`direct: ${target.url}`);
        }
        continue;
      }

      for (const engine of options.engines) {
        const url = buildBrianSearchUrl(engine, target.query, options.timeFilter);
        links.push({
          keyword: target.keyword,
          label: target.label,
          query: target.query,
          engine,
          timeFilter: options.timeFilter,
          url,
        });

        if (!options.json) {
          console.log(`\n${target.label}: ${target.query}`);
          console.log(`${engine}: ${url}`);
        }
      }
    }

    if (options.json) {
      console.log(JSON.stringify({ links }, null, 2));
    }
    return;
  }

  const jinaApiKey = process.env.JINA_API_KEY ?? "";
  if (!jinaApiKey && !options.dryRun) {
    throw new Error("JINA_API_KEY is required for live search. Use --dry-run to inspect queries.");
  }

  const config = { jinaApiKey };
  const results: SearchOnlyResult[] = [];
  const errors: Array<{ keyword: string; label: string; error: string }> = [];
  let totalTokens = 0;

  for (const target of selectedTargets) {
    if (options.dryRun) {
      const items: SearchOnlyItem[] = [];
      const urls: string[] = [];
      const usage = { tokens: null, decompressedContentLength: null };
      results.push({
        keyword: target.keyword,
        label: target.label,
        query: target.kind === "search-query" ? target.query : null,
        directUrl: target.kind === "direct-url" ? target.url : null,
        items,
        urls,
        usage,
      });
      if (!options.json) {
        if (target.kind === "search-query") {
          console.log(`${target.label}: ${target.query}`);
        } else {
          console.log(`${target.label}: ${target.url}`);
        }
      }
      continue;
    }

    if (target.kind === "direct-url") {
      const usage = { tokens: null, decompressedContentLength: null };
      const items = [{ title: target.label, url: target.url, description: "" }];
      results.push({
        keyword: target.keyword,
        label: target.label,
        query: null,
        directUrl: target.url,
        items,
        urls: items.map((item) => item.url),
        usage,
      });
      if (!options.json) {
        console.log(`\n${target.label}`);
        console.log("Direct URL; no Jina search call");
        console.log(`- ${target.url}`);
      }
      continue;
    }

    try {
      console.error(`[${results.length + errors.length + 1}/${selectedTargets.length}] Searching ${target.label}`);
      const call = await fetchJinaSearchWithUsage(target.query, config, {
        timeoutMs: options.timeoutMs,
      });
      const items = target.filter(call.results).slice(0, options.limitPerQuery);
      results.push({
        keyword: target.keyword,
        label: target.label,
        query: target.query,
        directUrl: null,
        items,
        urls: items.map((item) => item.url),
        usage: call.usage,
      });

      if (call.usage.tokens !== null) {
        totalTokens += call.usage.tokens;
      }

      if (!options.json) {
        console.log(`\n${target.label}: ${target.query}`);
        console.log(`Jina tokens: ${call.usage.tokens ?? "not reported"}`);
        if (call.usage.decompressedContentLength !== null) {
          console.log(`Decompressed bytes: ${call.usage.decompressedContentLength}`);
        }
        console.log(`Found ${items.length} matching results`);
        for (const item of items) {
          console.log(`- ${item.title || "(no title)"} — ${item.url}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ keyword: target.keyword, label: target.label, error: message });
      console.error(`Search failed for ${target.label}: ${target.query}: ${message}`);
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ results, errors, totalTokens }, null, 2));
  } else if (!options.dryRun) {
    console.log(`\nTotal Jina tokens: ${totalTokens}`);
  }

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
