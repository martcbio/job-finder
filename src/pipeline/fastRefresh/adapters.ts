import { ingestNormalizedJobs } from "../normalizedJobIngest";
import {
  describeSourceAdapter,
  type FastRefreshSourceAdapter,
  type SourceAdapter,
  type SourceAdapterDescriptor,
  type SourceOutcome,
  sourceAttemptStatus,
} from "../sourceAdapterContract";
import { buildRegisteredSourceAdapters } from "../sourceRegistry";
import type { FastRefreshOptions, FastRefreshSourceSummary } from "./types";
import { DEFAULT_FAST_REFRESH_OPTIONS as DEFAULT_OPTIONS, ZERO_COSTS as ZERO } from "./types";
import { errorMessage, normalizeSourceId, outcomeFromError } from "./utils";

export function buildFastRefreshSourceAdapters(
  options: Pick<FastRefreshOptions, "sourceIds" | "jobserveQueries" | "jobserveMaxPages">,
): FastRefreshSourceAdapter[] {
  const sourceIds = [...new Set(options.sourceIds.map(normalizeSourceId))];
  return buildRegisteredSourceAdapters(sourceIds, options);
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
  options: Pick<FastRefreshOptions, "jobserveImportLimitPerQuery" | "timeoutMs">,
): Promise<FastRefreshSourceSummary> {
  const started = Date.now();
  try {
    const discovery = await adapter.discover({
      keyword: adapter.defaultKeyword,
      // Direct adapters acquire every parsed card; this only bounds JobServe detail fetches.
      limit: options.jobserveImportLimitPerQuery,
      timeoutMs: options.timeoutMs,
    });
    if (discovery.jobs.length === 0) {
      return sourceSummary({
        source: discovery.source,
        keyword: discovery.keyword,
        runId: null,
        outcome: discovery.outcome,
        discovered: discovery.discovered,
        excluded: discovery.excluded,
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
      outcome: outcomeAfterPersistence(discovery.outcome, ingest.errors.length),
      discovered: discovery.discovered,
      excluded: discovery.excluded,
      imported: ingest.jobsPersisted,
      pagesPersisted: ingest.pagesPersisted,
      pagesFetched: discovery.pagesFetched,
      elapsedMs: Date.now() - started,
      errors: [
        ...discovery.errors,
        ...ingest.errors.map((error) => `${error.title}: ${error.error}`),
      ],
      blockedReason: discovery.blockedReason,
    });
  } catch (err) {
    return sourceSummary({
      source: adapter,
      keyword: adapter.defaultKeyword,
      runId: null,
      outcome: outcomeFromError(err),
      discovered: 0,
      excluded: 0,
      imported: 0,
      pagesPersisted: 0,
      pagesFetched: null,
      elapsedMs: Date.now() - started,
      errors: [errorMessage(err)],
      blockedReason: errorMessage(err),
    });
  }
}

export function outcomeAfterPersistence(
  discoveryOutcome: SourceOutcome,
  persistenceErrorCount: number,
): SourceOutcome {
  return persistenceErrorCount > 0 && discoveryOutcome === "success"
    ? "http_error"
    : discoveryOutcome;
}

function sourceSummary(input: {
  source: SourceAdapter;
  keyword: string;
  runId: number | null;
  outcome: SourceOutcome;
  discovered: number;
  excluded: number;
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
    excluded: input.excluded,
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
