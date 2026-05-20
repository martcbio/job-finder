import { quoteSqlLiteral } from "../db/config";
import type { ReviewActor } from "./jobReview";

export interface DuplicateJobRow {
  id: string;
  title: string;
  company_hint: string | null;
  canonical_url: string;
  category: string;
}

export interface DuplicateCandidate {
  jobIdA: string;
  jobIdB: string;
  confidence: number;
  reason: string;
}

export const DUPLICATE_CANDIDATE_STATES = [
  "suggested",
  "confirmed_same",
  "confirmed_distinct",
  "ignored",
] as const;

export type DuplicateCandidateState = (typeof DUPLICATE_CANDIDATE_STATES)[number];

export interface DuplicateCandidateReviewInput {
  candidateId: string;
  state: Exclude<DuplicateCandidateState, "suggested">;
  actor: ReviewActor;
  reasonCodes: string[];
  note: string | null;
}

export interface DuplicateCandidateReviewRow {
  id: string;
  job_id_a: string;
  job_id_b: string;
  previous_state: DuplicateCandidateState;
  state: DuplicateCandidateState;
}

export function isDuplicateCandidateState(value: string): value is DuplicateCandidateState {
  return (DUPLICATE_CANDIDATE_STATES as readonly string[]).includes(value);
}

export function buildDuplicateCandidateJobsSql(limit: number): string {
  return `SELECT COALESCE(json_agg(row_to_json(candidate_job)), '[]'::json)
FROM (
  SELECT
    id::text AS id,
    title_normalized AS title,
    company_hint,
    canonical_url,
    category
  FROM job_search.jobs
  WHERE review_state <> 'rejected_by_us'
  ORDER BY last_seen_at DESC, id DESC
  LIMIT ${limit}
) candidate_job;`;
}

export function buildUpsertDuplicateCandidateSql(candidate: DuplicateCandidate): string {
  const ordered = orderJobIds(candidate.jobIdA, candidate.jobIdB);

  return `INSERT INTO job_search.duplicate_candidates (
  job_id_a,
  job_id_b,
  confidence,
  reason,
  state
)
VALUES (
  ${quoteSqlLiteral(ordered.jobIdA)},
  ${quoteSqlLiteral(ordered.jobIdB)},
  ${candidate.confidence.toFixed(4)},
  ${quoteSqlLiteral(candidate.reason)},
  'suggested'
)
ON CONFLICT (job_id_a, job_id_b)
DO UPDATE SET
  confidence = GREATEST(job_search.duplicate_candidates.confidence, EXCLUDED.confidence),
  reason = EXCLUDED.reason
WHERE job_search.duplicate_candidates.state = 'suggested';`;
}

export function buildReviewDuplicateCandidateSql(input: DuplicateCandidateReviewInput): string {
  return `WITH current_candidate AS (
  SELECT id, job_id_a, job_id_b, state
  FROM job_search.duplicate_candidates
  WHERE id = ${quoteSqlLiteral(input.candidateId)}
  FOR UPDATE
),
updated_candidate AS (
  UPDATE job_search.duplicate_candidates dc
  SET state = ${quoteSqlLiteral(input.state)},
      reviewed_at = now(),
      reviewed_by = ${quoteSqlLiteral(input.actor)},
      review_reason_codes = ${textArrayLiteral(input.reasonCodes)},
      review_note = ${nullableText(input.note)}
  FROM current_candidate
  WHERE dc.id = current_candidate.id
  RETURNING
    dc.id,
    dc.job_id_a,
    dc.job_id_b,
    current_candidate.state AS previous_state,
    dc.state
),
candidate_jobs AS (
  SELECT j.id, j.review_state
  FROM job_search.jobs j
  JOIN updated_candidate uc ON j.id IN (uc.job_id_a, uc.job_id_b)
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
    candidate_jobs.id,
    candidate_jobs.review_state,
    candidate_jobs.review_state,
    ${textArrayLiteral(["duplicate_candidate_review", input.state, ...input.reasonCodes])},
    ${nullableText(input.note)},
    ${quoteSqlLiteral(input.actor)}
  FROM candidate_jobs
)
SELECT COALESCE(
  (
    SELECT json_build_object(
      'id', id::text,
      'job_id_a', job_id_a::text,
      'job_id_b', job_id_b::text,
      'previous_state', previous_state,
      'state', state
    )
    FROM updated_candidate
  ),
  'null'::json
);`;
}

export function findDuplicateCandidates(
  rows: DuplicateJobRow[],
  threshold: number,
): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];

  for (let leftIndex = 0; leftIndex < rows.length; leftIndex++) {
    const left = rows[leftIndex];
    if (!left) continue;

    for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex++) {
      const right = rows[rightIndex];
      if (!right || left.id === right.id || left.canonical_url === right.canonical_url) continue;

      const candidate = compareJobs(left, right, threshold);
      if (candidate) candidates.push(candidate);
    }
  }

  return candidates.sort((left, right) => right.confidence - left.confidence);
}

function compareJobs(
  left: DuplicateJobRow,
  right: DuplicateJobRow,
  threshold: number,
): DuplicateCandidate | null {
  const companyMatch =
    normalizeCompany(left.company_hint) !== "" &&
    normalizeCompany(left.company_hint) === normalizeCompany(right.company_hint);
  const titleScore = tokenJaccard(
    normalizeTitleTokens(left.title),
    normalizeTitleTokens(right.title),
  );
  const categoryMatch =
    left.category !== "unclassified" &&
    left.category !== "other" &&
    left.category === right.category;

  let confidence = titleScore;
  const reasons: string[] = [`title_similarity=${titleScore.toFixed(2)}`];

  if (companyMatch) {
    confidence += 0.18;
    reasons.push("same_company");
  }

  if (categoryMatch) {
    confidence += 0.06;
    reasons.push("same_category");
  }

  confidence = Math.min(confidence, 0.99);
  if (confidence < threshold) return null;

  const ordered = orderJobIds(left.id, right.id);
  return {
    ...ordered,
    confidence,
    reason: reasons.join("; "),
  };
}

function orderJobIds(left: string, right: string): { jobIdA: string; jobIdB: string } {
  const leftNumber = Number.parseInt(left, 10);
  const rightNumber = Number.parseInt(right, 10);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber < rightNumber
      ? { jobIdA: left, jobIdB: right }
      : { jobIdA: right, jobIdB: left };
  }
  return left < right ? { jobIdA: left, jobIdB: right } : { jobIdA: right, jobIdB: left };
}

function nullableText(value: string | null): string {
  return value === null ? "NULL" : quoteSqlLiteral(value);
}

function textArrayLiteral(values: string[]): string {
  if (values.length === 0) return "ARRAY[]::text[]";
  return `ARRAY[${values.map((value) => quoteSqlLiteral(value)).join(", ")}]::text[]`;
}

function normalizeCompany(value: string | null): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(inc|llc|ltd|limited|corp|corporation)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitleTokens(title: string): Set<string> {
  const stopwords = new Set(["the", "and", "of", "for", "to", "remote"]);
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9+#.]+/g, " ")
      .split(/\s+/)
      .map((token) => normalizeTitleToken(token))
      .filter((token) => token.length > 1 && !stopwords.has(token)),
  );
}

function normalizeTitleToken(token: string): string {
  if (token === "sr") return "senior";
  if (token === "eng") return "engineer";
  if (token === "ml") return "machine-learning";
  return token;
}

function tokenJaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }

  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}
