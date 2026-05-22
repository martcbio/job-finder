import { quoteSqlLiteral } from "../db/config";
import { runPsql, runPsqlJson } from "../db/psql";
import { buildUpsertJobPageSql } from "./jobPageIngest";
import {
  atsIdentityFromUrl,
  canonicalizeJobUrl,
  completeSearchQuery,
  completeSearchRun,
  createSearchQuery,
  createSearchRun,
  persistSearchResult,
} from "./searchPersistence";
import type { SearchTarget } from "./searchTargets";

export interface NormalizedJobInput {
  sourceId: string;
  sourceLabel: string;
  searchLabel: string | null;
  searchTerm: string | null;
  title: string;
  company: string | null;
  url: string;
  description: string;
  location: string | null;
  employmentType: string | null;
  compensation: string | null;
  raw: unknown;
}

export interface NormalizedJobIngestInput {
  sourceId: string;
  sourceLabel: string;
  keyword: string;
  jobs: NormalizedJobInput[];
  timeoutMs: number;
}

export interface NormalizedJobIngestResult {
  runId: number;
  queryId: number;
  jobsSeen: number;
  jobsPersisted: number;
  pagesPersisted: number;
  errors: Array<{ title: string; url: string; error: string }>;
}

interface JobIdRow {
  id: string;
  title: string;
  canonical_url: string;
}

export async function ingestNormalizedJobs(
  input: NormalizedJobIngestInput,
): Promise<NormalizedJobIngestResult> {
  if (input.jobs.length === 0) {
    throw new Error("Normalized ingest requires at least one job");
  }

  const runId = await createSearchRun({
    keyword: input.keyword,
    sourceSet: [input.sourceId],
    timeFilter: "normalized_import",
    includeRemote: true,
    location: null,
    limitPerQuery: input.jobs.length,
    timeoutMs: input.timeoutMs,
  });
  const queryId = await createSearchQuery({
    runId,
    target: normalizedImportTarget(input),
  });

  const errors: NormalizedJobIngestResult["errors"] = [];
  let jobsPersisted = 0;
  let pagesPersisted = 0;

  for (const [index, job] of input.jobs.entries()) {
    try {
      await persistSearchResult({
        queryId,
        rank: index + 1,
        sourceLabel: job.sourceLabel,
        item: {
          title: displayTitle(job),
          description: resultDescription(job),
          url: job.url,
        },
      });
      jobsPersisted += 1;

      if (job.description.trim()) {
        const persisted = await findPersistedJob(job);
        await runPsql(
          buildUpsertJobPageSql(
            {
              id: persisted.id,
              title: persisted.title,
              canonical_url: persisted.canonical_url,
            },
            {
              source: "http_extract",
              status: "success",
              markdown: normalizedJobMarkdown(job),
              usageTokens: null,
              decompressedBytes: Buffer.byteLength(job.description, "utf8"),
              error: null,
            },
          ),
        );
        pagesPersisted += 1;
      }
    } catch (err) {
      errors.push({
        title: job.title,
        url: job.url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await completeSearchQuery({
    queryId,
    status: errors.length === input.jobs.length ? "error" : "success",
    usageTokens: null,
    decompressedBytes: null,
    error:
      errors.length > 0 ? errors.map((error) => `${error.title}: ${error.error}`).join("\n") : null,
  });

  const status =
    errors.length === 0 ? "completed" : jobsPersisted > 0 ? "completed_with_errors" : "failed";
  await completeSearchRun({
    runId,
    status,
    totalReportedTokens: 0,
    errorSummary:
      errors.length > 0 ? errors.map((error) => `${error.title}: ${error.error}`).join("\n") : null,
  });

  return {
    runId,
    queryId,
    jobsSeen: input.jobs.length,
    jobsPersisted,
    pagesPersisted,
    errors,
  };
}

export function normalizeExternalJob(
  raw: Record<string, unknown>,
  sourceId: string,
): NormalizedJobInput {
  const title = firstText(raw, ["title", "job_title"]);
  const url = firstText(raw, ["url", "job_url", "job_url_direct", "canonical_url"]);
  if (!title) throw new Error("External job is missing a title");
  if (!url) throw new Error(`External job "${title}" is missing a URL`);

  return {
    sourceId,
    sourceLabel: sourceLabel(sourceId),
    searchLabel: nullableText(firstText(raw, ["search_label", "source_key"])),
    searchTerm: nullableText(firstText(raw, ["search_term", "query"])),
    title,
    company: nullableText(firstText(raw, ["company", "company_hint", "employer_name"])),
    url,
    description: firstText(raw, ["description", "summary_snippet", "description_raw"]),
    location: nullableText(firstText(raw, ["location"])),
    employmentType: nullableText(firstText(raw, ["job_type", "employment_type"])),
    compensation: nullableText(firstText(raw, ["compensation", "rate", "salary"])),
    raw,
  };
}

export function normalizeExternalJobPayload(
  payload: unknown,
  sourceId: string,
): NormalizedJobInput[] {
  const records = extractRecords(payload);
  return records.map((record, index) => {
    try {
      return normalizeExternalJob(record, sourceId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid ${sourceId} job at index ${index}: ${message}`);
    }
  });
}

export function normalizedJobMarkdown(job: NormalizedJobInput): string {
  const lines = [
    `# ${displayTitle(job)}`,
    "",
    `- Source: ${job.sourceLabel}`,
    job.searchLabel ? `- Search: ${job.searchLabel}` : null,
    job.searchTerm ? `- Search term: ${job.searchTerm}` : null,
    job.location ? `- Location: ${job.location}` : null,
    job.employmentType ? `- Employment type: ${job.employmentType}` : null,
    job.compensation ? `- Compensation: ${job.compensation}` : null,
    "",
    job.description.trim(),
  ].filter((line): line is string => line !== null);

  return lines.join("\n");
}

function normalizedImportTarget(input: NormalizedJobIngestInput): SearchTarget {
  return {
    kind: "search-query",
    keyword: input.keyword,
    sourceId: input.sourceId,
    label: input.sourceLabel,
    query: `${input.sourceId}:${input.keyword}`,
    filter: (results) => results,
  };
}

async function findPersistedJob(job: NormalizedJobInput): Promise<JobIdRow> {
  const canonicalUrl = canonicalizeJobUrl(job.url);
  const canonicalKey = atsIdentityFromUrl(job.url)?.canonicalKey ?? canonicalUrl;
  const row = await runPsqlJson<JobIdRow | null>(`SELECT COALESCE(
  (
    SELECT json_build_object(
      'id', id::text,
      'title', title_normalized,
      'canonical_url', canonical_url
    )
    FROM job_search.jobs
    WHERE canonical_key = ${quoteSqlLiteral(canonicalKey)}
       OR canonical_url = ${quoteSqlLiteral(canonicalUrl)}
    LIMIT 1
  ),
  'null'::json
);`);

  if (row === null) {
    throw new Error(`Persisted job not found for canonical URL ${canonicalUrl}`);
  }
  return row;
}

function extractRecords(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.map(requireRecord);
  const record = requireRecord(payload);
  for (const key of ["roles", "jobs", "data"]) {
    const value = record[key];
    if (Array.isArray(value)) return value.map(requireRecord);
  }
  throw new Error("Expected a JSON array or an object with roles, jobs, or data");
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected each job to be a JSON object");
  }
  return value as Record<string, unknown>;
}

function firstText(raw: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function nullableText(value: string): string | null {
  return value.trim() ? value.trim() : null;
}

function sourceLabel(sourceId: string): string {
  if (sourceId === "jobspy") return "JobSpy";
  if (sourceId === "jobserve") return "JobServe";
  return sourceId;
}

function displayTitle(job: NormalizedJobInput): string {
  return job.company ? `${job.company} - ${job.title}` : job.title;
}

function resultDescription(job: NormalizedJobInput): string {
  return [
    job.location ? `Location: ${job.location}` : null,
    job.employmentType ? `Employment type: ${job.employmentType}` : null,
    job.compensation ? `Compensation: ${job.compensation}` : null,
    job.description,
  ]
    .filter((part): part is string => part !== null && part.trim().length > 0)
    .join("\n\n");
}
