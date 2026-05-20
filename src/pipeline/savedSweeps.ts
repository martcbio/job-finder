import { quoteSqlLiteral } from "../db/config";
import type { PipelinePlanOptions, PipelineStepName } from "./pipelinePlan";

export interface SavedSweepInput {
  name: string;
  keywords: string[];
  sites: string[];
  timeFilter: string;
  includeRemote: boolean;
  location: string | null;
  maxQueries: number;
  searchLimit: number;
  searchTimeoutMs: number;
  pageLimit: number;
  pageTimeoutMs: number;
  classifyLimit: number;
  duplicateLimit: number;
  duplicateThreshold: number;
  queueLimit: number;
  enabled: boolean;
}

export interface SavedSweepRow {
  id: string;
  name: string;
  keywords: string[];
  sites: string[];
  time_filter: string;
  include_remote: boolean;
  location: string | null;
  max_queries: number;
  search_limit: number;
  search_timeout_ms: number;
  page_limit: number;
  page_timeout_ms: number;
  classify_limit: number;
  duplicate_limit: number;
  duplicate_threshold: number;
  queue_limit: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export function buildUpsertSavedSweepSql(input: SavedSweepInput): string {
  return `INSERT INTO job_search.saved_sweeps (
  name,
  keywords,
  sites,
  time_filter,
  include_remote,
  location,
  max_queries,
  search_limit,
  search_timeout_ms,
  page_limit,
  page_timeout_ms,
  classify_limit,
  duplicate_limit,
  duplicate_threshold,
  queue_limit,
  enabled
)
VALUES (
  ${quoteSqlLiteral(input.name)},
  ${textArrayLiteral(input.keywords)},
  ${textArrayLiteral(input.sites)},
  ${quoteSqlLiteral(input.timeFilter)},
  ${input.includeRemote ? "true" : "false"},
  ${nullableText(input.location)},
  ${input.maxQueries},
  ${input.searchLimit},
  ${input.searchTimeoutMs},
  ${input.pageLimit},
  ${input.pageTimeoutMs},
  ${input.classifyLimit},
  ${input.duplicateLimit},
  ${input.duplicateThreshold},
  ${input.queueLimit},
  ${input.enabled ? "true" : "false"}
)
ON CONFLICT (name) DO UPDATE SET
  keywords = EXCLUDED.keywords,
  sites = EXCLUDED.sites,
  time_filter = EXCLUDED.time_filter,
  include_remote = EXCLUDED.include_remote,
  location = EXCLUDED.location,
  max_queries = EXCLUDED.max_queries,
  search_limit = EXCLUDED.search_limit,
  search_timeout_ms = EXCLUDED.search_timeout_ms,
  page_limit = EXCLUDED.page_limit,
  page_timeout_ms = EXCLUDED.page_timeout_ms,
  classify_limit = EXCLUDED.classify_limit,
  duplicate_limit = EXCLUDED.duplicate_limit,
  duplicate_threshold = EXCLUDED.duplicate_threshold,
  queue_limit = EXCLUDED.queue_limit,
  enabled = EXCLUDED.enabled,
  updated_at = now()
RETURNING json_build_object(
  'id', id::text,
  'name', name,
  'keywords', keywords,
  'sites', sites,
  'time_filter', time_filter,
  'include_remote', include_remote,
  'location', location,
  'max_queries', max_queries,
  'search_limit', search_limit,
  'search_timeout_ms', search_timeout_ms,
  'page_limit', page_limit,
  'page_timeout_ms', page_timeout_ms,
  'classify_limit', classify_limit,
  'duplicate_limit', duplicate_limit,
  'duplicate_threshold', duplicate_threshold,
  'queue_limit', queue_limit,
  'enabled', enabled,
  'created_at', created_at,
  'updated_at', updated_at
);`;
}

export function buildGetSavedSweepSql(name: string): string {
  return `SELECT COALESCE(
  (
    SELECT row_to_json(saved_sweep_row)
    FROM (
      SELECT
        id::text AS id,
        name,
        keywords,
        sites,
        time_filter,
        include_remote,
        location,
        max_queries,
        search_limit,
        search_timeout_ms,
        page_limit,
        page_timeout_ms,
        classify_limit,
        duplicate_limit,
        duplicate_threshold,
        queue_limit,
        enabled,
        created_at,
        updated_at
      FROM job_search.saved_sweeps
      WHERE name = ${quoteSqlLiteral(name)}
    ) saved_sweep_row
  ),
  'null'::json
);`;
}

export function buildListSavedSweepsSql(enabledOnly: boolean): string {
  const where = enabledOnly ? "WHERE enabled = true" : "";

  return `SELECT COALESCE(json_agg(row_to_json(saved_sweep_row)), '[]'::json)
FROM (
  SELECT
    id::text AS id,
    name,
    keywords,
    sites,
    time_filter,
    include_remote,
    location,
    max_queries,
    search_limit,
    search_timeout_ms,
    page_limit,
    page_timeout_ms,
    classify_limit,
    duplicate_limit,
    duplicate_threshold,
    queue_limit,
    enabled,
    created_at,
    updated_at
  FROM job_search.saved_sweeps
  ${where}
  ORDER BY enabled DESC, name ASC
) saved_sweep_row;`;
}

export function savedSweepToPipelineOptions(
  row: SavedSweepRow,
  skipSteps: PipelineStepName[],
): PipelinePlanOptions {
  return {
    keywords: row.keywords,
    sites: row.sites,
    timeFilter: row.time_filter,
    includeRemote: row.include_remote,
    location: row.location,
    maxQueries: row.max_queries,
    searchLimit: row.search_limit,
    searchTimeoutMs: row.search_timeout_ms,
    pageLimit: row.page_limit,
    pageTimeoutMs: row.page_timeout_ms,
    classifyLimit: row.classify_limit,
    duplicateLimit: row.duplicate_limit,
    duplicateThreshold: Number(row.duplicate_threshold),
    queueLimit: row.queue_limit,
    skipSteps,
  };
}

export function renderSavedSweepsMarkdown(rows: SavedSweepRow[]): string {
  const lines = ["# Saved Sweeps", ""];

  if (rows.length === 0) {
    lines.push("_No saved sweeps found._");
    return `${lines.join("\n")}\n`;
  }

  for (const row of rows) {
    lines.push(`## ${row.name}`);
    lines.push("");
    lines.push(`- Enabled: ${row.enabled ? "yes" : "no"}`);
    lines.push(`- Keywords: ${row.keywords.join(", ")}`);
    lines.push(`- Sites: ${row.sites.join(", ")}`);
    lines.push(`- Time filter: ${row.time_filter}`);
    lines.push(`- Remote: ${row.include_remote ? "yes" : "no"}`);
    if (row.location) lines.push(`- Location: ${row.location}`);
    lines.push(`- Search: max ${row.max_queries} queries, ${row.search_limit} results/query`);
    lines.push(`- Page ingest limit: ${row.page_limit}`);
    lines.push(`- Classification limit: ${row.classify_limit}`);
    lines.push(`- Duplicate scan: ${row.duplicate_limit} jobs at ${row.duplicate_threshold}`);
    lines.push(`- Queue limit: ${row.queue_limit}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function nullableText(value: string | null): string {
  return value === null ? "NULL" : quoteSqlLiteral(value);
}

function textArrayLiteral(values: string[]): string {
  if (values.length === 0) return "ARRAY[]::text[]";
  return `ARRAY[${values.map((value) => quoteSqlLiteral(value)).join(", ")}]::text[]`;
}
