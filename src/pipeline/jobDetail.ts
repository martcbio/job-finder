import { quoteSqlLiteral } from "../db/config";
import type { FastRefreshJobRow } from "./fastRefresh/types";
import { jobRowToSummary } from "./fastRefresh/summaries";

export interface JobDetailRow {
  id: string;
  title: string;
  company_hint: string | null;
  canonical_url: string;
  canonical_key: string;
  review_state: string;
  category: string;
  rag_focus: string;
  enterprise_focus: string;
  classification_confidence: string | null;
  classification_reason: string | null;
  page_ingest_status: string;
  page_ingested_at: string | null;
  ats_source: string | null;
  ats_org: string | null;
  ats_job_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  labels: unknown[];
  observations: unknown[];
  pages: unknown[];
  review_events: unknown[];
}

export interface JobFullTextRow {
  jobId: string;
  title: string;
  company: string | null;
  canonicalUrl: string;
  reviewState: string;
  pageId: string | null;
  status: string | null;
  fetchedAt: string | null;
  fetchSource: string | null;
  sourceUrl: string | null;
  rawTitle: string | null;
  markdown: string | null;
  usageTokens: number | null;
  decompressedBytes: number | null;
  error: string | null;
  sourceId: string | null;
  sourceLabel: string | null;
  observedUrl: string | null;
}

function firstRecord(value: unknown[]): Record<string, unknown> {
  const first = value[0];
  return first && typeof first === "object" && !Array.isArray(first)
    ? (first as Record<string, unknown>)
    : {};
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringOrNumberField(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
}

export function buildJobDetailSql(jobId: string): string {
  return `SELECT COALESCE(
  (
    SELECT row_to_json(job_detail)
    FROM (
      SELECT
        j.id::text AS id,
        j.title_normalized AS title,
        j.company_hint,
        j.canonical_url,
        j.canonical_key,
        j.review_state,
        j.category,
        j.rag_focus,
        j.enterprise_focus,
        j.classification_confidence,
        j.classification_reason,
        j.page_ingest_status,
        j.page_ingested_at,
        j.ats_source,
        j.ats_org,
        j.ats_job_id,
        j.first_seen_at,
        j.last_seen_at,
        COALESCE(
          (
            SELECT json_agg(row_to_json(label_row) ORDER BY label_row.source_stage, label_row.confidence DESC)
            FROM (
              SELECT label, source_stage, confidence, reason
              FROM job_search.job_classification_labels
              WHERE job_id = j.id
            ) label_row
          ),
          '[]'::json
        ) AS labels,
        COALESCE(
          (
            SELECT json_agg(row_to_json(observation_row) ORDER BY observation_row.observed_at DESC, observation_row.id DESC)
            FROM (
              SELECT
                jo.id::text AS id,
                jo.observed_at,
                jo.observed_title,
                jo.observed_url,
                jo.observed_company_hint,
                sq.source_id,
                sq.source_label,
                sr.description_raw
              FROM job_search.job_observations jo
              JOIN job_search.search_results sr ON sr.id = jo.search_result_id
              JOIN job_search.search_queries sq ON sq.id = sr.query_id
              WHERE jo.job_id = j.id
            ) observation_row
          ),
          '[]'::json
        ) AS observations,
        COALESCE(
          (
            SELECT json_agg(row_to_json(page_row) ORDER BY page_row.fetched_at DESC)
            FROM (
              SELECT
                id::text,
                source,
                status,
                fetched_at,
                source_url,
                title_raw,
                markdown,
                usage_tokens,
                decompressed_bytes,
                error
              FROM job_search.job_pages
              WHERE job_id = j.id
            ) page_row
          ),
          '[]'::json
        ) AS pages,
        COALESCE(
          (
            SELECT json_agg(row_to_json(event_row) ORDER BY event_row.created_at DESC, event_row.id DESC)
            FROM (
              SELECT
                id::text,
                from_state,
                to_state,
                reason_codes,
                note,
                actor,
                created_at
              FROM job_search.review_events
              WHERE job_id = j.id
              LIMIT 50
            ) event_row
          ),
          '[]'::json
        ) AS review_events
      FROM job_search.jobs j
      WHERE j.id = ${quoteSqlLiteral(jobId)}
    ) job_detail
  ),
  'null'::json
);`;
}

export function buildJobFullTextSql(jobId: string): string {
  return `SELECT COALESCE(
  (
    SELECT row_to_json(full_text)
    FROM (
      SELECT
        j.id::text AS "jobId",
        j.title_normalized AS title,
        j.company_hint AS company,
        j.canonical_url AS "canonicalUrl",
        j.review_state AS "reviewState",
        latest_page.id::text AS "pageId",
        latest_page.status,
        latest_page.fetched_at::text AS "fetchedAt",
        latest_page.source AS "fetchSource",
        latest_page.source_url AS "sourceUrl",
        latest_page.title_raw AS "rawTitle",
        latest_page.markdown,
        latest_page.usage_tokens::bigint AS "usageTokens",
        latest_page.decompressed_bytes::bigint AS "decompressedBytes",
        latest_page.error,
        latest_observation.source_id AS "sourceId",
        latest_observation.source_label AS "sourceLabel",
        latest_observation.observed_url AS "observedUrl"
      FROM job_search.jobs j
      LEFT JOIN LATERAL (
        SELECT
          jp.id,
          jp.source,
          jp.status,
          jp.fetched_at,
          jp.source_url,
          jp.title_raw,
          jp.markdown,
          jp.usage_tokens,
          jp.decompressed_bytes,
          jp.error
        FROM job_search.job_pages jp
        WHERE jp.job_id = j.id
        ORDER BY
          CASE WHEN jp.status = 'success' THEN 0 ELSE 1 END,
          jp.fetched_at DESC,
          jp.id DESC
        LIMIT 1
      ) latest_page ON true
      LEFT JOIN LATERAL (
        SELECT
          sq.source_id,
          sq.source_label,
          jo.observed_url
        FROM job_search.job_observations jo
        JOIN job_search.search_results sr ON sr.id = jo.search_result_id
        JOIN job_search.search_queries sq ON sq.id = sr.query_id
        WHERE jo.job_id = j.id
        ORDER BY jo.observed_at DESC, jo.id DESC
        LIMIT 1
      ) latest_observation ON true
      WHERE j.id = ${quoteSqlLiteral(jobId)}
    ) full_text
  ),
  'null'::json
);`;
}

export function jobDetailToSummary(row: JobDetailRow): ReturnType<typeof jobRowToSummary> {
  const latestObservation = firstRecord(row.observations);
  const latestPage = firstRecord(row.pages);
  return jobRowToSummary({
    id: Number(row.id),
    title: row.title,
    company: row.company_hint,
    canonical_url: row.canonical_url,
    review_state: row.review_state,
    category: row.category,
    rag_focus: row.rag_focus,
    enterprise_focus: row.enterprise_focus,
    classification_confidence: row.classification_confidence,
    classification_reason: row.classification_reason,
    page_ingest_status: row.page_ingest_status,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    source_id: stringField(latestObservation.source_id),
    source_label: stringField(latestObservation.source_label),
    observed_url: stringField(latestObservation.observed_url),
    description_sample: stringField(latestObservation.description_raw),
    markdown: stringField(latestPage.markdown),
    page_status: stringField(latestPage.status),
    page_error: stringField(latestPage.error),
    page_usage_tokens: stringOrNumberField(latestPage.usage_tokens),
    page_decompressed_bytes: stringOrNumberField(latestPage.decompressed_bytes),
    labels: row.labels as FastRefreshJobRow["labels"],
    duplicate_candidates: [],
    review_events: row.review_events,
  });
}
