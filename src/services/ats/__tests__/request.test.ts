import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { fetchAtsJson } from "../request";
import type { Fetcher } from "../types";

const endpoint = "https://example.test/jobs";
const jobsSchema = z.array(z.object({ id: z.string() }));

describe("fetchAtsJson", () => {
  test("returns success for a valid empty payload", async () => {
    const result = await fetchAtsJson(
      endpoint,
      jobsSchema,
      async () => new Response("[]", { status: 200 }),
      () => undefined,
    );

    expect(result).toMatchObject({
      status: "success",
      endpoint,
      attempts: 1,
      data: [],
    });
  });

  test("returns a typed HTTP failure", async () => {
    const result = await fetchAtsJson(
      endpoint,
      jobsSchema,
      async () => new Response("not found", { status: 404, statusText: "Not Found" }),
      () => undefined,
    );

    expect(result).toMatchObject({
      status: "failure",
      attempts: 1,
      failure: {
        kind: "http",
        endpoint,
        status: 404,
        statusText: "Not Found",
        retryable: false,
      },
    });
  });

  test("returns a typed parse failure", async () => {
    const result = await fetchAtsJson(
      endpoint,
      jobsSchema,
      async () =>
        new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
      () => undefined,
    );

    expect(result).toMatchObject({
      status: "failure",
      attempts: 1,
      failure: {
        kind: "parse",
        endpoint,
        contentType: "text/plain",
      },
    });
  });

  test("returns a typed schema failure", async () => {
    const result = await fetchAtsJson(
      endpoint,
      jobsSchema,
      async () => new Response('{"jobs":[]}', { status: 200 }),
      () => undefined,
    );

    expect(result.status).toBe("failure");
    if (result.status === "success") throw new Error("expected schema acquisition to fail");
    expect(result.failure.kind).toBe("schema");
    if (result.failure.kind !== "schema") throw new Error("expected schema failure");
    expect(result.failure.issues.length).toBeGreaterThan(0);
  });

  test("returns a typed transport failure", async () => {
    const failingFetcher: Fetcher = async () => {
      throw Object.assign(new Error("network down"), { code: "ENETDOWN" });
    };
    const result = await fetchAtsJson(endpoint, jobsSchema, failingFetcher, () => undefined, {
      baseDelayMs: 1,
    });

    expect(result).toMatchObject({
      status: "failure",
      attempts: 4,
      failure: {
        kind: "transport",
        endpoint,
        message: "network down",
        errorCode: "ENETDOWN",
        retryable: true,
      },
    });
  });

  test("retries a transient transport failure", async () => {
    let calls = 0;
    const result = await fetchAtsJson(
      endpoint,
      jobsSchema,
      async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
        return new Response("[]", { status: 200 });
      },
      () => undefined,
      { baseDelayMs: 1 },
    );

    expect(result).toMatchObject({ status: "success", attempts: 2, data: [] });
  });

  test("times out a fetcher that never settles", async () => {
    const result = await fetchAtsJson(
      endpoint,
      jobsSchema,
      async () => new Promise<Response>(() => undefined),
      () => undefined,
      { timeoutMs: 2, baseDelayMs: 1 },
    );

    expect(result).toMatchObject({
      status: "failure",
      attempts: 4,
      failure: {
        kind: "transport",
        errorName: "TimeoutError",
        errorCode: "ETIMEDOUT",
        retryable: true,
      },
    });
  });
});
