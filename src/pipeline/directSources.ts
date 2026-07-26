import { htmlToReadableMarkdown } from "./httpPageExtract";
import type { NormalizedJobInput } from "./normalizedJobIngest";

export interface DirectSourceFetchOptions {
  limit: number;
  timeoutMs: number;
  fetcher?: typeof fetch;
}

export interface DirectSourceFetchResult {
  sourceId: "linear-careers" | "google-careers";
  sourceLabel: "Linear Careers" | "Google Careers";
  jobs: NormalizedJobInput[];
  discovered: number;
}

interface DirectListing {
  title: string;
  location: string | null;
  url: string;
}

const LINEAR_CAREERS_URL = "https://linear.app/careers";
const GOOGLE_CAREERS_URL = "https://www.google.com/about/careers/applications/jobs/results/";

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

export async function fetchGoogleCareersJobs(
  options: DirectSourceFetchOptions,
): Promise<DirectSourceFetchResult> {
  const fetcher = options.fetcher ?? fetch;
  const listings: DirectListing[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 5; page++) {
    const pageUrl = page === 1 ? GOOGLE_CAREERS_URL : `${GOOGLE_CAREERS_URL}?page=${page}`;
    const listingHtml = await requestText(fetcher, pageUrl, options.timeoutMs);
    const pageListings = parseGoogleCareersListings(listingHtml);
    if (pageListings.length === 0) break;
    for (const listing of pageListings) {
      if (seen.has(listing.url)) continue;
      seen.add(listing.url);
      listings.push(listing);
    }
    if (listings.filter(isRelevantGoogleRole).length >= options.limit) break;
  }
  const selected = listings.filter(isRelevantGoogleRole).slice(0, options.limit);
  const jobs = await Promise.all(
    selected.map(async (listing): Promise<NormalizedJobInput> => {
      const detailHtml = await requestText(fetcher, listing.url, options.timeoutMs);
      return {
        sourceId: "google-careers",
        sourceLabel: "Google Careers",
        searchLabel: "direct-source",
        searchTerm: "google-careers",
        title: listing.title,
        company: "Google",
        url: listing.url,
        sourceUrl: GOOGLE_CAREERS_URL,
        description: extractGoogleJobMarkdown(detailHtml, listing.url),
        location: listing.location,
        employmentType: null,
        compensation: null,
        raw: {
          source: "google-careers",
          title: listing.title,
          location: listing.location,
          url: listing.url,
        },
      };
    }),
  );

  return {
    sourceId: "google-careers",
    sourceLabel: "Google Careers",
    discovered: listings.length,
    jobs,
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

function isRelevantLinearRole(listing: DirectListing): boolean {
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

function isRelevantGoogleRole(listing: DirectListing): boolean {
  if (
    /\b(?:product manager|program manager|sales|marketing|recruiter|counsel|finance)\b/i.test(
      listing.title,
    )
  ) {
    return false;
  }
  if (
    !/\b(?:ai|machine learning|engineer|engineering|architect|developer|scientist)\b/i.test(
      listing.title,
    )
  ) {
    return false;
  }
  const location = listing.location ?? "";
  if (!location) return false;
  const nonUsLocations = location
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => !isUsLocation(value));
  return nonUsLocations.length > 0;
}

function isUsLocation(location: string): boolean {
  return (
    /\b(?:United States|USA|U\.S\.|US Remote|Remote US)\b/i.test(location) ||
    /,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/.test(
      location,
    )
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
