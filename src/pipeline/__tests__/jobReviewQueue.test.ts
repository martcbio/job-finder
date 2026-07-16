import { describe, expect, test } from "bun:test";
import {
  buildReviewQueueSql,
  type ReviewQueueRow,
  renderReviewQueueMarkdown,
} from "../jobReviewQueue";

describe("buildReviewQueueSql", () => {
  test("builds review queue query with state filters and review context", () => {
    const sql = buildReviewQueueSql({
      limit: 10,
      states: ["ready_for_review", "duplicate_candidate"],
    });

    expect(sql).toContain("FROM job_search.jobs j");
    expect(sql).toContain("FROM job_search.job_classification_labels jcl");
    expect(sql).toContain("FROM job_search.duplicate_candidates dc");
    expect(sql).toContain("FROM job_search.review_events re");
    expect(sql).toContain("'kind'");
    expect(sql).toContain("dc.job_id_b = j.id");
    expect(sql).toContain(
      "WHERE j.review_state = ANY(ARRAY['ready_for_review', 'duplicate_candidate']::text[])",
    );
    expect(sql).toContain("LIMIT 10");
  });

  test("filters by source id when sourceIds provided", () => {
    const sql = buildReviewQueueSql({
      limit: 5,
      states: ["ready_for_review"],
      sourceIds: ["linear-careers"],
    });

    expect(sql).toContain("sq_src.source_id = ANY(ARRAY['linear-careers']::text[])");
  });
});

describe("renderReviewQueueMarkdown", () => {
  test("renders empty queue", () => {
    const markdown = renderReviewQueueMarkdown([], {
      generatedAt: new Date("2026-05-20T00:00:00.000Z"),
      filters: { limit: 5, states: ["ready_for_review"] },
    });

    expect(markdown).toContain("# Job Review Queue");
    expect(markdown).toContain("Total jobs: 0");
    expect(markdown).toContain("_No jobs matched the queue filters._");
  });

  test("renders labels, duplicate candidates, and latest review event", () => {
    const row: ReviewQueueRow = {
      id: "42",
      title: "Senior Agentic Engineer [RAG]",
      company_hint: "Acme",
      canonical_url: "https://jobs.example.com/42",
      review_state: "ready_for_review",
      category: "agentic_engineer",
      rag_focus: "yes",
      enterprise_focus: "yes",
      classification_confidence: "0.7400",
      classification_labels: [
        { label: "agentic_engineer", source_stage: "page", confidence: "0.7400" },
        { label: "rag_enterprise", source_stage: "page", confidence: "0.7600" },
      ],
      duplicate_candidates: [
        {
          candidate_id: "7",
          other_job_id: "41",
          other_title: "Agentic Engineer",
          other_company_hint: "Acme",
          confidence: "0.8800",
          reason: "same_company",
          state: "suggested",
          kind: "similar",
        },
      ],
      latest_review_event: {
        from_state: "new",
        to_state: "ready_for_review",
        reason_codes: ["classified"],
        note: "Looks plausible",
        actor: "agent",
        created_at: "2026-05-20T01:00:00.000Z",
      },
      source_labels: ["Greenhouse"],
      last_seen_at: "2026-05-20T02:00:00.000Z",
      description_sample: "Build agentic enterprise RAG workflows.",
    };

    const markdown = renderReviewQueueMarkdown([row], {
      generatedAt: new Date("2026-05-20T00:00:00.000Z"),
      filters: { limit: 5, states: ["ready_for_review"] },
    });

    expect(markdown).toContain(
      "1. [Senior Agentic Engineer \\[RAG\\]](https://jobs.example.com/42)",
    );
    expect(markdown).toContain("Job ID: 42");
    expect(markdown).toContain("rag_enterprise@page(0.7600)");
    expect(markdown).toContain("Duplicate candidates: candidate 7: #41 Agentic Engineer");
    expect(markdown).toContain(
      'Latest event: new -> ready_for_review by agent reasons=classified note="Looks plausible"',
    );
  });
});
