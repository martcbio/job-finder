import { z } from "zod/v4";
import { logger } from "../logger";
import type { ApiContext, CloudConfig } from "./context";
import { ApiError } from "./errors";

const log = logger.child({ component: "api/cloud-applications" });
const CLOUD_TIMEOUT_MS = 10_000;

export const CLOUD_APPLICATION_STATUSES = [
  "interested",
  "shortlisted",
  "cv_staged",
  "sent",
  "response",
  "interview",
  "offer",
  "closed",
] as const;

export type CloudApplicationStatus = (typeof CLOUD_APPLICATION_STATUSES)[number];
export type CloudApplicationActor = "agent" | "owner";

const ApplicationStatusSchema = z.enum(CLOUD_APPLICATION_STATUSES);
const ApplicationActorSchema = z.enum(["agent", "owner"]);
const TimestampSchema = z.iso.datetime({ offset: true });
const ApplicationHistoryEntrySchema = z.object({
  status: ApplicationStatusSchema,
  at: TimestampSchema,
  by: ApplicationActorSchema,
});

const CloudApplicationSchema = z.object({
  id: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).transform(String),
  org: z.string().nullable(),
  ats: z.string().nullable(),
  external_id: z.string().nullable(),
  source: z.enum(["lab-openings", "jobserve", "manual"]),
  title: z.string(),
  company: z.string(),
  url: z.string().nullable(),
  status: ApplicationStatusSchema,
  status_history: z.array(ApplicationHistoryEntrySchema),
  cv_ref: z.string().nullable(),
  notes: z.string().nullable(),
  created_at: TimestampSchema.nullable(),
  updated_at: TimestampSchema.nullable(),
});

const CreateApplicationSchema = z.object({
  org: z.string().trim().min(1).nullable().optional(),
  ats: z.string().trim().min(1).nullable().optional(),
  external_id: z.string().trim().min(1).nullable().optional(),
  source: z.enum(["lab-openings", "jobserve", "manual"]),
  title: z.string().trim().min(1),
  company: z.string().trim().min(1),
  url: z.url().nullable().optional(),
  cv_ref: z.string().trim().min(1).nullable().optional(),
  notes: z.string().trim().min(1).nullable().optional(),
});

const TransitionApplicationSchema = z.object({
  to: ApplicationStatusSchema,
  by: ApplicationActorSchema,
  note: z.string().trim().min(1).optional(),
});

export type CloudApplication = z.infer<typeof CloudApplicationSchema>;
export type CreateCloudApplicationInput = z.infer<typeof CreateApplicationSchema>;
export type TransitionCloudApplicationInput = z.infer<typeof TransitionApplicationSchema>;

export type CloudApplicationUnavailableCode =
  | "cloud_not_configured"
  | "cloud_schema_not_exposed"
  | "cloud_upstream_error";

interface CloudUnavailableReason {
  code: CloudApplicationUnavailableCode;
  message: string;
  upstreamStatus?: number;
}

export type CloudApplicationResult<T> =
  | { status: "available"; data: T }
  | { status: "cloud_unavailable"; reason: CloudUnavailableReason };

const SELECT_FIELDS =
  "id,org,ats,external_id,source,title,company,url,status,status_history,cv_ref,notes,created_at,updated_at";

const NEXT_STATUS: Partial<Record<CloudApplicationStatus, CloudApplicationStatus>> = {
  interested: "shortlisted",
  shortlisted: "cv_staged",
  cv_staged: "sent",
  sent: "response",
  response: "interview",
  interview: "offer",
};

function unavailable(
  code: CloudApplicationUnavailableCode,
  message: string,
  upstreamStatus?: number,
): CloudApplicationResult<never> {
  return {
    status: "cloud_unavailable",
    reason: upstreamStatus === undefined ? { code, message } : { code, message, upstreamStatus },
  };
}

function applicationsUrl(config: CloudConfig): URL | null {
  if (!config.supabaseUrl || !config.supabaseServiceKey) return null;
  return new URL("/rest/v1/applications", `${config.supabaseUrl.replace(/\/$/, "")}/`);
}

function isMissingSchema(status: number, body: string): boolean {
  return (
    status === 406 ||
    (status === 404 && /42P01|PGRST106|PGRST205|schema must be one of|applications/i.test(body))
  );
}

async function cloudRequest(
  context: ApiContext,
  url: URL,
  init: RequestInit,
  options: { allowConflict?: boolean } = {},
): Promise<CloudApplicationResult<{ response: Response; body: string }>> {
  const serviceKey = context.cloudConfig.supabaseServiceKey;
  if (!serviceKey) {
    return unavailable(
      "cloud_not_configured",
      "Application lifecycle cloud credentials are not configured on this API server.",
    );
  }

  let response: Response;
  try {
    response = await context.fetch(url, {
      ...init,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Accept-Profile": "careers",
        ...init.headers,
      },
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    });
  } catch (error) {
    log.warn({ error }, "application lifecycle request failed");
    return unavailable("cloud_upstream_error", "Application lifecycle could not reach Supabase.");
  }

  const body = await response.text();
  if (!response.ok && isMissingSchema(response.status, body)) {
    return unavailable(
      "cloud_schema_not_exposed",
      "The careers applications table is not exposed through PostgREST yet.",
      response.status,
    );
  }
  if (response.status === 409 && options.allowConflict) {
    return { status: "available", data: { response, body } };
  }
  if (!response.ok) {
    log.warn(
      { upstreamStatus: response.status },
      "application lifecycle upstream returned an error",
    );
    return unavailable(
      "cloud_upstream_error",
      `Application lifecycle upstream returned HTTP ${response.status}.`,
      response.status,
    );
  }
  return { status: "available", data: { response, body } };
}

function parseRows(
  body: string,
  upstreamStatus: number,
): CloudApplicationResult<CloudApplication[]> {
  try {
    return { status: "available", data: z.array(CloudApplicationSchema).parse(JSON.parse(body)) };
  } catch (error) {
    log.warn({ error, upstreamStatus }, "application lifecycle returned an invalid payload");
    return unavailable(
      "cloud_upstream_error",
      "Application lifecycle returned an invalid response payload.",
      upstreamStatus,
    );
  }
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, "invalid_application", "Invalid application lifecycle payload", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function validateId(id: string): string {
  if (!/^[1-9]\d*$/.test(id)) {
    throw new ApiError(400, "invalid_application_id", "Application id must be a positive integer");
  }
  return id;
}

function filter(url: URL, name: string, value: string): void {
  url.searchParams.set(name, `eq.${value}`);
}

async function fetchRows(
  context: ApiContext,
  options: {
    status?: CloudApplicationStatus;
    id?: string;
    provenance?: CreateCloudApplicationInput;
  },
): Promise<CloudApplicationResult<CloudApplication[]>> {
  const url = applicationsUrl(context.cloudConfig);
  if (!url) {
    return unavailable(
      "cloud_not_configured",
      "Application lifecycle cloud credentials are not configured on this API server.",
    );
  }
  url.searchParams.set("select", SELECT_FIELDS);
  url.searchParams.set("order", "created_at.desc,id.desc");
  if (options.status) filter(url, "status", options.status);
  if (options.id) filter(url, "id", options.id);
  const provenance = options.provenance;
  if (provenance?.org && provenance.ats && provenance.external_id) {
    filter(url, "org", provenance.org);
    filter(url, "ats", provenance.ats);
    filter(url, "external_id", provenance.external_id);
  }
  const result = await cloudRequest(context, url, { method: "GET" });
  if (result.status !== "available") return result;
  return parseRows(result.data.body, result.data.response.status);
}

export function isLegalApplicationTransition(
  from: CloudApplicationStatus,
  to: CloudApplicationStatus,
): boolean {
  if (from === "closed") return false;
  return to === "closed" || NEXT_STATUS[from] === to;
}

export async function listCloudApplications(
  context: ApiContext,
  status: string | null,
): Promise<CloudApplicationResult<CloudApplication[]>> {
  let parsedStatus: CloudApplicationStatus | undefined;
  if (status) {
    const parsed = ApplicationStatusSchema.safeParse(status);
    if (!parsed.success) {
      throw new ApiError(400, "invalid_application_status", `Unsupported status "${status}"`, {
        valid: CLOUD_APPLICATION_STATUSES,
      });
    }
    parsedStatus = parsed.data;
  }
  return fetchRows(context, parsedStatus ? { status: parsedStatus } : {});
}

export async function getCloudApplication(
  context: ApiContext,
  idValue: string,
): Promise<CloudApplicationResult<CloudApplication>> {
  const id = validateId(idValue);
  const rows = await fetchRows(context, { id });
  if (rows.status !== "available") return rows;
  const application = rows.data[0];
  if (!application) {
    throw new ApiError(404, "application_not_found", `No application found with id ${id}`);
  }
  return { status: "available", data: application };
}

export async function updateCloudApplicationCvRef(
  context: ApiContext,
  idValue: string,
  cvRef: string,
): Promise<CloudApplicationResult<{ application: CloudApplication }>> {
  const id = validateId(idValue);
  const url = applicationsUrl(context.cloudConfig);
  if (!url) {
    return unavailable(
      "cloud_not_configured",
      "Application lifecycle cloud credentials are not configured on this API server.",
    );
  }
  url.searchParams.set("select", SELECT_FIELDS);
  filter(url, "id", id);
  filter(url, "status", "shortlisted");
  const result = await cloudRequest(context, url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Content-Profile": "careers",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ cv_ref: cvRef, updated_at: context.now().toISOString() }),
  });
  if (result.status !== "available") return result;
  const rows = parseRows(result.data.body, result.data.response.status);
  if (rows.status !== "available") return rows;
  const application = rows.data[0];
  if (!application) {
    throw new ApiError(
      409,
      "application_cv_stage_conflict",
      "The application is no longer shortlisted, so cv_ref was not updated.",
    );
  }
  return { status: "available", data: { application } };
}

export async function createCloudApplication(
  context: ApiContext,
  body: unknown,
): Promise<CloudApplicationResult<{ application: CloudApplication; created: boolean }>> {
  const input = parseBody(CreateApplicationSchema, body);
  const hasUniqueKey = Boolean(input.org && input.ats && input.external_id);
  if (hasUniqueKey) {
    const existing = await fetchRows(context, { provenance: input });
    if (existing.status !== "available") return existing;
    const application = existing.data[0];
    if (application) return { status: "available", data: { application, created: false } };
  }

  const url = applicationsUrl(context.cloudConfig);
  if (!url) {
    return unavailable(
      "cloud_not_configured",
      "Application lifecycle cloud credentials are not configured on this API server.",
    );
  }
  url.searchParams.set("select", SELECT_FIELDS);
  const result = await cloudRequest(
    context,
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Profile": "careers",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        org: input.org ?? null,
        ats: input.ats ?? null,
        external_id: input.external_id ?? null,
        source: input.source,
        title: input.title,
        company: input.company,
        url: input.url ?? null,
        cv_ref: input.cv_ref ?? null,
        notes: input.notes ?? null,
      }),
    },
    { allowConflict: hasUniqueKey },
  );
  if (result.status !== "available") return result;
  if (result.data.response.status === 409 && hasUniqueKey) {
    const existing = await fetchRows(context, { provenance: input });
    if (existing.status !== "available") return existing;
    const application = existing.data[0];
    if (application) return { status: "available", data: { application, created: false } };
    return unavailable(
      "cloud_upstream_error",
      "Application lifecycle hit a uniqueness conflict but could not load the existing row.",
      409,
    );
  }
  const rows = parseRows(result.data.body || "[]", result.data.response.status);
  if (rows.status !== "available") return rows;
  const inserted = rows.data[0];
  if (inserted) return { status: "available", data: { application: inserted, created: true } };

  if (hasUniqueKey) {
    const existing = await fetchRows(context, { provenance: input });
    if (existing.status !== "available") return existing;
    const application = existing.data[0];
    if (application) return { status: "available", data: { application, created: false } };
  }
  return unavailable(
    "cloud_upstream_error",
    "Application lifecycle write succeeded without returning a row.",
    result.data.response.status,
  );
}

export async function transitionCloudApplication(
  context: ApiContext,
  idValue: string,
  body: unknown,
): Promise<CloudApplicationResult<{ application: CloudApplication }>> {
  const id = validateId(idValue);
  const input = parseBody(TransitionApplicationSchema, body);
  const currentRows = await fetchRows(context, { id });
  if (currentRows.status !== "available") return currentRows;
  const current = currentRows.data[0];
  if (!current)
    throw new ApiError(404, "application_not_found", `No application found with id ${id}`);

  if (input.to === "sent" && input.by !== "owner") {
    throw new ApiError(
      403,
      "owner_required_for_sent",
      "Only the owner may record that an application was sent.",
    );
  }
  if (!isLegalApplicationTransition(current.status, input.to)) {
    throw new ApiError(
      409,
      "illegal_application_transition",
      `Cannot transition an application from ${current.status} to ${input.to}.`,
    );
  }
  if (input.to === "closed" && !input.note) {
    throw new ApiError(
      400,
      "close_reason_required",
      "Closing an application requires a reason in note.",
    );
  }

  const now = context.now().toISOString();
  const url = applicationsUrl(context.cloudConfig);
  if (!url) {
    return unavailable(
      "cloud_not_configured",
      "Application lifecycle cloud credentials are not configured on this API server.",
    );
  }
  url.searchParams.set("select", SELECT_FIELDS);
  filter(url, "id", id);
  filter(url, "status", current.status);
  const notes = input.note
    ? [current.notes, `[${now}] ${input.note}`].filter(Boolean).join("\n")
    : current.notes;
  const result = await cloudRequest(context, url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Content-Profile": "careers",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      status: input.to,
      status_history: [...current.status_history, { status: input.to, at: now, by: input.by }],
      updated_at: now,
      ...(input.note ? { notes } : {}),
    }),
  });
  if (result.status !== "available") return result;
  const rows = parseRows(result.data.body, result.data.response.status);
  if (rows.status !== "available") return rows;
  const application = rows.data[0];
  if (!application) {
    throw new ApiError(
      409,
      "application_transition_conflict",
      "The application changed while this transition was being recorded.",
    );
  }
  return { status: "available", data: { application } };
}
