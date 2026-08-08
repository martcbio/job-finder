import { quoteSqlLiteral } from "../db/config";
import { jsonbLiteral } from "../db/jsonSql";
import { extractTitle } from "./scrape";

export type PageIngestSource = "jina_reader" | "ats_api" | "http_extract";
export type PageIngestAttemptSource = PageIngestSource | "browser";
export type PageIngestStatus = "success" | "error" | "timeout";
export type PageIngestAttemptStatus = PageIngestStatus | "skipped";

export interface PageIngestJobRow {
  id: string;
  title: string;
  canonical_url: string;
}

export interface PageIngestResult {
  source?: PageIngestSource;
  status: PageIngestStatus;
  markdown: string | null;
  usageTokens: number | null;
  decompressedBytes: number | null;
  error: string | null;
}

export interface PageIngestAttempt {
  source: PageIngestAttemptSource;
  status: PageIngestAttemptStatus;
  durationMs: number | null;
  usageTokens: number | null;
  metadata: unknown;
  error: string | null;
}

export function buildPendingPageIngestSql(limit: number): string {
  return `SELECT COALESCE(json_agg(row_to_json(page_job)), '[]'::json)
FROM (
  SELECT
    j.id::text AS id,
    j.title_normalized AS title,
    j.canonical_url
  FROM job_search.jobs j
  WHERE j.page_ingest_status IN ('pending', 'error', 'timeout')
  ORDER BY j.last_seen_at DESC, j.id DESC
  LIMIT ${limit}
) page_job;`;
}

export function buildSearchRunPageIngestSql(runId: number, limit: number): string {
  return `SELECT COALESCE(json_agg(row_to_json(page_job)), '[]'::json)
FROM (
  SELECT DISTINCT ON (j.id)
    j.id::text AS id,
    j.title_normalized AS title,
    j.canonical_url
  FROM job_search.search_queries sq
  JOIN job_search.search_runs search_run ON search_run.id = sq.run_id
  JOIN job_search.search_results sr ON sr.query_id = sq.id
  JOIN job_search.job_observations jo ON jo.search_result_id = sr.id
  JOIN job_search.jobs j ON j.id = jo.job_id
  WHERE sq.run_id = ${runId}
    AND NOT EXISTS (
      SELECT 1
      FROM job_search.job_pages jp
      WHERE jp.job_id = j.id
        AND jp.status = 'success'
        AND jp.fetched_at >= search_run.started_at
        AND NULLIF(BTRIM(COALESCE(jp.markdown, '')), '') IS NOT NULL
    )
  ORDER BY j.id, j.last_seen_at DESC
  LIMIT ${limit}
) page_job;`;
}

export function buildUpsertJobPageSql(job: PageIngestJobRow, result: PageIngestResult): string {
  const source = result.source ?? "jina_reader";
  const titleRaw = result.markdown ? extractTitle(result.markdown) : null;

  return `WITH upserted_page AS (
  INSERT INTO job_search.job_pages (
    job_id,
    source,
    status,
    source_url,
    title_raw,
    markdown,
    usage_tokens,
    decompressed_bytes,
    error
  )
  VALUES (
    ${quoteSqlLiteral(job.id)},
    ${quoteSqlLiteral(source)},
    ${quoteSqlLiteral(result.status)},
    ${quoteSqlLiteral(job.canonical_url)},
    ${nullableText(titleRaw)},
    ${nullableText(result.markdown)},
    ${nullableNumber(result.usageTokens)},
    ${nullableNumber(result.decompressedBytes)},
    ${nullableText(result.error)}
  )
  ON CONFLICT (job_id, source)
  DO UPDATE SET
    status = EXCLUDED.status,
    fetched_at = now(),
    source_url = EXCLUDED.source_url,
    title_raw = EXCLUDED.title_raw,
    markdown = EXCLUDED.markdown,
    usage_tokens = EXCLUDED.usage_tokens,
    decompressed_bytes = EXCLUDED.decompressed_bytes,
    error = EXCLUDED.error
  WHERE job_search.job_pages.status <> 'success'
     OR EXCLUDED.status = 'success'
  RETURNING job_id
),
deleted_page_labels AS (
  DELETE FROM job_search.job_classification_labels
  WHERE job_id IN (SELECT job_id FROM upserted_page)
    AND source_stage = 'page'
)
UPDATE job_search.jobs
SET page_ingest_status = ${quoteSqlLiteral(result.status)},
    page_ingested_at = now(),
    category = CASE WHEN category = 'unclassified' THEN category ELSE 'unclassified' END,
    rag_focus = CASE WHEN category = 'unclassified' THEN rag_focus ELSE 'unknown' END,
    enterprise_focus = CASE WHEN category = 'unclassified' THEN enterprise_focus ELSE 'unknown' END,
    classification_confidence = CASE WHEN category = 'unclassified' THEN classification_confidence ELSE NULL END,
    classification_reason = CASE WHEN category = 'unclassified' THEN classification_reason ELSE NULL END,
    classified_at = CASE WHEN category = 'unclassified' THEN classified_at ELSE NULL END
WHERE id IN (SELECT job_id FROM upserted_page)
RETURNING id;`;
}

export function buildInsertPageIngestAttemptSql(jobId: string, attempt: PageIngestAttempt): string {
  return `INSERT INTO job_search.job_page_ingest_attempts (
  job_id,
  source,
  status,
  duration_ms,
  usage_tokens,
  metadata,
  error
)
VALUES (
  ${quoteSqlLiteral(jobId)},
  ${quoteSqlLiteral(attempt.source)},
  ${quoteSqlLiteral(attempt.status)},
  ${nullableNumber(attempt.durationMs)},
  ${nullableNumber(attempt.usageTokens)},
  ${jsonbLiteral(attempt.metadata)},
  ${nullableText(attempt.error)}
);`;
}

function nullableText(value: string | null): string {
  return value === null ? "NULL" : quoteSqlLiteral(value);
}

function nullableNumber(value: number | null): string {
  return value === null ? "NULL" : String(value);
}
