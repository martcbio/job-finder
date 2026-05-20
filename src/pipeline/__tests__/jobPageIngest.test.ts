import { describe, expect, test } from "bun:test";
import { buildPendingPageIngestSql, buildUpsertJobPageSql } from "../jobPageIngest";

describe("buildPendingPageIngestSql", () => {
  test("selects jobs needing page ingestion", () => {
    const sql = buildPendingPageIngestSql(10);

    expect(sql).toContain("j.page_ingest_status IN ('pending', 'error', 'timeout')");
    expect(sql).toContain("LIMIT 10");
  });
});

describe("buildUpsertJobPageSql", () => {
  test("upserts successful page ingestion and resets stale classification", () => {
    const sql = buildUpsertJobPageSql(
      { id: "42", title: "Engineer", canonical_url: "https://example.com/job" },
      {
        status: "success",
        markdown: "Title: Agentic Engineer\n\nBuild retrieval agents.",
        usageTokens: 123,
        decompressedBytes: 456,
        error: null,
      },
    );

    expect(sql).toContain("ON CONFLICT (job_id, source)");
    expect(sql).toContain("Title: Agentic Engineer");
    expect(sql).toContain("usage_tokens");
    expect(sql).toContain("category = CASE WHEN category = 'unclassified'");
    expect(sql).toContain("classification_confidence = CASE WHEN category = 'unclassified'");
  });
});
