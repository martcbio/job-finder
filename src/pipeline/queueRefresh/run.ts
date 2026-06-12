import { runFastRefresh, type FastRefreshOptions, type FastRefreshResult } from "../fastRefresh/run";
import { sourceAdapterFor } from "../fastRefresh/summaries";
import type { FastRefreshSourceSummary } from "../fastRefresh/types";
import { DEFAULT_FAST_REFRESH_OPTIONS, ZERO_COSTS } from "../fastRefresh/types";
import { sourceAttemptStatus } from "../sourceAdapterContract";
import { runJobspyLaneRefresh } from "./jobspyRefresh";
import { partitionQueueRefreshSourceIds } from "./plan";
import { runSourceSearchForSites, searchRunToSourceSummaries } from "./sourceSearchRun";

export interface QueueRefreshOptions extends Partial<FastRefreshOptions> {
  sourceIds?: string[];
  searchKeywords?: string[];
  searchMaxQueries?: number;
  searchLimitPerQuery?: number;
  pageIngestLimit?: number;
  skipPostProcess?: boolean;
  jobspySnapshotFile?: string | null;
}

async function runPostProcessSteps(input: {
  pageIngestLimit: number;
  classifyLimit: number;
  timeoutMs: number;
}): Promise<void> {
  const steps: string[][] = [
    [
      "bun",
      "run",
      "jobs:ingest-pages",
      "--",
      "--limit",
      String(input.pageIngestLimit),
      "--timeout-ms",
      String(input.timeoutMs),
    ],
    ["bun", "run", "jobs:classify", "--", "--limit", String(input.classifyLimit)],
  ];

  for (const command of steps) {
    const proc = Bun.spawn(command, {
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
    }
  }
}

function skippedSourceSummary(sourceId: string, reason: string): FastRefreshSourceSummary {
  const source = sourceAdapterFor(sourceId, null, null);
  return {
    source,
    keyword: sourceId,
    runId: null,
    outcome: "not_implemented",
    status: sourceAttemptStatus("not_implemented", 0, [reason]),
    discovered: 0,
    imported: 0,
    fullText: { persisted: 0, fetchedPages: null, status: "pending" },
    classification: { classified: 0 },
    costs: ZERO_COSTS,
    elapsedMs: 0,
    errors: [reason],
    blockedReason: reason,
  };
}

export async function runQueueRefresh(
  input: QueueRefreshOptions = {},
): Promise<FastRefreshResult> {
  const requestedIds =
    input.sourceIds && input.sourceIds.length > 0 ? input.sourceIds : undefined;
  const { fastRefreshIds, searchSiteIds, laneImportIds, unsupportedIds } =
    partitionQueueRefreshSourceIds(requestedIds ?? ["jobserve", "linear-careers"]);

  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  const fastResult =
    fastRefreshIds.length > 0
      ? await runFastRefresh({
          ...input,
          sourceIds: fastRefreshIds,
        })
      : null;

  const searchResult =
    searchSiteIds.length > 0
      ? await runSourceSearchForSites({
          siteIds: searchSiteIds,
          keywords: input.searchKeywords,
          maxQueries: input.searchMaxQueries,
          limitPerQuery: input.searchLimitPerQuery ?? 6,
          timeoutMs: input.timeoutMs ?? 20000,
        })
      : null;

  const laneSummaries: FastRefreshSourceSummary[] = [];
  for (const laneId of laneImportIds) {
    if (laneId === "jobspy") {
      laneSummaries.push(
        await runJobspyLaneRefresh({
          limit: input.directLimit ?? 6,
          timeoutMs: input.timeoutMs ?? 20000,
          snapshotFile: input.jobspySnapshotFile,
        }),
      );
    }
  }

  const skippedSummaries = unsupportedIds.map((id) =>
    skippedSourceSummary(id, `No refresh adapter for "${id}"`),
  );

  const fastImported =
    fastResult?.sources.reduce((sum, source) => sum + source.imported, 0) ?? 0;
  const laneImported = laneSummaries.reduce((sum, source) => sum + source.imported, 0);
  const searchResults = searchResult?.totalResults ?? 0;

  if (!input.skipPostProcess && (fastImported > 0 || laneImported > 0 || searchResults > 0)) {
    await runPostProcessSteps({
      pageIngestLimit: input.pageIngestLimit ?? 20,
      classifyLimit: input.classifyLimit ?? 250,
      timeoutMs: input.timeoutMs ?? 20000,
    });
  }

  const searchSources = searchResult ? searchRunToSourceSummaries(searchResult) : [];
  const sources = [
    ...(fastResult?.sources ?? []),
    ...laneSummaries,
    ...searchSources,
    ...skippedSummaries,
  ];
  const classified = fastResult?.classified ?? [];
  const finishedAt = new Date().toISOString();

  return {
    startedAt: fastResult?.startedAt ?? startedAt,
    finishedAt,
    elapsedMs: Date.now() - started,
    options: fastResult?.options ?? {
      ...DEFAULT_FAST_REFRESH_OPTIONS,
      ...input,
      sourceIds: [...fastRefreshIds, ...searchSiteIds, ...laneImportIds],
    },
    sources,
    classified,
    costs: fastResult?.costs ?? {
      jinaSearchTokens: searchResult?.totalReportedTokens ?? 0,
      jinaReaderTokens: 0,
      openAiTokens: 0,
      billableSearchApiCalls: searchResult?.successfulQueries ?? 0,
    },
    latest: fastResult?.latest ?? { jobs: [], jobserve: [], direct: [] },
  };
}
