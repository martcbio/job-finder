import type { ReviewQueueRow } from "./types";

/** States returned by GET /api/jobs/queue with no state filter. */
export const TRIAGE_QUEUE_STATES = new Set([
  "new",
  "needs_page_ingest",
  "needs_classification",
  "ready_for_review",
  "duplicate_candidate",
]);

export function isTriageQueueJob(job: ReviewQueueRow): boolean {
  return TRIAGE_QUEUE_STATES.has(job.review_state);
}

export function isShortlistedJob(job: ReviewQueueRow): boolean {
  return job.review_state === "shortlisted";
}

export function sortByLastSeen(rows: ReviewQueueRow[]): ReviewQueueRow[] {
  return [...rows].sort((a, b) =>
    (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? ""),
  );
}

export function mergeQueueRows(
  triage: ReviewQueueRow[],
  shortlisted: ReviewQueueRow[],
): ReviewQueueRow[] {
  const byId = new Map<string, ReviewQueueRow>();
  for (const row of triage) byId.set(row.id, row);
  for (const row of shortlisted) byId.set(row.id, row);
  return sortByLastSeen([...byId.values()]);
}

/** Triage + shortlisted, latest first — one list for Cockpit after source refresh. */
export function cockpitQueueJobs(queue: ReviewQueueRow[]): ReviewQueueRow[] {
  return sortByLastSeen(
    queue.filter((j) => isTriageQueueJob(j) || isShortlistedJob(j)),
  );
}
