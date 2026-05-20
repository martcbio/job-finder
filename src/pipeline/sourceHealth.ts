export interface SourceHealthFilters {
  days: number | null;
  minAttempts: number;
}

export interface SourceHealthRow {
  source_id: string;
  source_label: string;
  attempts: number;
  successes: number;
  direct: number;
  timeouts: number;
  errors: number;
  success_rate: string;
  timeout_rate: string;
  avg_duration_ms: number | null;
  avg_reported_tokens: number | null;
  avg_results: number;
  total_results: number;
  total_reported_tokens: number;
  unknown_usage_calls: number;
  last_success_at: string | null;
  last_attempt_at: string;
}

export interface RenderSourceHealthOptions {
  generatedAt: Date;
  filters: SourceHealthFilters;
}

export function buildSourceHealthSql(filters: SourceHealthFilters): string {
  const whereClauses = ["sq.status <> 'running'"];
  if (filters.days !== null) {
    whereClauses.push(`sq.started_at >= now() - (${filters.days} * interval '1 day')`);
  }

  return `WITH per_query AS (
  SELECT
    sq.id,
    sq.source_id,
    sq.source_label,
    sq.status,
    sq.started_at,
    sq.finished_at,
    sq.usage_tokens,
    COUNT(sr.id)::int AS result_count
  FROM job_search.search_queries sq
  LEFT JOIN job_search.search_results sr ON sr.query_id = sq.id
  WHERE ${whereClauses.join(" AND ")}
  GROUP BY sq.id
),
health AS (
  SELECT
    source_id,
    source_label,
    COUNT(*)::int AS attempts,
    COUNT(*) FILTER (WHERE status = 'success')::int AS successes,
    COUNT(*) FILTER (WHERE status = 'direct')::int AS direct,
    COUNT(*) FILTER (WHERE status = 'timeout')::int AS timeouts,
    COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
    ROUND(
      (COUNT(*) FILTER (WHERE status IN ('success', 'direct'))::numeric / NULLIF(COUNT(*), 0)),
      4
    )::text AS success_rate,
    ROUND(
      (COUNT(*) FILTER (WHERE status = 'timeout')::numeric / NULLIF(COUNT(*), 0)),
      4
    )::text AS timeout_rate,
    ROUND(AVG(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000))::int AS avg_duration_ms,
    ROUND(AVG(usage_tokens) FILTER (WHERE usage_tokens IS NOT NULL))::int AS avg_reported_tokens,
    ROUND(AVG(result_count), 2)::float AS avg_results,
    SUM(result_count)::int AS total_results,
    COALESCE(SUM(usage_tokens), 0)::bigint AS total_reported_tokens,
    COUNT(*) FILTER (WHERE status IN ('success', 'timeout', 'error') AND usage_tokens IS NULL)::int
      AS unknown_usage_calls,
    MAX(finished_at) FILTER (WHERE status IN ('success', 'direct')) AS last_success_at,
    MAX(started_at) AS last_attempt_at
  FROM per_query
  GROUP BY source_id, source_label
)
SELECT COALESCE(json_agg(row_to_json(health_row)), '[]'::json)
FROM (
  SELECT *
  FROM health
  WHERE attempts >= ${filters.minAttempts}
  ORDER BY total_results DESC, successes DESC, attempts DESC, source_label
) health_row;`;
}

export function renderSourceHealthMarkdown(
  rows: SourceHealthRow[],
  options: RenderSourceHealthOptions,
): string {
  const lines = [
    "# Source Health",
    "",
    `Generated: ${options.generatedAt.toISOString()}`,
    `Filters: ${formatFilters(options.filters)}`,
    `Sources: ${rows.length}`,
    "",
  ];

  if (rows.length === 0) {
    lines.push("_No source health rows matched the filters._");
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    "| Source | Attempts | Success | Timeouts | Errors | Avg tokens | Avg results | Total results | Unknown usage | Last success |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");

  for (const row of rows) {
    lines.push(
      [
        escapeTableCell(row.source_label),
        row.attempts,
        `${percentage(row.success_rate)}%`,
        `${row.timeouts} (${percentage(row.timeout_rate)}%)`,
        row.errors,
        row.avg_reported_tokens ?? "unknown",
        row.avg_results.toFixed(2),
        row.total_results,
        row.unknown_usage_calls,
        row.last_success_at ?? "never",
      ].join(" | "),
    );
  }

  return `${lines.join("\n")}\n`;
}

function formatFilters(filters: SourceHealthFilters): string {
  const parts = [`min_attempts=${filters.minAttempts}`];
  if (filters.days !== null) parts.push(`days=${filters.days}`);
  return parts.join(", ");
}

function percentage(value: string): string {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? (parsed * 100).toFixed(1) : "0.0";
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|");
}
