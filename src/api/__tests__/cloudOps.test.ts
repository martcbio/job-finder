import { describe, expect, test } from "bun:test";
import { summarizeParity } from "../cloudOps";
import type { ApiFetch } from "../context";
import { createJobFinderApiHandler } from "../server";

function responseFor(input: string | URL | Request, overrides: Record<string, Response>): Response {
  const url = new URL(String(input));
  const response = overrides[url.pathname];
  if (!response) throw new Error(`unexpected fetch: ${url}`);
  return response;
}

function handler(fetch: ApiFetch) {
  return createJobFinderApiHandler({
    cloudConfig: {
      supabaseUrl: "https://example.supabase.co",
      supabaseServiceKey: "service-secret",
    },
    fetch,
  });
}

const empty = () => Response.json([]);

describe("cloud ops boundary", () => {
  test("distinguishes target-registry drift from an openings mismatch", () => {
    const common = {
      run_date: "2026-07-26",
      openings_count: 42,
      ids_sha256: "same-openings",
      created_at: "2026-07-26T08:00:00Z",
    };

    expect(
      summarizeParity([
        {
          ...common,
          substrate: "mac",
          run_id: "mac-1",
          targets_sha256: "local-targets",
        },
        {
          ...common,
          substrate: "modal",
          run_id: "modal-1",
          targets_sha256: "cloud-targets",
        },
      ]),
    ).toMatchObject([{ runDate: "2026-07-26", status: "targets_mismatch" }]);
  });

  test("falls back to legacy doctor when doctor_v2 is not deployed", async () => {
    const requested: Array<{ path: string; profile: string | null; task: string | null }> = [];
    const fetch: ApiFetch = async (input, init) => {
      const url = new URL(String(input));
      requested.push({
        path: url.pathname,
        profile: new Headers(init?.headers).get("accept-profile"),
        task: url.searchParams.get("task"),
      });
      return responseFor(input, {
        "/rest/v1/doctor_v2": Response.json({ code: "42P01" }, { status: 404 }),
        "/rest/v1/doctor": Response.json([
          {
            task: "jobsradar",
            substrate: "mac",
            cadence_seconds: 86400,
            latest_success_at: "2026-07-15T10:00:00Z",
            stale: false,
          },
        ]),
        "/rest/v1/runs": empty(),
        "/rest/v1/alerts": empty(),
        "/rest/v1/parity_runs": empty(),
      });
    };

    const response = await handler(fetch)(new Request("http://localhost/api/cloud/ops"));
    const body = (await response.json()) as {
      data: { doctor: { status: string }; alerts: { status: string } };
    };

    expect(response.status).toBe(200);
    expect(body.data.doctor).toMatchObject({
      status: "doctor_not_deployed",
      source: "doctor",
      rows: [{ task: "jobsradar", substrate: "mac" }],
    });
    expect(requested).toContainEqual({ path: "/rest/v1/alerts", profile: "ops", task: null });
    expect(requested).toContainEqual({
      path: "/rest/v1/parity_runs",
      profile: "careers",
      task: null,
    });
    expect(
      requested.filter(({ path }) => path === "/rest/v1/runs").map(({ task }) => task),
    ).toEqual(["eq.jobsradar", "like.careers-*", "eq.subauth-pilot", "eq.funding-ingest"]);
  });

  test("maps an unexposed ops schema to alerts_unavailable without degrading other sections", async () => {
    const fetch: ApiFetch = async (input) =>
      responseFor(input, {
        "/rest/v1/doctor_v2": empty(),
        "/rest/v1/runs": empty(),
        "/rest/v1/alerts": Response.json({ code: "PGRST106" }, { status: 406 }),
        "/rest/v1/parity_runs": empty(),
      });

    const response = await handler(fetch)(new Request("http://localhost/api/cloud/ops"));
    const body = (await response.json()) as {
      data: {
        doctor: { status: string };
        runs: { status: string };
        alerts: { status: string };
        parity: { status: string };
      };
    };

    expect(response.status).toBe(200);
    expect(body.data.doctor.status).toBe("available");
    expect(body.data.runs.status).toBe("available");
    expect(body.data.parity.status).toBe("available");
    expect(body.data.alerts).toMatchObject({
      status: "alerts_unavailable",
      reason: { code: "alerts_schema_not_exposed", upstreamStatus: 406 },
    });
  });
});
