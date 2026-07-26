import { existsSync, readFileSync } from "node:fs";
import { sourceAdapterFor } from "../fastRefresh/summaries";
import type { FastRefreshSourceSummary } from "../fastRefresh/types";
import { ZERO_COSTS } from "../fastRefresh/types";
import { ingestNormalizedJobs, normalizeExternalJobPayload } from "../normalizedJobIngest";
import { sourceAttemptStatus } from "../sourceAdapterContract";

const DEFAULT_SNAPSHOT_CANDIDATES = [
  "snapshots/jobspy.json",
  "data/jobspy.json",
  ".cache/jobspy.json",
];

/** Resolves a JobSpy snapshot from explicit environment configuration and local defaults. */
export function resolveJobspySnapshotPath(env: NodeJS.ProcessEnv): string | null {
  const candidates = [env.JOBSPY_SNAPSHOT_FILE, ...DEFAULT_SNAPSHOT_CANDIDATES].filter(
    (value): value is string => Boolean(value),
  );
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** Imports one bounded JobSpy snapshot lane and returns a source-level outcome. */
export async function runJobspyLaneRefresh(input: {
  limit: number;
  timeoutMs: number;
  snapshotFile?: string | null;
  env: NodeJS.ProcessEnv;
}): Promise<FastRefreshSourceSummary> {
  const started = Date.now();
  const source = sourceAdapterFor("jobspy", "JobSpy", "");
  const file = input.snapshotFile ?? resolveJobspySnapshotPath(input.env);

  if (!file) {
    return {
      source,
      keyword: "jobspy",
      runId: null,
      outcome: "not_implemented",
      status: sourceAttemptStatus("not_implemented", 0, [
        "Set JOBSPY_SNAPSHOT_FILE or place snapshots/jobspy.json",
      ]),
      discovered: 0,
      excluded: 0,
      imported: 0,
      fullText: { persisted: 0, fetchedPages: null, status: "pending" },
      classification: { classified: 0 },
      costs: ZERO_COSTS,
      elapsedMs: Date.now() - started,
      errors: ["JobSpy snapshot file not found (JOBSPY_SNAPSHOT_FILE)"],
      blockedReason: "JobSpy snapshot file not found",
    };
  }

  try {
    const payload = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const jobs = normalizeExternalJobPayload(payload, "jobspy").slice(0, input.limit);
    if (jobs.length === 0) {
      return {
        source,
        keyword: "jobspy",
        runId: null,
        outcome: "zero_results",
        status: "zero_results",
        discovered: 0,
        excluded: 0,
        imported: 0,
        fullText: { persisted: 0, fetchedPages: null, status: "pending" },
        classification: { classified: 0 },
        costs: ZERO_COSTS,
        elapsedMs: Date.now() - started,
        errors: [],
        blockedReason: null,
      };
    }

    const ingest = await ingestNormalizedJobs({
      sourceId: "jobspy",
      sourceLabel: "JobSpy",
      keyword: "jobspy",
      jobs,
      timeoutMs: input.timeoutMs,
    });

    return {
      source,
      keyword: "jobspy",
      runId: ingest.runId,
      outcome: ingest.errors.length > 0 ? "http_error" : "success",
      status: sourceAttemptStatus(
        ingest.errors.length > 0 ? "http_error" : "success",
        ingest.jobsPersisted,
        ingest.errors.map((e) => e.error),
      ),
      discovered: jobs.length,
      excluded: 0,
      imported: ingest.jobsPersisted,
      fullText: {
        persisted: ingest.pagesPersisted,
        fetchedPages: null,
        status: ingest.pagesPersisted > 0 ? "success" : "snippet_only",
      },
      classification: { classified: 0 },
      costs: ZERO_COSTS,
      elapsedMs: Date.now() - started,
      errors: ingest.errors.map((e) => `${e.title}: ${e.error}`),
      blockedReason: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      source,
      keyword: "jobspy",
      runId: null,
      outcome: "http_error",
      status: sourceAttemptStatus("http_error", 0, [message]),
      discovered: 0,
      excluded: 0,
      imported: 0,
      fullText: { persisted: 0, fetchedPages: null, status: "pending" },
      classification: { classified: 0 },
      costs: ZERO_COSTS,
      elapsedMs: Date.now() - started,
      errors: [message],
      blockedReason: message,
    };
  }
}
