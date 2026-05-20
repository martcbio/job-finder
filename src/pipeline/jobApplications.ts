import { quoteSqlLiteral } from "../db/config";
import type { ReviewActor, ReviewState } from "./jobReview";

export const APPLICATION_STATUSES = [
  "prepared",
  "applied",
  "waiting",
  "rejected_by_company",
  "withdrawn",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export interface RecordApplicationInput {
  jobId: string;
  cvDraftId: string | null;
  status: ApplicationStatus;
  channel: string | null;
  externalUrl: string | null;
  appliedAt: string | null;
  note: string | null;
  actor: ReviewActor;
}

export interface RecordedApplicationRow {
  id: string;
  job_id: string;
  cv_draft_id: string | null;
  status: ApplicationStatus;
  from_state: ReviewState;
  to_state: ReviewState;
  event_id: string;
}

export interface ApplicationListOptions {
  status?: ApplicationStatus;
  limit: number;
}

export interface ApplicationListRow {
  id: string;
  job_id: string;
  cv_draft_id: string | null;
  status: ApplicationStatus;
  title: string;
  company_hint: string | null;
  canonical_url: string;
  channel: string | null;
  external_url: string | null;
  applied_at: string | null;
  note: string | null;
  created_at: string;
}

export function isApplicationStatus(value: string): value is ApplicationStatus {
  return (APPLICATION_STATUSES as readonly string[]).includes(value);
}

export function applicationStatusToReviewState(status: ApplicationStatus): ReviewState {
  switch (status) {
    case "prepared":
      return "ready_to_apply";
    case "applied":
      return "applied";
    case "waiting":
      return "waiting";
    case "rejected_by_company":
      return "rejected_by_company";
    case "withdrawn":
      return "rejected_by_us";
  }
}

export function buildRecordApplicationSql(input: RecordApplicationInput): string {
  const toState = applicationStatusToReviewState(input.status);

  return `WITH current_job AS (
  SELECT id, review_state
  FROM job_search.jobs
  WHERE id = ${quoteSqlLiteral(input.jobId)}
  FOR UPDATE
),
inserted_application AS (
  INSERT INTO job_search.job_applications (
    job_id,
    cv_draft_id,
    status,
    channel,
    external_url,
    applied_at,
    note
  )
  SELECT
    current_job.id,
    ${nullableBigint(input.cvDraftId)},
    ${quoteSqlLiteral(input.status)},
    ${nullableText(input.channel)},
    ${nullableText(input.externalUrl)},
    ${nullableTimestamp(input.appliedAt, input.status)},
    ${nullableText(input.note)}
  FROM current_job
  RETURNING id, job_id, cv_draft_id, status
),
updated_job AS (
  UPDATE job_search.jobs j
  SET review_state = ${quoteSqlLiteral(toState)}
  FROM current_job
  WHERE j.id = current_job.id
  RETURNING j.id, current_job.review_state AS from_state, j.review_state AS to_state
),
inserted_event AS (
  INSERT INTO job_search.review_events (
    job_id,
    from_state,
    to_state,
    reason_codes,
    note,
    actor
  )
  SELECT
    updated_job.id,
    updated_job.from_state,
    updated_job.to_state,
    ${textArrayLiteral(["application_recorded", input.status])},
    ${nullableText(input.note)},
    ${quoteSqlLiteral(input.actor)}
  FROM updated_job
  RETURNING id
)
SELECT COALESCE(
  (
    SELECT json_build_object(
      'id', inserted_application.id::text,
      'job_id', inserted_application.job_id::text,
      'cv_draft_id', inserted_application.cv_draft_id::text,
      'status', inserted_application.status,
      'from_state', updated_job.from_state,
      'to_state', updated_job.to_state,
      'event_id', inserted_event.id::text
    )
    FROM inserted_application, updated_job, inserted_event
  ),
  'null'::json
);`;
}

export function buildListApplicationsSql(options: ApplicationListOptions): string {
  const where = options.status ? `WHERE ja.status = ${quoteSqlLiteral(options.status)}` : "";

  return `SELECT COALESCE(json_agg(row_to_json(application_row)), '[]'::json)
FROM (
  SELECT
    ja.id::text AS id,
    ja.job_id::text AS job_id,
    ja.cv_draft_id::text AS cv_draft_id,
    ja.status,
    j.title_normalized AS title,
    j.company_hint,
    j.canonical_url,
    ja.channel,
    ja.external_url,
    ja.applied_at,
    ja.note,
    ja.created_at
  FROM job_search.job_applications ja
  JOIN job_search.jobs j ON j.id = ja.job_id
  ${where}
  ORDER BY ja.created_at DESC, ja.id DESC
  LIMIT ${options.limit}
) application_row;`;
}

export function renderApplicationsMarkdown(rows: ApplicationListRow[]): string {
  const lines = ["# Job Applications", ""];

  if (rows.length === 0) {
    lines.push("_No application records found._");
    return `${lines.join("\n")}\n`;
  }

  for (const row of rows) {
    lines.push(`## ${row.title}`);
    lines.push("");
    lines.push(`- Job ID: ${row.job_id}`);
    lines.push(`- Application ID: ${row.id}`);
    lines.push(`- Status: ${row.status}`);
    lines.push(`- Company: ${row.company_hint ?? "Unknown"}`);
    lines.push(`- Job URL: ${row.canonical_url}`);
    if (row.cv_draft_id) lines.push(`- CV draft ID: ${row.cv_draft_id}`);
    if (row.channel) lines.push(`- Channel: ${row.channel}`);
    if (row.external_url) lines.push(`- External URL: ${row.external_url}`);
    if (row.applied_at) lines.push(`- Applied at: ${row.applied_at}`);
    if (row.note) lines.push(`- Note: ${row.note}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function nullableText(value: string | null): string {
  return value === null ? "NULL" : quoteSqlLiteral(value);
}

function nullableBigint(value: string | null): string {
  return value === null ? "NULL" : `${quoteSqlLiteral(value)}::bigint`;
}

function nullableTimestamp(value: string | null, status: ApplicationStatus): string {
  if (value !== null) return `${quoteSqlLiteral(value)}::timestamptz`;
  return status === "applied" || status === "waiting" ? "now()" : "NULL";
}

function textArrayLiteral(values: string[]): string {
  if (values.length === 0) return "ARRAY[]::text[]";
  return `ARRAY[${values.map((value) => quoteSqlLiteral(value)).join(", ")}]::text[]`;
}
