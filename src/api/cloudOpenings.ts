import { z } from "zod/v4";
import { logger } from "../logger";
import type { ApiContext, CloudConfig } from "./context";
import { ApiError } from "./errors";

const log = logger.child({ component: "api/cloud-openings" });
const CLOUD_TIMEOUT_MS = 10_000;

const CloudOpeningSchema = z.object({
  org: z.string(),
  ats: z.enum(["ashby", "greenhouse", "lever"]),
  external_id: z.string(),
  title: z.string().nullable(),
  company: z.string(),
  location: z.string(),
  locations: z.array(z.string()),
  url: z.string().url(),
  posted_at: z.iso.datetime({ offset: true }).nullable(),
  location_eligibility: z.enum(["eligible", "ineligible", "undecided"]),
  location_reason_codes: z.array(z.string()),
  role_relevance: z.enum(["relevant", "irrelevant", "undecided"]),
  role_reason_codes: z.array(z.string()),
  disposition: z.enum(["suitable", "unsuitable_location", "unsuitable_role", "undecided"]),
  first_seen_at: z.iso.datetime({ offset: true }),
  last_seen_at: z.iso.datetime({ offset: true }),
  first_seen_run_id: z.string(),
  last_seen_run_id: z.string(),
  raw: z.unknown().optional(),
});

const CloudOpeningRawSchema = z.object({
  org: z.string(),
  ats: z.enum(["ashby", "greenhouse", "lever"]),
  external_id: z.string(),
  title: z.string().nullable(),
  company: z.string(),
  raw: z.unknown(),
});

const CloudRunSchema = z.object({
  run_id: z.string(),
  run_date: z.iso.date(),
  completed_at: z.iso.datetime({ offset: true }),
  health: z.enum(["complete", "degraded", "failed"]),
  matched_openings_count: z.number().int().nonnegative(),
  raw_openings_count: z.number().int().nonnegative(),
  eligible_openings_count: z.number().int().nonnegative(),
  suitable_openings_count: z.number().int().nonnegative(),
  unsuitable_location_openings_count: z.number().int().nonnegative(),
  unsuitable_role_openings_count: z.number().int().nonnegative(),
  undecided_openings_count: z.number().int().nonnegative(),
  substrate: z.enum(["modal", "mac"]),
});

export type CloudOpening = z.infer<typeof CloudOpeningSchema>;
export type CloudOpeningRaw = z.infer<typeof CloudOpeningRawSchema>;
export type CloudRun = z.infer<typeof CloudRunSchema>;
export interface CloudOpeningCounts {
  scope: "returned_rows";
  raw: number;
  eligible: number;
  suitable: number;
  unsuitableLocation: number;
  unsuitableRole: number;
  undecided: number;
}
export type CloudUnavailableCode =
  | "cloud_not_configured"
  | "cloud_schema_not_exposed"
  | "cloud_upstream_error";

export type CloudRowsResult<T> =
  | { status: "available"; rows: T[] }
  | {
      status: "cloud_unavailable";
      reason: {
        code: CloudUnavailableCode;
        message: string;
        upstreamStatus?: number;
      };
    };

export type CloudOpeningsResult =
  | { status: "available"; rows: CloudOpening[]; counts: CloudOpeningCounts }
  | Extract<CloudRowsResult<never>, { status: "cloud_unavailable" }>;

interface CloudRequest {
  table: "openings" | "openings_runs";
  select: string;
  limit: number;
  offset?: number;
  order: string;
  filters?: Record<string, string>;
}

function unavailable(
  code: CloudUnavailableCode,
  message: string,
  upstreamStatus?: number,
): CloudRowsResult<never> {
  return {
    status: "cloud_unavailable",
    reason: upstreamStatus === undefined ? { code, message } : { code, message, upstreamStatus },
  };
}

function cloudUrl(config: CloudConfig, request: CloudRequest): URL | null {
  if (!config.supabaseUrl || !config.supabaseServiceKey) return null;
  const url = new URL(`/rest/v1/${request.table}`, `${config.supabaseUrl.replace(/\/$/, "")}/`);
  url.searchParams.set("select", request.select);
  url.searchParams.set("order", request.order);
  url.searchParams.set("limit", String(request.limit));
  if (request.offset !== undefined && request.offset > 0) {
    url.searchParams.set("offset", String(request.offset));
  }
  for (const [name, value] of Object.entries(request.filters ?? {})) {
    url.searchParams.set(name, value);
  }
  return url;
}

async function fetchCloudRows<T>(
  context: ApiContext,
  request: CloudRequest,
  schema: z.ZodType<T[]>,
): Promise<CloudRowsResult<T>> {
  const url = cloudUrl(context.cloudConfig, request);
  const serviceKey = context.cloudConfig.supabaseServiceKey;
  if (!url || !serviceKey) {
    return unavailable(
      "cloud_not_configured",
      "Cloud lane credentials are not configured on this API server.",
    );
  }

  let response: Response;
  try {
    response = await context.fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Accept-Profile": "careers",
      },
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    });
  } catch (error) {
    log.warn(
      { code: "cloud_upstream_error", table: request.table, error },
      "cloud lane request failed",
    );
    return unavailable("cloud_upstream_error", "Cloud lane could not reach Supabase.");
  }

  if (response.status === 406) {
    log.info(
      { code: "cloud_schema_not_exposed", table: request.table, upstreamStatus: 406 },
      "cloud lane schema is not exposed",
    );
    return unavailable(
      "cloud_schema_not_exposed",
      "The careers schema is not exposed through PostgREST yet.",
      406,
    );
  }

  if (!response.ok) {
    log.warn(
      {
        code: "cloud_upstream_error",
        table: request.table,
        upstreamStatus: response.status,
      },
      "cloud lane upstream returned an error",
    );
    return unavailable(
      "cloud_upstream_error",
      `Cloud lane upstream returned HTTP ${response.status}.`,
      response.status,
    );
  }

  try {
    return { status: "available", rows: schema.parse(await response.json()) };
  } catch (error) {
    log.warn(
      {
        code: "cloud_upstream_error",
        table: request.table,
        upstreamStatus: response.status,
        error,
      },
      "cloud lane returned an invalid payload",
    );
    return unavailable(
      "cloud_upstream_error",
      "Cloud lane returned an invalid response payload.",
      response.status,
    );
  }
}

export function parseCloudSince(value: string | null): string | undefined {
  if (value === null || value === "") return undefined;
  const parsed = z.iso.datetime({ offset: true }).safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, "invalid_since", "since must be an ISO 8601 timestamp");
  }
  return parsed.data;
}

export async function listCloudOpenings(
  context: ApiContext,
  options: {
    limit: number;
    since?: string;
    runId?: string;
    includeRaw?: boolean;
    workableLocationsOnly?: boolean;
  },
): Promise<CloudOpeningsResult> {
  const rows: CloudOpening[] = [];
  while (rows.length < options.limit) {
    const pageLimit = Math.min(1000, options.limit - rows.length);
    const page = await fetchCloudRows(
      context,
      {
        table: "openings",
        select:
          "org,ats,external_id,title,company,location,locations,url,posted_at,location_eligibility,location_reason_codes,role_relevance,role_reason_codes,disposition,first_seen_at,last_seen_at,first_seen_run_id,last_seen_run_id" +
          (options.includeRaw ? ",raw" : ""),
        limit: pageLimit,
        offset: rows.length,
        order: "last_seen_at.desc",
        filters: {
          ...(options.since ? { first_seen_at: `gte.${options.since}` } : {}),
          ...(options.runId ? { last_seen_run_id: `eq.${options.runId}` } : {}),
          ...(options.workableLocationsOnly
            ? { location_eligibility: "in.(eligible,undecided)" }
            : {}),
        },
      },
      z.array(CloudOpeningSchema),
    );
    if (page.status !== "available") return page;
    rows.push(...page.rows);
    if (page.rows.length < pageLimit) break;
  }
  return {
    status: "available",
    rows,
    counts: {
      scope: "returned_rows",
      raw: rows.length,
      eligible: rows.filter((row) => row.location_eligibility === "eligible").length,
      suitable: rows.filter((row) => row.disposition === "suitable").length,
      unsuitableLocation: rows.filter((row) => row.disposition === "unsuitable_location").length,
      unsuitableRole: rows.filter((row) => row.disposition === "unsuitable_role").length,
      undecided: rows.filter((row) => row.disposition === "undecided").length,
    },
  };
}

export function getCloudOpeningRaw(
  context: ApiContext,
  provenance: { org: string; ats: string; externalId: string },
): Promise<CloudRowsResult<CloudOpeningRaw>> {
  return fetchCloudRows(
    context,
    {
      table: "openings",
      select: "org,ats,external_id,title,company,raw",
      limit: 1,
      order: "last_seen_at.desc",
      filters: {
        org: `eq.${provenance.org}`,
        ats: `eq.${provenance.ats}`,
        external_id: `eq.${provenance.externalId}`,
      },
    },
    z.array(CloudOpeningRawSchema),
  );
}

export function listCloudRuns(
  context: ApiContext,
  limit: number,
): Promise<CloudRowsResult<CloudRun>> {
  return fetchCloudRows(
    context,
    {
      table: "openings_runs",
      select:
        "run_id,run_date,completed_at,health,matched_openings_count,raw_openings_count,eligible_openings_count,suitable_openings_count,unsuitable_location_openings_count,unsuitable_role_openings_count,undecided_openings_count,substrate",
      limit,
      order: "completed_at.desc",
    },
    z.array(CloudRunSchema),
  );
}
