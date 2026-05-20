import {
  type BrianJobSite,
  type BrianSiteSearchTarget,
  buildBrianSiteSearchTarget,
} from "./brianSites";
import { buildSearchQuery, filterJobResults, type JinaSearchResult } from "./search";
import type { BrianTimeFilter } from "./searchEngines";

export interface SearchTargetOptions {
  keywords: string[];
  domains: string[];
  sites: BrianJobSite[];
  timeFilter: BrianTimeFilter;
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
): SearchResultItem[] {
  const normalizedTerms = terms.map((term) => term.toLowerCase());
  const seen = new Set<string>();
  const filtered: SearchResultItem[] = [];

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

export function buildSearchTargets(options: SearchTargetOptions): SearchTarget[] {
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
      sourceId: domain,
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
    filter: (results: JinaSearchResult[]) => filterResultsByTerms(results, target.filters),
  };
}
