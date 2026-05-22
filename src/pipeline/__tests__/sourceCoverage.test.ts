import { describe, expect, test } from "bun:test";
import {
  applySourceCoverageScreening,
  buildSourceCoverageRunContextSql,
  buildSourceCoverageSql,
  renderSourceCoverageMarkdown,
  type SourceCoverageRow,
  sourceCoverageOutcome,
  sourceCoverageReasons,
} from "../sourceCoverage";

function row(overrides: Partial<SourceCoverageRow>): SourceCoverageRow {
  return {
    source_id: "greenhouse",
    source_label: "Greenhouse",
    query_count: 1,
    query_statuses: ["success"],
    result_count: 1,
    job_count: 1,
    full_text_job_count: 1,
    page_attempted_job_count: 1,
    classified_job_count: 1,
    search_reported_tokens: 0,
    page_reported_tokens: 123,
    labels: ["agentic_engineer"],
    search_errors: [],
    page_errors: [],
    sample_jobs: [
      {
        id: "42",
        title: "Senior Agentic Engineer",
        company_hint: "Acme",
        url: "https://example.com/jobs/42",
        category: "agentic_engineer",
        markdown:
          "Title: Senior Agentic Engineer\n\n## About the role\n\nResponsibilities include building useful agent systems.\n\n## Requirements\n\nSenior software engineering experience with product delivery.\n\n".repeat(
            10,
          ),
        labels: [{ label: "agentic_engineer" }],
      },
    ],
    ...overrides,
  };
}

describe("Source coverage SQL", () => {
  test("builds a run-scoped source coverage query across search, pages, and labels", () => {
    const sql = buildSourceCoverageSql(123);

    expect(sql).toContain("WITH source_catalog");
    expect(sql).toContain("current_run AS");
    expect(sql).toContain("sq.run_id = 123");
    expect(sql).toContain("job_search.search_queries sq");
    expect(sql).toContain("job_search.search_results sr");
    expect(sql).toContain("job_search.job_pages jp");
    expect(sql).toContain("jp.fetched_at >= cr.started_at");
    expect(sql).toContain("jpia.attempted_at >= cr.started_at");
    expect(sql).toContain("j.classified_at >= cr.started_at");
    expect(sql).toContain("jcl.classified_at >= cr.started_at");
    expect(sql).toContain("job_search.job_classification_labels jcl");
    expect(sql).toContain("job_search.job_page_ingest_attempts jpia");
    expect(sql).toContain("search_reported_tokens");
    expect(sql).toContain("page_reported_tokens");
    expect(sql).toContain("'markdown'");
    expect(sql).toContain("'labels'");
    expect(sql).toContain("'greenhouse'");
    expect(sql).toContain("'other-pages'");
  });

  test("builds a run context query for report-only regeneration", () => {
    const sql = buildSourceCoverageRunContextSql(123);

    expect(sql).toContain("FROM job_search.search_runs");
    expect(sql).toContain("WHERE id = 123");
    expect(sql).toContain("'timeFilter', time_filter");
  });
});

describe("Source coverage outcomes", () => {
  test("marks full search, full text, and classification evidence as confirmed", () => {
    expect(sourceCoverageOutcome(row({}))).toBe("confirmed");
    expect(sourceCoverageReasons(row({}))).toContain(
      "search, full text, and classification evidence present",
    );
  });

  test("separates partial, blocked, and untested source states", () => {
    expect(sourceCoverageOutcome(row({ full_text_job_count: 0, classified_job_count: 0 }))).toBe(
      "partial",
    );
    expect(sourceCoverageOutcome(row({ search_errors: ["timeout: Jina search timed out"] }))).toBe(
      "blocked",
    );
    expect(sourceCoverageOutcome(row({ query_count: 0, result_count: 0, job_count: 0 }))).toBe(
      "untested",
    );
    expect(sourceCoverageOutcome(row({ query_statuses: ["direct"] }))).toBe("partial");
    expect(sourceCoverageReasons(row({ query_statuses: ["direct"] }))).toContain(
      "direct URL stored an entry-point page, not discovered individual job postings",
    );
  });

  test("screens full-text samples before treating coverage as confirmed", () => {
    const screened = applySourceCoverageScreening([
      row({
        sample_jobs: [
          {
            id: "42",
            title: "Senior Agentic Engineer",
            company_hint: "Acme",
            url: "https://example.com/jobs/42",
            category: "agentic_engineer",
            markdown: "This position is closed and no longer accepting applications.",
            labels: [{ label: "agentic_engineer" }],
          },
        ],
      }),
    ])[0];

    expect(screened).toBeDefined();
    if (!screened) throw new Error("screened row missing");
    expect(screened.usable_full_text_job_count).toBe(0);
    expect(screened.rejected_job_count).toBe(1);
    expect(sourceCoverageOutcome(screened)).toBe("partial");
    expect(sourceCoverageReasons(screened)).toContain(
      "full-text snapshots were screened out as unusable, stale, or ineligible",
    );
  });
});

describe("renderSourceCoverageMarkdown", () => {
  test("renders confirmed, partial, blocked, and untested sections", () => {
    const markdown = renderSourceCoverageMarkdown(
      [
        row({ source_id: "greenhouse", source_label: "Greenhouse" }),
        row({
          source_id: "lever",
          source_label: "Lever",
          full_text_job_count: 0,
          classified_job_count: 0,
        }),
        row({
          source_id: "adp",
          source_label: "ADP",
          query_statuses: ["timeout"],
          result_count: 0,
          job_count: 0,
          full_text_job_count: 0,
          classified_job_count: 0,
          search_errors: ["timeout: Jina search timed out"],
        }),
        row({
          source_id: "glassdoor",
          source_label: "Glassdoor",
          query_count: 0,
          query_statuses: [],
          result_count: 0,
          job_count: 0,
          full_text_job_count: 0,
          page_attempted_job_count: 0,
          classified_job_count: 0,
          labels: [],
          sample_jobs: [],
        }),
      ],
      {
        generatedAt: new Date("2026-05-21T00:00:00.000Z"),
        runId: 123,
        keyword: "Agentic",
        timeFilter: "24hours",
        includeRemote: true,
        location: null,
      },
    );

    expect(markdown).toContain("# Source Coverage");
    expect(markdown).toContain("- Confirmed: 1");
    expect(markdown).toContain("- Partial: 1");
    expect(markdown).toContain("- Blocked: 1");
    expect(markdown).toContain("- Untested: 1");
    expect(markdown).toContain("- Page reported tokens: 492");
    expect(markdown).toContain("- Usable full-text jobs: 1");
    expect(markdown).toContain("Senior Agentic Engineer (agentic_engineer)");
    expect(markdown).toContain("1/1");
    expect(markdown).toContain("timeout: Jina search timed out");
  });
});
