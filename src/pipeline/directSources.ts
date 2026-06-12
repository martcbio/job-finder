import { htmlToReadableMarkdown } from "./httpPageExtract";
import type { NormalizedJobInput } from "./normalizedJobIngest";

export interface DirectSourceFetchOptions {
  limit: number;
  timeoutMs: number;
  fetcher?: typeof fetch;
}

export interface DirectSourceFetchResult {
  sourceId: "linear-careers";
  sourceLabel: "Linear Careers";
  jobs: NormalizedJobInput[];
  discovered: number;
}

interface LinearListing {
  title: string;
  location: string | null;
  url: string;
}

const LINEAR_CAREERS_URL = "https://linear.app/careers";

export async function fetchLinearCareersJobs(
  options: DirectSourceFetchOptions,
): Promise<DirectSourceFetchResult> {
  const fetcher = options.fetcher ?? fetch;
  const listingHtml = await requestText(fetcher, LINEAR_CAREERS_URL, options.timeoutMs);
  const listings = parseLinearCareersListings(listingHtml);
  const selected = listings.filter(isRelevantLinearRole).slice(0, options.limit);
  const jobs: NormalizedJobInput[] = [];

  for (const listing of selected) {
    const detailHtml = await requestText(fetcher, listing.url, options.timeoutMs);
    jobs.push({
      sourceId: "linear-careers",
      sourceLabel: "Linear Careers",
      searchLabel: "direct-source",
      searchTerm: "linear-careers",
      title: listing.title,
      company: "Linear",
      url: listing.url,
      sourceUrl: LINEAR_CAREERS_URL,
      description: extractLinearJobMarkdown(detailHtml, listing.url),
      location: listing.location,
      employmentType: null,
      compensation: null,
      raw: {
        source: "linear-careers",
        title: listing.title,
        location: listing.location,
        url: listing.url,
      },
    });
  }

  return {
    sourceId: "linear-careers",
    sourceLabel: "Linear Careers",
    discovered: listings.length,
    jobs,
  };
}

export function parseLinearCareersListings(html: string): LinearListing[] {
  const seen = new Set<string>();
  const listings: LinearListing[] = [];
  const linkPattern = /<a\b[^>]*href=(["'])(\/careers\/[0-9a-f-]{36})\1[^>]*>(.*?)<\/a>/gis;

  for (const match of html.matchAll(linkPattern)) {
    const path = match[2];
    const body = match[3];
    if (!path || !body || seen.has(path)) continue;
    const text = cleanText(body);
    if (!text.includes("Learn more")) continue;
    const withoutCta = text.replace(/\s*Learn more\s*(?:→|->)?\s*$/i, "").trim();
    const listing = splitLinearListingText(withoutCta);
    if (!listing.title) continue;
    seen.add(path);
    listings.push({
      ...listing,
      url: new URL(path, LINEAR_CAREERS_URL).toString(),
    });
  }

  return listings;
}

function isRelevantLinearRole(listing: LinearListing): boolean {
  const title = listing.title.toLowerCase();
  if (
    /\b(?:designer|marketing|product manager|counsel|accounting|sales|account executive)\b/.test(
      title,
    )
  ) {
    return false;
  }
  return /\b(?:ai|engineer|engineering|solutions)\b/i.test(
    `${listing.title} ${listing.location ?? ""}`,
  );
}

function splitLinearListingText(text: string): { title: string; location: string | null } {
  const locationPatterns = [
    "Europe, North America",
    "Europe, North America",
    "Europe",
    "North America",
    "London",
    "Australia",
    "APAC",
    "EMEA",
  ];

  for (const location of locationPatterns) {
    if (text.endsWith(location)) {
      return {
        title: text.slice(0, -location.length).trim(),
        location,
      };
    }
  }

  return { title: text.trim(), location: null };
}

async function requestText(fetcher: typeof fetch, url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(`Direct source request timed out after ${timeoutMs}ms`),
    timeoutMs,
  );
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export function extractLinearJobMarkdown(html: string, url: string): string {
  return htmlToReadableMarkdown(html, url, {
    contentSelectors: ["main", '[role="main"]', "article"],
  }).slice(0, 24000);
}

function cleanText(html: string): string {
  return decodeHtml(
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 10)));
}
