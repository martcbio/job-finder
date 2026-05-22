import { describe, expect, test } from "bun:test";
import {
  buildSourceAvailabilitySummary,
  renderSourceAvailabilityMarkdown,
  type SourceAvailabilityAttempt,
} from "../sourceAvailability";
import type { SourceCoverageRow } from "../sourceCoverage";

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
    page_reported_tokens: 25,
    labels: ["agentic_engineer"],
    search_errors: [],
    page_errors: [],
    sample_jobs: [
      {
        id: "1",
        title: "Agentic Engineer",
        company_hint: "Acme",
        url: "https://example.com/jobs/1",
        category: "agentic_engineer",
      },
    ],
    ...overrides,
  };
}

describe("Source availability summary", () => {
  test("aggregates discovery availability and ingest/classification rates by source", () => {
    const attempts: SourceAvailabilityAttempt[] = [
      {
        keyword: "Agentic",
        runIndex: 1,
        runId: 10,
        rows: [
          row({}),
          row({ source_id: "adp", source_label: "ADP", result_count: 0, job_count: 0 }),
        ],
      },
      {
        keyword: "RAG",
        runIndex: 1,
        runId: 11,
        rows: [
          row({
            query_statuses: ["error"],
            search_errors: ["error: provider down"],
            result_count: 0,
            job_count: 0,
            full_text_job_count: 0,
            classified_job_count: 0,
          }),
        ],
      },
    ];

    const summary = buildSourceAvailabilitySummary(attempts);
    const greenhouse = summary.sources.find((source) => source.sourceId === "greenhouse");
    const adp = summary.sources.find((source) => source.sourceId === "adp");

    expect(greenhouse?.attempts).toBe(2);
    expect(greenhouse?.availableAttempts).toBe(1);
    expect(greenhouse?.availabilityRate).toBe(0.5);
    expect(greenhouse?.fullTextRate).toBe(1);
    expect(adp?.availabilityRate).toBe(1);
    expect(adp?.fullTextRate).toBeNull();
  });

  test("renders a markdown report with targets, costs, outcomes, and reasons", () => {
    const summary = buildSourceAvailabilitySummary([
      {
        keyword: "Agentic",
        runIndex: 1,
        runId: 10,
        rows: [row({ page_reported_tokens: 99 })],
      },
    ]);

    const markdown = renderSourceAvailabilityMarkdown(summary);

    expect(markdown).toContain("# Source Availability");
    expect(markdown).toContain("- Availability target: 95.0%");
    expect(markdown).toContain("- Page reported tokens: 99");
    expect(markdown).toContain("confirmed:1");
    expect(markdown).toContain("covered");
  });

  test("uses screened usable full text for full-text rates", () => {
    const summary = buildSourceAvailabilitySummary([
      {
        keyword: "Agentic",
        runIndex: 1,
        runId: 10,
        rows: [row({ full_text_job_count: 1, usable_full_text_job_count: 0 })],
      },
    ]);

    const greenhouse = summary.sources.find((source) => source.sourceId === "greenhouse");

    expect(greenhouse?.fullTextJobs).toBe(0);
    expect(greenhouse?.fullTextRate).toBe(0);
  });
});
