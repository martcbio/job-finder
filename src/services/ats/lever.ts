import { logger } from "../../logger";
import { fetchAtsJson } from "./request";
import {
  type AtsJobData,
  type AtsOrgAcquisition,
  type Fetcher,
  leverJobSchema,
  leverListResponseSchema,
  type WorkplaceType,
} from "./types";

const log = logger.child({ component: "ats/lever" });

export function parseLeverUrl(url: string): { org: string; id: string } | null {
  try {
    const { hostname, pathname } = new URL(url);
    if (!hostname.includes("lever.co")) return null;
    const segments = pathname.split("/").filter(Boolean);
    const [org, id] = segments;
    if (!org || !id) return null;
    return { org, id };
  } catch {
    return null;
  }
}

function normalizeWorkplaceType(value: string | null | undefined): WorkplaceType | null {
  if (!value) return null;
  switch (value.toLowerCase()) {
    case "remote":
      return "Remote";
    case "hybrid":
      return "Hybrid";
    case "on-site":
    case "onsite":
      return "OnSite";
    default:
      return null;
  }
}

export async function fetchLeverJob(
  url: string,
  fetcher: Fetcher = fetch,
): Promise<AtsJobData | null> {
  const parsed = parseLeverUrl(url);
  if (!parsed) return null;
  const { org, id } = parsed;

  const apiUrl = `https://api.lever.co/v0/postings/${org}/${id}?mode=json`;

  let res: Response;
  try {
    res = await fetcher(apiUrl);
  } catch (err) {
    log.warn({ err, url }, "lever fetch failed");
    return null;
  }

  if (!res.ok) {
    log.warn({ status: res.status, url }, "lever non-ok response");
    return null;
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    log.warn({ err, url }, "lever json parse failed");
    return null;
  }

  const result = leverJobSchema.safeParse(raw);
  if (!result.success) {
    log.warn({ url, issues: result.error.issues }, "lever schema mismatch");
    return null;
  }

  const job = result.data;
  const primary = job.categories?.location ?? "";
  const all = job.categories?.allLocations ?? [];
  const locations = primary && !all.includes(primary) ? [primary, ...all] : all;

  return {
    source: "lever",
    title: job.text ?? null,
    location: primary,
    locations,
    workplaceType: normalizeWorkplaceType(job.workplaceType),
    country: job.country ?? null,
    descriptionPlain: job.descriptionPlain ?? job.descriptionBodyPlain ?? null,
  };
}

export async function listOrgJobs(
  org: string,
  fetcher: Fetcher = fetch,
): Promise<AtsOrgAcquisition> {
  const endpoint = `https://api.lever.co/v0/postings/${org}`;
  const acquisition = await fetchAtsJson(
    endpoint,
    leverListResponseSchema,
    fetcher,
    (attempt, err) => {
      log.warn({ attempt, err, org }, "lever org retry");
    },
  );
  if (acquisition.status === "failure") return acquisition;

  return {
    status: "success",
    endpoint: acquisition.endpoint,
    attempts: acquisition.attempts,
    durationMs: acquisition.durationMs,
    jobs: acquisition.data.map((job) => {
      const primary = job.categories?.location ?? "";
      const all = job.categories?.allLocations ?? [];
      const locations = primary && !all.includes(primary) ? [primary, ...all] : all;
      const stableId = job.id || job.hostedUrl;
      if (!stableId)
        throw new Error("Lever list entry passed validation without a stable identity");

      return {
        source: "lever",
        org,
        id: stableId,
        title: job.text ?? null,
        location: primary,
        locations,
        url: job.hostedUrl ?? `https://jobs.lever.co/${org}/${stableId}`,
        postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
        raw: job,
      };
    }),
  };
}
