import { fetchLinearCareersJobs } from "../directSources";
import { fetchLiveJobServeRoles, jobServeRoleToNormalizedJob } from "../jobserveLive";
import { ingestNormalizedJobs } from "../normalizedJobIngest";
import {
  describeSourceAdapter,
  type FastRefreshSourceAdapter,
  type SourceAdapter,
  type SourceAdapterDescriptor,
  type SourceOutcome,
  sourceAttemptStatus,
} from "../sourceAdapterContract";
import { sourceAdapterFor } from "./summaries";
import type { FastRefreshOptions, FastRefreshSourceSummary } from "./types";
import { DEFAULT_FAST_REFRESH_OPTIONS as DEFAULT_OPTIONS, ZERO_COSTS as ZERO } from "./types";
import { errorMessage, normalizeSourceId, outcomeFromError } from "./utils";

export function buildFastRefreshSourceAdapters(
  options: Pick<FastRefreshOptions, "sourceIds" | "jobserveQueries" | "jobserveMaxPages">,
): FastRefreshSourceAdapter[] {
  const sourceIds = new Set(options.sourceIds.map(normalizeSourceId));
  return [
    ...(sourceIds.has("jobserve")
      ? options.jobserveQueries.map((query) =>
          jobServeSourceAdapter(query, options.jobserveMaxPages),
        )
      : []),
    ...(sourceIds.has("linear-careers") ? [linearCareersSourceAdapter()] : []),
  ];
}

export function listFastRefreshSources(
  options: Pick<
    FastRefreshOptions,
    "sourceIds" | "jobserveQueries" | "jobserveMaxPages"
  > = DEFAULT_OPTIONS,
): SourceAdapterDescriptor[] {
  const defaultIds = new Set(DEFAULT_OPTIONS.sourceIds);
  return buildFastRefreshSourceAdapters(options).map((adapter) =>
    describeSourceAdapter(adapter, defaultIds.has(adapter.id)),
  );
}

export async function ingestSourceAdapter(
  adapter: FastRefreshSourceAdapter,
  options: Pick<FastRefreshOptions, "directLimit" | "jobserveImportLimitPerQuery" | "timeoutMs">,
): Promise<FastRefreshSourceSummary> {
  const started = Date.now();
  try {
    const limit =
      adapter.id === "linear-careers" ? options.directLimit : options.jobserveImportLimitPerQuery;
    const discovery = await adapter.discover({
      keyword: adapter.defaultKeyword,
      limit,
      timeoutMs: options.timeoutMs,
    });
    if (discovery.jobs.length === 0) {
      return sourceSummary({
        source: discovery.source,
        keyword: discovery.keyword,
        runId: null,
        outcome: discovery.outcome,
        discovered: discovery.discovered,
        imported: 0,
        pagesPersisted: 0,
        pagesFetched: discovery.pagesFetched,
        elapsedMs: Date.now() - started,
        errors: discovery.errors,
        blockedReason: discovery.blockedReason,
      });
    }

    const ingest = await ingestNormalizedJobs({
      sourceId: adapter.id,
      sourceLabel: adapter.label,
      keyword: discovery.keyword,
      jobs: discovery.jobs,
      timeoutMs: options.timeoutMs,
    });

    return sourceSummary({
      source: discovery.source,
      keyword: discovery.keyword,
      runId: ingest.runId,
      outcome: ingest.errors.length > 0 ? "http_error" : "success",
      discovered: discovery.discovered,
      imported: ingest.jobsPersisted,
      pagesPersisted: ingest.pagesPersisted,
      pagesFetched: discovery.pagesFetched,
      elapsedMs: Date.now() - started,
      errors: [
        ...discovery.errors,
        ...ingest.errors.map((error) => `${error.title}: ${error.error}`),
      ],
    });
  } catch (err) {
    return sourceSummary({
      source: adapter,
      keyword: adapter.defaultKeyword,
      runId: null,
      outcome: outcomeFromError(err),
      discovered: 0,
      imported: 0,
      pagesPersisted: 0,
      pagesFetched: null,
      elapsedMs: Date.now() - started,
      errors: [errorMessage(err)],
      blockedReason: errorMessage(err),
    });
  }
}

function jobServeSourceAdapter(query: string, maxPages: number): FastRefreshSourceAdapter {
  return {
    ...sourceAdapterFor("jobserve", "JobServe", ""),
    defaultKeyword: query,
    async discover(input) {
      const result = await fetchLiveJobServeRoles({
        query,
        maxPages,
        timeoutMs: input.timeoutMs,
      });
      const jobs = result.roles
        .slice(0, input.limit)
        .map((role) => jobServeRoleToNormalizedJob(role, query));
      return {
        source: sourceAdapterFor("jobserve", "JobServe", ""),
        keyword: query,
        outcome: jobs.length > 0 ? "success" : "zero_results",
        discovered: result.roles.length,
        jobs,
        pagesFetched: result.pagesFetched,
        costs: ZERO,
        errors: [],
        blockedReason: null,
      };
    },
  };
}

function linearCareersSourceAdapter(): FastRefreshSourceAdapter {
  return {
    ...sourceAdapterFor("linear-careers", "Linear Careers", ""),
    defaultKeyword: "linear-careers",
    async discover(input) {
      const result = await fetchLinearCareersJobs({
        limit: input.limit,
        timeoutMs: input.timeoutMs,
      });
      return {
        source: sourceAdapterFor(result.sourceId, result.sourceLabel, ""),
        keyword: "linear-careers",
        outcome: result.jobs.length > 0 ? "success" : "zero_results",
        discovered: result.discovered,
        jobs: result.jobs,
        pagesFetched: null,
        costs: ZERO,
        errors: [],
        blockedReason: null,
      };
    },
  };
}

function sourceSummary(input: {
  source: SourceAdapter;
  keyword: string;
  runId: number | null;
  outcome: SourceOutcome;
  discovered: number;
  imported: number;
  pagesPersisted: number;
  pagesFetched: number | null;
  elapsedMs: number;
  errors?: string[];
  blockedReason?: string | null;
}): FastRefreshSourceSummary {
  return {
    source: sourceMetadata(input.source),
    keyword: input.keyword,
    runId: input.runId,
    outcome: input.outcome,
    status: sourceAttemptStatus(input.outcome, input.imported, input.errors ?? []),
    discovered: input.discovered,
    imported: input.imported,
    fullText: {
      persisted: input.pagesPersisted,
      fetchedPages: input.pagesFetched,
      status:
        input.pagesPersisted > 0 ? "success" : input.imported > 0 ? "snippet_only" : "pending",
    },
    classification: {
      classified: 0,
    },
    costs: ZERO,
    elapsedMs: input.elapsedMs,
    errors: input.errors ?? [],
    blockedReason: input.blockedReason ?? null,
  };
}

function sourceMetadata(source: SourceAdapter): SourceAdapter {
  return {
    id: source.id,
    label: source.label,
    kind: source.kind,
    quality: source.quality,
  };
}
