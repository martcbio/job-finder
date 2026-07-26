import { describe, expect, test } from "bun:test";
import { listCloudOpenings, listCloudRuns, parseCloudSince } from "../cloudOpenings";
import type { ApiContext, ApiFetch } from "../context";
import { createJobFinderApiHandler } from "../server";

function context(fetch: ApiFetch, configured = true): ApiContext {
  return {
    query: async () => {
      throw new Error("database query was not expected");
    },
    fastRefresh: async () => {
      throw new Error("fast refresh was not expected");
    },
    env: {},
    now: () => new Date("2026-07-15T12:00:00Z"),
    allowOrigins: [],
    cloudConfig: configured
      ? {
          supabaseUrl: "https://example.supabase.co",
          supabaseServiceKey: "service-secret",
        }
      : {},
    fetch,
  };
}

describe("cloud openings boundary", () => {
  test("builds the PostgREST openings query and parses rows", async () => {
    let requestedUrl = "";
    let requestedHeaders: Headers | undefined;
    const fetch: ApiFetch = async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      return Response.json([
        {
          org: "acme",
          ats: "greenhouse",
          external_id: "job-1",
          title: "AI Engineer",
          company: "Acme",
          location: "London",
          locations: ["London", "Remote UK"],
          url: "https://example.com/jobs/1",
          posted_at: null,
          location_eligibility: "eligible",
          location_reason_codes: ["location.europe_or_uk"],
          role_relevance: "relevant",
          role_reason_codes: ["role.technical"],
          disposition: "suitable",
          first_seen_at: "2026-07-15T09:00:00Z",
          last_seen_at: "2026-07-15T10:00:00Z",
          first_seen_run_id: "run-1",
          last_seen_run_id: "run-1",
        },
      ]);
    };

    const result = await listCloudOpenings(context(fetch), {
      limit: 42,
      since: "2026-07-14T00:00:00Z",
      runId: "run-1",
    });

    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("expected available cloud rows");
    expect(result.rows[0]?.external_id).toBe("job-1");
    expect(result.counts).toEqual({
      scope: "returned_rows",
      raw: 1,
      eligible: 1,
      suitable: 1,
      unsuitableLocation: 0,
      unsuitableRole: 0,
      undecided: 0,
    });
    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/rest/v1/openings");
    expect(url.searchParams.get("limit")).toBe("42");
    expect(url.searchParams.get("order")).toBe("last_seen_at.desc");
    expect(url.searchParams.get("first_seen_at")).toBe("gte.2026-07-14T00:00:00Z");
    expect(url.searchParams.get("last_seen_run_id")).toBe("eq.run-1");
    expect(requestedHeaders?.get("apikey")).toBe("service-secret");
    expect(requestedHeaders?.get("authorization")).toBe("Bearer service-secret");
    expect(requestedHeaders?.get("accept-profile")).toBe("careers");
  });

  test("includes full ATS bodies only when explicitly requested", async () => {
    let requestedUrl = "";
    const result = await listCloudOpenings(
      context(async (input) => {
        requestedUrl = String(input);
        return Response.json([
          {
            org: "acme",
            ats: "greenhouse",
            external_id: "job-1",
            title: "AI Engineer",
            company: "Acme",
            location: "London",
            locations: ["London"],
            url: "https://example.com/jobs/1",
            posted_at: "2026-07-15T09:00:00Z",
            location_eligibility: "eligible",
            location_reason_codes: ["location.europe_or_uk"],
            role_relevance: "relevant",
            role_reason_codes: ["role.technical"],
            disposition: "suitable",
            first_seen_at: "2026-07-15T09:00:00Z",
            last_seen_at: "2026-07-15T10:00:00Z",
            first_seen_run_id: "run-1",
            last_seen_run_id: "run-1",
            raw: { content: "Full role body" },
          },
        ]);
      }),
      { limit: 1, includeRaw: true, workableLocationsOnly: true },
    );

    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("expected available cloud rows");
    expect(result.rows[0]?.raw).toEqual({ content: "Full role body" });
    const url = new URL(requestedUrl);
    expect(url.searchParams.get("select")).toContain(",raw");
    expect(url.searchParams.get("location_eligibility")).toBe("in.(eligible,undecided)");
  });

  test("paginates beyond the PostgREST 1000-row response ceiling", async () => {
    const offsets: string[] = [];
    const openingRow = (id: number) => ({
      org: "acme",
      ats: "greenhouse",
      external_id: `job-${id}`,
      title: "AI Engineer",
      company: "Acme",
      location: "London",
      locations: ["London"],
      url: `https://example.com/jobs/${id}`,
      posted_at: null,
      location_eligibility: "eligible",
      location_reason_codes: ["location.europe_or_uk"],
      role_relevance: "relevant",
      role_reason_codes: ["role.technical"],
      disposition: "suitable",
      first_seen_at: "2026-07-15T09:00:00Z",
      last_seen_at: "2026-07-15T10:00:00Z",
      first_seen_run_id: "run-1",
      last_seen_run_id: "run-1",
    });
    const result = await listCloudOpenings(
      context(async (input) => {
        const url = new URL(String(input));
        offsets.push(url.searchParams.get("offset") ?? "0");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const count = offset === 0 ? 1000 : 200;
        return Response.json(
          Array.from({ length: count }, (_, index) => openingRow(offset + index)),
        );
      }),
      { limit: 1500 },
    );

    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("expected available cloud rows");
    expect(offsets).toEqual(["0", "1000"]);
    expect(result.rows).toHaveLength(1200);
    expect(result.counts).toMatchObject({ raw: 1200, eligible: 1200, suitable: 1200 });
  });

  test("parses cloud run rows", async () => {
    const result = await listCloudRuns(
      context(async () =>
        Response.json([
          {
            run_id: "run-1",
            run_date: "2026-07-15",
            completed_at: "2026-07-15T10:00:00Z",
            health: "complete",
            matched_openings_count: 17,
            raw_openings_count: 723,
            eligible_openings_count: 50,
            suitable_openings_count: 25,
            unsuitable_location_openings_count: 650,
            unsuitable_role_openings_count: 23,
            undecided_openings_count: 25,
            substrate: "modal",
          },
        ]),
      ),
      3,
    );

    expect(result).toEqual({
      status: "available",
      rows: [
        {
          run_id: "run-1",
          run_date: "2026-07-15",
          completed_at: "2026-07-15T10:00:00Z",
          health: "complete",
          matched_openings_count: 17,
          raw_openings_count: 723,
          eligible_openings_count: 50,
          suitable_openings_count: 25,
          unsuitable_location_openings_count: 650,
          unsuitable_role_openings_count: 23,
          undecided_openings_count: 25,
          substrate: "modal",
        },
      ],
    });
  });

  test("maps missing configuration without calling fetch", async () => {
    let called = false;
    const result = await listCloudRuns(
      context(async () => {
        called = true;
        return Response.json([]);
      }, false),
      30,
    );

    expect(called).toBe(false);
    expect(result).toMatchObject({
      status: "cloud_unavailable",
      reason: { code: "cloud_not_configured" },
    });
  });

  test("maps an unexposed schema to a calm unavailable state", async () => {
    const result = await listCloudRuns(
      context(async () => new Response(null, { status: 406 })),
      30,
    );

    expect(result).toMatchObject({
      status: "cloud_unavailable",
      reason: { code: "cloud_schema_not_exposed", upstreamStatus: 406 },
    });
  });

  test("maps other upstream statuses explicitly", async () => {
    const result = await listCloudRuns(
      context(async () => new Response(null, { status: 503 })),
      30,
    );

    expect(result).toMatchObject({
      status: "cloud_unavailable",
      reason: { code: "cloud_upstream_error", upstreamStatus: 503 },
    });
  });

  test("maps network failures explicitly", async () => {
    const result = await listCloudRuns(
      context(async () => {
        throw new TypeError("connection refused");
      }),
      30,
    );

    expect(result).toMatchObject({
      status: "cloud_unavailable",
      reason: { code: "cloud_upstream_error" },
    });
  });

  test("rejects malformed upstream rows", async () => {
    const result = await listCloudRuns(
      context(async () => Response.json([{ run_id: "run-1", health: "unknown" }])),
      30,
    );

    expect(result).toMatchObject({
      status: "cloud_unavailable",
      reason: { code: "cloud_upstream_error", upstreamStatus: 200 },
    });
  });

  test("rejects a non-ISO since filter", () => {
    expect(() => parseCloudSince("yesterday")).toThrow("since must be an ISO 8601 timestamp");
  });

  test("exposes bounded cloud routes through the API envelope", async () => {
    const requestedUrls: string[] = [];
    const handler = createJobFinderApiHandler({
      cloudConfig: {
        supabaseUrl: "https://example.supabase.co",
        supabaseServiceKey: "service-secret",
      },
      fetch: async (input) => {
        requestedUrls.push(String(input));
        return Response.json([]);
      },
    });

    const openings = await handler(
      new Request("http://localhost/api/cloud/openings?limit=17&since=2026-07-15T00:00:00Z"),
    );
    const runs = await handler(new Request("http://localhost/api/cloud/runs"));

    expect(openings.status).toBe(200);
    expect(runs.status).toBe(200);
    expect(new URL(requestedUrls[0] ?? "").searchParams.get("limit")).toBe("17");
    expect(new URL(requestedUrls[1] ?? "").searchParams.get("limit")).toBe("30");

    const overLimit = await handler(new Request("http://localhost/api/cloud/openings?limit=2001"));
    expect(overLimit.status).toBe(400);
    expect(await overLimit.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_positive_integer" },
    });
  });
});
