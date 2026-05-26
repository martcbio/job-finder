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

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export type PrototypeId = "cockpit" | "swipe" | "bento" | "timeline";

export interface PrototypeInfo {
  id: PrototypeId;
  name: string;
  tagline: string;
  accent: string;
}
