import { describe, expect, test } from "bun:test";
import {
  buildGetSavedSweepSql,
  buildListSavedSweepsSql,
  buildUpsertSavedSweepSql,
  renderSavedSweepsMarkdown,
  savedSweepToPipelineOptions,
} from "../savedSweeps";

describe("saved sweep SQL", () => {
  test("builds upsert query", () => {
    const sql = buildUpsertSavedSweepSql({
      name: "daily-agentic",
      keywords: ["Agentic", "RAG"],
      sites: ["greenhouse", "lever"],
      timeFilter: "24hours",
      includeRemote: true,
      location: "Europe",
      maxQueries: 20,
      searchLimit: 5,
      searchTimeoutMs: 30000,
      pageLimit: 10,
      pageTimeoutMs: 45000,
      classifyLimit: 50,
      duplicateLimit: 250,
      duplicateThreshold: 0.82,
      queueLimit: 25,
      enabled: true,
    });

    expect(sql).toContain("INSERT INTO job_search.saved_sweeps");
    expect(sql).toContain("'daily-agentic'");
    expect(sql).toContain("ARRAY['Agentic', 'RAG']::text[]");
    expect(sql).toContain("ARRAY['greenhouse', 'lever']::text[]");
    expect(sql).toContain("ON CONFLICT (name) DO UPDATE");
    expect(sql).toContain("updated_at = now()");
  });

  test("builds get and list queries", () => {
    expect(buildGetSavedSweepSql("daily-agentic")).toContain("WHERE name = 'daily-agentic'");
    expect(buildListSavedSweepsSql(true)).toContain("WHERE enabled = true");
    expect(buildListSavedSweepsSql(false)).not.toContain("WHERE enabled = true");
  });
});

describe("saved sweep rendering and plan conversion", () => {
  const row = {
    id: "1",
    name: "daily-agentic",
    keywords: ["Agentic"],
    sites: ["greenhouse"],
    time_filter: "24hours",
    include_remote: true,
    location: null,
    max_queries: 12,
    search_limit: 5,
    search_timeout_ms: 30000,
    page_limit: 10,
    page_timeout_ms: 45000,
    classify_limit: 50,
    duplicate_limit: 250,
    duplicate_threshold: 0.82,
    queue_limit: 25,
    enabled: true,
    created_at: "2026-05-20T00:00:00.000Z",
    updated_at: "2026-05-20T00:00:00.000Z",
  };

  test("converts saved sweep rows into pipeline options", () => {
    const options = savedSweepToPipelineOptions(row, ["search"]);

    expect(options.keywords).toEqual(["Agentic"]);
    expect(options.sites).toEqual(["greenhouse"]);
    expect(options.skipSteps).toEqual(["search"]);
    expect(options.duplicateThreshold).toBe(0.82);
  });

  test("renders markdown", () => {
    const markdown = renderSavedSweepsMarkdown([row]);

    expect(markdown).toContain("# Saved Sweeps");
    expect(markdown).toContain("## daily-agentic");
    expect(markdown).toContain("- Keywords: Agentic");
    expect(markdown).toContain("- Duplicate scan: 250 jobs at 0.82");
  });
});
