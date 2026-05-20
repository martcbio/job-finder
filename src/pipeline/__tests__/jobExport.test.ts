import { describe, expect, test } from "bun:test";
import { buildJobsExportSql, type JobExportRow, renderJobsMarkdown } from "../jobExport";

describe("buildJobsExportSql", () => {
  test("builds the default export query", () => {
    const sql = buildJobsExportSql({ limit: 25, reviewState: null, runId: null });

    expect(sql).toContain("FROM job_search.jobs j");
    expect(sql).toContain("ORDER BY j.last_seen_at DESC, j.id DESC");
    expect(sql).toContain("LIMIT 25");
    expect(sql).not.toContain("j.review_state =");
    expect(sql).not.toContain("sq.run_id =");
  });

  test("adds review state and run filters", () => {
    const sql = buildJobsExportSql({ limit: 10, reviewState: "ready_for_review", runId: 7 });

    expect(sql).toContain("WHERE j.review_state = 'ready_for_review' AND sq.run_id = 7");
    expect(sql).toContain("LIMIT 10");
  });
});

describe("renderJobsMarkdown", () => {
  test("renders an empty export", () => {
    const markdown = renderJobsMarkdown([], {
      generatedAt: new Date("2026-05-20T00:00:00.000Z"),
      filters: { limit: 5, reviewState: null, runId: null },
    });

    expect(markdown).toContain("# Job Search Export");
    expect(markdown).toContain("Total jobs: 0");
    expect(markdown).toContain("_No jobs matched the export filters._");
  });

  test("renders job rows with source and observation context", () => {
    const row: JobExportRow = {
      id: "42",
      title: "Agentic Engineer [RAG]",
      company_hint: "Acme",
      canonical_url: "https://jobs.example.com/42",
      review_state: "new",
      category: "agentic_engineer",
      rag_focus: "yes",
      enterprise_focus: "no",
      classification_confidence: "0.7400",
      classification_reason: "matched agent language",
      first_seen_at: "2026-05-20T01:00:00.000Z",
      last_seen_at: "2026-05-20T02:00:00.000Z",
      observations: 2,
      source_labels: ["Greenhouse", "Lever"],
      source_ids: ["greenhouse", "lever"],
      description_sample: "Build agentic search systems.\nWith retrieval.",
    };

    const markdown = renderJobsMarkdown([row], {
      generatedAt: new Date("2026-05-20T00:00:00.000Z"),
      filters: { limit: 5, reviewState: "new", runId: 3 },
    });

    expect(markdown).toContain("Filters: limit=5, state=new, run_id=3");
    expect(markdown).toContain("1. [Agentic Engineer \\[RAG\\]](https://jobs.example.com/42)");
    expect(markdown).toContain("Classification: agentic_engineer / rag=yes / enterprise=no");
    expect(markdown).toContain("Confidence: 0.7400");
    expect(markdown).toContain("Sources: Greenhouse, Lever");
    expect(markdown).toContain("Observations: 2");
    expect(markdown).toContain("Snippet: Build agentic search systems. With retrieval.");
  });
});
