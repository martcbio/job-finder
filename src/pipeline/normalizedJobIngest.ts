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
  sourceUrl: string | null;
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
  const url = preferredJobUrl(raw);
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
    sourceUrl: sourceUrl(raw, url),
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
    `- Job URL: ${job.url}`,
    job.sourceUrl ? `- Source URL: ${job.sourceUrl}` : null,
    job.searchLabel ? `- Search: ${job.searchLabel}` : null,
    job.searchTerm ? `- Search term: ${job.searchTerm}` : null,
    job.location ? `- Location: ${job.location}` : null,
    job.employmentType ? `- Employment type: ${job.employmentType}` : null,
    job.compensation ? `- Compensation: ${job.compensation}` : null,
    ...rawMetadataLines(job.raw),
    arrayMetadataLine("Capture quality flags", captureQualityFlags(job.raw, job.description)),
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
    const value = valueAtPath(raw, key);
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function preferredJobUrl(raw: Record<string, unknown>): string {
  const candidates = [
    firstText(raw, ["raw_jobspy.job_url_direct"]),
    firstText(raw, ["job_url_direct"]),
    firstText(raw, ["direct_url"]),
    firstText(raw, ["canonical_url"]),
    firstText(raw, ["url"]),
    firstText(raw, ["raw_jobspy.job_url"]),
    firstText(raw, ["job_url"]),
    firstText(raw, ["permalink"]),
  ].filter(Boolean);

  return candidates.find((url) => !isIndeedUrl(url)) ?? candidates[0] ?? "";
}

function sourceUrl(raw: Record<string, unknown>, selectedUrl: string): string | null {
  const candidates = [
    firstText(raw, ["url"]),
    firstText(raw, ["raw_jobspy.job_url"]),
    firstText(raw, ["job_url"]),
  ].filter(Boolean);
  const originalUrl = candidates.find((url) => url !== selectedUrl);
  return originalUrl ?? null;
}

function valueAtPath(raw: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = raw;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isIndeedUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return hostname === "indeed.com" || hostname.endsWith(".indeed.com");
  } catch {
    return false;
  }
}

function nullableText(value: string): string | null {
  return value.trim() ? value.trim() : null;
}

function sourceLabel(sourceId: string): string {
  if (sourceId === "jobspy") return "JobSpy";
  if (sourceId === "jobserve") return "JobServe";
  return sourceId;
}

function rawMetadataLines(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const record = raw as Record<string, unknown>;
  return [
    metadataLine("Posted date", textValue(record.posted_date)),
    metadataLine("Duration", textValue(record.duration)),
    metadataLine("Reference", textValue(record.reference)),
    metadataLine("JobServe ID", textValue(record.job_id)),
    metadataLine("Apply URL", textValue(record.apply_url)),
    metadataLine("Detail URL", textValue(record.detail_fetch_url)),
    booleanMetadataLine("Outside IR35", record.outside_ir35),
    booleanMetadataLine("Inside IR35", record.inside_ir35),
    booleanMetadataLine("Remote signal", record.remote_signal),
    metadataLine("Detail status", textValue(record.detail_status)),
    metadataLine("Detail error", textValue(record.detail_error)),
    arrayMetadataLine("Priority notes", record.priority_notes),
  ].filter((line): line is string => line !== null);
}

export function captureQualityFlags(raw: unknown, description: string): string[] {
  const flags: string[] = [];
  const text = description.trim();
  const lineCount = text.split("\n").filter((line) => line.trim()).length;
  if (text.length > 1200 && lineCount <= 3) flags.push("single_line_long_body");
  if (/\b(?:skip to content|open app|sign up|privacy terms|cookie settings)\b/i.test(text)) {
    flags.push("nav_or_cookie_boilerplate");
  }
  if (
    /\b(?:job not found|not available anymore|no longer accepting applications|page you are looking for doesn't exist)\b/i.test(
      text,
    )
  ) {
    flags.push("closed_or_error_page");
  }
  if (/\bcurrent openings\b/i.test(text) && /\bsearch \d+ jobs\b/i.test(text)) {
    flags.push("listing_page_not_job_detail");
  }

  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const detailStatus = (record as Record<string, unknown>).detail_status;
  if (detailStatus === "error") flags.push("detail_fetch_error");
  if (detailStatus === "skipped") flags.push("detail_fetch_skipped");

  return [...new Set(flags)];
}

function metadataLine(label: string, value: string): string | null {
  return value ? `- ${label}: ${value}` : null;
}

function booleanMetadataLine(label: string, value: unknown): string | null {
  return typeof value === "boolean" ? `- ${label}: ${value ? "yes" : "no"}` : null;
}

function arrayMetadataLine(label: string, value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
  return items.length > 0 ? `- ${label}: ${items.join(", ")}` : null;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function displayTitle(job: NormalizedJobInput): string {
  return job.company ? `${job.company} - ${job.title}` : job.title;
}

function resultDescription(job: NormalizedJobInput): string {
  return [
    `Job URL: ${job.url}`,
    job.sourceUrl ? `Source URL: ${job.sourceUrl}` : null,
    job.location ? `Location: ${job.location}` : null,
    job.employmentType ? `Employment type: ${job.employmentType}` : null,
    job.compensation ? `Compensation: ${job.compensation}` : null,
    job.description,
  ]
    .filter((part): part is string => part !== null && part.trim().length > 0)
    .join("\n\n");
}
