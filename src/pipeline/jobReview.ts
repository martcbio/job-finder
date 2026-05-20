import { quoteSqlLiteral } from "../db/config";

export const REVIEW_STATES = [
  "new",
  "needs_page_ingest",
  "needs_classification",
  "ready_for_review",
  "shortlisted",
  "needs_cv_tailoring",
  "ready_to_apply",
  "applied",
  "waiting",
  "rejected_by_us",
  "rejected_by_company",
  "stale",
  "duplicate_candidate",
  "not_relevant",
] as const;

export type ReviewState = (typeof REVIEW_STATES)[number];

export const REVIEW_ACTORS = ["system", "human", "agent"] as const;

export type ReviewActor = (typeof REVIEW_ACTORS)[number];

export interface ReviewTransitionInput {
  jobId: string;
  toState: ReviewState;
  reasonCodes: string[];
  note: string | null;
  actor: ReviewActor;
}

export interface ReviewTransitionRow {
  job_id: string;
  from_state: ReviewState;
  to_state: ReviewState;
  event_id: string;
}

export function isReviewState(value: string): value is ReviewState {
  return (REVIEW_STATES as readonly string[]).includes(value);
}

export function isReviewActor(value: string): value is ReviewActor {
  return (REVIEW_ACTORS as readonly string[]).includes(value);
}

export function buildReviewTransitionSql(input: ReviewTransitionInput): string {
  return `WITH current_job AS (
  SELECT id, review_state
  FROM job_search.jobs
  WHERE id = ${quoteSqlLiteral(input.jobId)}
  FOR UPDATE
),
updated_job AS (
  UPDATE job_search.jobs j
  SET review_state = ${quoteSqlLiteral(input.toState)}
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
    id,
    from_state,
    to_state,
    ${textArrayLiteral(input.reasonCodes)},
    ${nullableText(input.note)},
    ${quoteSqlLiteral(input.actor)}
  FROM updated_job
  RETURNING id
)
SELECT COALESCE(
  (
    SELECT json_build_object(
      'job_id', updated_job.id::text,
      'from_state', updated_job.from_state,
      'to_state', updated_job.to_state,
      'event_id', inserted_event.id::text
    )
    FROM updated_job, inserted_event
  ),
  'null'::json
);`;
}

export function buildReviewEventsSql(jobId: string, limit: number): string {
  return `SELECT COALESCE(json_agg(row_to_json(review_row)), '[]'::json)
FROM (
  SELECT
    id::text AS id,
    job_id::text AS job_id,
    from_state,
    to_state,
    reason_codes,
    note,
    actor,
    created_at
  FROM job_search.review_events
  WHERE job_id = ${quoteSqlLiteral(jobId)}
  ORDER BY created_at DESC, id DESC
  LIMIT ${limit}
) review_row;`;
}

function nullableText(value: string | null): string {
  return value === null ? "NULL" : quoteSqlLiteral(value);
}

function textArrayLiteral(values: string[]): string {
  if (values.length === 0) return "ARRAY[]::text[]";
  return `ARRAY[${values.map((value) => quoteSqlLiteral(value)).join(", ")}]::text[]`;
}
