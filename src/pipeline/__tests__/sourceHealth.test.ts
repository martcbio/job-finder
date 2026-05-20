import { describe, expect, test } from "bun:test";
import {
  buildSourceHealthSql,
  renderSourceHealthMarkdown,
  type SourceHealthRow,
} from "../sourceHealth";

describe("buildSourceHealthSql", () => {
  test("builds source health query from stored query and result records", () => {
    const sql = buildSourceHealthSql({ days: 14, minAttempts: 3 });

    expect(sql).toContain("FROM job_search.search_queries sq");
    expect(sql).toContain("LEFT JOIN job_search.search_results sr ON sr.query_id = sq.id");
    expect(sql).toContain("sq.started_at >= now() - (14 * interval '1 day')");
    expect(sql).toContain("WHERE attempts >= 3");
    expect(sql).toContain("unknown_usage_calls");
  });

  test("omits day filter when not requested", () => {
    const sql = buildSourceHealthSql({ days: null, minAttempts: 1 });

    expect(sql).not.toContain("interval '1 day'");
    expect(sql).toContain("WHERE attempts >= 1");
  });
});

describe("renderSourceHealthMarkdown", () => {
  test("renders empty source health report", () => {
    const markdown = renderSourceHealthMarkdown([], {
      generatedAt: new Date("2026-05-20T00:00:00.000Z"),
      filters: { days: null, minAttempts: 1 },
    });

    expect(markdown).toContain("# Source Health");
    expect(markdown).toContain("Sources: 0");
    expect(markdown).toContain("_No source health rows matched the filters._");
  });

  test("renders metric rows", () => {
    const row: SourceHealthRow = {
      source_id: "greenhouse",
      source_label: "Greenhouse",
      attempts: 4,
      successes: 3,
      direct: 0,
      timeouts: 1,
      errors: 0,
      success_rate: "0.7500",
      timeout_rate: "0.2500",
      avg_duration_ms: 1234,
      avg_reported_tokens: 1000,
      avg_results: 2.5,
      total_results: 10,
      total_reported_tokens: 3000,
      unknown_usage_calls: 1,
      last_success_at: "2026-05-20T00:00:00.000Z",
      last_attempt_at: "2026-05-20T01:00:00.000Z",
    };

    const markdown = renderSourceHealthMarkdown([row], {
      generatedAt: new Date("2026-05-20T02:00:00.000Z"),
      filters: { days: 7, minAttempts: 2 },
    });

    expect(markdown).toContain("Filters: min_attempts=2, days=7");
    expect(markdown).toContain("Greenhouse | 4 | 75.0%");
    expect(markdown).toContain("1 (25.0%)");
    expect(markdown).toContain("1000");
  });
});
