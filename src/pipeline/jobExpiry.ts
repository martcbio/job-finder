import { quoteSqlLiteral } from "../db/config";

export const DEFAULT_EXPIRY_DAYS = 21;

export interface ExpireJobRow {
  id: string;
  title: string;
  company_hint: string | null;
  review_state: string;
  last_seen_at: string;
}

const EXPIRABLE_REVIEW_STATES = [
  "new",
  "needs_page_ingest",
  "needs_classification",
  "ready_for_review",
  "duplicate_candidate",
] as const;

export function expiryCutoff(now: Date, days: number): Date {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("Expiry days must be a positive integer");
  }
  return new Date(now.getTime() - days * 86_400_000);
}

export function buildExpireCandidatesSql(cutoff: Date): string {
  return `SELECT COALESCE(json_agg(row_to_json(expiring_job)), '[]'::json)
FROM (
  SELECT
    id::text AS id,
    title_normalized AS title,
    company_hint,
    review_state,
    last_seen_at::text AS last_seen_at
  FROM job_search.jobs
  WHERE review_state = ANY(${expirableStateArraySql()})
    AND last_seen_at < ${timestampSql(cutoff)}
  ORDER BY last_seen_at, id
) expiring_job;`;
}

export function buildApplyJobExpirySql(cutoff: Date): string {
  return `WITH candidates AS (
  SELECT id, title_normalized, company_hint, review_state, last_seen_at
  FROM job_search.jobs
  WHERE review_state = ANY(${expirableStateArraySql()})
    AND last_seen_at < ${timestampSql(cutoff)}
  ORDER BY id
  FOR UPDATE
),
updated_jobs AS (
  UPDATE job_search.jobs j
  SET review_state = 'stale'
  FROM candidates c
  WHERE j.id = c.id
  RETURNING
    j.id,
    j.title_normalized,
    j.company_hint,
    c.review_state AS previous_state,
    j.review_state,
    j.last_seen_at
),
inserted_events AS (
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
    previous_state,
    review_state,
    ARRAY['source_expired']::text[],
    ${quoteSqlLiteral(`Not observed since before ${cutoff.toISOString()}`)},
    'system'
  FROM updated_jobs
)
SELECT COALESCE(json_agg(row_to_json(expired_job)), '[]'::json)
FROM (
  SELECT
    id::text AS id,
    title_normalized AS title,
    company_hint,
    review_state,
    last_seen_at::text AS last_seen_at
  FROM updated_jobs
  ORDER BY last_seen_at, id
) expired_job;`;
}

/**
 * Reconciles a live, deterministic URL-death verdict without deleting evidence.
 * Only queue states that can be safely auto-staled are changed; every transition
 * receives a durable review event.
 */
export function buildMarkJobsStaleByCanonicalUrlsSql(
  urls: readonly string[],
  reason: string,
): string {
  const normalizedUrls = [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
  if (normalizedUrls.length === 0) return "SELECT '[]'::json;";
  const urlArray = `ARRAY[${normalizedUrls.map(quoteSqlLiteral).join(", ")}]::text[]`;
  return `WITH candidates AS (
  SELECT id, title_normalized, company_hint, review_state, last_seen_at
  FROM job_search.jobs
  WHERE review_state <> 'stale'
    AND canonical_url = ANY(${urlArray})
  ORDER BY id
  FOR UPDATE
),
updated_jobs AS (
  UPDATE job_search.jobs j
  SET review_state = 'stale'
  FROM candidates c
  WHERE j.id = c.id
    AND c.review_state = ANY(${expirableStateArraySql()})
  RETURNING
    j.id,
    j.title_normalized,
    j.company_hint,
    c.review_state AS previous_state,
    j.review_state,
    j.last_seen_at
),
inserted_transition_events AS (
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
    previous_state,
    review_state,
    ARRAY['source_url_dead']::text[],
    ${quoteSqlLiteral(reason)},
    'system'
  FROM updated_jobs
),
inserted_flag_events AS (
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
    review_state,
    review_state,
    ARRAY['source_url_dead']::text[],
    ${quoteSqlLiteral(reason)},
    'system'
  FROM candidates
  WHERE review_state <> ALL(${expirableStateArraySql()})
    AND NOT EXISTS (
      SELECT 1
      FROM job_search.review_events existing_event
      WHERE existing_event.job_id = candidates.id
        AND existing_event.from_state = candidates.review_state
        AND existing_event.to_state = candidates.review_state
        AND existing_event.reason_codes @> ARRAY['source_url_dead']::text[]
        AND existing_event.note = ${quoteSqlLiteral(reason)}
    )
)
SELECT COALESCE(json_agg(row_to_json(staled_job)), '[]'::json)
FROM (
  SELECT
    id::text AS id,
    title_normalized AS title,
    company_hint,
    review_state,
    last_seen_at::text AS last_seen_at
  FROM updated_jobs
  ORDER BY last_seen_at, id
) staled_job;`;
}

function expirableStateArraySql(): string {
  return `ARRAY[${EXPIRABLE_REVIEW_STATES.map(quoteSqlLiteral).join(", ")}]::text[]`;
}

function timestampSql(value: Date): string {
  if (Number.isNaN(value.getTime())) throw new Error("Expiry cutoff must be a valid date");
  return `${quoteSqlLiteral(value.toISOString())}::timestamptz`;
}
