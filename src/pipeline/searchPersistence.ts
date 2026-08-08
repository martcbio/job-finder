import { quoteSqlLiteral } from "../db/config";
import { jsonbLiteral } from "../db/jsonSql";
import { runPsql, runPsqlJson } from "../db/psql";
import { parseAshbyUrl } from "../services/ats/ashby";
import { parseGreenhouseUrl } from "../services/ats/greenhouse";
import { parseLeverUrl } from "../services/ats/lever";
import { parseWorkableUrl } from "../services/ats/workable";
import type { SearchResultItem, SearchTarget } from "./searchTargets";

export interface CreateSearchRunInput {
  keyword: string;
  sourceSet: string[];
  timeFilter: string;
  includeRemote: boolean;
  location: string | null;
  limitPerQuery: number;
  timeoutMs: number;
}

export interface CreateSearchQueryInput {
  runId: number;
  target: SearchTarget;
}

export interface CompleteSearchQueryInput {
  queryId: number;
  status: "success" | "timeout" | "error";
  usageTokens: number | null;
  decompressedBytes: number | null;
  error: string | null;
}

export interface PersistSearchResultInput {
  queryId: number;
  rank: number;
  sourceLabel: string;
  item: SearchResultItem;
  canonicalKeyOverride?: string;
  rawEvidence?: unknown;
}

export interface AtsIdentity {
  source: "ashby" | "greenhouse" | "lever" | "workable";
  org: string;
  jobId: string;
  canonicalKey: string;
}

interface IdRow {
  id: number;
}

export function canonicalizeJobUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.hash = "";

  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.startsWith("utm_") ||
      ["ref", "source", "src", "gh_src", "lever-source"].includes(normalizedKey)
    ) {
      url.searchParams.delete(key);
    }
  }

  const sortedParams = [...url.searchParams.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  url.search = "";
  for (const [key, value] of sortedParams) {
    url.searchParams.append(key, value);
  }

  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}

export function companyHintFromUrl(
  sourceLabel: string,
  rawUrl: string,
  title: string,
): string | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const parts = url.pathname.split("/").filter(Boolean);

    if (host.includes("greenhouse.io") && parts[0]) return titleCaseSlug(parts[0]);
    if (host.includes("lever.co") && parts[0]) return titleCaseSlug(parts[0]);
    if (host.includes("ashbyhq.com") && parts[0]) return titleCaseSlug(parts[0]);
    if (host.includes("workable.com") && parts[0] && parts[0] !== "j") {
      return titleCaseSlug(parts[0]);
    }
    if (host.includes("smartrecruiters.com") && parts[0]) return titleCaseSlug(parts[0]);
    if (host.includes("myworkdayjobs.com")) return titleCaseSlug(host.split(".")[0] ?? sourceLabel);
    if (host.includes("oraclecloud.com")) return titleCaseSlug(host.split(".")[0] ?? sourceLabel);
    if (title.includes(" - ")) return title.split(" - ")[0]?.trim() || null;

    return titleCaseSlug(host.split(".")[0] ?? sourceLabel);
  } catch {
    return sourceLabel;
  }
}

export function atsIdentityFromUrl(rawUrl: string): AtsIdentity | null {
  const greenhouse = parseGreenhouseUrl(rawUrl);
  if (greenhouse) {
    return atsIdentity("greenhouse", greenhouse.org, greenhouse.id);
  }

  const lever = parseLeverUrl(rawUrl);
  if (lever) {
    return atsIdentity("lever", lever.org, lever.id);
  }

  const ashby = parseAshbyUrl(rawUrl);
  if (ashby) {
    return atsIdentity("ashby", ashby.org, ashby.id);
  }

  const workable = parseWorkableUrl(rawUrl);
  if (workable) {
    return atsIdentity("workable", workable.slug, workable.shortcode);
  }

  return null;
}

export async function createSearchRun(input: CreateSearchRunInput): Promise<number> {
  const row = await runPsqlJson<IdRow>(
    `INSERT INTO job_search.search_runs (
       keyword,
       source_set,
       time_filter,
       include_remote,
       location,
       limit_per_query,
       timeout_ms
     )
     VALUES (
       ${quoteSqlLiteral(input.keyword)},
       ${jsonbLiteral(input.sourceSet)},
       ${quoteSqlLiteral(input.timeFilter)},
       ${input.includeRemote ? "true" : "false"},
       ${nullableText(input.location)},
       ${input.limitPerQuery},
       ${input.timeoutMs}
     )
     RETURNING json_build_object('id', id);`,
  );

  return row.id;
}

export async function createSearchQuery(input: CreateSearchQueryInput): Promise<number> {
  const target = input.target;
  const row = await runPsqlJson<IdRow>(
    `INSERT INTO job_search.search_queries (
       run_id,
       source_label,
       source_id,
       query,
       direct_url,
       status,
       finished_at
     )
     VALUES (
       ${input.runId},
       ${quoteSqlLiteral(target.label)},
       ${quoteSqlLiteral(target.sourceId)},
       ${nullableText(target.kind === "search-query" ? target.query : null)},
       ${nullableText(target.kind === "direct-url" ? target.url : null)},
       ${quoteSqlLiteral(target.kind === "direct-url" ? "direct" : "running")},
       ${target.kind === "direct-url" ? "now()" : "NULL"}
     )
     RETURNING json_build_object('id', id);`,
  );

  return row.id;
}

export async function completeSearchQuery(input: CompleteSearchQueryInput): Promise<void> {
  await runPsql(
    `UPDATE job_search.search_queries
     SET status = ${quoteSqlLiteral(input.status)},
         finished_at = now(),
         usage_tokens = ${nullableNumber(input.usageTokens)},
         decompressed_bytes = ${nullableNumber(input.decompressedBytes)},
         error = ${nullableText(input.error)}
     WHERE id = ${input.queryId};`,
  );
}

export async function persistSearchResult(input: PersistSearchResultInput): Promise<void> {
  await runPsql(buildPersistSearchResultSql(input));
}

export function buildPersistSearchResultSql(input: PersistSearchResultInput): string {
  const canonicalUrl = canonicalizeJobUrl(input.item.url);
  const atsIdentity = atsIdentityFromUrl(input.item.url);
  const canonicalKeyOverride = input.canonicalKeyOverride?.trim() || null;
  const canonicalKey = canonicalKeyOverride ?? atsIdentity?.canonicalKey ?? canonicalUrl;
  const companyHint = companyHintFromUrl(input.sourceLabel, input.item.url, input.item.title);
  const normalizedTitle = normalizeTitle(input.item.title, input.sourceLabel);

  return `WITH inserted_result AS (
       INSERT INTO job_search.search_results (
         query_id,
         rank,
         title_raw,
         description_raw,
         url_raw,
         url_canonical,
         company_hint,
         raw_payload,
         ats_source,
         ats_org,
         ats_job_id
       )
       VALUES (
         ${input.queryId},
         ${input.rank},
         ${quoteSqlLiteral(input.item.title)},
         ${quoteSqlLiteral(input.item.description)},
         ${quoteSqlLiteral(input.item.url)},
         ${quoteSqlLiteral(canonicalUrl)},
         ${nullableText(companyHint)},
         ${input.rawEvidence === undefined ? "'{}'::jsonb" : jsonbLiteral(input.rawEvidence)},
         ${nullableText(atsIdentity?.source ?? null)},
         ${nullableText(atsIdentity?.org ?? null)},
         ${nullableText(atsIdentity?.jobId ?? null)}
       )
       RETURNING id
     ),
     existing_job AS (
       SELECT id
       FROM job_search.jobs
       WHERE canonical_key = ${quoteSqlLiteral(canonicalKey)}
          OR canonical_url = ${quoteSqlLiteral(canonicalUrl)}
          OR (
            ${nullableText(atsIdentity?.source ?? null)} IS NOT NULL
            AND ats_source = ${nullableText(atsIdentity?.source ?? null)}
            AND ats_org = ${nullableText(atsIdentity?.org ?? null)}
            AND ats_job_id = ${nullableText(atsIdentity?.jobId ?? null)}
          )
       ORDER BY
         CASE WHEN canonical_key = ${quoteSqlLiteral(canonicalKey)} THEN 0 ELSE 1 END,
         id ASC
       LIMIT 1
     ),
     updated_existing_job AS (
       UPDATE job_search.jobs
       SET canonical_key = ${quoteSqlLiteral(canonicalKey)},
           last_seen_at = now(),
           title_normalized = ${quoteSqlLiteral(normalizedTitle)},
           company_hint = COALESCE(${nullableText(companyHint)}, job_search.jobs.company_hint),
           ats_source = COALESCE(job_search.jobs.ats_source, ${nullableText(atsIdentity?.source ?? null)}),
           ats_org = COALESCE(job_search.jobs.ats_org, ${nullableText(atsIdentity?.org ?? null)}),
           ats_job_id = COALESCE(job_search.jobs.ats_job_id, ${nullableText(atsIdentity?.jobId ?? null)})
       WHERE id IN (SELECT id FROM existing_job)
       RETURNING id
     ),
     inserted_job AS (
       INSERT INTO job_search.jobs (
         canonical_key,
         canonical_url,
         title_normalized,
         company_hint,
         ats_source,
         ats_org,
         ats_job_id,
         first_seen_at,
         last_seen_at
       )
       SELECT
         ${quoteSqlLiteral(canonicalKey)},
         ${quoteSqlLiteral(canonicalUrl)},
         ${quoteSqlLiteral(normalizedTitle)},
         ${nullableText(companyHint)},
         ${nullableText(atsIdentity?.source ?? null)},
         ${nullableText(atsIdentity?.org ?? null)},
         ${nullableText(atsIdentity?.jobId ?? null)},
         now(),
         now()
       WHERE NOT EXISTS (SELECT 1 FROM updated_existing_job)
       RETURNING id
     ),
     upserted_job AS (
       SELECT id FROM updated_existing_job
       UNION ALL
       SELECT id FROM inserted_job
     )
     INSERT INTO job_search.job_observations (
       job_id,
       search_result_id,
       observed_title,
       observed_url,
       observed_company_hint
     )
     SELECT
       upserted_job.id,
       inserted_result.id,
       ${quoteSqlLiteral(input.item.title)},
       ${quoteSqlLiteral(input.item.url)},
       ${nullableText(companyHint)}
     FROM upserted_job, inserted_result
     ON CONFLICT (job_id, search_result_id) DO NOTHING;`;
}

export async function completeSearchRun(input: {
  runId: number;
  status: "completed" | "completed_with_errors" | "failed";
  totalReportedTokens: number;
  errorSummary: string | null;
}): Promise<void> {
  await runPsql(
    `UPDATE job_search.search_runs
     SET status = ${quoteSqlLiteral(input.status)},
         finished_at = now(),
         total_reported_tokens = ${input.totalReportedTokens},
         error_summary = ${nullableText(input.errorSummary)}
     WHERE id = ${input.runId};`,
  );
}

function nullableText(value: string | null): string {
  return value === null ? "NULL" : quoteSqlLiteral(value);
}

function nullableNumber(value: number | null): string {
  return value === null ? "NULL" : String(value);
}

function normalizeTitle(title: string, fallback: string): string {
  const normalized = title.trim().replace(/\s+/g, " ");
  return normalized || fallback;
}

function atsIdentity(source: AtsIdentity["source"], org: string, jobId: string): AtsIdentity {
  return {
    source,
    org,
    jobId,
    canonicalKey: `ats:${source}:${org.toLowerCase()}:${jobId.toLowerCase()}`,
  };
}

function titleCaseSlug(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}
