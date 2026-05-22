import { buildSearchQuery, filterJobResults, type JinaSearchResult } from "./search";
import type { TimeFilter } from "./searchEngines";
import {
  buildJobSourceSearchTarget,
  type JobSourceSearchTarget,
  type JobSourceSite,
} from "./sourceSites";

export interface SearchTargetOptions {
  keywords: string[];
  domains: string[];
  sites: JobSourceSite[];
  timeFilter: TimeFilter;
  includeRemote: boolean;
  location: string | null;
}

export type SearchResultItem = JinaSearchResult;

export type SearchTarget =
  | {
      kind: "search-query";
      keyword: string;
      sourceId: string;
      label: string;
      query: string;
      filter: (results: JinaSearchResult[]) => SearchResultItem[];
    }
  | {
      kind: "direct-url";
      keyword: string;
      sourceId: string;
      label: string;
      url: string;
    };

function filterResultsByTerms(
  results: JinaSearchResult[],
  terms: readonly string[],
  jobUrlPatterns: readonly RegExp[] = [],
): SearchResultItem[] {
  const normalizedTerms = terms.map((term) => term.toLowerCase());
  const seen = new Set<string>();
  const filtered: SearchResultItem[] = [];

  for (const result of results) {
    const url = result.url.replace(/[.,;:!?]+$/, "");
    const normalizedUrl = url.toLowerCase();
    const matchesSource = normalizedTerms.some((term) => normalizedUrl.includes(term));
    const matchesJobPattern =
      jobUrlPatterns.length === 0 || jobUrlPatterns.some((pattern) => pattern.test(normalizedUrl));
    if (matchesSource && matchesJobPattern && !isKnownBadSearchResult(result) && !seen.has(url)) {
      seen.add(url);
      filtered.push({ ...result, url });
    }
  }

  return filtered;
}

function isKnownBadSearchResult(result: JinaSearchResult): boolean {
  const text = `${result.title}\n${result.url}\n${result.description}`.toLowerCase();
  return [
    /\bjob (?:has )?expired\b/,
    /\bjob not found\b/,
    /\bposting (?:has been )?(?:removed|closed)\b/,
    /\bsorry,? this job was removed\b/,
    /\bsorry,? this job has expired\b/,
    /\bthis job (?:is )?no longer available\b/,
    /\bno longer accepting applications\b/,
    /\bremote.{0,80}\b(?:united states|u\.s\.|usa|us\/canada|us|canada)\b/,
    /\b(?:united states|u\.s\.|usa|us\/canada|us|canada).{0,80}\bremote\b/,
    /remote[-_]+(?:united[-_]+states|us|usa)\b/,
    /\bremote\s*[-,]?\s*(?:united states|u\.s\.|usa|us)\b/,
    /\b(?:united states|u\.s\.|usa|us)\s*[-,]?\s*remote\b/,
    /\bremote(?:\s+role|\s+job)?\s+(?:for|in)\s+(?:latam|latin america)\b/,
    /\b(?:controller|accountant|accounting|sales executive|account executive)\b/,
    /\bdev(?:sec)?ops engineer\b/,
    /\bjava developer\b/,
  ].some((pattern) => pattern.test(text));
}

export function buildSearchTargets(options: SearchTargetOptions): SearchTarget[] {
  if (options.sites.length > 0) {
    return options.keywords.flatMap((keyword) =>
      options.sites.map((site) => {
        const target = buildJobSourceSearchTarget(site, {
          keyword,
          includeRemote: options.includeRemote,
          location: options.location,
          timeFilter: options.timeFilter,
        });

        return convertSourceTarget(keyword, target);
      }),
    );
  }

  return options.keywords.flatMap((keyword) =>
    options.domains.map((domain) => ({
      kind: "search-query" as const,
      keyword,
      sourceId: domain,
      label: domain,
      query: buildSearchQuery(keyword, domain),
      filter: (results: JinaSearchResult[]) => filterJobResults(results, domain),
    })),
  );
}

function convertSourceTarget(keyword: string, target: JobSourceSearchTarget): SearchTarget {
  if (target.kind === "direct-url") {
    return {
      kind: "direct-url",
      keyword,
      sourceId: target.site.id,
      label: target.site.label,
      url: target.url,
    };
  }

  return {
    kind: "search-query",
    keyword,
    sourceId: target.site.id,
    label: target.site.label,
    query: target.query,
    filter: (results: JinaSearchResult[]) =>
      filterResultsByTerms(results, target.filters, target.jobUrlPatterns),
  };
}
