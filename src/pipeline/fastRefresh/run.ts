import { planMigrations } from "../../db/migrations";
import { runPsql, runPsqlJson } from "../../db/psql";
import {
  buildClassifiableJobsForSearchRunSql,
  buildUpdateJobClassificationSql,
  type ClassifiableJobRow,
  classifyJobText,
} from "../jobClassification";
import { rankJobServeContracts } from "../jobserveContracts";
import { buildFastRefreshSourceAdapters, ingestSourceAdapter } from "./adapters";
import { buildLatestJobRowsSql } from "./queries";
import {
  aggregateCosts,
  jobRowToJobServeContract,
  mergeJobRows,
  orderJobSummaries,
} from "./summaries";
import type {
  FastRefreshClassificationSummary,
  FastRefreshJobRow,
  FastRefreshOptions,
  FastRefreshResult,
} from "./types";
import { DEFAULT_FAST_REFRESH_OPTIONS as DEFAULT_OPTIONS } from "./types";
import { normalizeSourceId } from "./utils";

export function normalizeFastRefreshOptions(
  input: Partial<FastRefreshOptions> = {},
): FastRefreshOptions {
  return {
    ...DEFAULT_OPTIONS,
    ...input,
    sourceIds:
      input.sourceIds && input.sourceIds.length > 0
        ? [...new Set(input.sourceIds.map(normalizeSourceId))]
        : DEFAULT_OPTIONS.sourceIds,
    jobserveQueries:
      input.jobserveQueries && input.jobserveQueries.length > 0
        ? input.jobserveQueries
        : DEFAULT_OPTIONS.jobserveQueries,
  };
}

export async function runFastRefresh(
  input: Partial<FastRefreshOptions> = {},
): Promise<FastRefreshResult> {
  const options = normalizeFastRefreshOptions(input);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  await assertMigrationsReady();

  const adapters = buildFastRefreshSourceAdapters(options);
  const sources = await Promise.all(
    adapters.map((adapter) => ingestSourceAdapter(adapter, options)),
  );

  const runIds = sources.flatMap((item) => (item.runId === null ? [] : [item.runId]));
  const classified = await Promise.all(
    runIds.map((runId) => classifyRun(runId, options.classifyLimit)),
  );
  const classifiedByRunId = new Map(classified.map((item) => [item.runId, item.classified]));
  const sourceSummaries = sources.map((source) => ({
    ...source,
    classification: {
      classified: source.runId === null ? 0 : (classifiedByRunId.get(source.runId) ?? 0),
    },
  }));

  const jobserveRunIds = sources
    .filter((source) => source.source.id === "jobserve")
    .flatMap((source) => (source.runId === null ? [] : [source.runId]));
  const jobserveRows =
    jobserveRunIds.length > 0
      ? await runPsqlJson<FastRefreshJobRow[]>(
          buildLatestJobRowsSql({
            limit: 1000,
            runIds: jobserveRunIds,
            sourceIds: ["jobserve"],
          }),
        )
      : [];
  const rankedJobServe = rankJobServeContracts(jobserveRows.map(jobRowToJobServeContract), {
    limit: options.limit,
  });
  const directRows =
    runIds.length > 0 && options.sourceIds.includes("linear-careers")
      ? await runPsqlJson<FastRefreshJobRow[]>(
          buildLatestJobRowsSql({
            limit: options.limit,
            runIds,
            sourceIds: ["linear-careers"],
          }),
        )
      : [];
  const rankedIds = [...rankedJobServe.map((row) => row.id), ...directRows.map((row) => row.id)];
  const rows = mergeJobRows(jobserveRows, directRows);
  const rankedById = new Map(rankedJobServe.map((row) => [row.id, row]));
  const directIds = new Set(directRows.map((row) => row.id));
  const jobs = orderJobSummaries(rows, rankedIds, rankedById);
  const finishedAt = new Date().toISOString();

  return {
    startedAt,
    finishedAt,
    elapsedMs: Date.now() - started,
    options,
    sources: sourceSummaries,
    classified,
    costs: aggregateCosts(sourceSummaries),
    latest: {
      jobs,
      jobserve: jobs.filter((job) => job.source.id === "jobserve"),
      direct: jobs.filter((job) => directIds.has(job.id)),
    },
  };
}

async function assertMigrationsReady(): Promise<void> {
  const plan = await planMigrations();
  if (plan.pending.length > 0) {
    throw new Error(
      `Database has ${plan.pending.length} pending migration(s). Run bun run db:migrate.`,
    );
  }
}

async function classifyRun(
  runId: number,
  limit: number,
): Promise<FastRefreshClassificationSummary> {
  const rows = await runPsqlJson<ClassifiableJobRow[]>(
    buildClassifiableJobsForSearchRunSql(runId, limit),
  );
  let classified = 0;
  for (const row of rows) {
    const classification = classifyJobText({
      title: row.title,
      description: row.description_text,
      hasPageSnapshot: row.has_page_snapshot,
    });
    await runPsql(buildUpdateJobClassificationSql(row.id, classification));
    classified++;
  }
  return { runId, classified };
}
