import { decodeHtmlEntities } from "./htmlEntities";
import { htmlToReadableMarkdown } from "./httpPageExtract";
import type { NormalizedJobInput } from "./normalizedJobIngest";

export interface DirectSourceFetchOptions {
  timeoutMs: number;
  fetcher?: typeof fetch;
}

export interface DirectSourceFetchResult {
  sourceId: "linear-careers" | "google-careers";
  sourceLabel: "Linear Careers" | "Google Careers";
  jobs: NormalizedJobInput[];
  discovered: number;
  pagesFetched: number;
  truncated: boolean;
  errors: string[];
}

interface DirectListing {
  title: string;
  location: string | null;
  url: string;
}

const LINEAR_CAREERS_URL = "https://linear.app/careers";
const GOOGLE_CAREERS_URL = "https://www.google.com/about/careers/applications/jobs/results/";
const GOOGLE_MAX_LISTING_PAGES = 5;
const LINEAR_LOCATION_SUFFIX_RE =
  /\s+(Europe(?:,\s*North America)?|North America|London|Australia|APAC|EMEA)$/i;

export async function fetchLinearCareersJobs(
  options: DirectSourceFetchOptions,
): Promise<DirectSourceFetchResult> {
  const fetcher = options.fetcher ?? fetch;
  const listingHtml = await requestText(fetcher, LINEAR_CAREERS_URL, options.timeoutMs);
  const listings = parseLinearCareersListings(listingHtml);
  const result = await fetchDirectListingJobs(listings, {
    fetcher,
    timeoutMs: options.timeoutMs,
    sourceId: "linear-careers",
    sourceLabel: "Linear Careers",
    company: "Linear",
    sourceUrl: LINEAR_CAREERS_URL,
    extractDescription: extractLinearJobMarkdown,
  });

  return {
    sourceId: "linear-careers",
    sourceLabel: "Linear Careers",
    discovered: listings.length,
    pagesFetched: 1,
    truncated: false,
    jobs: result.jobs,
    errors: result.errors,
  };
}

export async function fetchGoogleCareersJobs(
  options: DirectSourceFetchOptions,
): Promise<DirectSourceFetchResult> {
  const fetcher = options.fetcher ?? fetch;
  const listings: DirectListing[] = [];
  const seen = new Set<string>();
  let pagesFetched = 0;
  let discoveryTruncated = false;
  for (let page = 1; page <= GOOGLE_MAX_LISTING_PAGES; page++) {
    const pageUrl = page === 1 ? GOOGLE_CAREERS_URL : `${GOOGLE_CAREERS_URL}?page=${page}`;
    const listingHtml = await requestText(fetcher, pageUrl, options.timeoutMs);
    pagesFetched++;
    const pageListings = parseGoogleCareersListings(listingHtml);
    if (pageListings.length === 0) break;
    for (const listing of pageListings) {
      if (seen.has(listing.url)) continue;
      seen.add(listing.url);
      listings.push(listing);
    }
    if (page === GOOGLE_MAX_LISTING_PAGES) discoveryTruncated = true;
  }
  const result = await fetchDirectListingJobs(listings, {
    fetcher,
    timeoutMs: options.timeoutMs,
    sourceId: "google-careers",
    sourceLabel: "Google Careers",
    company: "Google",
    sourceUrl: GOOGLE_CAREERS_URL,
    extractDescription: extractGoogleJobMarkdown,
  });

  return {
    sourceId: "google-careers",
    sourceLabel: "Google Careers",
    discovered: listings.length,
    pagesFetched,
    truncated: discoveryTruncated,
    jobs: result.jobs,
    errors: [
      ...(discoveryTruncated
        ? [
            `Google Careers discovery stopped at the ${GOOGLE_MAX_LISTING_PAGES}-page safety cap while the final page still contained listings.`,
          ]
        : []),
      ...result.errors,
    ],
  };
}

export function parseLinearCareersListings(html: string): DirectListing[] {
  const seen = new Set<string>();
  const listings: DirectListing[] = [];
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

export function parseGoogleCareersListings(html: string): DirectListing[] {
  const seen = new Set<string>();
  const listings: DirectListing[] = [];
  const linkPattern =
    /<a\b[^>]*href=(["'])jobs\/results\/([^"'?#]+)\1[^>]*aria-label=(["'])Learn more about [^"']+\3[^>]*>/gis;

  for (const match of html.matchAll(linkPattern)) {
    const slug = match[2];
    if (!slug || seen.has(slug) || match.index === undefined) continue;
    const cardStart = html.lastIndexOf('<li class="lLd3Je"', match.index);
    if (cardStart === -1) continue;
    const cardPrefix = html.slice(cardStart, match.index);
    const title = cleanText(
      cardPrefix.match(/<h3\b[^>]*class=(["'])QJPWVe\1[^>]*>(.*?)<\/h3>/is)?.[2] ?? "",
    );
    if (!title) continue;
    const locations = [
      ...cardPrefix.matchAll(
        /<span\b[^>]*class=(["'])[^"']*\br0wTof\b[^"']*\1[^>]*>(.*?)<\/span>/gis,
      ),
    ]
      .map((locationMatch) => cleanText(locationMatch[2] ?? ""))
      .filter(Boolean);
    seen.add(slug);
    listings.push({
      title,
      location: [...new Set(locations)].join("; ") || null,
      url: new URL(slug, GOOGLE_CAREERS_URL).toString(),
    });
  }

  return listings;
}

async function fetchDirectListingJobs(
  listings: readonly DirectListing[],
  options: {
    fetcher: typeof fetch;
    timeoutMs: number;
    sourceId: DirectSourceFetchResult["sourceId"];
    sourceLabel: DirectSourceFetchResult["sourceLabel"];
    company: string;
    sourceUrl: string;
    extractDescription(html: string, url: string): string;
  },
): Promise<{ jobs: NormalizedJobInput[]; errors: string[] }> {
  const results = await mapWithConcurrency(listings, DIRECT_DETAIL_CONCURRENCY, async (listing) => {
    try {
      const detailHtml = await requestText(options.fetcher, listing.url, options.timeoutMs);
      return {
        job: directListingToNormalizedJob(
          listing,
          options,
          options.extractDescription(detailHtml, listing.url),
        ),
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        job: directListingToNormalizedJob(
          listing,
          options,
          `# ${listing.title}\n\nDetail fetch failed: ${message}`,
          message,
        ),
        error: `${options.sourceLabel} detail fetch failed for ${listing.url}: ${message}`,
      };
    }
  });
  return {
    jobs: results.map((result) => result.job),
    errors: results.flatMap((result) => (result.error === null ? [] : [result.error])),
  };
}

function directListingToNormalizedJob(
  listing: DirectListing,
  options: {
    sourceId: DirectSourceFetchResult["sourceId"];
    sourceLabel: DirectSourceFetchResult["sourceLabel"];
    company: string;
    sourceUrl: string;
  },
  description: string,
  failureReason: string | null = null,
): NormalizedJobInput {
  return {
    sourceId: options.sourceId,
    sourceLabel: options.sourceLabel,
    searchLabel: "direct-source",
    searchTerm: options.sourceId,
    title: listing.title,
    company: options.company,
    url: listing.url,
    sourceUrl: options.sourceUrl,
    description,
    location: listing.location,
    employmentType: null,
    compensation: null,
    raw: {
      source: options.sourceId,
      title: listing.title,
      location: listing.location,
      url: listing.url,
      fetchStrategy: "direct_careers",
      detail_status: failureReason === null ? "success" : "error",
      detail_error: failureReason ?? "",
      failureReason,
    },
  };
}

function splitLinearListingText(text: string): { title: string; location: string | null } {
  const match = text.match(LINEAR_LOCATION_SUFFIX_RE);
  if (match?.[1]) {
    return {
      title: text.slice(0, match.index).trim(),
      location: match[1],
    };
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

export function extractGoogleJobMarkdown(html: string, url: string): string {
  const title = cleanText(html.match(/<title\b[^>]*>(.*?)<\/title>/is)?.[1] ?? "").replace(
    /\s+—\s+Google Careers\s*$/i,
    "",
  );
  const sections = [".KwJkGe", ".aG5W3", ".BDNOWe"]
    .map((selector) =>
      htmlToReadableMarkdown(html, url, {
        contentSelectors: [selector],
      })
        .replace(/^Title:.*\n?/m, "")
        .replace(/^URL Source:.*\n?/m, "")
        .trim(),
    )
    .filter(Boolean);
  return [`# ${title}`, "", ...sections].join("\n\n").slice(0, 24000);
}

function cleanText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

export const DIRECT_DETAIL_CONCURRENCY = 3;

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      const value = values[index];
      if (value !== undefined) results[index] = await mapper(value);
    }
  });
  await Promise.all(workers);
  return results;
}
