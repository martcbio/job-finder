import { describe, expect, test } from "bun:test";
import type { ReviewQueueRow } from "../../types";
import {
  deriveEmploymentType,
  deriveItRelevance,
  filterQueueJobs,
  toQueueJobView,
} from "../reviewQueueModel";

function job(
  title: string,
  description_sample: string | null = null,
  labels: string[] = [],
): ReviewQueueRow {
  return {
    id: title,
    title,
    company_hint: null,
    canonical_url: "https://example.com/job",
    review_state: "ready_for_review",
    category: "",
    rag_focus: "",
    enterprise_focus: "",
    classification_confidence: null,
    classification_labels: labels.map((label) => ({
      label,
      source_stage: "test",
      confidence: 1,
    })),
    duplicate_candidates: [],
    latest_review_event: null,
    source_labels: ["JobServe"],
    last_seen_at: "2026-07-15T10:00:00.000Z",
    description_sample,
  };
}

describe("deriveItRelevance", () => {
  test("recognises explicit software roles", () => {
    expect(deriveItRelevance(job("Senior Software Engineer", "Aerospace customer"))).toBe("it");
    expect(deriveItRelevance(job("AI Enablement Analyst"))).toBe("it");
    expect(deriveItRelevance(job("Engineer", "Build cloud platforms with Kubernetes"))).toBe("it");
    expect(deriveItRelevance(job("Engineer", null, ["backend", "typescript"]))).toBe("it");
  });

  test("rejects explicit non-IT engineering roles", () => {
    expect(deriveItRelevance(job("Mechanical Engineer"))).toBe("non_it");
    expect(deriveItRelevance(job("Field Service Engineer", "Maintain hydraulic equipment"))).toBe(
      "non_it",
    );
    expect(deriveItRelevance(job("Engineer", "Shift maintenance of CNC machinery"))).toBe("non_it");
  });

  test("leaves a bare engineer without evidence unclear", () => {
    expect(deriveItRelevance(job("Engineer", "Join our growing team"))).toBe("unclear");
  });
});

describe("deriveEmploymentType", () => {
  test("recognises contract signals, including IR35 and day rates", () => {
    expect(deriveEmploymentType(job("Platform Engineer - Contract"))).toBe("contract");
    expect(deriveEmploymentType(job("Developer", "£650 per day, outside IR35"))).toBe("contract");
  });

  test("recognises permanent signals", () => {
    expect(deriveEmploymentType(job("Permanent Data Engineer"))).toBe("permanent");
    expect(deriveEmploymentType(job("Developer", "Full-time role with a £75k salary"))).toBe(
      "permanent",
    );
    expect(
      deriveEmploymentType(
        job("Developer", "- Inside IR35: no\n- Outside IR35: no\nFull-time salary"),
      ),
    ).toBe("permanent");
    expect(
      deriveEmploymentType(
        job("Developer", "- Employment type: FullTime\nWork with external contractors"),
      ),
    ).toBe("permanent");
  });

  test("returns unknown without a type signal", () => {
    expect(deriveEmploymentType(job("Backend Developer"))).toBe("unknown");
  });
});

describe("filterQueueJobs relevance defaults", () => {
  const views = [
    toQueueJobView(job("Software Engineer")),
    toQueueJobView(job("Engineer", "Join our team")),
    toQueueJobView(job("Mechanical Engineer")),
  ];

  test("hides non-IT rows by default", () => {
    expect(filterQueueJobs(views, "", [], []).map((view) => view.itRelevance)).toEqual([
      "it",
      "unclear",
    ]);
  });

  test("reveals non-IT rows through the quick chip or facet", () => {
    expect(filterQueueJobs(views, "", [], ["non_it"])).toHaveLength(1);
    expect(
      filterQueueJobs(views, "", [{ facet: "it_relevance", value: "Non-IT" }], []),
    ).toHaveLength(1);
  });
});
