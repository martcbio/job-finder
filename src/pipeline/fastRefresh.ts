import { quoteSqlLiteral } from "../db/config";
import { planMigrations } from "../db/migrations";
import { runPsql, runPsqlJson } from "../db/psql";
import { fetchLinearCareersJobs } from "./directSources";
import {
  type ClassifiableJobRow,
  buildClassifiableJobsForSearchRunSql,
  buildUpdateJobClassificationSql,
  classifyJobText,
} from "./jobClassification";
import {
  type JobServeContractRow,
  type RankedJobServeContract,
  rankJobServeContract,
  rankJobServeContracts,
} from "./jobserveContracts";
import { fetchLiveJobServeRoles, jobServeRoleToNormalizedJob } from "./jobserveLive";
import { ingestNormalizedJobs } from "./normalizedJobIngest";
import { type JobScreeningDecision, screenJob } from "./jobScreening";

export type SourceKind =
  | "direct_employer"
  | "ats"
  | "recruiter"
  | "aggregator"
  | "search"
  | "protected";

export type SourceQuality = "high" | "medium" | "low" | "opportunistic";

export type SourceOutcome =
  | "success"
  | "zero_results"
  | "snippet_only"
  | "blocked_captcha"
  | "blocked_auth"
  | "blocked_robots_or_waf"
  | "redirect_only"
  | "expired"
  | "parse_error"
  | "timeout"
  | "http_error"
  | "api_key_missing"
  | "not_implemented";

export interface SourceAdapter {
  id: string;
  label: string;
  kind: SourceKind;
  quality: SourceQuality;
}

export interface FastRefreshOptions {
  limit: number;
  jobserveQueries: string[];
  jobserveMaxPages: number;
  jobserveImportLimitPerQuery: number;
  directLimit: number;
  timeoutMs: number;
  classifyLimit: number;
}

export interface FastRefreshSourceSummary {
  source: SourceAdapter;
  keyword: string;
  runId: number | null;
  outcome: SourceOutcome;
  discovered: number;
  imported: number;
  fullText: {
    persisted: number;
    fetchedPages: number | null;
    status: "success" | "pending" | "snippet_only" | "error";
  };
  costs: FastRefreshCosts;
  elapsedMs: number;
  errors: string[];
  blockedReason: string | null;
}

export interface FastRefreshClassificationSummary {
  runId: number;
  classified: number;
}

export interface FastRefreshCosts {
  jinaSearchTokens: number | null;
  jinaReaderTokens: number | null;
  openAiTokens: number | null;
  billableSearchApiCalls: number | null;
}

export interface JobSummary {
  id: number;
  title: string;
  company: string | null;
  location: string | null;
  source: SourceAdapter;
  links: JobSummaryLink[];
  classification: {
    category: string;
    labels: string[];
    ragFocus: string;
    enterpriseFocus: string;
    confidence: number | null;
    reason: string | null;
  };
  eligibility: {
    status: "likely_ok" | "needs_review" | "likely_reject";
    flags: string[];
    reasons: string[];
    summary: string;
  };
  ingest: {
    fullTextStatus: "success" | "snippet_only" | "blocked" | "expired" | "error" | "pending";
    firstSeenAt: string;
    lastSeenAt: string;
    postedAt: string | null;
  };
  ranking: {
    tier: number | null;
    score: number | null;
    reasons: string[];
    softened: string | null;
  };
  reviewState: string;
  dedupe: {
    candidateCount: number;
    groups: Array<{ id: string; state: string; confidence: number; reason: string }>;
  };
  cost: FastRefreshCosts;
}

export interface JobSummaryLink {
  kind: "canonical" | "source" | "apply" | "employer" | "tracking";
  url: string;
  blocked?: boolean;
  note?: string;
}

export interface FastRefreshResult {
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  options: FastRefreshOptions;
  sources: FastRefreshSourceSummary[];
  classified: FastRefreshClassificationSummary[];
  costs: FastRefreshCosts;
  latest: {
    jobs: JobSummary[];
    jobserve: JobSummary[];
    direct: JobSummary[];
  };
}

export interface FastRefreshRunDetail {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  keyword: string;
  sourceSet: unknown;
  timeFilter: string;
  limitPerQuery: number;
  timeoutMs: number;
  totalReportedTokens: number;
  errorSummary: string | null;
  elapsedMs: number | null;
  costs: FastRefreshCosts;
  sources: Array<{
    id: string;
    label: string;
    outcome: SourceOutcome;
    status: string;
    query: string | null;
    directUrl: string | null;
    startedAt: string;
    finishedAt: string | null;
    usageTokens: number | null;
    decompressedBytes: number | null;
    error: string | null;
    candidateCount: number;
    jobCount: number;
    fullTextCount: number;
  }>;
}

export interface FastRefreshJobRow {
  id: number;
  title: string;
  company: string | null;
  canonical_url: string;
  review_state: string;
  category: string;
  rag_focus: string;
  enterprise_focus: string;
  classification_confidence: string | number | null;
  classification_reason: string | null;
  page_ingest_status: string;
  first_seen_at: string;
  last_seen_at: string;
  source_id: string | null;
  source_label: string | null;
  observed_url: string | null;
  description_sample: string | null;
  markdown: string | null;
  page_status: string | null;
  page_error: string | null;
  page_usage_tokens: string | number | null;
  page_decompressed_bytes: string | number | null;
  labels: Array<{ label: string; source_stage?: string; confidence?: string | number; reason?: string }>;
  duplicate_candidates: Array<{ id: string; state: string; confidence: string | number; reason: string }>;
  review_events: unknown[];
}

const DEFAULT_JOBSERVE_QUERIES = [
  "agentic",
  "langchain",
  "forward deployed engineer",
  "inference engineer",
];

export const DEFAULT_FAST_REFRESH_OPTIONS: FastRefreshOptions = {
  limit: 20,
  jobserveQueries: DEFAULT_JOBSERVE_QUERIES,
  jobserveMaxPages: 3,
  jobserveImportLimitPerQuery: 8,
  directLimit: 6,
  timeoutMs: 20000,
  classifyLimit: 250,
};

const ZERO_COSTS: FastRefreshCosts = {
  jinaSearchTokens: 0,
  jinaReaderTokens: 0,
  openAiTokens: 0,
  billableSearchApiCalls: 0,
};

const JINA_READER_COST_UNKNOWN: FastRefreshCosts = {
  jinaSearchTokens: 0,
  jinaReaderTokens: null,
  openAiTokens: 0,
  billableSearchApiCalls: 0,
};

export async function runFastRefresh(
  input: Partial<FastRefreshOptions> = {},
): Promise<FastRefreshResult> {
  const options = normalizeFastRefreshOptions(input);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  await assertMigrationsReady();

  const sources = await Promise.all([
    ...options.jobserveQueries.map((query) => ingestJobServeQuery(query, options)),
    ingestLinearCareers(options),
  ]);

  const runIds = sources.flatMap((item) => (item.runId === null ? [] : [item.runId]));
  const classified: FastRefreshClassificationSummary[] = [];
  for (const runId of runIds) {
    classified.push(await classifyRun(runId, options.classifyLimit));
  }

  const jobserveRunIds = sources
    .filter((source) => source.source.id === "jobserve")
    .flatMap((source) => (source.runId === null ? [] : [source.runId]));
  const jobserveRows = await runPsqlJson<FastRefreshJobRow[]>(
    buildLatestJobRowsSql({
      limit: 1000,
      runIds: jobserveRunIds,
      sourceIds: ["jobserve"],
    }),
  );
  const rankedJobServe = rankJobServeContracts(jobserveRows.map(jobRowToJobServeContract), {
    limit: options.limit,
  });
  const directRows = await runPsqlJson<FastRefreshJobRow[]>(
    buildLatestJobRowsSql({
      limit: options.limit,
      runIds,
      sourceIds: ["linear-careers"],
    }),
  );
  const rankedIds = [...rankedJobServe.map((row) => row.id), ...directRows.map((row) => row.id)];
  const rows = mergeJobRows(jobserveRows, directRows);
  const rankedById = new Map(rankedJobServe.map((row) => [row.id, row]));
  const directIds = new Set(directRows.map((row) => row.id));
  const jobs = orderJobSummaries(rows, rankedIds, rankedById);
  const finishedAt = new Date().toISOString();

  return {
    startedAt,
    finishedAt,
    elapsedMs: Date.now() - started,
    options,
    sources,
    classified,
    costs: aggregateCosts(sources),
    latest: {
      jobs,
      jobserve: jobs.filter((job) => job.source.id === "jobserve"),
      direct: jobs.filter((job) => directIds.has(job.id)),
    },
  };
}

export function normalizeFastRefreshOptions(
  input: Partial<FastRefreshOptions> = {},
): FastRefreshOptions {
  return {
    ...DEFAULT_FAST_REFRESH_OPTIONS,
    ...input,
    jobserveQueries:
      input.jobserveQueries && input.jobserveQueries.length > 0
        ? input.jobserveQueries
        : DEFAULT_FAST_REFRESH_OPTIONS.jobserveQueries,
  };
}

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
                sq.status,
                sq.query,
                sq.direct_url AS "directUrl",
                sq.started_at::text AS "startedAt",
                sq.finished_at::text AS "finishedAt",
                sq.usage_tokens::bigint AS "usageTokens",
                sq.decompressed_bytes::bigint AS "decompressedBytes",
                sq.error,
                COUNT(DISTINCT res.id)::int AS "candidateCount",
                COUNT(DISTINCT jo.job_id)::int AS "jobCount",
                COUNT(DISTINCT jp.job_id) FILTER (WHERE jp.status = 'success')::int AS "fullTextCount"
              FROM job_search.search_queries sq
              LEFT JOIN job_search.search_results res ON res.query_id = sq.id
              LEFT JOIN job_search.job_observations jo ON jo.search_result_id = res.id
              LEFT JOIN job_search.job_pages jp ON jp.job_id = jo.job_id
              WHERE sq.run_id = sr.id
              GROUP BY sq.id
            ) source_row
          ),
          '[]'::json
        ) AS sources
      FROM job_search.search_runs sr
      WHERE sr.id = ${quoteSqlLiteral(runId)}
    ) run_row
  ),
  'null'::json
);`.replace(
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
  );
}

export function jobRowToSummary(
  row: FastRefreshJobRow,
  rankingOverride?: RankedJobServeContract,
): JobSummary {
  const labels = Array.isArray(row.labels) ? row.labels : [];
  const screening = screenJob({
    title: row.title,
    companyHint: row.company,
    canonicalUrl: row.canonical_url,
    markdown: row.markdown,
    descriptionSample: row.description_sample,
    labels,
  });
  const ranked = rankingOverride ?? inferredJobServeRanking(row);

  return {
    id: Number(row.id),
    title: row.title,
    company: row.company,
    location: extractLocation(row.markdown, row.description_sample),
    source: sourceAdapterFor(row.source_id, row.source_label, row.canonical_url),
    links: linksForJob(row),
    classification: {
      category: row.category,
      labels: labels.map((label) => label.label),
      ragFocus: row.rag_focus,
      enterpriseFocus: row.enterprise_focus,
      confidence: numberOrNull(row.classification_confidence),
      reason: row.classification_reason,
    },
    eligibility: eligibilityFromScreening(screening),
    ingest: {
      fullTextStatus: fullTextStatus(row),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      postedAt: ranked?.postedAt?.toISOString() ?? extractPostedAt(row.markdown),
    },
    ranking: rankingForJob(row, ranked),
    reviewState: row.review_state,
    dedupe: {
      candidateCount: row.duplicate_candidates.length,
      groups: row.duplicate_candidates.map((candidate) => ({
        id: candidate.id,
        state: candidate.state,
        confidence: numberOrZero(candidate.confidence),
        reason: candidate.reason,
      })),
    },
    cost: costsForJob(row),
  };
}

export function renderFastRefreshMarkdown(result: FastRefreshResult): string {
  const lines = [
    "# Fast Job Refresh",
    "",
    `Generated: ${result.finishedAt}`,
    `Elapsed: ${(result.elapsedMs / 1000).toFixed(2)}s`,
    "",
    "## Counts",
    "",
  ];

  for (const row of result.sources) {
    lines.push(
      `- ${row.source.label} / ${row.keyword}: ${row.outcome}, discovered ${row.discovered}, imported ${row.imported}, full-text pages ${row.fullText.persisted}, run ${row.runId ?? "none"}${
        row.fullText.fetchedPages === null ? "" : `, pages fetched ${row.fullText.fetchedPages}`
      }`,
    );
  }

  const classifiedTotal = result.classified.reduce((sum, item) => sum + item.classified, 0);
  lines.push(`- Classified this run: ${classifiedTotal}`);
  lines.push(
    `- Tokens/cost: ${formatCost(result.costs.jinaSearchTokens)} Jina Search tokens, ${formatCost(
      result.costs.jinaReaderTokens,
    )} Jina Reader tokens, ${formatCost(result.costs.openAiTokens)} OpenAI tokens, ${formatCost(
      result.costs.billableSearchApiCalls,
    )} billable search API calls`,
  );
  lines.push("");
  lines.push("## Latest Ranked Jobs");
  lines.push("");

  if (result.latest.jobs.length === 0) {
    lines.push("No ranked jobs available.");
  } else {
    for (const [index, row] of result.latest.jobs.entries()) {
      const canonical = row.links.find((link) => link.kind === "canonical")?.url ?? "#";
      lines.push(`${index + 1}. [${escapeMarkdownLinkText(row.title)}](${canonical})`);
      lines.push(
        `   ${[row.company, row.source.label, row.classification.category, row.eligibility.status]
          .filter(Boolean)
          .join(" | ")}`,
      );
      lines.push(`   matched: ${row.ranking.reasons.join(", ") || row.classification.labels.join(", ")}`);
      lines.push(`   full text: ${row.ingest.fullTextStatus}; review: ${row.reviewState}`);
      lines.push("");
    }
  }

  if (result.latest.direct.length > 0) {
    lines.push("## Direct Source Lane");
    lines.push("");
    for (const [index, row] of result.latest.direct.entries()) {
      const canonical = row.links.find((link) => link.kind === "canonical")?.url ?? "#";
      lines.push(`${index + 1}. [${escapeMarkdownLinkText(row.title)}](${canonical})`);
      lines.push(
        `   ${[row.company, row.source.label, row.classification.category, row.eligibility.status]
          .filter(Boolean)
          .join(" | ")}`,
      );
      lines.push(`   matched: ${row.classification.labels.join(", ") || "direct-source current role"}`);
      lines.push("");
    }
  }

  const errors = result.sources.flatMap((row) =>
    row.errors.map((error) => `${row.source.label} / ${row.keyword}: ${error}`),
  );
  if (errors.length > 0) {
    lines.push("## Errors");
    lines.push("");
    lines.push(...errors.map((error) => `- ${error}`));
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function assertMigrationsReady(): Promise<void> {
  const plan = await planMigrations();
  if (plan.pending.length > 0) {
    throw new Error(`Database has ${plan.pending.length} pending migration(s). Run bun run db:migrate.`);
  }
}

async function ingestJobServeQuery(
  query: string,
  options: Pick<FastRefreshOptions, "jobserveMaxPages" | "jobserveImportLimitPerQuery" | "timeoutMs">,
): Promise<FastRefreshSourceSummary> {
  const started = Date.now();
  try {
    const result = await fetchLiveJobServeRoles({
      query,
      maxPages: options.jobserveMaxPages,
      timeoutMs: options.timeoutMs,
    });
    const jobs = result.roles
      .slice(0, options.jobserveImportLimitPerQuery)
      .map((role) => jobServeRoleToNormalizedJob(role, query));
    if (jobs.length === 0) {
      return sourceSummary({
        source: sourceAdapterFor("jobserve", "JobServe", ""),
        keyword: query,
        runId: null,
        outcome: "zero_results",
        discovered: result.roles.length,
        imported: 0,
        pagesPersisted: 0,
        pagesFetched: result.pagesFetched,
        elapsedMs: Date.now() - started,
      });
    }

    const ingest = await ingestNormalizedJobs({
      sourceId: "jobserve",
      sourceLabel: "JobServe",
      keyword: query,
      jobs,
      timeoutMs: options.timeoutMs,
    });

    return sourceSummary({
      source: sourceAdapterFor("jobserve", "JobServe", ""),
      keyword: query,
      runId: ingest.runId,
      outcome: ingest.errors.length > 0 ? "http_error" : "success",
      discovered: result.roles.length,
      imported: ingest.jobsPersisted,
      pagesPersisted: ingest.pagesPersisted,
      pagesFetched: result.pagesFetched,
      elapsedMs: Date.now() - started,
      errors: ingest.errors.map((error) => `${error.title}: ${error.error}`),
    });
  } catch (err) {
    return sourceSummary({
      source: sourceAdapterFor("jobserve", "JobServe", ""),
      keyword: query,
      runId: null,
      outcome: outcomeFromError(err),
      discovered: 0,
      imported: 0,
      pagesPersisted: 0,
      pagesFetched: null,
      elapsedMs: Date.now() - started,
      errors: [errorMessage(err)],
      blockedReason: errorMessage(err),
    });
  }
}

async function ingestLinearCareers(
  options: Pick<FastRefreshOptions, "directLimit" | "timeoutMs">,
): Promise<FastRefreshSourceSummary> {
  const started = Date.now();
  try {
    const result = await fetchLinearCareersJobs({
      limit: options.directLimit,
      timeoutMs: options.timeoutMs,
    });
    if (result.jobs.length === 0) {
      return sourceSummary({
        source: sourceAdapterFor(result.sourceId, result.sourceLabel, ""),
        keyword: "linear-careers",
        runId: null,
        outcome: "zero_results",
        discovered: result.discovered,
        imported: 0,
        pagesPersisted: 0,
        pagesFetched: null,
        elapsedMs: Date.now() - started,
      });
    }

    const ingest = await ingestNormalizedJobs({
      sourceId: result.sourceId,
      sourceLabel: result.sourceLabel,
      keyword: "linear-careers",
      jobs: result.jobs,
      timeoutMs: options.timeoutMs,
    });

    return sourceSummary({
      source: sourceAdapterFor(result.sourceId, result.sourceLabel, ""),
      keyword: "linear-careers",
      runId: ingest.runId,
      outcome: ingest.errors.length > 0 ? "http_error" : "success",
      discovered: result.discovered,
      imported: ingest.jobsPersisted,
      pagesPersisted: ingest.pagesPersisted,
      pagesFetched: null,
      elapsedMs: Date.now() - started,
      errors: ingest.errors.map((error) => `${error.title}: ${error.error}`),
    });
  } catch (err) {
    return sourceSummary({
      source: sourceAdapterFor("linear-careers", "Linear Careers", ""),
      keyword: "linear-careers",
      runId: null,
      outcome: outcomeFromError(err),
      discovered: 0,
      imported: 0,
      pagesPersisted: 0,
      pagesFetched: null,
      elapsedMs: Date.now() - started,
      errors: [errorMessage(err)],
      blockedReason: errorMessage(err),
    });
  }
}

async function classifyRun(runId: number, limit: number): Promise<FastRefreshClassificationSummary> {
  const rows = await runPsqlJson<ClassifiableJobRow[]>(
    buildClassifiableJobsForSearchRunSql(runId, limit),
  );
  let classified = 0;
  for (const row of rows) {
    const classification = classifyJobText({
      title: row.title,
      description: row.description_text,
      hasPageSnapshot: row.has_page_snapshot,
    });
    await runPsql(buildUpdateJobClassificationSql(row.id, classification));
    classified++;
  }
  return { runId, classified };
}

function orderJobSummaries(
  rows: FastRefreshJobRow[],
  orderedIds: number[],
  rankedById: Map<number, RankedJobServeContract>,
): JobSummary[] {
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const ordered = orderedIds
    .map((id) => rowsById.get(id))
    .filter((row): row is FastRefreshJobRow => row !== undefined)
    .map((row) => jobRowToSummary(row, rankedById.get(row.id)));
  const seen = new Set<number>();
  return ordered.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

function mergeJobRows(...groups: FastRefreshJobRow[][]): FastRefreshJobRow[] {
  const rows = new Map<number, FastRefreshJobRow>();
  for (const group of groups) {
    for (const row of group) rows.set(row.id, row);
  }
  return [...rows.values()];
}

function jobRowToJobServeContract(row: FastRefreshJobRow): JobServeContractRow {
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    url: row.canonical_url,
    lastSeenAt: row.last_seen_at,
    markdown: row.markdown ?? "",
    description: row.description_sample ?? "",
  };
}

function sourceSummary(input: {
  source: SourceAdapter;
  keyword: string;
  runId: number | null;
  outcome: SourceOutcome;
  discovered: number;
  imported: number;
  pagesPersisted: number;
  pagesFetched: number | null;
  elapsedMs: number;
  errors?: string[];
  blockedReason?: string | null;
}): FastRefreshSourceSummary {
  return {
    source: input.source,
    keyword: input.keyword,
    runId: input.runId,
    outcome: input.outcome,
    discovered: input.discovered,
    imported: input.imported,
    fullText: {
      persisted: input.pagesPersisted,
      fetchedPages: input.pagesFetched,
      status: input.pagesPersisted > 0 ? "success" : input.imported > 0 ? "snippet_only" : "pending",
    },
    costs: ZERO_COSTS,
    elapsedMs: input.elapsedMs,
    errors: input.errors ?? [],
    blockedReason: input.blockedReason ?? null,
  };
}

function sourceAdapterFor(
  sourceId: string | null,
  sourceLabel: string | null,
  url: string,
): SourceAdapter {
  const id = sourceId ?? sourceIdFromUrl(url);
  if (id === "linear-careers") {
    return {
      id,
      label: sourceLabel ?? "Linear Careers",
      kind: "direct_employer",
      quality: "high",
    };
  }
  if (id === "jobserve") {
    return {
      id,
      label: sourceLabel ?? "JobServe",
      kind: "recruiter",
      quality: "medium",
    };
  }
  if (["greenhouse", "lever", "ashby", "workable", "smartrecruiters"].includes(id)) {
    return {
      id,
      label: sourceLabel ?? titleCase(id),
      kind: "ats",
      quality: "high",
    };
  }
  if (["linkedin", "glassdoor", "wellfound", "remote-rocketship"].includes(id)) {
    return {
      id,
      label: sourceLabel ?? titleCase(id),
      kind: "protected",
      quality: "opportunistic",
    };
  }
  return {
    id,
    label: sourceLabel ?? titleCase(id),
    kind: "aggregator",
    quality: "medium",
  };
}

function linksForJob(row: FastRefreshJobRow): JobSummaryLink[] {
  const links: JobSummaryLink[] = [];
  pushLink(links, "canonical", row.canonical_url);
  if (row.observed_url && row.observed_url !== row.canonical_url) pushLink(links, "source", row.observed_url);
  for (const [kind, label] of [
    ["apply", "Apply URL"],
    ["source", "Source URL"],
    ["employer", "Detail URL"],
  ] as const) {
    const url = extractMarkdownMetadata(row.markdown, label);
    if (url) pushLink(links, kind, url, linkBlockStatus(url));
  }
  return links;
}

function pushLink(
  links: JobSummaryLink[],
  kind: JobSummaryLink["kind"],
  url: string | null,
  blocked?: { blocked: boolean; note: string } | null,
): void {
  if (!url || links.some((link) => link.url === url && link.kind === kind)) return;
  links.push({ kind, url, ...(blocked ?? {}) });
}

function linkBlockStatus(url: string): { blocked: boolean; note: string } | null {
  const host = hostname(url);
  if (host.includes("jobg8.com")) {
    return {
      blocked: true,
      note: "JobG8 traffic/apply hops are often CAPTCHA-gated; keep source evidence but prefer readable canonical detail link.",
    };
  }
  if (host.includes("indeed.com")) {
    return {
      blocked: false,
      note: "Indeed link retained only when no better direct link is present.",
    };
  }
  return null;
}

function fullTextStatus(
  row: FastRefreshJobRow,
): "success" | "snippet_only" | "blocked" | "expired" | "error" | "pending" {
  if (row.page_status === "success" && row.markdown?.trim()) return "success";
  const error = `${row.page_error ?? ""}\n${row.markdown ?? ""}`;
  if (/captcha|access denied|verify you are human/i.test(error)) return "blocked";
  if (/expired|closed|no longer accepting/i.test(error)) return "expired";
  if (row.page_status === "error" || row.page_ingest_status === "error") return "error";
  if (row.description_sample?.trim()) return "snippet_only";
  return "pending";
}

function rankingForJob(
  row: FastRefreshJobRow,
  ranked: RankedJobServeContract | null | undefined,
): JobSummary["ranking"] {
  if (ranked) {
    return {
      tier: ranked.tier,
      score: 100 - ranked.tier * 10,
      reasons: ranked.whyMatched,
      softened: ranked.whySoftened,
    };
  }
  if (row.source_id === "linear-careers") {
    return {
      tier: null,
      score: 72,
      reasons: ["direct employer", "current careers page", ...row.labels.map((label) => label.label)],
      softened: null,
    };
  }
  return {
    tier: null,
    score: row.labels.length > 0 ? 55 : null,
    reasons: row.labels.map((label) => label.label),
    softened: null,
  };
}

function inferredJobServeRanking(row: FastRefreshJobRow): RankedJobServeContract | null {
  if (row.source_id !== "jobserve") return null;
  return rankJobServeContract({
    id: row.id,
    title: row.title,
    company: row.company,
    url: row.canonical_url,
    lastSeenAt: row.last_seen_at,
    markdown: row.markdown ?? "",
    description: row.description_sample ?? "",
  });
}

function eligibilityFromScreening(screening: JobScreeningDecision): JobSummary["eligibility"] {
  const status =
    screening.status === "high_signal"
      ? "likely_ok"
      : screening.status === "needs_human_review"
        ? "needs_review"
        : "likely_reject";
  return {
    status,
    flags: screening.reasons.map((reason) => reason.code),
    reasons: screening.reasons.map((reason) => reason.detail),
    summary: screening.summary,
  };
}

function aggregateCosts(rows: FastRefreshSourceSummary[]): FastRefreshCosts {
  return rows.reduce(
    (costs, row) => ({
      jinaSearchTokens: addNullable(costs.jinaSearchTokens, row.costs.jinaSearchTokens),
      jinaReaderTokens: addNullable(costs.jinaReaderTokens, row.costs.jinaReaderTokens),
      openAiTokens: addNullable(costs.openAiTokens, row.costs.openAiTokens),
      billableSearchApiCalls: addNullable(
        costs.billableSearchApiCalls,
        row.costs.billableSearchApiCalls,
      ),
    }),
    { ...ZERO_COSTS },
  );
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return left + right;
}

function costsForJob(row: FastRefreshJobRow): FastRefreshCosts {
  const usage = numberOrNull(row.page_usage_tokens);
  if (usage === null) return ZERO_COSTS;
  return { ...JINA_READER_COST_UNKNOWN, jinaReaderTokens: usage };
}

function extractLocation(markdown: string | null, description: string | null): string | null {
  const location = extractMarkdownMetadata(markdown, "Location");
  if (location) return location;
  return description?.match(/\bLocation:\s*([^\n]+)/i)?.[1]?.trim() ?? null;
}

function extractPostedAt(markdown: string | null): string | null {
  const posted = extractMarkdownMetadata(markdown, "Posted date");
  if (!posted) return null;
  return posted;
}

function extractMarkdownMetadata(markdown: string | null, label: string): string | null {
  if (!markdown) return null;
  const match = markdown.match(new RegExp(`^- ${escapeRegExp(label)}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? null;
}

function outcomeFromError(err: unknown): SourceOutcome {
  const message = errorMessage(err);
  if (/timeout|aborted/i.test(message)) return "timeout";
  if (/captcha/i.test(message)) return "blocked_captcha";
  if (/401|403|auth/i.test(message)) return "blocked_auth";
  if (/parse|could not find|could not parse/i.test(message)) return "parse_error";
  if (/api key/i.test(message)) return "api_key_missing";
  return "http_error";
}

function sourceIdFromUrl(url: string): string {
  const host = hostname(url);
  if (host.includes("greenhouse.io")) return "greenhouse";
  if (host.includes("lever.co")) return "lever";
  if (host.includes("ashbyhq.com")) return "ashby";
  if (host.includes("workable.com")) return "workable";
  if (host.includes("smartrecruiters.com")) return "smartrecruiters";
  if (host.includes("linkedin.com")) return "linkedin";
  if (host.includes("glassdoor.")) return "glassdoor";
  if (host.includes("wellfound.com")) return "wellfound";
  if (host.includes("jobserve.com")) return "jobserve";
  return host.replace(/^www\./, "") || "unknown";
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrZero(value: string | number | null): number {
  return numberOrNull(value) ?? 0;
}

function positiveSqlLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 1000) {
    throw new Error("SQL limit must be a positive integer up to 1000");
  }
  return value;
}

function titleCase(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeMarkdownLinkText(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function formatCost(value: number | null): string {
  return value === null ? "unknown" : String(value);
}
