import { describe, expect, test } from "bun:test";
import { type ApiQuery, createJobFinderApiHandler } from "../server";

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://job-finder.local.test${path}`, init);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function handlerWithQuery(query: (sql: string) => Promise<unknown>) {
  const typedQuery: ApiQuery = async <T>(sql: string): Promise<T> => {
    return (await query(sql)) as T;
  };

  return createJobFinderApiHandler({
    query: typedQuery,
    now: () => new Date("2026-05-21T00:00:00.000Z"),
    env: {
      DATABASE_URL: "postgres://mcb@localhost:5432/jobs",
      JINA_API_KEY: "jina-test",
    },
    allowOrigins: ["http://localhost:5173"],
  });
}

describe("job-finder API", () => {
  test("GET /api/meta exposes frontend enums and treats Notion as optional", async () => {
    const handler = createJobFinderApiHandler({
      env: {
        DATABASE_URL: "postgres://mcb@localhost:5432/jobs",
        JINA_API_KEY: "jina-test",
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
    expect(data.applicationStatuses).toContain("waiting");
    expect(sourceLanes.map((lane) => lane.id)).toContain("jobspy");
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
        }),
      }),
    );
    const planBody = await json(planResponse);
    const planData = planBody.data as Record<string, unknown>;

    expect(planResponse.status).toBe(200);
    expect(planData.started).toBe(false);
    expect(planData.plan).toBeArray();
    expect(JSON.stringify(planData.plan)).toContain("JobSpy aggregators");

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
