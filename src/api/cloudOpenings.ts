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
  first_seen_at: z.iso.datetime({ offset: true }),
  last_seen_at: z.iso.datetime({ offset: true }),
  first_seen_run_id: z.string(),
  last_seen_run_id: z.string(),
});

const CloudRunSchema = z.object({
  run_id: z.string(),
  run_date: z.iso.date(),
  completed_at: z.iso.datetime({ offset: true }),
  health: z.enum(["complete", "degraded", "failed"]),
  matched_openings_count: z.number().int().nonnegative(),
  substrate: z.enum(["modal", "mac"]),
});

export type CloudOpening = z.infer<typeof CloudOpeningSchema>;
export type CloudRun = z.infer<typeof CloudRunSchema>;
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

interface CloudRequest {
  table: "openings" | "openings_runs";
  select: string;
  limit: number;
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

export function listCloudOpenings(
  context: ApiContext,
  options: { limit: number; since?: string },
): Promise<CloudRowsResult<CloudOpening>> {
  return fetchCloudRows(
    context,
    {
      table: "openings",
      select:
        "org,ats,external_id,title,company,location,locations,url,posted_at,first_seen_at,last_seen_at,first_seen_run_id,last_seen_run_id",
      limit: options.limit,
      order: "last_seen_at.desc",
      filters: options.since ? { first_seen_at: `gte.${options.since}` } : undefined,
    },
    z.array(CloudOpeningSchema),
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
      select: "run_id,run_date,completed_at,health,matched_openings_count,substrate",
      limit,
      order: "completed_at.desc",
    },
    z.array(CloudRunSchema),
  );
}
