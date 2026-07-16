import { describe, expect, test } from "bun:test";
import type { ApiQuery } from "../context";
import { createJobFinderApiHandler } from "../server";

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

describe("POST /api/applications validation", () => {
  test("rejects a malformed cvDraftId before querying Postgres", async () => {
    const query: ApiQuery = async () => {
      throw new Error("query should not run");
    };
    const response = await createJobFinderApiHandler({ query })(
      request({ jobId: "1", cvDraftId: "9oops" }),
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_field");
  });

  test("rejects a malformed appliedAt before querying Postgres", async () => {
    const query: ApiQuery = async () => {
      throw new Error("query should not run");
    };
    const response = await createJobFinderApiHandler({ query })(
      request({ jobId: "1", appliedAt: "next Tuesday" }),
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_field");
  });

  test("accepts valid cvDraftId and appliedAt values", async () => {
    const queries: string[] = [];
    const query: ApiQuery = async <T>(sql: string) => {
      queries.push(sql);
      return {
        id: "7",
        job_id: "1",
        cv_draft_id: "9",
        status: "applied",
        from_state: "ready_to_apply",
        to_state: "applied",
        event_id: "8",
      } as T;
    };
    const response = await createJobFinderApiHandler({ query })(
      request({
        jobId: "1",
        cvDraftId: "9",
        status: "applied",
        appliedAt: "2026-07-16T08:15:00Z",
      }),
    );

    expect(response.status).toBe(201);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("'9'::bigint");
    expect(queries[0]).toContain("'2026-07-16T08:15:00Z'::timestamptz");
  });
});
