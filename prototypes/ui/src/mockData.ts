import type {
  PipelineRunRow,
  ReviewQueueRow,
  SourceHealthRow,
} from "./types";

export const PROTOTYPES = [
  {
    id: "cockpit",
    name: "Signal Cockpit",
    tagline: "Dense ops console — every metric visible",
    accent: "#22c55e",
  },
  {
    id: "swipe",
    name: "Swipe Triage",
    tagline: "Card stack for fast human review",
    accent: "#f97316",
  },
  {
    id: "bento",
    name: "Bento Command",
    tagline: "Living dashboard tiles with micro-motion",
    accent: "#0ea5e9",
  },
  {
    id: "timeline",
    name: "Pipeline Timeline",
    tagline: "Runs, sources, and evidence chronology",
    accent: "#14b8a6",
  },
] as const;

export const MOCK_QUEUE: ReviewQueueRow[] = [
  {
    id: "j-001",
    title: "Senior Agentic Engineer",
    company_hint: "Helix Systems",
    canonical_url: "https://jobs.lever.co/helix/agentic-sr",
    review_state: "ready_for_review",
    category: "agentic_engineer",
    rag_focus: "high",
    enterprise_focus: "mid_market",
    classification_confidence: "0.87",
    classification_labels: [
      { label: "agentic", source_stage: "page", confidence: 0.91 },
      { label: "rag", source_stage: "metadata", confidence: 0.78 },
    ],
    duplicate_candidates: [],
    latest_review_event: {
      from_state: "needs_classification",
      to_state: "ready_for_review",
      reason_codes: ["classified"],
      note: null,
      actor: "system",
      created_at: "2026-05-25T18:42:00Z",
    },
    source_labels: ["linear-careers", "jobspy"],
    last_seen_at: "2026-05-25T19:10:00Z",
    description_sample:
      "Build autonomous agent workflows over customer knowledge bases. Strong Python, LLM orchestration, evaluation harnesses.",
  },
  {
    id: "j-002",
    title: "Forward Deployed Engineer — AI",
    company_hint: "Northwind Analytics",
    canonical_url: "https://boards.greenhouse.io/northwind/fde-ai",
    review_state: "shortlisted",
    category: "fde",
    rag_focus: "medium",
    enterprise_focus: "enterprise",
    classification_confidence: "0.92",
    classification_labels: [
      { label: "customer-facing", source_stage: "page", confidence: 0.88 },
    ],
    duplicate_candidates: [
      {
        candidate_id: "dup-12",
        other_job_id: "j-008",
        other_title: "FDE, Applied AI",
        other_company_hint: "Northwind",
        confidence: 0.73,
        reason: "company + title similarity",
        state: "pending",
      },
    ],
    latest_review_event: {
      from_state: "ready_for_review",
      to_state: "shortlisted",
      reason_codes: ["strong_fit"],
      note: "EU remote confirmed in page ingest",
      actor: "human",
      created_at: "2026-05-25T17:05:00Z",
    },
    source_labels: ["greenhouse-direct"],
    last_seen_at: "2026-05-25T17:30:00Z",
    description_sample:
      "Embed with enterprise customers to ship RAG pipelines and agent tooling. Travel ~20%.",
  },
  {
    id: "j-003",
    title: "Inference Engineer",
    company_hint: "Tensorlane",
    canonical_url: "https://jobs.ashby.io/tensorlane/inference",
    review_state: "needs_page_ingest",
    category: "inference_engineer",
    rag_focus: "low",
    enterprise_focus: "startup",
    classification_confidence: "0.61",
    classification_labels: [
      { label: "gpu", source_stage: "metadata", confidence: 0.65 },
    ],
    duplicate_candidates: [],
    latest_review_event: null,
    source_labels: ["ashby", "jobserve"],
    last_seen_at: "2026-05-25T16:55:00Z",
    description_sample:
      "Optimize model serving latency for production chat workloads. CUDA, vLLM, batching strategies.",
  },
  {
    id: "j-004",
    title: "Staff ML Platform Engineer",
    company_hint: "Cohort Labs",
    canonical_url: "https://workable.com/cohort/staff-ml-platform",
    review_state: "needs_cv_tailoring",
    category: "ml_platform",
    rag_focus: "medium",
    enterprise_focus: "scaleup",
    classification_confidence: "0.84",
    classification_labels: [
      { label: "platform", source_stage: "page", confidence: 0.82 },
    ],
    duplicate_candidates: [],
    latest_review_event: {
      from_state: "shortlisted",
      to_state: "needs_cv_tailoring",
      reason_codes: ["cv_needed"],
      note: null,
      actor: "human",
      created_at: "2026-05-24T11:20:00Z",
    },
    source_labels: ["workable", "source_search"],
    last_seen_at: "2026-05-25T09:00:00Z",
    description_sample:
      "Own feature store, eval pipelines, and deployment infra for applied research teams.",
  },
  {
    id: "j-005",
    title: "Applied AI Engineer",
    company_hint: "Meridian Docs",
    canonical_url: "https://jobs.lever.co/meridian/applied-ai",
    review_state: "duplicate_candidate",
    category: "agentic_engineer",
    rag_focus: "high",
    enterprise_focus: "mid_market",
    classification_confidence: "0.79",
    classification_labels: [],
    duplicate_candidates: [
      {
        candidate_id: "dup-31",
        other_job_id: "j-001",
        other_title: "Senior Agentic Engineer",
        other_company_hint: "Helix Systems",
        confidence: 0.68,
        reason: "url redirect overlap",
        state: "pending",
      },
    ],
    latest_review_event: {
      from_state: "ready_for_review",
      to_state: "duplicate_candidate",
      reason_codes: ["dup_flagged"],
      note: "Awaiting human merge decision",
      actor: "system",
      created_at: "2026-05-25T14:00:00Z",
    },
    source_labels: ["jobspy"],
    last_seen_at: "2026-05-25T14:00:00Z",
    description_sample:
      "Ship document agents for legal workflows. Hybrid London, 2d/wk.",
  },
  {
    id: "j-006",
    title: "RAG Engineer",
    company_hint: "Vaultline",
    canonical_url: "https://jobs.lever.co/vaultline/rag",
    review_state: "not_relevant",
    category: "rag_engineer",
    rag_focus: "high",
    enterprise_focus: "enterprise",
    classification_confidence: "0.71",
    classification_labels: [
      { label: "onsite-london", source_stage: "page", confidence: 0.95 },
    ],
    duplicate_candidates: [],
    latest_review_event: {
      from_state: "ready_for_review",
      to_state: "not_relevant",
      reason_codes: ["location"],
      note: "5-day onsite requirement",
      actor: "human",
      created_at: "2026-05-23T08:15:00Z",
    },
    source_labels: ["lever-direct"],
    last_seen_at: "2026-05-23T08:15:00Z",
    description_sample: "Enterprise RAG over financial documents. Must be in-office 5 days.",
  },
  {
    id: "j-007",
    title: "AI Solutions Architect",
    company_hint: "Praxis Group",
    canonical_url: "https://praxis.workday/ai-architect",
    review_state: "ready_to_apply",
    category: "solutions_architect",
    rag_focus: "medium",
    enterprise_focus: "enterprise",
    classification_confidence: "0.89",
    classification_labels: [
      { label: "pre-sales", source_stage: "page", confidence: 0.86 },
    ],
    duplicate_candidates: [],
    latest_review_event: {
      from_state: "needs_cv_tailoring",
      to_state: "ready_to_apply",
      reason_codes: ["cv_approved"],
      note: "Draft v2 approved",
      actor: "human",
      created_at: "2026-05-25T12:00:00Z",
    },
    source_labels: ["source_search", "jobserve"],
    last_seen_at: "2026-05-25T12:00:00Z",
    description_sample:
      "Design multi-tenant agent platforms for regulated clients. Remote EU.",
  },
];

export const MOCK_SOURCE_HEALTH: SourceHealthRow[] = [
  {
    source_id: "linear-careers",
    lane: "direct-url",
    attempts: 47,
    successes: 41,
    success_rate: 0.87,
    timeouts: 2,
    errors: 4,
    avg_tokens: 1240,
    avg_results: 3.2,
    total_results: 134,
  },
  {
    source_id: "jobserve",
    lane: "jobserve",
    attempts: 62,
    successes: 38,
    success_rate: 0.61,
    timeouts: 11,
    errors: 13,
    avg_tokens: 890,
    avg_results: 1.8,
    total_results: 112,
  },
  {
    source_id: "jobspy",
    lane: "jobspy",
    attempts: 28,
    successes: 22,
    success_rate: 0.79,
    timeouts: 3,
    errors: 3,
    avg_tokens: null,
    avg_results: 4.7,
    total_results: 103,
  },
  {
    source_id: "greenhouse-direct",
    lane: "source_search",
    attempts: 19,
    successes: 17,
    success_rate: 0.89,
    timeouts: 0,
    errors: 2,
    avg_tokens: 620,
    avg_results: 2.1,
    total_results: 40,
  },
];

export const MOCK_PIPELINE_RUNS: PipelineRunRow[] = [
  {
    id: "run-8842",
    status: "completed",
    started_at: "2026-05-25T18:00:00Z",
    finished_at: "2026-05-25T18:04:12Z",
    step_count: 6,
    error_message: null,
  },
  {
    id: "run-8839",
    status: "completed",
    started_at: "2026-05-25T12:00:00Z",
    finished_at: "2026-05-25T12:03:44Z",
    step_count: 6,
    error_message: null,
  },
  {
    id: "run-8831",
    status: "failed",
    started_at: "2026-05-24T18:00:00Z",
    finished_at: "2026-05-24T18:01:02Z",
    step_count: 2,
    error_message: "jobserve: rate_limited after 3 retries",
  },
];

export function formatState(state: string): string {
  return state.replace(/_/g, " ");
}

export function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function stateColor(state: string): string {
  const map: Record<string, string> = {
    ready_for_review: "#f59e0b",
    shortlisted: "#22c55e",
    needs_page_ingest: "#64748b",
    needs_cv_tailoring: "#6366f1",
    ready_to_apply: "#14b8a6",
    duplicate_candidate: "#f97316",
    not_relevant: "#71717a",
    rejected_by_us: "#ef4444",
  };
  return map[state] ?? "#94a3b8";
}
