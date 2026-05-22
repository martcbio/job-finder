import { quoteSqlLiteral } from "../db/config";
import { type JobScreeningStatus, screenJob } from "./jobScreening";
import { JOB_SOURCE_SITES, type JobSourceSite } from "./sourceSites";

export type SourceCoverageOutcome = "confirmed" | "partial" | "blocked" | "untested";

export interface SourceCoverageJobSample {
  id: string;
  title: string;
  company_hint: string | null;
  url: string;
  category: string;
  markdown?: string | null;
  labels?: { label: string }[];
  screening_status?: JobScreeningStatus;
  screening_reasons?: string[];
  screening_summary?: string;
}

export interface SourceCoverageRow {
  source_id: string;
  source_label: string;
  query_count: number;
  query_statuses: string[];
  result_count: number;
  job_count: number;
  full_text_job_count: number;
  usable_full_text_job_count?: number;
  high_signal_job_count?: number;
  review_job_count?: number;
  rejected_job_count?: number;
  page_attempted_job_count: number;
  classified_job_count: number;
  search_reported_tokens: number;
  page_reported_tokens: number;
  labels: string[];
  search_errors: string[];
  page_errors: string[];
  sample_jobs: SourceCoverageJobSample[];
}

export interface RenderSourceCoverageOptions {
  generatedAt: Date;
  runId: number;
  keyword: string;
  timeFilter: string;
  includeRemote: boolean;
  location: string | null;
}

export interface SourceCoverageRunContext {
  runId: number;
  keyword: string;
  timeFilter: string;
  includeRemote: boolean;
  location: string | null;
}

export function buildSourceCoverageSql(
  runId: number,
  sources: readonly JobSourceSite[] = JOB_SOURCE_SITES,
): string {
  if (sources.length === 0) {
    throw new Error("Source coverage report requires at least one source");
  }

  return `WITH source_catalog(source_id, source_label) AS (
  VALUES
${sources
  .map((source) => `    (${quoteSqlLiteral(source.id)}, ${quoteSqlLiteral(source.label)})`)
  .join(",\n")}
),
current_run AS (
  SELECT started_at
  FROM job_search.search_runs
  WHERE id = ${runId}
),
coverage AS (
  SELECT
    sc.source_id,
    sc.source_label,
    COUNT(DISTINCT sq.id)::int AS query_count,
    COALESCE(
      json_agg(DISTINCT sq.status) FILTER (WHERE sq.id IS NOT NULL),
      '[]'::json
    ) AS query_statuses,
    COUNT(DISTINCT sr.id)::int AS result_count,
    COUNT(DISTINCT jo.job_id)::int AS job_count,
    COUNT(DISTINCT jo.job_id) FILTER (
      WHERE EXISTS (
        SELECT 1
        FROM job_search.job_pages jp
        WHERE jp.job_id = jo.job_id
          AND jp.status = 'success'
          AND jp.fetched_at >= cr.started_at
          AND NULLIF(BTRIM(COALESCE(jp.markdown, '')), '') IS NOT NULL
      )
    )::int AS full_text_job_count,
    COUNT(DISTINCT jo.job_id) FILTER (
      WHERE EXISTS (
        SELECT 1
        FROM job_search.job_page_ingest_attempts jpia
        WHERE jpia.job_id = jo.job_id
          AND jpia.attempted_at >= cr.started_at
      )
    )::int AS page_attempted_job_count,
    COUNT(DISTINCT jo.job_id) FILTER (
      WHERE (j.category <> 'unclassified' AND j.classified_at >= cr.started_at)
         OR EXISTS (
           SELECT 1
           FROM job_search.job_classification_labels jcl_exists
           WHERE jcl_exists.job_id = jo.job_id
             AND jcl_exists.classified_at >= cr.started_at
         )
    )::int AS classified_job_count,
    COALESCE(SUM(DISTINCT sq.usage_tokens), 0)::bigint AS search_reported_tokens,
    COALESCE((
      SELECT SUM(page_tokens)::bigint
      FROM (
        SELECT DISTINCT jp_tokens.job_id, jp_tokens.source, jp_tokens.usage_tokens AS page_tokens
        FROM job_search.job_pages jp_tokens
        WHERE jp_tokens.job_id IN (
          SELECT DISTINCT jo_tokens.job_id
          FROM job_search.search_results sr_tokens
          JOIN job_search.job_observations jo_tokens
            ON jo_tokens.search_result_id = sr_tokens.id
          JOIN job_search.search_queries sq_tokens
            ON sq_tokens.id = sr_tokens.query_id
          WHERE sq_tokens.run_id = ${runId}
            AND sq_tokens.source_id = sc.source_id
        )
          AND jp_tokens.fetched_at >= cr.started_at
          AND jp_tokens.usage_tokens IS NOT NULL
      ) page_token_rows
    ), 0)::bigint AS page_reported_tokens,
    COALESCE(
      json_agg(DISTINCT jcl.label) FILTER (WHERE jcl.label IS NOT NULL),
      '[]'::json
    ) AS labels,
    COALESCE(
      json_agg(DISTINCT CONCAT(sq.status, ': ', sq.error)) FILTER (WHERE sq.error IS NOT NULL),
      '[]'::json
    ) AS search_errors,
    COALESCE(
      json_agg(DISTINCT CONCAT(jpia.source, '/', jpia.status, ': ', jpia.error))
        FILTER (WHERE jpia.status IN ('error', 'timeout') AND jpia.error IS NOT NULL),
      '[]'::json
    ) AS page_errors,
    COALESCE(
      jsonb_agg(DISTINCT jsonb_build_object(
        'id', j.id::text,
        'title', j.title_normalized,
        'company_hint', j.company_hint,
        'url', j.canonical_url,
        'category', j.category,
        'markdown', (
          SELECT jp_sample.markdown
          FROM job_search.job_pages jp_sample
          WHERE jp_sample.job_id = j.id
            AND jp_sample.status = 'success'
            AND jp_sample.fetched_at >= cr.started_at
            AND NULLIF(BTRIM(COALESCE(jp_sample.markdown, '')), '') IS NOT NULL
          ORDER BY jp_sample.fetched_at DESC, LENGTH(jp_sample.markdown) DESC
          LIMIT 1
        ),
        'labels', COALESCE(
          (
            SELECT jsonb_agg(DISTINCT jsonb_build_object('label', jcl_sample.label))
            FROM job_search.job_classification_labels jcl_sample
            WHERE jcl_sample.job_id = j.id
              AND jcl_sample.classified_at >= cr.started_at
          ),
          '[]'::jsonb
        )
      )) FILTER (WHERE j.id IS NOT NULL),
      '[]'::jsonb
    ) AS sample_jobs
  FROM source_catalog sc
  CROSS JOIN current_run cr
  LEFT JOIN job_search.search_queries sq
    ON sq.run_id = ${runId}
   AND sq.source_id = sc.source_id
  LEFT JOIN job_search.search_results sr ON sr.query_id = sq.id
  LEFT JOIN job_search.job_observations jo ON jo.search_result_id = sr.id
  LEFT JOIN job_search.jobs j ON j.id = jo.job_id
  LEFT JOIN job_search.job_classification_labels jcl
    ON jcl.job_id = j.id
   AND jcl.classified_at >= cr.started_at
  LEFT JOIN job_search.job_page_ingest_attempts jpia
    ON jpia.job_id = j.id
   AND jpia.attempted_at >= cr.started_at
  GROUP BY sc.source_id, sc.source_label, cr.started_at
)
SELECT COALESCE(json_agg(row_to_json(coverage_row)), '[]'::json)
FROM (
  SELECT *
  FROM coverage
  ORDER BY source_label
) coverage_row;`;
}

export function applySourceCoverageScreening(rows: SourceCoverageRow[]): SourceCoverageRow[] {
  return rows.map((row) => {
    let highSignal = 0;
    let needsReview = 0;
    let rejected = 0;

    const sampleJobs = row.sample_jobs.map((sample) => {
      const decision = screenJob({
        title: sample.title,
        companyHint: sample.company_hint,
        canonicalUrl: sample.url,
        markdown: sample.markdown ?? null,
        labels: sample.labels ?? [],
      });

      if (decision.status === "high_signal") highSignal++;
      if (decision.status === "needs_human_review") needsReview++;
      if (decision.status === "rejected") rejected++;

      return {
        ...sample,
        screening_status: decision.status,
        screening_reasons: decision.reasons.map((reason) => reason.code),
        screening_summary: decision.summary,
      };
    });

    return {
      ...row,
      sample_jobs: sampleJobs,
      usable_full_text_job_count: highSignal + needsReview,
      high_signal_job_count: highSignal,
      review_job_count: needsReview,
      rejected_job_count: rejected,
    };
  });
}

export function sourceCoverageOutcome(row: SourceCoverageRow): SourceCoverageOutcome {
  if (row.query_count === 0) return "untested";

  if (row.query_statuses.includes("direct")) {
    return "partial";
  }

  if (
    row.result_count > 0 &&
    usableFullTextCount(row) > 0 &&
    row.classified_job_count > 0 &&
    row.search_errors.length === 0
  ) {
    return "confirmed";
  }

  if (row.search_errors.length > 0 || row.page_errors.length > 0) {
    return "blocked";
  }

  return "partial";
}

export function sourceCoverageReasons(row: SourceCoverageRow): string[] {
  const reasons: string[] = [];
  const outcome = sourceCoverageOutcome(row);

  if (outcome === "untested") {
    reasons.push("no search query/direct URL was run for this source");
    return reasons;
  }

  if (row.query_statuses.includes("direct")) {
    reasons.push("direct URL stored an entry-point page, not discovered individual job postings");
  }
  if (row.result_count === 0) reasons.push("searched but returned no persisted results");
  if (row.job_count === 0 && row.result_count > 0) {
    reasons.push("results did not link to persisted jobs");
  }
  if (row.job_count > 0 && row.full_text_job_count === 0) {
    reasons.push("no jobs from this source have successful full-text snapshots");
  } else if (row.full_text_job_count < row.job_count) {
    reasons.push("only some jobs from this source have successful full-text snapshots");
  }
  if (row.full_text_job_count > 0 && row.classified_job_count === 0) {
    reasons.push("full-text jobs were not classified");
  } else if (row.classified_job_count < row.job_count && row.job_count > 0) {
    reasons.push("only some jobs from this source are classified");
  }
  if (row.full_text_job_count > 0 && usableFullTextCount(row) === 0) {
    reasons.push("full-text snapshots were screened out as unusable, stale, or ineligible");
  }
  if (row.rejected_job_count && row.rejected_job_count > 0) {
    reasons.push(`${row.rejected_job_count} screened rejected/low-quality job(s)`);
  }

  reasons.push(...row.search_errors);
  reasons.push(...row.page_errors);

  if (reasons.length === 0) reasons.push("search, full text, and classification evidence present");
  return reasons;
}

export function buildSourceCoverageRunContextSql(runId: number): string {
  return `SELECT json_build_object(
  'runId', id,
  'keyword', keyword,
  'timeFilter', time_filter,
  'includeRemote', include_remote,
  'location', location
)
FROM job_search.search_runs
WHERE id = ${runId};`;
}

export function renderSourceCoverageMarkdown(
  rows: SourceCoverageRow[],
  options: RenderSourceCoverageOptions,
): string {
  const byOutcome = groupByOutcome(rows);
  const lines = [
    "# Source Coverage",
    "",
    `Generated: ${options.generatedAt.toISOString()}`,
    `Search run: ${options.runId}`,
    `Keyword: ${options.keyword}`,
    `Time filter: ${options.timeFilter}`,
    `Remote filter: ${options.includeRemote ? "included" : "excluded"}`,
    `Location: ${options.location ?? "none"}`,
    "",
    "## Summary",
    "",
    `- Confirmed: ${byOutcome.confirmed.length}`,
    `- Partial: ${byOutcome.partial.length}`,
    `- Blocked: ${byOutcome.blocked.length}`,
    `- Untested: ${byOutcome.untested.length}`,
    `- Search reported tokens: ${sumRows(rows, "search_reported_tokens")}`,
    `- Page reported tokens: ${sumRows(rows, "page_reported_tokens")}`,
    `- Usable full-text jobs: ${rows.reduce((sum, row) => sum + usableFullTextCount(row), 0)}`,
    `- High-signal jobs: ${rows.reduce((sum, row) => sum + (row.high_signal_job_count ?? 0), 0)}`,
    `- Needs-review jobs: ${rows.reduce((sum, row) => sum + (row.review_job_count ?? 0), 0)}`,
    `- Screened rejected jobs: ${rows.reduce((sum, row) => sum + (row.rejected_job_count ?? 0), 0)}`,
    "",
  ];

  for (const outcome of ["confirmed", "partial", "blocked", "untested"] as const) {
    lines.push(`## ${titleCase(outcome)}`);
    lines.push("");
    const sectionRows = byOutcome[outcome];
    if (sectionRows.length === 0) {
      lines.push("_None._");
      lines.push("");
      continue;
    }

    lines.push(
      "| Source | Queries | Statuses | Results | Jobs | Usable/Raw Full Text | Classified | Search Tokens | Page Tokens | Labels | Reasons | Samples |",
    );
    lines.push("|---|---:|---|---:|---:|---:|---:|---:|---:|---|---|---|");
    for (const row of sectionRows) {
      lines.push(
        [
          escapeTableCell(row.source_label),
          row.query_count,
          escapeTableCell(row.query_statuses.join(", ") || "none"),
          row.result_count,
          row.job_count,
          `${usableFullTextCount(row)}/${row.full_text_job_count}`,
          row.classified_job_count,
          row.search_reported_tokens,
          row.page_reported_tokens,
          escapeTableCell(row.labels.join(", ") || "none"),
          escapeTableCell(sourceCoverageReasons(row).join("; ")),
          escapeTableCell(formatSamples(row.sample_jobs)),
        ].join(" | "),
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function sumRows(
  rows: SourceCoverageRow[],
  field: "search_reported_tokens" | "page_reported_tokens",
): number {
  return rows.reduce((sum, row) => sum + Number(row[field]), 0);
}

function usableFullTextCount(row: SourceCoverageRow): number {
  return row.usable_full_text_job_count ?? row.full_text_job_count;
}

function groupByOutcome(
  rows: SourceCoverageRow[],
): Record<SourceCoverageOutcome, SourceCoverageRow[]> {
  return {
    confirmed: rows.filter((row) => sourceCoverageOutcome(row) === "confirmed"),
    partial: rows.filter((row) => sourceCoverageOutcome(row) === "partial"),
    blocked: rows.filter((row) => sourceCoverageOutcome(row) === "blocked"),
    untested: rows.filter((row) => sourceCoverageOutcome(row) === "untested"),
  };
}

function formatSamples(samples: SourceCoverageJobSample[]): string {
  if (samples.length === 0) return "none";
  return samples
    .slice(0, 3)
    .map((sample) => {
      const screening = sample.screening_status
        ? `; ${sample.screening_status}${sample.screening_reasons?.length ? `: ${sample.screening_reasons.join(",")}` : ""}`
        : "";
      return `${sample.title} (${sample.category}${screening})`;
    })
    .join("; ");
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (match) => match.toUpperCase());
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
