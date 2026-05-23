import type { NormalizedJobInput } from "./normalizedJobIngest";

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
  | "not_implemented";

export const SOURCE_OUTCOMES: SourceOutcome[] = [
  "success",
  "zero_results",
  "snippet_only",
  "blocked_captcha",
  "blocked_auth",
  "blocked_robots_or_waf",
  "redirect_only",
  "expired",
  "parse_error",
  "timeout",
  "http_error",
  "not_implemented",
];

export type SourceAttemptStatus =
  | "success"
  | "zero_results"
  | "partial"
  | "blocked"
  | "timeout"
  | "parser_error"
  | "rate_limited"
  | "auth_required";

export const SOURCE_ATTEMPT_STATUSES: SourceAttemptStatus[] = [
  "success",
  "zero_results",
  "partial",
  "blocked",
  "timeout",
  "parser_error",
  "rate_limited",
  "auth_required",
];

export interface SourceCostUsage {
  jinaSearchTokens: number | null;
  jinaReaderTokens: number | null;
  openAiTokens: number | null;
  billableSearchApiCalls: number | null;
}

export interface SourceAdapter {
  id: string;
  label: string;
  kind: SourceKind;
  quality: SourceQuality;
}

export interface SourceAdapterDescriptor extends SourceAdapter {
  defaultKeyword: string;
  defaultIncluded: boolean;
  supportsSourceScopedRefresh: boolean;
}

export interface SourceDiscoveryInput {
  keyword: string;
  limit: number;
  timeoutMs: number;
}

export interface SourceDiscoveryResult {
  source: SourceAdapter;
  keyword: string;
  outcome: SourceOutcome;
  discovered: number;
  jobs: NormalizedJobInput[];
  pagesFetched: number | null;
  costs: SourceCostUsage;
  errors: string[];
  blockedReason: string | null;
}

export interface FastRefreshSourceAdapter extends SourceAdapter {
  defaultKeyword: string;
  discover(input: SourceDiscoveryInput): Promise<SourceDiscoveryResult>;
}

export interface SourceCandidateContractSnapshot {
  sourceId: string;
  sourceLabel: string;
  candidateUrl: string;
  canonicalUrl: string;
  title: string;
  company: string | null;
  location: string | null;
  remoteHint: string | null;
  discoveredAt: string | null;
  searchTerm: string | null;
  rawPresent: boolean;
  fetchStrategy: string;
  failureReason: string | null;
}

export interface SourceDiscoveryContractSnapshot {
  source: SourceAdapter;
  keyword: string;
  status: SourceAttemptStatus;
  outcome: SourceOutcome;
  discovered: number;
  candidateCount: number;
  pagesFetched: number | null;
  costs: SourceCostUsage;
  errors: string[];
  blockedReason: string | null;
  candidates: SourceCandidateContractSnapshot[];
}

export function describeSourceAdapter(
  adapter: FastRefreshSourceAdapter,
  defaultIncluded: boolean,
): SourceAdapterDescriptor {
  assertNonEmpty(adapter.id, "adapter.id");
  assertNonEmpty(adapter.label, "adapter.label");
  assertNonEmpty(adapter.defaultKeyword, "adapter.defaultKeyword");
  return {
    id: adapter.id,
    label: adapter.label,
    kind: adapter.kind,
    quality: adapter.quality,
    defaultKeyword: adapter.defaultKeyword,
    defaultIncluded,
    supportsSourceScopedRefresh: true,
  };
}

export function sourceAttemptStatus(
  outcome: SourceOutcome,
  imported: number,
  errors: readonly string[] = [],
): SourceAttemptStatus {
  const errorText = errors.join("\n");
  if (/rate|429/i.test(errorText)) return "rate_limited";
  if (/401|403|auth/i.test(errorText) || outcome === "blocked_auth") return "auth_required";
  if (outcome === "success") return imported > 0 || errors.length === 0 ? "success" : "partial";
  if (outcome === "zero_results") return "zero_results";
  if (outcome === "timeout") return "timeout";
  if (outcome === "parse_error") return "parser_error";
  if (
    outcome === "blocked_captcha" ||
    outcome === "blocked_robots_or_waf" ||
    outcome === "redirect_only"
  ) {
    return "blocked";
  }
  return "partial";
}

export function assertSourceDiscoveryResultContract(
  result: SourceDiscoveryResult,
): SourceDiscoveryContractSnapshot {
  assertSourceMetadata(result.source);
  assertNonEmpty(result.keyword, "result.keyword");
  if (!SOURCE_OUTCOMES.includes(result.outcome)) {
    throw new Error(`Unsupported source outcome "${result.outcome}"`);
  }
  if (!Number.isInteger(result.discovered) || result.discovered < 0) {
    throw new Error("result.discovered must be a non-negative integer");
  }
  if (result.discovered < result.jobs.length) {
    throw new Error("result.discovered must be greater than or equal to jobs.length");
  }
  if (result.outcome === "success" && result.jobs.length === 0) {
    throw new Error(
      "result.outcome success requires at least one normalized job; use zero_results",
    );
  }
  if (result.outcome === "zero_results" && result.jobs.length > 0) {
    throw new Error("result.outcome zero_results cannot include normalized jobs");
  }
  if (
    result.pagesFetched !== null &&
    (!Number.isInteger(result.pagesFetched) || result.pagesFetched < 0)
  ) {
    throw new Error("result.pagesFetched must be null or a non-negative integer");
  }
  assertCosts(result.costs);
  if (!Array.isArray(result.errors) || result.errors.some((error) => typeof error !== "string")) {
    throw new Error("result.errors must be an array of strings");
  }
  if (result.blockedReason !== null && typeof result.blockedReason !== "string") {
    throw new Error("result.blockedReason must be null or a string");
  }

  return {
    source: result.source,
    keyword: result.keyword,
    status: sourceAttemptStatus(result.outcome, result.jobs.length, result.errors),
    outcome: result.outcome,
    discovered: result.discovered,
    candidateCount: result.jobs.length,
    pagesFetched: result.pagesFetched,
    costs: result.costs,
    errors: result.errors,
    blockedReason: result.blockedReason,
    candidates: result.jobs.map((job, index) =>
      sourceCandidateSnapshot(job, result.source, result.keyword, index),
    ),
  };
}

function sourceCandidateSnapshot(
  job: NormalizedJobInput,
  source: SourceAdapter,
  keyword: string,
  index: number,
): SourceCandidateContractSnapshot {
  assertNonEmpty(job.sourceId, `jobs[${index}].sourceId`);
  assertNonEmpty(job.sourceLabel, `jobs[${index}].sourceLabel`);
  assertNonEmpty(job.title, `jobs[${index}].title`);
  assertNonEmpty(job.url, `jobs[${index}].url`);
  if (job.sourceId !== source.id) {
    throw new Error(`jobs[${index}].sourceId must match result.source.id`);
  }
  if (job.sourceLabel !== source.label) {
    throw new Error(`jobs[${index}].sourceLabel must match result.source.label`);
  }

  const raw = rawObject(job.raw);
  return {
    sourceId: job.sourceId,
    sourceLabel: job.sourceLabel,
    candidateUrl: job.sourceUrl ?? job.url,
    canonicalUrl: job.url,
    title: job.title,
    company: job.company,
    location: job.location,
    remoteHint: stringRawField(raw, "remoteHint"),
    discoveredAt: stringRawField(raw, "discoveredAt"),
    searchTerm: job.searchTerm ?? keyword,
    rawPresent: job.raw !== undefined && job.raw !== null,
    fetchStrategy: stringRawField(raw, "fetchStrategy") ?? "normalized_adapter",
    failureReason: stringRawField(raw, "failureReason"),
  };
}

function assertSourceMetadata(source: SourceAdapter): void {
  assertNonEmpty(source.id, "source.id");
  assertNonEmpty(source.label, "source.label");
  if (
    !["direct_employer", "ats", "recruiter", "aggregator", "search", "protected"].includes(
      source.kind,
    )
  ) {
    throw new Error(`Unsupported source kind "${source.kind}"`);
  }
  if (!["high", "medium", "low", "opportunistic"].includes(source.quality)) {
    throw new Error(`Unsupported source quality "${source.quality}"`);
  }
}

function assertCosts(costs: SourceCostUsage): void {
  for (const field of [
    "jinaSearchTokens",
    "jinaReaderTokens",
    "openAiTokens",
    "billableSearchApiCalls",
  ] as const) {
    const value = costs[field];
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`costs.${field} must be null or a non-negative number`);
    }
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function rawObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringRawField(raw: Record<string, unknown>, field: string): string | null {
  const value = raw[field];
  return typeof value === "string" && value.trim() ? value : null;
}
