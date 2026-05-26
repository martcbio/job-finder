export const DEFAULT_PORT = 3737;
export const RUN_CONFIRMATION = "run-local-pipeline";

export const DEFAULT_QUEUE_STATES = [
  "new",
  "needs_page_ingest",
  "needs_classification",
  "ready_for_review",
  "duplicate_candidate",
] as const;
