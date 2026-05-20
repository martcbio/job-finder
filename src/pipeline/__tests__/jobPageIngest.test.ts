import { describe, expect, test } from "bun:test";
import {
  buildInsertPageIngestAttemptSql,
  buildPendingPageIngestSql,
  buildUpsertJobPageSql,
} from "../jobPageIngest";

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
    expect(sql).toContain("'jina_reader'");
    expect(sql).toContain("Title: Agentic Engineer");
    expect(sql).toContain("usage_tokens");
    expect(sql).toContain("DELETE FROM job_search.job_classification_labels");
    expect(sql).toContain("source_stage = 'page'");
    expect(sql).toContain("category = CASE WHEN category = 'unclassified'");
    expect(sql).toContain("classification_confidence = CASE WHEN category = 'unclassified'");
  });

  test("upserts ATS metadata separately from Jina markdown", () => {
    const sql = buildUpsertJobPageSql(
      { id: "42", title: "Engineer", canonical_url: "https://example.com/job" },
      {
        source: "ats_api",
        status: "success",
        markdown: "## ATS Structured Data\n- Workplace type: Remote",
        usageTokens: null,
        decompressedBytes: null,
        error: null,
      },
    );

    expect(sql).toContain("'ats_api'");
    expect(sql).toContain("## ATS Structured Data");
    expect(sql).toContain("NULL");
  });

  test("upserts plain HTTP extraction as a first-class page source", () => {
    const sql = buildUpsertJobPageSql(
      { id: "42", title: "Engineer", canonical_url: "https://example.com/job" },
      {
        source: "http_extract",
        status: "success",
        markdown: "Title: Engineer\n\nBuild useful systems.",
        usageTokens: null,
        decompressedBytes: 2048,
        error: null,
      },
    );

    expect(sql).toContain("'http_extract'");
    expect(sql).toContain("Title: Engineer");
    expect(sql).toContain("2048");
  });
});

describe("buildInsertPageIngestAttemptSql", () => {
  test("records method attempts with structured metadata", () => {
    const sql = buildInsertPageIngestAttemptSql("42", {
      source: "ats_api",
      status: "success",
      durationMs: 123,
      usageTokens: null,
      metadata: { source: "greenhouse", workplaceType: null },
      error: null,
    });

    expect(sql).toContain("INSERT INTO job_search.job_page_ingest_attempts");
    expect(sql).toContain("'ats_api'");
    expect(sql).toContain("'success'");
    expect(sql).toContain("123");
    expect(sql).toContain('"source":"greenhouse"');
  });
});
