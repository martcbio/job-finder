import { quoteSqlLiteral } from "../db/config";

export interface JobExportFilters {
  limit: number;
  reviewState: string | null;
  runId: number | null;
}

export interface JobExportRow {
  id: string;
  title: string;
  company_hint: string | null;
  canonical_url: string;
  review_state: string;
  category: string;
  rag_focus: string;
  enterprise_focus: string;
  classification_confidence: string | null;
  classification_reason: string | null;
  first_seen_at: string;
  last_seen_at: string;
  observations: number;
  source_labels: string[];
  source_ids: string[];
  description_sample: string | null;
}

export interface RenderJobsMarkdownOptions {
  generatedAt: Date;
  filters: JobExportFilters;
}

export function buildJobsExportSql(filters: JobExportFilters): string {
  const whereClauses: string[] = [];
  if (filters.reviewState !== null) {
    whereClauses.push(`j.review_state = ${quoteSqlLiteral(filters.reviewState)}`);
  }
  if (filters.runId !== null) {
    whereClauses.push(`sq.run_id = ${filters.runId}`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  return `SELECT COALESCE(json_agg(row_to_json(export_row)), '[]'::json)
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
    j.classification_reason,
    j.first_seen_at,
    j.last_seen_at,
    COUNT(DISTINCT jo.id)::int AS observations,
    COALESCE(array_remove(array_agg(DISTINCT sq.source_label), NULL), ARRAY[]::text[]) AS source_labels,
    COALESCE(array_remove(array_agg(DISTINCT sq.source_id), NULL), ARRAY[]::text[]) AS source_ids,
    MIN(sr.description_raw) FILTER (WHERE sr.description_raw <> '') AS description_sample
  FROM job_search.jobs j
  LEFT JOIN job_search.job_observations jo ON jo.job_id = j.id
  LEFT JOIN job_search.search_results sr ON sr.id = jo.search_result_id
  LEFT JOIN job_search.search_queries sq ON sq.id = sr.query_id
  ${whereSql}
  GROUP BY j.id
  ORDER BY j.last_seen_at DESC, j.id DESC
  LIMIT ${filters.limit}
) export_row;`;
}

export function renderJobsMarkdown(
  rows: JobExportRow[],
  options: RenderJobsMarkdownOptions,
): string {
  const lines = [
    "# Job Search Export",
    "",
    `Generated: ${options.generatedAt.toISOString()}`,
    `Filters: ${formatFilters(options.filters)}`,
    `Total jobs: ${rows.length}`,
    "",
    "## Jobs",
    "",
  ];

  if (rows.length === 0) {
    lines.push("_No jobs matched the export filters._");
    return `${lines.join("\n")}\n`;
  }

  rows.forEach((row, index) => {
    lines.push(`${index + 1}. [${escapeMarkdown(row.title)}](${row.canonical_url})`);
    lines.push(`   Company: ${row.company_hint ?? "Unknown"}`);
    lines.push(`   State: ${row.review_state}`);
    lines.push(
      `   Classification: ${row.category} / rag=${row.rag_focus} / enterprise=${row.enterprise_focus}`,
    );
    if (row.classification_confidence !== null) {
      lines.push(`   Confidence: ${row.classification_confidence}`);
    }
    lines.push(
      `   Sources: ${row.source_labels.length > 0 ? row.source_labels.join(", ") : "Unknown"}`,
    );
    lines.push(`   Seen: ${row.first_seen_at} to ${row.last_seen_at}`);
    lines.push(`   Observations: ${row.observations}`);
    if (row.description_sample) {
      lines.push(`   Snippet: ${truncateOneLine(row.description_sample, 240)}`);
    }
    lines.push("");
  });

  return `${lines.join("\n")}\n`;
}

function formatFilters(filters: JobExportFilters): string {
  const parts = [`limit=${filters.limit}`];
  if (filters.reviewState !== null) parts.push(`state=${filters.reviewState}`);
  if (filters.runId !== null) parts.push(`run_id=${filters.runId}`);
  return parts.join(", ");
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function truncateOneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}
