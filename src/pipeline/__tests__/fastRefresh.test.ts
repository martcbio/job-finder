import { describe, expect, test } from "bun:test";
import {
  buildFastRefreshRunSql,
  buildFastRefreshSourceAdapters,
  buildLatestFastRefreshRunSql,
  buildLatestJobRowsSql,
  type FastRefreshJobRow,
  jobRowToSummary,
  listFastRefreshSources,
  normalizeFastRefreshOptions,
  SOURCE_ATTEMPT_STATUSES,
  sourceAttemptStatus,
} from "../fastRefresh";

function baseRow(overrides: Partial<FastRefreshJobRow> = {}): FastRefreshJobRow {
  return {
    id: 1,
    title: "Senior Agentic Engineer",
    company: "Acme",
    canonical_url: "https://jobserve.com/gb/en/job/senior-agentic-engineer",
    review_state: "ready_for_review",
    category: "agentic_engineer",
    rag_focus: "yes",
    enterprise_focus: "yes",
    classification_confidence: "0.7400",
    classification_reason: "matched agent/LLM application engineering language",
    page_ingest_status: "success",
    first_seen_at: "2026-05-21T00:00:00.000Z",
    last_seen_at: "2026-05-21T01:00:00.000Z",
    source_id: "jobserve",
    source_label: "JobServe",
    observed_url: "https://www.jobserve.com/gb/en/job/senior-agentic-engineer/",
    description_sample: "Outside IR35 contract building agentic systems. Remote across Europe.",
    markdown:
      "# Senior Agentic Engineer\n\n- Location: Remote, Europe\n- Apply URL: https://www.jobg8.com/traffic/apply/abc\n- Source URL: http://www.jobserve.com/abc\n\nResponsibilities, requirements, qualifications, outside IR35 contract, agentic systems, RAG, enterprise workflows, remote across Europe.",
    page_status: "success",
    page_error: null,
    page_usage_tokens: null,
    page_decompressed_bytes: 2048,
    labels: [
      {
        label: "agentic_engineer",
        source_stage: "page",
        confidence: "0.7400",
        reason: "matched agentic",
      },
      {
        label: "rag_enterprise",
        source_stage: "page",
        confidence: "0.7600",
        reason: "matched RAG and enterprise",
      },
    ],
    duplicate_candidates: [
      {
        id: "22",
        state: "suggested",
        confidence: "0.8300",
        reason: "same company and similar title",
      },
    ],
    review_events: [],
    ...overrides,
  };
}

describe("fast refresh contract helpers", () => {
  test("normalizes defaults while preserving explicit JobServe queries", () => {
    const options = normalizeFastRefreshOptions({
      limit: 5,
      jobserveQueries: ["agentic", "rag"],
    });

    expect(options.limit).toBe(5);
    expect(options.sourceIds).toEqual(["jobserve", "linear-careers"]);
    expect(options.jobserveQueries).toEqual(["agentic", "rag"]);
    expect(options.jobserveMaxPages).toBe(3);
  });

  test("builds concrete source adapters for JobServe queries and Linear Careers", () => {
    const adapters = buildFastRefreshSourceAdapters({
      sourceIds: ["jobserve", "linear-careers"],
      jobserveQueries: ["agentic", "rag"],
      jobserveMaxPages: 2,
    });

    expect(adapters.map((adapter) => adapter.id)).toEqual([
      "jobserve",
      "jobserve",
      "linear-careers",
    ]);
    expect(adapters.map((adapter) => adapter.defaultKeyword)).toEqual([
      "agentic",
      "rag",
      "linear-careers",
    ]);
    expect(adapters[0]?.discover).toBeFunction();
  });

  test("source adapter descriptors are stable enough for UI and source-scoped refresh", () => {
    const sources = listFastRefreshSources({
      sourceIds: ["jobserve", "linear-careers"],
      jobserveQueries: ["agentic"],
      jobserveMaxPages: 1,
    });

    expect(sources).toEqual([
      {
        id: "jobserve",
        label: "JobServe",
        kind: "recruiter",
        quality: "medium",
        defaultKeyword: "agentic",
        defaultIncluded: true,
        supportsSourceScopedRefresh: true,
      },
      {
        id: "linear-careers",
        label: "Linear Careers",
        kind: "direct_employer",
        quality: "high",
        defaultKeyword: "linear-careers",
        defaultIncluded: true,
        supportsSourceScopedRefresh: true,
      },
    ]);
  });

  test("maps detailed source outcomes to the API attempt status vocabulary", () => {
    expect(SOURCE_ATTEMPT_STATUSES).toEqual([
      "success",
      "zero_results",
      "partial",
      "blocked",
      "timeout",
      "parser_error",
      "rate_limited",
      "auth_required",
    ]);
    expect(sourceAttemptStatus("success", 2)).toBe("success");
    expect(sourceAttemptStatus("zero_results", 0)).toBe("zero_results");
    expect(sourceAttemptStatus("http_error", 1)).toBe("partial");
    expect(sourceAttemptStatus("blocked_captcha", 0)).toBe("blocked");
    expect(sourceAttemptStatus("timeout", 0)).toBe("timeout");
    expect(sourceAttemptStatus("parse_error", 0)).toBe("parser_error");
    expect(sourceAttemptStatus("http_error", 0, ["HTTP 429 rate limited"])).toBe("rate_limited");
    expect(sourceAttemptStatus("blocked_auth", 0)).toBe("auth_required");
  });

  test("maps DB rows to UI-facing summaries with links, classification, eligibility, and dedupe", () => {
    const summary = jobRowToSummary(baseRow());
    const apply = summary.links.find((link) => link.kind === "apply");

    expect(summary.source.id).toBe("jobserve");
    expect(summary.source.quality).toBe("medium");
    expect(summary.links.map((link) => link.kind)).toContain("canonical");
    expect(apply?.blocked).toBe(true);
    expect(apply?.note).toContain("CAPTCHA");
    expect(summary.classification.labels).toContain("rag_enterprise");
    expect(summary.eligibility.status).toBe("likely_ok");
    expect(summary.ingest.fullTextStatus).toBe("success");
    expect(summary.dedupe.candidateCount).toBe(1);
    expect(summary.cost.jinaReaderTokens).toBe(0);
  });

  test("exposes blocked and snippet-only full-text states instead of flattening them", () => {
    const blocked = jobRowToSummary(
      baseRow({
        markdown: "Verify you are human before continuing. CAPTCHA required.",
        page_status: "error",
        page_error: "captcha required",
      }),
    );
    const snippetOnly = jobRowToSummary(
      baseRow({
        markdown: null,
        page_status: null,
        page_error: null,
        page_ingest_status: "pending",
        description_sample: "Short outward listing snippet only.",
      }),
    );

    expect(blocked.ingest.fullTextStatus).toBe("blocked");
    expect(blocked.eligibility.status).toBe("likely_reject");
    expect(snippetOnly.ingest.fullTextStatus).toBe("snippet_only");
  });

  test("builds source-filtered latest-job SQL for fast readback", () => {
    const sql = buildLatestJobRowsSql({
      limit: 20,
      runIds: [7, 8],
      sourceIds: ["jobserve", "linear-careers"],
    });

    expect(sql).toContain("latest_observation.run_id IN (7, 8)");
    expect(sql).toContain("'jobserve'");
    expect(sql).toContain("'linear-careers'");
    expect(sql).toContain("LIMIT 20");
  });

  test("builds run detail SQL with explicit source outcome states and costs", () => {
    const sql = buildFastRefreshRunSql("99");

    expect(sql).toContain("blocked_captcha");
    expect(sql).toContain("blocked_auth");
    expect(sql).toContain("http_error");
    expect(sql).toContain("jinaReaderTokens");
    expect(sql).toContain("WHERE sr.id = '99'");
  });

  test("builds latest run detail SQL for the refresh run alias", () => {
    const sql = buildLatestFastRefreshRunSql();

    expect(sql).toContain("latest_sr.id");
    expect(sql).toContain("ORDER BY latest_sr.started_at DESC");
    expect(sql).not.toContain("sourceAttemptStatusFromQueryStatus");
  });
});
