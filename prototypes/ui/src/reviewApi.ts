import type { ApiEnvelope } from "./types";

const API_BASE = "/api";

export interface ReviewTransitionResult {
  job_id: string;
  from_state: string;
  to_state: string;
  event_id: string;
}

export async function postJobReview(
  jobId: string,
  state: string,
  opts?: { reasonCodes?: string[]; note?: string },
): Promise<{ ok: true; data: ReviewTransitionResult } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${API_BASE}/jobs/${jobId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        state,
        actor: "human",
        reasonCodes: opts?.reasonCodes ?? ["swipe_triage"],
        note: opts?.note ?? null,
      }),
    });
    const body = (await res.json()) as ApiEnvelope<ReviewTransitionResult>;
    if (!res.ok || !body.ok || !body.data) {
      return { ok: false, error: body.error?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: body.data };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}
