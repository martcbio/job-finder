import { logger } from "../../logger";
import { type AtsJobData, type Fetcher, greenhouseJobSchema } from "./types";

const log = logger.child({ component: "ats/greenhouse" });

export function parseGreenhouseUrl(url: string): { org: string; id: string } | null {
  try {
    const { hostname, pathname } = new URL(url);
    if (!hostname.includes("greenhouse.io")) return null;
    const segments = pathname.split("/").filter(Boolean);
    // boards.greenhouse.io/{org}/jobs/{id} and job-boards.greenhouse.io/{org}/jobs/{id}
    const jobsIdx = segments.indexOf("jobs");
    if (jobsIdx <= 0 || jobsIdx === segments.length - 1) return null;
    const org = segments[jobsIdx - 1];
    const id = segments[jobsIdx + 1];
    if (!org || !id) return null;
    return { org, id };
  } catch {
    return null;
  }
}

function extractCountry(officeLocation: string | null | undefined): string | null {
  if (!officeLocation) return null;
  // offices[].location is "City, Region, Country" — take the last comma-segment.
  const parts = officeLocation
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 1 ? (parts[parts.length - 1] ?? null) : null;
}

function htmlToPlainText(value: string | null | undefined): string | null {
  if (!value) return null;
  const decoded = decodeHtmlEntities(value);
  return decodeHtmlEntities(
    decoded
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/li>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(h[1-6]|p|div|section|article|ul|ol)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

export async function fetchGreenhouseJob(
  url: string,
  fetcher: Fetcher = fetch,
): Promise<AtsJobData | null> {
  const parsed = parseGreenhouseUrl(url);
  if (!parsed) return null;
  const { org, id } = parsed;

  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${org}/jobs/${id}`;

  let res: Response;
  try {
    res = await fetcher(apiUrl);
  } catch (err) {
    log.warn({ err, url }, "greenhouse fetch failed");
    return null;
  }

  if (!res.ok) {
    log.warn({ status: res.status, url }, "greenhouse non-ok response");
    return null;
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    log.warn({ err, url }, "greenhouse json parse failed");
    return null;
  }

  const result = greenhouseJobSchema.safeParse(raw);
  if (!result.success) {
    log.warn({ url, issues: result.error.issues }, "greenhouse schema mismatch");
    return null;
  }

  const job = result.data;
  const primary = job.location?.name ?? "";
  const officeLocations = (job.offices ?? [])
    .map((o) => o.location)
    .filter((l): l is string => !!l);
  const locations =
    primary && !officeLocations.includes(primary) ? [primary, ...officeLocations] : officeLocations;

  return {
    source: "greenhouse",
    title: job.title ?? null,
    company: job.company_name ?? null,
    location: primary,
    locations,
    workplaceType: null,
    country: extractCountry(job.offices?.[0]?.location),
    descriptionPlain: htmlToPlainText(job.content),
  };
}
