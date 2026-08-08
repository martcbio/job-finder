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
import { outcomeAfterPersistence } from "../fastRefresh/adapters";
import { discoveryOutcome } from "../fastRefresh/sourceFactories";

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
    const defaults = normalizeFastRefreshOptions();
    const options = normalizeFastRefreshOptions({
      limit: 5,
      jobserveQueries: ["agentic", "rag"],
    });

    expect(defaults.jobserveQueries).toEqual(["AI engineer", "agentic AI", "LLM engineer"]);
    expect(options.limit).toBe(5);
    expect(options.sourceIds).toEqual(["jobserve", "linear-careers", "google-careers"]);
    expect(options.jobserveQueries).toEqual(["agentic", "rag"]);
    expect(options.jobserveMaxPages).toBe(2);
    expect(options.jobserveImportLimitPerQuery).toBe(5);
  });

  test("refuses JobServe refresh settings that exceed the fair-use safety envelope", () => {
    expect(() =>
      normalizeFastRefreshOptions({
        jobserveQueries: ["one", "two", "three", "four"],
      }),
    ).toThrow("JobServe refresh is limited to 3 queries");
    expect(() => normalizeFastRefreshOptions({ jobserveMaxPages: 3 })).toThrow(
      "JobServe refresh is limited to 2 pages per query",
    );
    expect(() => normalizeFastRefreshOptions({ jobserveImportLimitPerQuery: 6 })).toThrow(
      "JobServe refresh is limited to 5 detail pages per query",
    );
  });

  test("builds concrete source adapters for JobServe and direct careers sources", () => {
    const adapters = buildFastRefreshSourceAdapters({
      sourceIds: ["jobserve", "linear-careers", "google-careers"],
      jobserveQueries: ["agentic", "rag"],
      jobserveMaxPages: 2,
    });

    expect(adapters.map((adapter) => adapter.id)).toEqual([
      "jobserve",
      "jobserve",
      "linear-careers",
      "google-careers",
    ]);
    expect(adapters.map((adapter) => adapter.defaultKeyword)).toEqual([
      "agentic",
      "rag",
      "linear-careers",
      "google-careers",
    ]);
    expect(adapters[0]?.discover).toBeFunction();
  });

  test("keeps JobServe usage restriction run-wide while allowing direct sources to continue", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    const fetcher = Object.assign(
      async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("jobserve.com")) {
          return new Response(
            "<h1>Usage Restricted</h1><p>Your IP Address has been deemed to exceed our fair usage levels.</p>",
          );
        }
        if (url === "https://linear.app/careers") {
          return new Response(
            '<a href="/careers/00000000-0000-4000-8000-000000000001">Senior Engineer Europe Learn more →</a>',
          );
        }
        if (url === "https://linear.app/careers/00000000-0000-4000-8000-000000000001") {
          return new Response("<main><h1>Senior Engineer</h1><p>Build systems.</p></main>");
        }
        throw new Error(`Unexpected request: ${url}`);
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;
    globalThis.fetch = fetcher;

    try {
      const adapters = buildFastRefreshSourceAdapters({
        sourceIds: ["jobserve", "linear-careers"],
        jobserveQueries: ["one", "two", "three"],
        jobserveMaxPages: 1,
      });
      const receipts = [];
      for (const adapter of adapters) {
        receipts.push(
          await adapter.discover({ keyword: adapter.defaultKeyword, limit: 1, timeoutMs: 1000 }),
        );
      }

      expect(receipts).toHaveLength(4);
      expect(receipts.slice(0, 3).map((receipt) => receipt.outcome)).toEqual([
        "blocked_robots_or_waf",
        "blocked_robots_or_waf",
        "blocked_robots_or_waf",
      ]);
      expect(receipts[1]?.errors[0]).toContain("query skipped");
      expect(receipts[3]).toMatchObject({
        source: { id: "linear-careers" },
        outcome: "success",
        discovered: 1,
        excluded: 0,
      });
      expect(calls.filter((url) => url.includes("jobserve.com"))).toHaveLength(1);
      expect(calls.filter((url) => url.includes("linear.app/careers"))).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("turns ordinary JobServe detail failures into a partial source receipt", async () => {
    const originalFetch = globalThis.fetch;
    const seedHtml = `<form id="frm1" action="/gb/en/JobSearch.aspx?shid=400A6BF6B1A53C1181D0">
      <input name="ctl00$txtKeyWords" value="">
      <input name="selAge" value="3">
    </form>`;
    const submittedHtml = `<html><body>
      <form>
        <div id="joblistingcollection">
          <div class="jobListItem" id="ABC123">
            <a href="/gb/en/search-jobs/ABC123" class="jobListPosition">Senior AI Engineer</a>
            <a href="/gb/en/WABC123.jsap" class="jobListApply">Apply</a>
            <p class="jobListSkills">Build agentic systems. <a href="/gb/en/WABC123.jsjob">more</a></p>
            <label class="jobListLabel left">Rate</label><span class="jobListDetail left">£600 per day</span>
            <label class="jobListLabel left">Type</label><span class="jobListDetail left">Contract</span>
          </div>
        </div>
      </form>
    </body></html>`;
    const responses = [
      new Response(seedHtml),
      new Response(submittedHtml),
      new Response("temporarily unavailable", { status: 503 }),
    ];
    globalThis.fetch = (async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected JobServe request");
      return response;
    }) as unknown as typeof fetch;

    try {
      const [adapter] = buildFastRefreshSourceAdapters({
        sourceIds: ["jobserve"],
        jobserveQueries: ["agentic"],
        jobserveMaxPages: 1,
      });
      if (!adapter) throw new Error("Expected JobServe adapter");

      const receipt = await adapter.discover({ keyword: "agentic", limit: 1, timeoutMs: 1000 });

      expect(receipt).toMatchObject({ outcome: "http_error", discovered: 1, excluded: 0 });
      expect(receipt.jobs).toHaveLength(1);
      expect(receipt.errors[0]).toContain("JobServe detail fetch failed");
      expect(sourceAttemptStatus(receipt.outcome, receipt.jobs.length, receipt.errors)).toBe(
        "partial",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("acquires every Linear card and derives excluded from discovered minus jobs", async () => {
    const originalFetch = globalThis.fetch;
    const listingId = (index: number) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const listings = Array.from(
      { length: 18 },
      (_, index) =>
        `<a href="/careers/${listingId(index + 1)}">Engineer ${index + 1} Europe Learn more →</a>`,
    ).join("\n");
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://linear.app/careers") return new Response(listings);
      return new Response("<main><h1>Engineer</h1><p>Build systems.</p></main>");
    }) as typeof fetch;

    try {
      const [adapter] = buildFastRefreshSourceAdapters({
        sourceIds: ["linear-careers"],
        jobserveQueries: [],
        jobserveMaxPages: 1,
      });
      if (!adapter) throw new Error("Expected Linear adapter");

      const receipt = await adapter.discover({
        keyword: "linear-careers",
        limit: 1,
        timeoutMs: 1000,
      });

      expect(receipt.discovered).toBe(18);
      expect(receipt.jobs).toHaveLength(18);
      expect(receipt.excluded).toBe(receipt.discovered - receipt.jobs.length);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("source adapter descriptors are stable enough for UI and source-scoped refresh", () => {
    const sources = listFastRefreshSources({
      sourceIds: ["jobserve", "linear-careers", "google-careers"],
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
      {
        id: "google-careers",
        label: "Google Careers",
        kind: "direct_employer",
        quality: "high",
        defaultKeyword: "google-careers",
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

  test("keeps blocked discovery primary when persistence also has errors", () => {
    expect(outcomeAfterPersistence("blocked_robots_or_waf", 1)).toBe("blocked_robots_or_waf");
    expect(outcomeAfterPersistence("success", 1)).toBe("http_error");
  });

  test("reports a bounded Google listing scan as structured partial discovery", () => {
    expect(
      discoveryOutcome(
        5,
        [
          "Google Careers discovery stopped at the 5-page safety cap while the final page still contained listings.",
        ],
        null,
        true,
      ),
    ).toBe("partial");
    expect(sourceAttemptStatus("partial", 5)).toBe("partial");
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
    expect(summary.ingest.markdownLineCount).toBeGreaterThan(1);
    expect(summary.ingest.markdownBulletCount).toBeGreaterThan(1);
    expect(summary.dedupe.candidateCount).toBe(1);
    expect(summary.cost.jinaReaderTokens).toBe(0);
  });

  test("surfaces capture quality flags from stored markdown metadata", () => {
    const summary = jobRowToSummary(
      baseRow({
        markdown:
          "# Senior Agentic Engineer\n\n- Capture quality flags: single_line_long_body, nav_or_cookie_boilerplate\n\nBody",
      }),
    );

    expect(summary.ingest.captureQualityFlags).toEqual([
      "single_line_long_body",
      "nav_or_cookie_boilerplate",
    ]);
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
    expect(sql).toContain('"classificationCount"');
    expect(sql).toContain("job_classification_labels");
    expect(sql).toContain("WHERE sr.id = '99'");
  });

  test("builds latest run detail SQL for the refresh run alias", () => {
    const sql = buildLatestFastRefreshRunSql();

    expect(sql).toContain("latest_sr.id");
    expect(sql).toContain("ORDER BY latest_sr.started_at DESC");
    expect(sql).not.toContain("sourceAttemptStatusFromQueryStatus");
  });
});
