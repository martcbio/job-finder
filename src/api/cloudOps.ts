import { z } from "zod/v4";
import { logger } from "../logger";
import type { ApiContext, CloudConfig } from "./context";

const log = logger.child({ component: "api/cloud-ops" });
const CLOUD_TIMEOUT_MS = 10_000;

const nullableNumber = z.union([z.number(), z.string()]).transform(Number).nullable();
const nullableInteger = nullableNumber.refine((value) => value === null || Number.isInteger(value));
const timestamp = z.iso.datetime({ offset: true });

const DoctorV2RowSchema = z.object({
  task: z.string(),
  substrate: z.string().nullable(),
  cadence_seconds: nullableInteger,
  latest_success_at: timestamp.nullable(),
  latest_run_at: timestamp.nullable(),
  last_exit_status: nullableInteger,
  runs_24h: nullableInteger,
  failures_24h: nullableInteger,
  failure_rate_24h: nullableNumber,
  expected_beats_24h: nullableInteger,
  missed_beats_24h: nullableInteger,
  stale: z.boolean(),
  unhealthy: z.boolean(),
});

const LegacyDoctorRowSchema = z.object({
  task: z.string(),
  substrate: z.string().nullable(),
  cadence_seconds: nullableInteger,
  latest_success_at: timestamp.nullable(),
  stale: z.boolean(),
});

const OpsRunSchema = z.object({
  task: z.string(),
  substrate: z.string().nullable(),
  started_at: timestamp.nullable(),
  finished_at: timestamp.nullable(),
  exit_status: nullableInteger,
});

const AlertSchema = z.object({
  id: z.union([z.number(), z.string()]),
  fingerprint: z.string(),
  severity: z.enum(["warn", "critical"]),
  task: z.string().nullable(),
  substrate: z.string().nullable(),
  message: z.string(),
  first_seen: timestamp,
  last_seen: timestamp,
  occurrences: z.number().int().nonnegative(),
  delivered_at: timestamp.nullable(),
});

const ParityRunSchema = z.object({
  run_date: z.iso.date(),
  substrate: z.enum(["mac", "modal"]),
  run_id: z.string(),
  openings_count: z.number().int().nonnegative(),
  ids_sha256: z.string(),
  created_at: timestamp,
});

export type DoctorV2Row = z.infer<typeof DoctorV2RowSchema>;
export type LegacyDoctorRow = z.infer<typeof LegacyDoctorRowSchema>;
export type OpsRun = z.infer<typeof OpsRunSchema>;
export type OpsAlert = z.infer<typeof AlertSchema>;
export type ParityRun = z.infer<typeof ParityRunSchema>;

type UnavailableReason = {
  code: "cloud_not_configured" | "cloud_upstream_error";
  message: string;
  upstreamStatus?: number;
  upstreamMessage?: string;
};

type FetchResult<T> =
  | { status: "available"; rows: T[] }
  | { status: "unavailable"; reason: UnavailableReason }
  | { status: "missing"; upstreamStatus: number };

interface OpsRequest {
  table: string;
  select: string;
  order?: string;
  limit?: number;
  profile?: "careers" | "ops";
  filters?: Record<string, string>;
  missingStatuses?: number[];
}

function opsUrl(config: CloudConfig, request: OpsRequest): URL | null {
  if (!config.supabaseUrl || !config.supabaseServiceKey) return null;
  const url = new URL(`/rest/v1/${request.table}`, `${config.supabaseUrl.replace(/\/$/, "")}/`);
  url.searchParams.set("select", request.select);
  if (request.order) url.searchParams.set("order", request.order);
  if (request.limit !== undefined) url.searchParams.set("limit", String(request.limit));
  for (const [name, value] of Object.entries(request.filters ?? {})) {
    url.searchParams.set(name, value);
  }
  return url;
}

async function fetchRows<T>(
  context: ApiContext,
  request: OpsRequest,
  schema: z.ZodType<T[]>,
): Promise<FetchResult<T>> {
  const url = opsUrl(context.cloudConfig, request);
  const serviceKey = context.cloudConfig.supabaseServiceKey;
  if (!url || !serviceKey) {
    return {
      status: "unavailable",
      reason: {
        code: "cloud_not_configured",
        message: "Cloud operations credentials are not configured on this API server.",
      },
    };
  }

  let response: Response;
  try {
    response = await context.fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        ...(request.profile ? { "Accept-Profile": request.profile } : {}),
      },
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    });
  } catch (error) {
    log.warn({ table: request.table, error }, "cloud ops request failed");
    return {
      status: "unavailable",
      reason: {
        code: "cloud_upstream_error",
        message: "Cloud operations could not reach Supabase.",
      },
    };
  }

  const bodyText = await response.text();
  const missing =
    request.missingStatuses?.includes(response.status) === true ||
    /42P01|PGRST106|schema must be one of/i.test(bodyText);
  if (!response.ok && missing) return { status: "missing", upstreamStatus: response.status };

  if (!response.ok) {
    const upstreamMessage = bodyText.match(/"message"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/)?.[1];
    log.warn(
      { table: request.table, upstreamStatus: response.status, upstreamMessage },
      "cloud ops upstream returned an error",
    );
    return {
      status: "unavailable",
      reason: {
        code: "cloud_upstream_error",
        message: `Cloud operations upstream returned HTTP ${response.status}.`,
        upstreamStatus: response.status,
        ...(upstreamMessage ? { upstreamMessage } : {}),
      },
    };
  }

  try {
    return { status: "available", rows: schema.parse(JSON.parse(bodyText)) };
  } catch (error) {
    log.warn({ table: request.table, error }, "cloud ops returned an invalid payload");
    return {
      status: "unavailable",
      reason: {
        code: "cloud_upstream_error",
        message: "Cloud operations returned an invalid response payload.",
        upstreamStatus: response.status,
      },
    };
  }
}

async function loadDoctor(context: ApiContext) {
  const current = await fetchRows(
    context,
    {
      table: "doctor_v2",
      select:
        "task,substrate,cadence_seconds,latest_success_at,latest_run_at,last_exit_status,runs_24h,failures_24h,failure_rate_24h,expected_beats_24h,missed_beats_24h,stale,unhealthy",
      order: "task.asc,substrate.asc",
      missingStatuses: [404],
    },
    z.array(DoctorV2RowSchema),
  );
  if (current.status === "available") {
    return { status: "available" as const, source: "doctor_v2" as const, rows: current.rows };
  }
  if (current.status === "unavailable") return current;

  const legacy = await fetchRows(
    context,
    {
      table: "doctor",
      select: "task,substrate,cadence_seconds,latest_success_at,stale",
      order: "task.asc,substrate.asc",
    },
    z.array(LegacyDoctorRowSchema),
  );
  if (legacy.status === "available") {
    return {
      status: "doctor_not_deployed" as const,
      source: "doctor" as const,
      rows: legacy.rows,
    };
  }
  return legacy.status === "missing"
    ? {
        status: "unavailable" as const,
        reason: {
          code: "cloud_upstream_error" as const,
          message: "Neither doctor_v2 nor the legacy doctor view is available.",
          upstreamStatus: legacy.upstreamStatus,
        },
      }
    : legacy;
}

async function loadAlerts(context: ApiContext) {
  const result = await fetchRows(
    context,
    {
      table: "alerts",
      select:
        "id,fingerprint,severity,task,substrate,message,first_seen,last_seen,occurrences,delivered_at",
      order: "last_seen.desc",
      limit: 40,
      profile: "ops",
      filters: { delivered_at: "is.null" },
      missingStatuses: [404, 406],
    },
    z.array(AlertSchema),
  );
  if (result.status === "available") return result;
  return {
    status: "alerts_unavailable" as const,
    reason:
      result.status === "missing"
        ? {
            code: "alerts_schema_not_exposed" as const,
            message: "The ops schema is not exposed through PostgREST yet.",
            upstreamStatus: result.upstreamStatus,
          }
        : result.reason,
  };
}

async function loadRuns(context: ApiContext) {
  const filters = ["like.careers-*", "eq.subauth-pilot", "eq.funding-ingest"];
  const results = await Promise.all(
    filters.map((task) =>
      fetchRows(
        context,
        {
          table: "runs",
          select: "task,substrate,started_at,finished_at,exit_status",
          order: "started_at.desc",
          limit: 40,
          filters: { task },
        },
        z.array(OpsRunSchema),
      ),
    ),
  );
  const unavailable = results.find((result) => result.status !== "available");
  if (unavailable) {
    return unavailable.status === "missing"
      ? {
          status: "unavailable" as const,
          reason: {
            code: "cloud_upstream_error" as const,
            message: "The operations runs table is not available.",
            upstreamStatus: unavailable.upstreamStatus,
          },
        }
      : unavailable;
  }
  const rows = results
    .flatMap((result) => (result.status === "available" ? result.rows : []))
    .sort((left, right) => (right.started_at ?? "").localeCompare(left.started_at ?? ""))
    .slice(0, 40);
  return { status: "available" as const, rows };
}

export async function getCloudOps(context: ApiContext) {
  const [doctor, runs, alerts, parity] = await Promise.all([
    loadDoctor(context),
    loadRuns(context),
    loadAlerts(context),
    fetchRows(
      context,
      {
        table: "parity_runs",
        select: "run_date,substrate,run_id,openings_count,ids_sha256,created_at",
        order: "run_date.desc,created_at.desc",
        limit: 100,
        profile: "careers",
      },
      z.array(ParityRunSchema),
    ),
  ]);

  return { doctor, runs, alerts, parity };
}
