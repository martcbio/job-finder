import type { SourceAdapter, SourceAttemptStatus, SourceOutcome } from "../sourceAdapterContract";

export {
  type FastRefreshSourceAdapter,
  SOURCE_ATTEMPT_STATUSES,
  type SourceAdapter,
  type SourceAdapterDescriptor,
  type SourceAttemptStatus,
  type SourceOutcome,
  sourceAttemptStatus,
} from "../sourceAdapterContract";

export interface FastRefreshOptions {
  limit: number;
  sourceIds: string[];
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
  status: SourceAttemptStatus;
  discovered: number;
  excluded: number;
  imported: number;
  fullText: {
    persisted: number;
    fetchedPages: number | null;
    status: "success" | "pending" | "snippet_only" | "error";
  };
  classification: {
    classified: number;
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
    captureQualityFlags: string[];
    markdownLineCount: number;
    markdownBulletCount: number;
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
    status: SourceAttemptStatus;
    queryStatus: string;
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
    classificationCount: number;
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
  labels: Array<{
    label: string;
    source_stage?: string;
    confidence?: string | number;
    reason?: string;
  }>;
  duplicate_candidates: Array<{
    id: string;
    state: string;
    confidence: string | number;
    reason: string;
  }>;
  review_events: unknown[];
}

const DEFAULT_JOBSERVE_QUERIES = ["AI engineer", "agentic AI", "LLM engineer"];

export const DEFAULT_FAST_REFRESH_OPTIONS: FastRefreshOptions = {
  limit: 20,
  sourceIds: ["jobserve", "linear-careers", "google-careers"],
  jobserveQueries: DEFAULT_JOBSERVE_QUERIES,
  jobserveMaxPages: 2,
  jobserveImportLimitPerQuery: 5,
  directLimit: 6,
  timeoutMs: 20000,
  classifyLimit: 250,
};

export const ZERO_COSTS: FastRefreshCosts = {
  jinaSearchTokens: 0,
  jinaReaderTokens: 0,
  openAiTokens: 0,
  billableSearchApiCalls: 0,
};

export const JINA_READER_COST_UNKNOWN: FastRefreshCosts = {
  jinaSearchTokens: 0,
  jinaReaderTokens: null,
  openAiTokens: 0,
  billableSearchApiCalls: 0,
};
