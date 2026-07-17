import { describe, expect, test } from "bun:test";
import { cloudOpeningToQueueRow, mergeCloudOpeningsIntoQueue } from "../../cloudQueue";
import type { CloudOpeningRow, ReviewQueueRow } from "../../types";
import { filterQueueJobs, toQueueJobView } from "../reviewQueueModel";

function opening(overrides: Partial<CloudOpeningRow> = {}): CloudOpeningRow {
  return {
    org: "acme-lab",
    ats: "greenhouse",
    external_id: "42",
    title: "Senior AI Platform Engineer",
    company: "Acme Lab",
    location: "London",
    locations: ["London", "Remote UK"],
    url: "https://job-boards.greenhouse.io/acme-lab/jobs/42",
    posted_at: "2026-07-15T08:00:00.000Z",
    first_seen_at: "2026-07-16T08:00:00.000Z",
    last_seen_at: "2026-07-17T08:00:00.000Z",
    first_seen_run_id: "run-latest",
    last_seen_run_id: "run-latest",
    ...overrides,
  };
}

function localRow(url: string): ReviewQueueRow {
  return {
    id: "local-1",
    title: "Senior AI Platform Engineer",
    company_hint: "Acme Lab",
    canonical_url: url,
    review_state: "ready_for_review",
    category: "ml_platform",
    rag_focus: "",
    enterprise_focus: "",
    classification_confidence: "0.91",
    classification_labels: [],
    duplicate_candidates: [],
    latest_review_event: null,
    source_labels: ["greenhouse-direct"],
    last_seen_at: "2026-07-17T09:00:00.000Z",
    description_sample: null,
  };
}

describe("cloud openings in the review queue", () => {
  test("maps a lab opening into the shared queue model", () => {
    const row = cloudOpeningToQueueRow(opening(), "run-latest");
    const view = toQueueJobView(row, Date.parse("2026-07-17T12:00:00.000Z"));

    expect(row).toMatchObject({
      queue_source: "lab",
      company_hint: "Acme Lab",
      category: "ai_ml",
      classification_confidence: null,
      first_seen_at: "2026-07-16T08:00:00.000Z",
      last_seen_at: "2026-07-17T08:00:00.000Z",
      is_latest_run: true,
      application_provenance: {
        org: "acme-lab",
        ats: "greenhouse",
        external_id: "42",
      },
    });
    expect(view.location).toBe("London, Remote UK");
    expect(view.source).toBe("acme-lab");
    expect(view.queueSource).toBe("lab");
    expect(view.confidence).toBe(0);
    expect(view.ir35).toBe("unknown");
  });

  test("deduplicates cloud openings against normalized local URLs", () => {
    const local = localRow("http://www.job-boards.greenhouse.io/acme-lab/jobs/42/?gh_src=feed");
    expect(mergeCloudOpeningsIntoQueue([local], [opening()], "run-latest")).toEqual([local]);
  });

  test("filters every mapped lab row through the Labs quick chip", () => {
    const lab = toQueueJobView(cloudOpeningToQueueRow(opening(), "run-latest"));
    const local = toQueueJobView(localRow("https://example.com/jobs/local"));
    expect(filterQueueJobs([lab, local], "", [], ["lab"])).toEqual([lab]);
  });
});
