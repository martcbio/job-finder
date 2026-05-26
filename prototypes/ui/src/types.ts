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
  lane: string;
  attempts: number;
  successes: number;
  success_rate: number;
  timeouts: number;
  errors: number;
  avg_tokens: number | null;
  avg_results: number | null;
  total_results: number;
}

export interface PipelineRunRow {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  step_count: number;
  error_message: string | null;
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

export type PrototypeId =
  | "cockpit"
  | "swipe"
  | "bento"
  | "editorial"
  | "split"
  | "timeline"
  | "kanban";

export interface PrototypeInfo {
  id: PrototypeId;
  name: string;
  tagline: string;
  accent: string;
}
