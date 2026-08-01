import { describe, expect, test } from "bun:test";
import type { JobIngestResult } from "../../pipeline/jobIngest";
import { classifyIngestResult, classifyIngestThrow } from "../incident";

function failedReceipt(...errors: string[]): JobIngestResult {
  return {
    status: "failed",
    startedAt: "2026-08-01T00:00:00.000Z",
    finishedAt: "2026-08-01T00:00:00.000Z",
    elapsedMs: 0,
    options: {
      sourceIds: ["jobserve"],
      marketDir: "/test/job-market",
      jobserveQueries: [],
      jobserveMaxPages: 1,
      jobserveImportLimitPerQuery: 1,
      timeoutMs: 1_000,
    },
    sources: [
      {
        id: "jobserve",
        label: "JobServe",
        status: "failed",
        runId: null,
        discovered: 0,
        imported: 0,
        evidencePath: null,
        errors,
        elapsedMs: 0,
      },
    ],
  };
}

describe("classifyIngestThrow", () => {
  test("treats unambiguous CLI input as operator input", () => {
    expect(classifyIngestThrow(new Error("Unknown ingest source: unsupported"))).toEqual({
      _tag: "non_repair",
      reason: "operator_input",
      summary: "Error: Unknown ingest source: unsupported",
    });
  });

  test("treats an invalid safe timeout as operator input", () => {
    expect(classifyIngestThrow(new Error("--timeout-ms requires a safe positive integer"))).toEqual(
      {
        _tag: "non_repair",
        reason: "operator_input",
        summary: "Error: --timeout-ms requires a safe positive integer",
      },
    );
  });

  test("treats the exact pending migration readiness diagnostic as operator input", () => {
    expect(
      classifyIngestThrow(
        new Error("Database has 3 pending migration(s). Run bun run db:migrate."),
      ),
    ).toEqual({
      _tag: "non_repair",
      reason: "operator_input",
      summary: "Error: Database has 3 pending migration(s). Run bun run db:migrate.",
    });
  });

  test("does not dispatch or repair thrown source transport errors", () => {
    for (const error of [
      new Error("fetch failed"),
      new Error("network failure while loading careers page"),
    ]) {
      expect(classifyIngestThrow(error)).toEqual({
        _tag: "non_repair",
        reason: "external_transient",
        summary: `${error.name}: ${error.message}`,
      });
    }
  });

  test("treats a TypeError fetch failure as source transport before its name", () => {
    expect(classifyIngestThrow(new TypeError("fetch failed"))).toEqual({
      _tag: "non_repair",
      reason: "external_transient",
      summary: "TypeError: fetch failed",
    });
  });

  test("treats a typed timeout as external from its bare Error message", () => {
    expect(classifyIngestThrow(new TypeError("request timed out"))).toEqual({
      _tag: "non_repair",
      reason: "external_transient",
      summary: "TypeError: request timed out",
    });
  });

  test("treats typed DNS and connection-reset errors as external", () => {
    for (const error of [
      new TypeError("getaddrinfo ENOTFOUND careers.example.test"),
      new TypeError("socket ECONNRESET while loading careers.example.test"),
    ]) {
      expect(classifyIngestThrow(error)).toEqual({
        _tag: "non_repair",
        reason: "external_transient",
        summary: `${error.name}: ${error.message}`,
      });
    }
  });

  test("retains a typed error name for non-external repair evidence", () => {
    expect(classifyIngestThrow(new TypeError("unclassified condition"))).toMatchObject({
      _tag: "repair",
      incident: {
        evidence: [{ message: "TypeError: unclassified condition" }],
      },
    });
  });

  test("does not dispatch repair for source-side access restrictions or HTTP responses", () => {
    for (const message of [
      "JobServe usage restricted; aborting search.",
      "JobServe fair usage threshold reached; aborting search.",
      "linear-careers HTTP 404",
      "linear-careers HTTP 410",
      "linear-careers HTTP 503",
      "linear-careers HTTP 401",
      "linear-careers HTTP 403",
      "linear-careers HTTP 429 Too Many Requests",
      "linear-careers 429 Too Many Requests",
      "linear-careers rate limited",
    ]) {
      expect(classifyIngestThrow(new Error(message))).toEqual({
        _tag: "non_repair",
        reason: "external_transient",
        summary: `Error: ${message}`,
      });
    }
  });
});

describe("classifyIngestResult", () => {
  test("returns healthy for a complete ingest result", () => {
    expect(classifyIngestResult({ ...failedReceipt(), status: "complete", sources: [] })).toEqual({
      _tag: "healthy",
      reason: "ingest_complete",
    });
  });

  test("does not dispatch or repair operator-style source receipt evidence", () => {
    expect(classifyIngestResult(failedReceipt("JobServe ingest is limited to 3 queries"))).toEqual({
      _tag: "non_repair",
      reason: "operator_input",
      summary: "jobsradar ingest returned failed",
    });
  });

  test("treats the exact pending migration readiness receipt as operator input", () => {
    expect(
      classifyIngestResult(
        failedReceipt("Database has 3 pending migration(s). Run bun run db:migrate."),
      ),
    ).toEqual({
      _tag: "non_repair",
      reason: "operator_input",
      summary: "jobsradar ingest returned failed",
    });
  });

  test("prefers external-transient for mixed safe receipt evidence", () => {
    expect(
      classifyIngestResult(
        failedReceipt("JobServe ingest is limited to 3 queries", "transport failure: fetch failed"),
      ),
    ).toEqual({
      _tag: "non_repair",
      reason: "external_transient",
      summary: "jobsradar ingest returned failed",
    });
  });

  test("retains repair for mixed operator and internal receipt evidence", () => {
    expect(
      classifyIngestResult(
        failedReceipt("JobServe ingest is limited to 3 queries", "TypeError: schema mismatch"),
      )._tag,
    ).toBe("repair");
  });

  test("retains repair for schema receipt evidence", () => {
    expect(classifyIngestResult(failedReceipt("Schema validation failed"))._tag).toBe("repair");
  });

  test("retains repair for unrelated non-HTTP numeric source evidence", () => {
    for (const error of [
      "Listing reference 401 was unavailable",
      "Listing reference 403 was unavailable",
      "Listing reference 512 was unavailable",
    ]) {
      expect(classifyIngestResult(failedReceipt(error))._tag).toBe("repair");
    }
  });

  test("does not dispatch or repair source transport receipt evidence", () => {
    for (const error of [
      "transport failure: fetch failed",
      "Network error while loading careers page",
    ]) {
      expect(classifyIngestResult(failedReceipt(error))).toEqual({
        _tag: "non_repair",
        reason: "external_transient",
        summary: "jobsradar ingest returned failed",
      });
    }
  });
});
