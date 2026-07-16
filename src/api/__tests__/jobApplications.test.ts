import { describe, expect, test } from "bun:test";
import { isLegalApplicationTransition } from "../cloudApplications";
import type { ApiFetch } from "../context";
import { createJobFinderApiHandler } from "../server";

const application = {
  id: 7,
  org: "acme",
  ats: "greenhouse",
  external_id: "job-1",
  source: "lab-openings",
  title: "AI Engineer",
  company: "Acme",
  url: "https://example.com/jobs/1",
  status: "interested",
  status_history: [],
  cv_ref: null,
  notes: null,
  created_at: "2026-07-16T08:00:00Z",
  updated_at: "2026-07-16T08:00:00Z",
} as const;

function handler(fetch: ApiFetch) {
  return createJobFinderApiHandler({
    cloudConfig: {
      supabaseUrl: "https://example.supabase.co",
      supabaseServiceKey: "service-secret",
    },
    now: () => new Date("2026-07-16T09:00:00Z"),
    fetch,
  });
}

function post(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

describe("cloud application lifecycle", () => {
  test("defines every legal forward edge and close edge", () => {
    const forward = [
      ["interested", "shortlisted"],
      ["shortlisted", "cv_staged"],
      ["cv_staged", "sent"],
      ["sent", "response"],
      ["response", "interview"],
      ["interview", "offer"],
    ] as const;
    for (const [from, to] of forward) expect(isLegalApplicationTransition(from, to)).toBe(true);
    for (const from of ["interested", "shortlisted", "offer"] as const) {
      expect(isLegalApplicationTransition(from, "closed")).toBe(true);
    }
    expect(isLegalApplicationTransition("closed", "closed")).toBe(false);
    expect(isLegalApplicationTransition("interested", "response")).toBe(false);
  });

  test("creates idempotently on the provenance key", async () => {
    const requests: Array<{ url: URL; method: string }> = [];
    const fetch: ApiFetch = async (input, init) => {
      requests.push({ url: new URL(String(input)), method: init?.method ?? "GET" });
      return Response.json([application]);
    };

    const response = await handler(fetch)(
      post("/api/applications", {
        org: "acme",
        ats: "greenhouse",
        external_id: "job-1",
        source: "lab-openings",
        title: "AI Engineer",
        company: "Acme",
        url: "https://example.com/jobs/1",
      }),
    );
    const body = (await response.json()) as {
      data: { status: string; data: { created: boolean } };
    };

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ status: "available", data: { created: false } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url.searchParams.get("org")).toBe("eq.acme");
    expect(requests[0]?.url.searchParams.get("external_id")).toBe("eq.job-1");
  });

  test("resolves a concurrent create conflict to the existing row", async () => {
    let call = 0;
    const response = await handler(async () => {
      call += 1;
      if (call === 1) return Response.json([]);
      if (call === 2) return Response.json({ code: "23505" }, { status: 409 });
      return Response.json([application]);
    })(
      post("/api/applications", {
        org: "acme",
        ats: "greenhouse",
        external_id: "job-1",
        source: "lab-openings",
        title: "AI Engineer",
        company: "Acme",
      }),
    );
    const body = (await response.json()) as {
      data: { status: string; data: { created: boolean } };
    };

    expect(response.status).toBe(200);
    expect(call).toBe(3);
    expect(body.data).toMatchObject({ status: "available", data: { created: false } });
  });

  test("appends history for a legal forward edge", async () => {
    let patchBody: Record<string, unknown> | undefined;
    const fetch: ApiFetch = async (_input, init) => {
      if (init?.method === "PATCH") {
        patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json([
          {
            ...application,
            status: "shortlisted",
            status_history: [
              { status: "shortlisted", at: "2026-07-16T09:00:00.000Z", by: "agent" },
            ],
            updated_at: "2026-07-16T09:00:00.000Z",
          },
        ]);
      }
      return Response.json([application]);
    };

    const response = await handler(fetch)(
      post("/api/applications/7/transition", { to: "shortlisted", by: "agent" }),
    );

    expect(response.status).toBe(200);
    expect(patchBody).toMatchObject({
      status: "shortlisted",
      status_history: [{ status: "shortlisted", at: "2026-07-16T09:00:00.000Z", by: "agent" }],
    });
  });

  test("rejects illegal edges without writing", async () => {
    let writes = 0;
    const response = await handler(async (_input, init) => {
      if (init?.method !== "GET") writes += 1;
      return Response.json([application]);
    })(post("/api/applications/7/transition", { to: "response", by: "owner" }));

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("illegal_application_transition");
    expect(writes).toBe(0);
  });

  test("rejects sent unless the owner records it", async () => {
    let writes = 0;
    const response = await handler(async (_input, init) => {
      if (init?.method !== "GET") writes += 1;
      return Response.json([{ ...application, status: "cv_staged" }]);
    })(post("/api/applications/7/transition", { to: "sent", by: "agent" }));

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("owner_required_for_sent");
    expect(writes).toBe(0);
  });

  test("allows the owner to record sent", async () => {
    const fetch: ApiFetch = async (_input, init) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { status_history: unknown[] };
        expect(body.status_history).toContainEqual({
          status: "sent",
          at: "2026-07-16T09:00:00.000Z",
          by: "owner",
        });
        return Response.json([
          {
            ...application,
            status: "sent",
            status_history: body.status_history,
            updated_at: "2026-07-16T09:00:00.000Z",
          },
        ]);
      }
      return Response.json([{ ...application, status: "cv_staged" }]);
    };

    const response = await handler(fetch)(
      post("/api/applications/7/transition", { to: "sent", by: "owner" }),
    );
    expect(response.status).toBe(200);
  });

  test("lists by status and exposes a missing schema as degraded data", async () => {
    let requested: URL | undefined;
    const response = await handler(async (input) => {
      requested = new URL(String(input));
      return Response.json({ code: "42P01", message: "relation does not exist" }, { status: 404 });
    })(new Request("http://localhost/api/applications?status=interview"));
    const body = (await response.json()) as { data: { status: string; reason: { code: string } } };

    expect(response.status).toBe(200);
    expect(requested?.searchParams.get("status")).toBe("eq.interview");
    expect(body.data).toMatchObject({
      status: "cloud_unavailable",
      reason: { code: "cloud_schema_not_exposed" },
    });
  });
});
