import { describe, expect, test } from "bun:test";
import { type ApiQuery, createJobFinderApiHandler, type FastRefreshRunner } from "../server";

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://job-finder.local.test${path}`, init);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function handlerWithQuery(
  query: (sql: string) => Promise<unknown>,
  fastRefresh?: FastRefreshRunner,
) {
  const typedQuery: ApiQuery = async <T>(sql: string): Promise<T> => {
    return (await query(sql)) as T;
  };

  return createJobFinderApiHandler({
    query: typedQuery,
    ...(fastRefresh ? { fastRefresh } : {}),
    now: () => new Date("2026-05-21T00:00:00.000Z"),
    env: {
      DATABASE_URL: "postgres://mcb@localhost:5432/jobs",
    },
    allowOrigins: ["http://localhost:5173"],
  });
}

describe("job-finder API", () => {
  test("GET /api/meta exposes frontend enums and treats Notion as optional", async () => {
    const handler = createJobFinderApiHandler({
      env: {
        DATABASE_URL: "postgres://mcb@localhost:5432/jobs",
      },
    });

    const response = await handler(request("/api/meta"));
    const body = await json(response);
    const data = body.data as Record<string, unknown>;
    const integrations = data.integrations as Record<string, Record<string, unknown>>;
    const pipeline = data.pipeline as Record<string, unknown>;
    const sourceLanes = pipeline.sourceLanes as Array<Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(data.reviewStates).toContain("ready_for_review");
    expect(data.applicationStatuses).toContain("interested");
    expect(data.applicationStatuses).toContain("interview");
    expect(sourceLanes.map((lane) => lane.id)).toContain("jobspy");
    expect(integrations.jina?.requiredForSearch).toBe(false);
    expect(integrations.jina?.configured).toBe(false);
    expect(integrations.openrouter?.requiredForFastRefresh).toBe(false);
    expect(integrations.notion?.mode).toBe("optional");
    expect(integrations.notion?.requiredForApiStartup).toBe(false);
    expect(integrations.notion?.configured).toBe(false);
  });

  test("GET /api/health reports DB and integration status", async () => {
    const calls: string[] = [];
    const handler = handlerWithQuery(async (sql) => {
      calls.push(sql);
      if (sql.includes("current_database()")) {
        return {
          database: "jobs",
          user: "mcb",
          schema: "job_search",
          version: "PostgreSQL 18.4",
        };
      }
      if (sql.includes("schema_migrations")) {
        return { applied: 13, latest: "013" };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const response = await handler(request("/api/health"));
    const body = await json(response);
    const data = body.data as Record<string, unknown>;
    const migrations = data.migrations as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(migrations.applied).toBe(13);
  });

  test("GET /api/jobs/queue validates filters and returns queued jobs", async () => {
    const calls: string[] = [];
    const handler = handlerWithQuery(async (sql) => {
      calls.push(sql);
      expect(sql).toContain("ready_for_review");
      return [
        {
          id: "1",
          title: "Senior Agentic Engineer",
          company_hint: "Webflow",
          canonical_url: "https://job-boards.greenhouse.io/webflow/jobs/7914493",
          review_state: "ready_for_review",
          category: "agentic_engineer",
          rag_focus: "yes",
          enterprise_focus: "yes",
          classification_confidence: "0.74",
          classification_labels: [],
          duplicate_candidates: [],
          latest_review_event: null,
          source_labels: ["Greenhouse"],
          last_seen_at: "2026-05-20T21:05:25.810932+07:00",
          description_sample: "At Webflow...",
        },
      ];
    });

    const response = await handler(request("/api/jobs/queue?state=ready_for_review&limit=5"));
    const body = await json(response);
    const data = body.data as unknown[];

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(data).toHaveLength(1);
  });

  test("POST /api/refresh/fast runs the shared fast-refresh service with bounded options", async () => {
    const calls: unknown[] = [];
    const handler = handlerWithQuery(
      async () => {
        throw new Error("query should not run for injected fast refresh");
      },
      async (options) => {
        calls.push(options);
        return {
          startedAt: "2026-05-21T00:00:00.000Z",
          finishedAt: "2026-05-21T00:00:01.250Z",
          elapsedMs: 1250,
          options: {
            limit: 3,
            sourceIds: ["jobserve", "linear-careers"],
            jobserveQueries: ["agentic"],
            jobserveMaxPages: 1,
            jobserveImportLimitPerQuery: 2,
            directLimit: 1,
            timeoutMs: 5000,
            classifyLimit: 10,
          },
          sources: [
            {
              source: {
                id: "jobserve",
                label: "JobServe",
                kind: "recruiter",
                quality: "medium",
              },
              keyword: "agentic",
              runId: 44,
              outcome: "success",
              status: "success",
              discovered: 10,
              excluded: 3,
              imported: 2,
              fullText: { persisted: 2, fetchedPages: 1, status: "success" },
              classification: { classified: 2 },
              costs: {
                jinaSearchTokens: 0,
                jinaReaderTokens: 0,
                openAiTokens: 0,
                billableSearchApiCalls: 0,
              },
              elapsedMs: 1000,
              errors: [],
              blockedReason: null,
            },
          ],
          classified: [{ runId: 44, classified: 2 }],
          costs: {
            jinaSearchTokens: 0,
            jinaReaderTokens: 0,
            openAiTokens: 0,
            billableSearchApiCalls: 0,
          },
          latest: { jobs: [], jobserve: [], direct: [] },
        };
      },
    );

    const response = await handler(
      request("/api/refresh/fast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          limit: 3,
          jobserveQueries: ["agentic"],
          jobserveMaxPages: 1,
          jobserveImportLimitPerQuery: 2,
          directLimit: 1,
          timeoutMs: 5000,
          classifyLimit: 10,
        }),
      }),
    );
    const body = await json(response);
    const data = body.data as Record<string, unknown>;
    const sources = data.sources as Array<Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      limit: 3,
      jobserveQueries: ["agentic"],
      jobserveMaxPages: 1,
      jobserveImportLimitPerQuery: 2,
      directLimit: 1,
      timeoutMs: 5000,
      classifyLimit: 10,
    });
    expect(sources[0]?.outcome).toBe("success");
    expect(sources[0]?.status).toBe("success");
    expect(sources[0]?.excluded).toBe(3);
    expect((sources[0]?.classification as Record<string, unknown>)?.classified).toBe(2);
    expect(data.elapsedMs).toBe(1250);
  });

  test("GET /api/sources exposes source-scoped refresh metadata and attempt statuses", async () => {
    const handler = handlerWithQuery(async () => {
      throw new Error("query should not run for source metadata");
    });

    const response = await handler(request("/api/sources"));
    const body = await json(response);
    const data = body.data as Record<string, unknown>;
    const sources = data.fastRefresh as Array<Record<string, unknown>>;
    const statuses = data.attemptStatuses as string[];

    expect(response.status).toBe(200);
    expect(sources.map((source) => source.id)).toContain("jobserve");
    expect(sources.map((source) => source.id)).toContain("linear-careers");
    const queueRefresh = data.queueRefresh as Array<Record<string, unknown>>;
    const refreshableSourceIds = data.refreshableSourceIds as string[];
    expect(queueRefresh.map((source) => source.id)).toContain("rippling");
    expect(queueRefresh.map((source) => source.id)).toContain("jobspy");
    expect(queueRefresh.length).toBeGreaterThan(10);
    expect(refreshableSourceIds).toContain("greenhouse");
    expect(refreshableSourceIds).toContain("jobspy");
    expect(statuses).toContain("partial");
    expect(statuses).toContain("auth_required");
  });

  test("POST /api/refresh/source/:source constrains fast refresh to one source", async () => {
    const calls: unknown[] = [];
    const handler = handlerWithQuery(
      async () => {
        throw new Error("query should not run for injected source refresh");
      },
      async (options) => {
        calls.push(options);
        return {
          startedAt: "2026-05-21T00:00:00.000Z",
          finishedAt: "2026-05-21T00:00:00.250Z",
          elapsedMs: 250,
          options: {
            limit: 2,
            sourceIds: ["linear-careers"],
            jobserveQueries: ["agentic"],
            jobserveMaxPages: 1,
            jobserveImportLimitPerQuery: 1,
            directLimit: 2,
            timeoutMs: 5000,
            classifyLimit: 10,
          },
          sources: [
            {
              source: {
                id: "linear-careers",
                label: "Linear Careers",
                kind: "direct_employer",
                quality: "high",
              },
              keyword: "linear-careers",
              runId: 45,
              outcome: "success",
              status: "success",
              discovered: 18,
              excluded: 0,
              imported: 2,
              fullText: { persisted: 2, fetchedPages: null, status: "success" },
              classification: { classified: 2 },
              costs: {
                jinaSearchTokens: 0,
                jinaReaderTokens: 0,
                openAiTokens: 0,
                billableSearchApiCalls: 0,
              },
              elapsedMs: 250,
              errors: [],
              blockedReason: null,
            },
          ],
          classified: [{ runId: 45, classified: 2 }],
          costs: {
            jinaSearchTokens: 0,
            jinaReaderTokens: 0,
            openAiTokens: 0,
            billableSearchApiCalls: 0,
          },
          latest: { jobs: [], jobserve: [], direct: [] },
        };
      },
    );

    const response = await handler(
      request("/api/refresh/source/linear", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 2, directLimit: 2, jobserveMaxPages: 1, timeoutMs: 5000 }),
      }),
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sourceIds: ["linear-careers"],
      limit: 2,
      directLimit: 2,
    });
  });

  test("GET /api/jobs/latest returns UI-facing summaries with classification and eligibility", async () => {
    const calls: string[] = [];
    const handler = handlerWithQuery(async (sql) => {
      calls.push(sql);
      expect(sql).toContain("job_search.job_pages");
      return [
        {
          id: 12,
          title: "Forward Deployed AI Engineer",
          company: "Linear",
          canonical_url: "https://linear.app/careers/00000000-0000-0000-0000-000000000000",
          review_state: "ready_for_review",
          category: "fde",
          rag_focus: "yes",
          enterprise_focus: "yes",
          classification_confidence: "0.7600",
          classification_reason: "matched FDE/customer-facing engineering language",
          page_ingest_status: "success",
          first_seen_at: "2026-05-21T00:00:00.000Z",
          last_seen_at: "2026-05-21T00:01:00.000Z",
          source_id: "linear-careers",
          source_label: "Linear Careers",
          observed_url: "https://linear.app/careers/00000000-0000-0000-0000-000000000000",
          description_sample: "What you'll do: build AI agent workflows. Remote across Europe.",
          markdown:
            "# Linear - Forward Deployed AI Engineer\n\n- Source: Linear Careers\n- Job URL: https://linear.app/careers/00000000-0000-0000-0000-000000000000\n- Location: Europe, North America\n\nWhat you'll do: build AI agent workflows, requirements, qualifications, responsibilities, enterprise RAG workflows, customer engineering, and remote across Europe.",
          page_status: "success",
          page_error: null,
          page_usage_tokens: null,
          page_decompressed_bytes: 2048,
          labels: [
            { label: "fde", source_stage: "page", confidence: "0.7600", reason: "matched FDE" },
            {
              label: "rag_enterprise",
              source_stage: "page",
              confidence: "0.7600",
              reason: "matched RAG",
            },
          ],
          duplicate_candidates: [],
          review_events: [],
        },
      ];
    });

    const response = await handler(request("/api/jobs/latest?limit=5"));
    const body = await json(response);
    const data = body.data as Array<Record<string, unknown>>;
    const first = data[0] as Record<string, unknown>;
    const source = first.source as Record<string, unknown>;
    const classification = first.classification as Record<string, unknown>;
    const eligibility = first.eligibility as Record<string, unknown>;
    const ingest = first.ingest as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(source.id).toBe("linear-careers");
    expect(classification.category).toBe("fde");
    expect(classification.labels).toContain("rag_enterprise");
    expect(eligibility.status).not.toBeUndefined();
    expect(ingest.fullTextStatus).toBe("success");
  });

  test("GET /api/runs/:id returns source-level refresh status", async () => {
    const calls: string[] = [];
    const handler = handlerWithQuery(async (sql) => {
      calls.push(sql);
      expect(sql).toContain("FROM job_search.search_runs sr");
      return {
        id: "44",
        startedAt: "2026-05-21T00:00:00.000Z",
        finishedAt: "2026-05-21T00:00:01.000Z",
        status: "completed",
        keyword: "jobserve:agentic",
        sourceSet: ["jobserve"],
        timeFilter: "normalized_import",
        limitPerQuery: 2,
        timeoutMs: 5000,
        totalReportedTokens: 0,
        errorSummary: null,
        elapsedMs: 1000,
        costs: {
          jinaSearchTokens: 0,
          jinaReaderTokens: 0,
          openAiTokens: 0,
          billableSearchApiCalls: 0,
        },
        sources: [
          {
            id: "jobserve",
            label: "JobServe",
            outcome: "success",
            status: "success",
            queryStatus: "success",
            query: "jobserve:agentic",
            directUrl: null,
            startedAt: "2026-05-21T00:00:00.000Z",
            finishedAt: "2026-05-21T00:00:01.000Z",
            usageTokens: null,
            decompressedBytes: null,
            error: null,
            candidateCount: 2,
            jobCount: 2,
            fullTextCount: 2,
            classificationCount: 2,
          },
        ],
      };
    });

    const response = await handler(request("/api/runs/44"));
    const body = await json(response);
    const data = body.data as Record<string, unknown>;
    const sources = data.sources as Array<Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(sources[0]?.candidateCount).toBe(2);
    expect(sources[0]?.classificationCount).toBe(2);
    expect(sources[0]?.outcome).toBe("success");
    expect(sources[0]?.status).toBe("success");
  });

  test("GET /api/runs/latest returns the newest persisted source run", async () => {
    const calls: string[] = [];
    const handler = handlerWithQuery(async (sql) => {
      calls.push(sql);
      expect(sql).toContain("latest_sr.id");
      return {
        id: "45",
        startedAt: "2026-05-21T00:00:00.000Z",
        finishedAt: "2026-05-21T00:00:01.000Z",
        status: "completed",
        keyword: "linear-careers",
        sourceSet: ["linear-careers"],
        timeFilter: "direct_source",
        limitPerQuery: 2,
        timeoutMs: 5000,
        totalReportedTokens: 0,
        errorSummary: null,
        elapsedMs: 1000,
        costs: {
          jinaSearchTokens: 0,
          jinaReaderTokens: 0,
          openAiTokens: 0,
          billableSearchApiCalls: 0,
        },
        sources: [],
      };
    });

    const response = await handler(request("/api/runs/latest"));
    const body = await json(response);
    const data = body.data as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(data.id).toBe("45");
  });

  test("GET /api/jobs/:id/full-text returns stored markdown and provenance", async () => {
    const calls: string[] = [];
    const handler = handlerWithQuery(async (sql) => {
      calls.push(sql);
      expect(sql).toContain("job_search.job_pages");
      return {
        jobId: "12",
        title: "Forward Deployed AI Engineer",
        company: "Linear",
        canonicalUrl: "https://linear.app/careers/00000000-0000-0000-0000-000000000000",
        reviewState: "ready_for_review",
        pageId: "99",
        status: "success",
        fetchedAt: "2026-05-21T00:00:00.000Z",
        fetchSource: "direct",
        sourceUrl: "https://linear.app/careers/00000000-0000-0000-0000-000000000000",
        rawTitle: "Forward Deployed AI Engineer",
        markdown: "# Forward Deployed AI Engineer\n\nFull text",
        usageTokens: 0,
        decompressedBytes: 2048,
        error: null,
        sourceId: "linear-careers",
        sourceLabel: "Linear Careers",
        observedUrl: "https://linear.app/careers/00000000-0000-0000-0000-000000000000",
      };
    });

    const response = await handler(request("/api/jobs/12/full-text"));
    const body = await json(response);
    const data = body.data as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(data.markdown).toContain("Full text");
    expect(data.sourceLabel).toBe("Linear Careers");
  });

  test("POST /api/jobs/:id/review rejects invalid states before touching DB", async () => {
    const handler = handlerWithQuery(async () => {
      throw new Error("query should not run");
    });

    const response = await handler(
      request("/api/jobs/1/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "auto_apply_everywhere" }),
      }),
    );
    const body = await json(response);
    const error = body.error as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(error.code).toBe("invalid_review_state");
  });

  test("POST /api/jobs/:id/review records a local review transition", async () => {
    const calls: string[] = [];
    const handler = handlerWithQuery(async (sql) => {
      calls.push(sql);
      expect(sql).toContain("UPDATE job_search.jobs");
      expect(sql).toContain("shortlisted");
      return {
        job_id: "1",
        from_state: "ready_for_review",
        to_state: "shortlisted",
        event_id: "7",
      };
    });

    const response = await handler(
      request("/api/jobs/1/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          state: "shortlisted",
          reasonCodes: ["strong_match"],
          note: "Looks relevant",
        }),
      }),
    );
    const body = await json(response);
    const data = body.data as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(data.to_state).toBe("shortlisted");
  });

  test("POST /api/duplicates/:candidateId/review records duplicate feedback", async () => {
    const calls: string[] = [];
    const handler = handlerWithQuery(async (sql) => {
      calls.push(sql);
      expect(sql).toContain("UPDATE job_search.duplicate_candidates");
      expect(sql).toContain("confirmed_distinct");
      return {
        id: "12",
        job_id_a: "1",
        job_id_b: "2",
        previous_state: "suggested",
        state: "confirmed_distinct",
      };
    });

    const response = await handler(
      request("/api/duplicates/12/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          state: "confirmed_distinct",
          reasonCodes: ["different_team"],
        }),
      }),
    );
    const body = await json(response);
    const data = body.data as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(data.state).toBe("confirmed_distinct");
  });

  test("POST /api/pipeline-runs returns a plan by default and gates execution", async () => {
    const handler = handlerWithQuery(async () => {
      throw new Error("query should not run for inline dry planning");
    });

    const planResponse = await handler(
      request("/api/pipeline-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          keywords: ["Agentic"],
          sites: ["greenhouse"],
          sourceLanes: ["source_search", "jobspy"],
          jobspyFile: "/data/jobspy.json",
        }),
      }),
    );
    const planBody = await json(planResponse);
    const planData = planBody.data as Record<string, unknown>;

    expect(planResponse.status).toBe(200);
    expect(planData.started).toBe(false);
    expect(planData.plan).toBeArray();
    expect(JSON.stringify(planData.plan)).toContain("jobs:import-normalized");

    const executeResponse = await handler(
      request("/api/pipeline-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          keywords: ["Agentic"],
          sites: ["greenhouse"],
          execute: true,
        }),
      }),
    );
    const executeBody = await json(executeResponse);
    const error = executeBody.error as Record<string, unknown>;

    expect(executeResponse.status).toBe(409);
    expect(error.code).toBe("confirmation_required");
  });

  test("OPTIONS returns CORS headers for an allowed frontend origin", async () => {
    const handler = handlerWithQuery(async () => []);
    const response = await handler(
      request("/api/jobs", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:5173" },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
  });
});
