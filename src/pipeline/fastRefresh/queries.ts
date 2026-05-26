import { quoteSqlLiteral } from "../../db/config";
import { positiveSqlLimit } from "./utils";

export function buildLatestJobRowsSql(input: {
  limit: number;
  jobIds?: readonly number[];
  runIds?: readonly number[];
  sourceIds?: readonly string[];
}): string {
  const whereClauses: string[] = [];
  if (input.jobIds && input.jobIds.length > 0) {
    whereClauses.push(`j.id IN (${[...new Set(input.jobIds)].join(", ")})`);
  }
  if (input.runIds && input.runIds.length > 0) {
    whereClauses.push(`latest_observation.run_id IN (${[...new Set(input.runIds)].join(", ")})`);
  }
  if (input.sourceIds && input.sourceIds.length > 0) {
    whereClauses.push(
      `latest_observation.source_id = ANY(ARRAY[${input.sourceIds
        .map(quoteSqlLiteral)
        .join(", ")}]::text[])`,
    );
  }
  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  return `SELECT COALESCE(json_agg(row_to_json(job_row)), '[]'::json)
FROM (
  SELECT
    j.id,
    j.title_normalized AS title,
    j.company_hint AS company,
    j.canonical_url,
    j.review_state,
    j.category,
    j.rag_focus,
    j.enterprise_focus,
    j.classification_confidence,
    j.classification_reason,
    j.page_ingest_status,
    j.first_seen_at::text,
    j.last_seen_at::text,
    latest_observation.source_id,
    latest_observation.source_label,
    latest_observation.observed_url,
    latest_observation.description_raw AS description_sample,
    latest_page.markdown,
    latest_page.status AS page_status,
    latest_page.error AS page_error,
    latest_page.usage_tokens AS page_usage_tokens,
    latest_page.decompressed_bytes AS page_decompressed_bytes,
    COALESCE(labels.labels, '[]'::json) AS labels,
    COALESCE(duplicates.duplicate_candidates, '[]'::json) AS duplicate_candidates,
    COALESCE(events.review_events, '[]'::json) AS review_events
  FROM job_search.jobs j
  LEFT JOIN LATERAL (
    SELECT
      sq.run_id,
      sq.source_id,
      sq.source_label,
      jo.observed_url,
      sr.description_raw
    FROM job_search.job_observations jo
    JOIN job_search.search_results sr ON sr.id = jo.search_result_id
    JOIN job_search.search_queries sq ON sq.id = sr.query_id
    WHERE jo.job_id = j.id
    ORDER BY jo.observed_at DESC, jo.id DESC
    LIMIT 1
  ) latest_observation ON true
  LEFT JOIN LATERAL (
    SELECT
      jp.markdown,
      jp.status,
      jp.error,
      jp.usage_tokens,
      jp.decompressed_bytes
    FROM job_search.job_pages jp
    WHERE jp.job_id = j.id
    ORDER BY
      CASE WHEN jp.status = 'success' THEN 0 ELSE 1 END,
      jp.fetched_at DESC,
      jp.id DESC
    LIMIT 1
  ) latest_page ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(row_to_json(label_row) ORDER BY label_row.confidence DESC) AS labels
    FROM (
      SELECT label, source_stage, confidence, reason
      FROM job_search.job_classification_labels
      WHERE job_id = j.id
    ) label_row
  ) labels ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(row_to_json(duplicate_row) ORDER BY duplicate_row.confidence DESC) AS duplicate_candidates
    FROM (
      SELECT id::text, state, confidence, reason
      FROM job_search.duplicate_candidates
      WHERE job_id_a = j.id OR job_id_b = j.id
      LIMIT 20
    ) duplicate_row
  ) duplicates ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(row_to_json(event_row) ORDER BY event_row.created_at DESC, event_row.id DESC) AS review_events
    FROM (
      SELECT id::text, from_state, to_state, reason_codes, note, actor, created_at
      FROM job_search.review_events
      WHERE job_id = j.id
      LIMIT 20
    ) event_row
  ) events ON true
  ${whereSql}
  ORDER BY j.last_seen_at DESC, j.id DESC
  LIMIT ${positiveSqlLimit(input.limit)}
) job_row;`;
}

export function buildFastRefreshRunSql(runId: string): string {
  return buildFastRefreshRunSqlWhere(`sr.id = ${quoteSqlLiteral(runId)}`);
}

export function buildLatestFastRefreshRunSql(): string {
  return buildFastRefreshRunSqlWhere(
    `sr.id = (
          SELECT latest_sr.id
          FROM job_search.search_runs latest_sr
          ORDER BY latest_sr.started_at DESC, latest_sr.id DESC
          LIMIT 1
        )`,
  );
}

function buildFastRefreshRunSqlWhere(whereSql: string): string {
  return `SELECT COALESCE(
  (
    SELECT row_to_json(run_row)
    FROM (
      SELECT
        sr.id::text AS id,
        sr.started_at::text AS "startedAt",
        sr.finished_at::text AS "finishedAt",
        sr.status,
        sr.keyword,
        sr.source_set AS "sourceSet",
        sr.time_filter AS "timeFilter",
        sr.limit_per_query AS "limitPerQuery",
        sr.timeout_ms AS "timeoutMs",
        sr.total_reported_tokens::bigint AS "totalReportedTokens",
        sr.error_summary AS "errorSummary",
        CASE
          WHEN sr.finished_at IS NULL THEN NULL
          ELSE (EXTRACT(EPOCH FROM (sr.finished_at - sr.started_at)) * 1000)::int
        END AS "elapsedMs",
        json_build_object(
          'jinaSearchTokens', 0,
          'jinaReaderTokens', sr.total_reported_tokens,
          'openAiTokens', 0,
          'billableSearchApiCalls', 0
        ) AS costs,
        COALESCE(
          (
            SELECT json_agg(row_to_json(source_row) ORDER BY source_row."startedAt", source_row.id)
            FROM (
              SELECT
	                sq.source_id AS id,
	                sq.source_label AS label,
	                sourceOutcomeFromQueryStatus(sq.status, sq.error) AS outcome,
	                sourceAttemptStatusFromQueryStatus(sq.status, sq.error) AS status,
	                sq.status AS "queryStatus",
	                sq.query,
                sq.direct_url AS "directUrl",
                sq.started_at::text AS "startedAt",
                sq.finished_at::text AS "finishedAt",
                sq.usage_tokens::bigint AS "usageTokens",
                sq.decompressed_bytes::bigint AS "decompressedBytes",
                sq.error,
                COUNT(DISTINCT res.id)::int AS "candidateCount",
                COUNT(DISTINCT jo.job_id)::int AS "jobCount",
                COUNT(DISTINCT jp.job_id) FILTER (WHERE jp.status = 'success')::int AS "fullTextCount",
                COUNT(DISTINCT jcl.job_id)::int AS "classificationCount"
              FROM job_search.search_queries sq
              LEFT JOIN job_search.search_results res ON res.query_id = sq.id
              LEFT JOIN job_search.job_observations jo ON jo.search_result_id = res.id
              LEFT JOIN job_search.job_pages jp ON jp.job_id = jo.job_id
              LEFT JOIN job_search.job_classification_labels jcl ON jcl.job_id = jo.job_id
              WHERE sq.run_id = sr.id
              GROUP BY sq.id
            ) source_row
          ),
          '[]'::json
        ) AS sources
      FROM job_search.search_runs sr
	      WHERE ${whereSql}
	    ) run_row
	  ),
	  'null'::json
	);`
    .replace(
      "sourceOutcomeFromQueryStatus(sq.status, sq.error)",
      `CASE
      WHEN sq.status = 'success' THEN 'success'
      WHEN sq.status = 'direct' THEN 'success'
      WHEN sq.status = 'timeout' THEN 'timeout'
      WHEN sq.error ILIKE '%captcha%' THEN 'blocked_captcha'
      WHEN sq.error ILIKE '%auth%' OR sq.error ILIKE '%401%' OR sq.error ILIKE '%403%' THEN 'blocked_auth'
      WHEN sq.status = 'error' THEN 'http_error'
	      ELSE 'not_implemented'
	    END`,
    )
    .replace(
      "sourceAttemptStatusFromQueryStatus(sq.status, sq.error)",
      `CASE
      WHEN sq.status = 'success' OR sq.status = 'direct' THEN 'success'
      WHEN sq.status = 'timeout' THEN 'timeout'
      WHEN sq.error ILIKE '%rate%' OR sq.error ILIKE '%429%' THEN 'rate_limited'
      WHEN sq.error ILIKE '%auth%' OR sq.error ILIKE '%401%' OR sq.error ILIKE '%403%' THEN 'auth_required'
      WHEN sq.error ILIKE '%captcha%' THEN 'blocked'
      WHEN sq.error ILIKE '%parse%' THEN 'parser_error'
      WHEN sq.status = 'error' THEN 'partial'
      ELSE 'partial'
    END`,
    );
}
