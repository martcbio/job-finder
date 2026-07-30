import { planMigrations } from "../db/migrations";
import { buildFastRefreshSourceAdapters, ingestSourceAdapter } from "./fastRefresh/adapters";
import type { FastRefreshOptions, FastRefreshSourceSummary } from "./fastRefresh/types";
import { DEFAULT_FAST_REFRESH_OPTIONS } from "./fastRefresh/types";
import { normalizeSourceId } from "./fastRefresh/utils";
import { resolveLabOpeningsPaths } from "./labOpenings";
import { runLabRawIngest } from "./labRawIngest";

const ALLOWED_SOURCE_IDS = new Set(["lab-ats", "jobserve", "linear-careers", "google-careers"]);
const DEFAULT_SOURCE_IDS = ["lab-ats", "linear-careers", "google-careers"];

export interface JobIngestOptions
  extends Pick<
    FastRefreshOptions,
    | "jobserveQueries"
    | "jobserveMaxPages"
    | "jobserveImportLimitPerQuery"
    | "directLimit"
    | "timeoutMs"
  > {
  sourceIds: string[];
  marketDir: string;
}

export interface JobIngestOptionsInput extends Partial<JobIngestOptions> {
  includeJobServe?: boolean;
}

export interface JobIngestSourceReceipt {
  id: string;
  label: string;
  status: "complete" | "degraded" | "failed";
  runId: number | null;
  discovered: number;
  imported: number;
  evidencePath: string | null;
  errors: string[];
  elapsedMs: number;
}

export interface JobIngestResult {
  status: "complete" | "degraded" | "failed";
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  options: JobIngestOptions;
  sources: JobIngestSourceReceipt[];
}

interface JobIngestDependencies {
  ensureReady(): Promise<void>;
  runLab(options: JobIngestOptions): Promise<JobIngestSourceReceipt>;
  runSources(options: JobIngestOptions): Promise<JobIngestSourceReceipt[]>;
}

export function normalizeJobIngestOptions(input: JobIngestOptionsInput = {}): JobIngestOptions {
  const requested = input.sourceIds?.length ? input.sourceIds : DEFAULT_SOURCE_IDS;
  const sourceIds = [...new Set(requested.map(normalizeSourceId))];
  if (input.includeJobServe && !sourceIds.includes("jobserve")) sourceIds.push("jobserve");
  for (const sourceId of sourceIds) {
    if (!ALLOWED_SOURCE_IDS.has(sourceId)) throw new Error(`Unknown ingest source: ${sourceId}`);
  }
  const options: JobIngestOptions = {
    sourceIds,
    marketDir: input.marketDir ?? resolveLabOpeningsPaths().marketDir,
    jobserveQueries: input.jobserveQueries ?? DEFAULT_FAST_REFRESH_OPTIONS.jobserveQueries,
    jobserveMaxPages: input.jobserveMaxPages ?? DEFAULT_FAST_REFRESH_OPTIONS.jobserveMaxPages,
    jobserveImportLimitPerQuery:
      input.jobserveImportLimitPerQuery ?? DEFAULT_FAST_REFRESH_OPTIONS.jobserveImportLimitPerQuery,
    directLimit: input.directLimit ?? DEFAULT_FAST_REFRESH_OPTIONS.directLimit,
    timeoutMs: input.timeoutMs ?? DEFAULT_FAST_REFRESH_OPTIONS.timeoutMs,
  };
  if (options.jobserveQueries.length > 3) {
    throw new Error("JobServe ingest is limited to 3 queries");
  }
  if (options.jobserveMaxPages > 2) {
    throw new Error("JobServe ingest is limited to 2 pages per query");
  }
  if (options.jobserveImportLimitPerQuery > 5) {
    throw new Error("JobServe ingest is limited to 5 detail pages per query");
  }
  return options;
}

function sourceHealth(source: FastRefreshSourceSummary): JobIngestSourceReceipt["status"] {
  if (source.status === "success" || source.status === "zero_results") return "complete";
  if (source.status === "partial") return "degraded";
  return "failed";
}

function overallHealth(sources: JobIngestSourceReceipt[]): JobIngestResult["status"] {
  if (sources.length === 0 || sources.every((source) => source.status === "failed"))
    return "failed";
  return sources.every((source) => source.status === "complete") ? "complete" : "degraded";
}

const defaultDependencies: JobIngestDependencies = {
  async ensureReady() {
    const plan = await planMigrations();
    if (plan.pending.length > 0) {
      throw new Error(
        `Database has ${plan.pending.length} pending migration(s). Run bun run db:migrate.`,
      );
    }
  },
  async runLab(options) {
    const result = await runLabRawIngest({
      marketDir: options.marketDir,
      timeoutMs: options.timeoutMs,
    });
    return {
      id: result.id,
      label: result.label,
      status: result.status,
      runId: result.runId,
      discovered: result.discovered,
      imported: result.imported,
      evidencePath: result.evidencePath,
      errors: result.errors,
      elapsedMs: result.elapsedMs,
    };
  },
  async runSources(options) {
    const adapters = buildFastRefreshSourceAdapters({
      ...options,
      sourceIds: options.sourceIds.filter((sourceId) => sourceId !== "lab-ats"),
    });
    const receipts: JobIngestSourceReceipt[] = [];
    for (const adapter of adapters) {
      const source = await ingestSourceAdapter(adapter, options);
      receipts.push({
        id: source.source.id,
        label: source.source.label,
        status: sourceHealth(source),
        runId: source.runId,
        discovered: source.discovered,
        imported: source.imported,
        evidencePath: null,
        errors: source.errors,
        elapsedMs: source.elapsedMs,
      });
    }
    return receipts;
  },
};

export async function runJobIngest(
  input: JobIngestOptionsInput = {},
  dependencies: Partial<JobIngestDependencies> = {},
): Promise<JobIngestResult> {
  const options = normalizeJobIngestOptions(input);
  const deps = { ...defaultDependencies, ...dependencies };
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  await deps.ensureReady();
  const sources: JobIngestSourceReceipt[] = [];
  if (options.sourceIds.includes("lab-ats")) sources.push(await deps.runLab(options));
  const nonLabSourceIds = options.sourceIds.filter((sourceId) => sourceId !== "lab-ats");
  if (nonLabSourceIds.length > 0) {
    sources.push(...(await deps.runSources({ ...options, sourceIds: nonLabSourceIds })));
  }
  const finishedAt = new Date().toISOString();
  return {
    status: overallHealth(sources),
    startedAt,
    finishedAt,
    elapsedMs: Date.now() - started,
    options,
    sources,
  };
}
