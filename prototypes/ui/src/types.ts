export interface ReviewQueueLabel {
  label: string;
  source_stage: string;
  confidence: string | number;
}

export interface ReviewQueueDuplicate {
  candidate_id: string;
  other_job_id: string;
  other_title: string;
  other_company_hint: string | null;
  confidence: string | number;
  reason: string;
  state: string;
}

export interface ReviewQueueEvent {
  from_state: string | null;
  to_state: string;
  reason_codes: string[];
  note: string | null;
  actor: string;
  created_at: string;
}

export interface ReviewQueueRow {
  id: string;
  title: string;
  company_hint: string | null;
  canonical_url: string;
  review_state: string;
  category: string;
  rag_focus: string;
  enterprise_focus: string;
  classification_confidence: string | null;
  classification_labels: ReviewQueueLabel[];
  duplicate_candidates: ReviewQueueDuplicate[];
  latest_review_event: ReviewQueueEvent | null;
  source_labels: string[];
  last_seen_at: string;
  description_sample: string | null;
}

export interface SourceHealthRow {
  source_id: string;
  source_label?: string;
  lane?: string;
  attempts: number;
  successes: number;
  success_rate: number | string;
  timeouts: number;
  errors: number;
  avg_tokens?: number | null;
  avg_reported_tokens?: number | null;
  avg_results: number | null;
  total_results: number;
}

export interface PipelineRunRow {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  step_count?: number;
  error_message?: string | null;
  error_summary?: string | null;
  steps?: Array<{ step_name: string; status: string }>;
  sweep_name?: string | null;
}

export interface RefreshRunRow {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  keyword: string;
  elapsedMs: number | null;
}

export interface FastRefreshResult {
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  sources: Array<{
    source: { id: string; label: string };
    outcome: string;
    status: string;
    discovered: number;
    imported: number;
    classification: { classified: number };
  }>;
  latest: { jobs: unknown[] };
}

export interface ApiMeta {
  reviewStates: string[];
  reviewActors: string[];
}

export interface FastRefreshSourceInfo {
  id: string;
  label: string;
  kind: string;
  defaultIncluded: boolean;
}

export interface SourcesApiData {
  fastRefresh: FastRefreshSourceInfo[];
  queueRefresh?: FastRefreshSourceInfo[];
  refreshableSourceIds?: string[];
}

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export interface CloudOpeningRow {
  org: string;
  ats: "ashby" | "greenhouse" | "lever";
  external_id: string;
  title: string | null;
  company: string;
  location: string;
  locations: string[];
  url: string;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  first_seen_run_id: string;
  last_seen_run_id: string;
}

export interface CloudRunRow {
  run_id: string;
  run_date: string;
  completed_at: string;
  health: "complete" | "degraded" | "failed";
  matched_openings_count: number;
  substrate: "modal" | "mac";
}

export type CloudUnavailableCode =
  | "cloud_not_configured"
  | "cloud_schema_not_exposed"
  | "cloud_upstream_error";

export type CloudRowsResult<T> =
  | { status: "available"; rows: T[] }
  | {
      status: "cloud_unavailable";
      reason: { code: CloudUnavailableCode; message: string; upstreamStatus?: number };
    };

export interface OpsDoctorRow {
  task: string;
  substrate: string | null;
  cadence_seconds: number | null;
  latest_success_at: string | null;
  latest_run_at?: string | null;
  last_exit_status?: number | null;
  runs_24h?: number | null;
  failures_24h?: number | null;
  failure_rate_24h?: number | null;
  expected_beats_24h?: number | null;
  missed_beats_24h?: number | null;
  stale: boolean;
  unhealthy?: boolean;
}

export interface OpsRunRow {
  task: string;
  substrate: string | null;
  started_at: string | null;
  finished_at: string | null;
  exit_status: number | null;
}

export interface OpsAlertRow {
  id: number | string;
  fingerprint: string;
  severity: "warn" | "critical";
  task: string | null;
  substrate: string | null;
  message: string;
  first_seen: string;
  last_seen: string;
  occurrences: number;
  delivered_at: string | null;
}

export interface OpsParityRow {
  run_date: string;
  substrate: "mac" | "modal";
  run_id: string;
  openings_count: number;
  ids_sha256: string;
  created_at: string;
}

interface OpsUnavailable {
  status: "unavailable";
  reason: { code: string; message: string; upstreamStatus?: number };
}

export interface CloudOpsPayload {
  doctor:
    | { status: "available"; source: "doctor_v2"; rows: OpsDoctorRow[] }
    | { status: "doctor_not_deployed"; source: "doctor"; rows: OpsDoctorRow[] }
    | OpsUnavailable;
  runs: { status: "available"; rows: OpsRunRow[] } | OpsUnavailable;
  alerts:
    | { status: "available"; rows: OpsAlertRow[] }
    | {
        status: "alerts_unavailable";
        reason: { code: string; message: string; upstreamStatus?: number };
      };
  parity: { status: "available"; rows: OpsParityRow[] } | OpsUnavailable;
}

export type PrototypeId = "cockpit" | "cloud" | "swipe" | "bento" | "timeline";

export interface PrototypeInfo {
  id: PrototypeId;
  name: string;
  tagline: string;
  accent: string;
}
