import { quoteSqlLiteral } from "../db/config";
import type { ReviewState } from "./jobReview";

export interface ReviewQueueFilters {
  limit: number;
  states: ReviewState[];
}

export interface ReviewQueueLabel {
  label: string;
  source_stage: string;
  confidence: string | number;
}

export interface ReviewQueueDuplicate {
  candidate_id: string;
  other_job_id: string;
  other_title: string;
  other_company_hint: string | null;
  confidence: string | number;
  reason: string;
  state: string;
}

export interface ReviewQueueEvent {
  from_state: string | null;
  to_state: string;
  reason_codes: string[];
  note: string | null;
  actor: string;
  created_at: string;
}

export interface ReviewQueueRow {
  id: string;
  title: string;
  company_hint: string | null;
  canonical_url: string;
  review_state: string;
  category: string;
  rag_focus: string;
  enterprise_focus: string;
  classification_confidence: string | null;
  classification_labels: ReviewQueueLabel[];
  duplicate_candidates: ReviewQueueDuplicate[];
  latest_review_event: ReviewQueueEvent | null;
  source_labels: string[];
  last_seen_at: string;
  description_sample: string | null;
}

export interface RenderReviewQueueOptions {
  generatedAt: Date;
  filters: ReviewQueueFilters;
}

export function buildReviewQueueSql(filters: ReviewQueueFilters): string {
  return `SELECT COALESCE(json_agg(row_to_json(queue_row)), '[]'::json)
FROM (
  SELECT
    j.id::text AS id,
    j.title_normalized AS title,
    j.company_hint,
    j.canonical_url,
    j.review_state,
    j.category,
    j.rag_focus,
    j.enterprise_focus,
    j.classification_confidence,
    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'label', jcl.label,
            'source_stage', jcl.source_stage,
            'confidence', jcl.confidence
          )
          ORDER BY
            CASE jcl.source_stage WHEN 'page' THEN 0 WHEN 'metadata' THEN 1 ELSE 2 END,
            jcl.confidence DESC,
            jcl.label
        )
        FROM job_search.job_classification_labels jcl
        WHERE jcl.job_id = j.id
      ),
      '[]'::json
    ) AS classification_labels,
    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'candidate_id', dc.id::text,
            'other_job_id', other_job.id::text,
            'other_title', other_job.title_normalized,
            'other_company_hint', other_job.company_hint,
            'confidence', dc.confidence,
            'reason', dc.reason,
            'state', dc.state
          )
          ORDER BY dc.confidence DESC, dc.id DESC
        )
        FROM job_search.duplicate_candidates dc
        JOIN job_search.jobs other_job
          ON other_job.id = CASE WHEN dc.job_id_a = j.id THEN dc.job_id_b ELSE dc.job_id_a END
        WHERE (dc.job_id_a = j.id OR dc.job_id_b = j.id)
          AND dc.state = 'suggested'
      ),
      '[]'::json
    ) AS duplicate_candidates,
    (
      SELECT row_to_json(event_row)
      FROM (
        SELECT
          re.from_state,
          re.to_state,
          re.reason_codes,
          re.note,
          re.actor,
          re.created_at
        FROM job_search.review_events re
        WHERE re.job_id = j.id
        ORDER BY re.created_at DESC, re.id DESC
        LIMIT 1
      ) event_row
    ) AS latest_review_event,
    COALESCE(array_remove(array_agg(DISTINCT sq.source_label), NULL), ARRAY[]::text[]) AS source_labels,
    j.last_seen_at,
    COALESCE(
      MAX(jp.markdown) FILTER (WHERE jp.markdown <> ''),
      MIN(sr.description_raw) FILTER (WHERE sr.description_raw <> '')
    ) AS description_sample
  FROM job_search.jobs j
  LEFT JOIN job_search.job_observations jo ON jo.job_id = j.id
  LEFT JOIN job_search.search_results sr ON sr.id = jo.search_result_id
  LEFT JOIN job_search.search_queries sq ON sq.id = sr.query_id
  LEFT JOIN job_search.job_pages jp ON jp.job_id = j.id AND jp.status = 'success'
  WHERE j.review_state = ANY(${reviewStateArrayLiteral(filters.states)})
  GROUP BY j.id
  ORDER BY j.last_seen_at DESC, j.id DESC
  LIMIT ${filters.limit}
) queue_row;`;
}

export function renderReviewQueueMarkdown(
  rows: ReviewQueueRow[],
  options: RenderReviewQueueOptions,
): string {
  const lines = [
    "# Job Review Queue",
    "",
    `Generated: ${options.generatedAt.toISOString()}`,
    `States: ${options.filters.states.join(", ")}`,
    `Total jobs: ${rows.length}`,
    "",
  ];

  if (rows.length === 0) {
    lines.push("_No jobs matched the queue filters._");
    return `${lines.join("\n")}\n`;
  }

  rows.forEach((row, index) => {
    lines.push(`${index + 1}. [${escapeMarkdown(row.title)}](${row.canonical_url})`);
    lines.push(`   Job ID: ${row.id}`);
    lines.push(`   Company: ${row.company_hint ?? "Unknown"}`);
    lines.push(`   State: ${row.review_state}`);
    lines.push(
      `   Classification: ${row.category} / rag=${row.rag_focus} / enterprise=${row.enterprise_focus}`,
    );
    if (row.classification_labels.length > 0) {
      lines.push(`   Labels: ${formatLabels(row.classification_labels)}`);
    }
    if (row.duplicate_candidates.length > 0) {
      lines.push(`   Duplicate candidates: ${formatDuplicates(row.duplicate_candidates)}`);
    }
    if (row.latest_review_event) {
      lines.push(`   Latest event: ${formatLatestEvent(row.latest_review_event)}`);
    }
    lines.push(
      `   Sources: ${row.source_labels.length > 0 ? row.source_labels.join(", ") : "Unknown"}`,
    );
    lines.push(`   Last seen: ${row.last_seen_at}`);
    if (row.description_sample) {
      lines.push(`   Snippet: ${truncateOneLine(row.description_sample, 220)}`);
    }
    lines.push("");
  });

  return `${lines.join("\n")}\n`;
}

function reviewStateArrayLiteral(states: ReviewState[]): string {
  return `ARRAY[${states.map((state) => quoteSqlLiteral(state)).join(", ")}]::text[]`;
}

function formatLabels(labels: ReviewQueueLabel[]): string {
  return labels
    .map((label) => `${label.label}@${label.source_stage}(${formatConfidence(label.confidence)})`)
    .join(", ");
}

function formatDuplicates(duplicates: ReviewQueueDuplicate[]): string {
  return duplicates
    .map(
      (duplicate) =>
        `candidate ${duplicate.candidate_id}: #${duplicate.other_job_id} ${duplicate.other_title} (${formatConfidence(duplicate.confidence)}; ${duplicate.reason})`,
    )
    .join("; ");
}

function formatLatestEvent(event: ReviewQueueEvent): string {
  const reasons = event.reason_codes.length > 0 ? ` reasons=${event.reason_codes.join(",")}` : "";
  const note = event.note ? ` note=${JSON.stringify(event.note)}` : "";
  return `${event.from_state ?? "-"} -> ${event.to_state} by ${event.actor}${reasons}${note}`;
}

function formatConfidence(confidence: string | number): string {
  if (typeof confidence === "number") return confidence.toFixed(4);
  const parsed = Number.parseFloat(confidence);
  return Number.isFinite(parsed) ? parsed.toFixed(4) : confidence;
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function truncateOneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}
