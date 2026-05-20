import { quoteSqlLiteral } from "../db/config";
import { extractTitle } from "./scrape";

export interface PageIngestJobRow {
  id: string;
  title: string;
  canonical_url: string;
}

export interface PageIngestResult {
  status: "success" | "error" | "timeout";
  markdown: string | null;
  usageTokens: number | null;
  decompressedBytes: number | null;
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

export function buildUpsertJobPageSql(job: PageIngestJobRow, result: PageIngestResult): string {
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
    'jina_reader',
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
  RETURNING job_id
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
WHERE id IN (SELECT job_id FROM upserted_page);`;
}

function nullableText(value: string | null): string {
  return value === null ? "NULL" : quoteSqlLiteral(value);
}

function nullableNumber(value: number | null): string {
  return value === null ? "NULL" : String(value);
}
