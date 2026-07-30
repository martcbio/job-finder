import {
  buildGoogleCareersAdapters,
  buildJobServeAdapters,
  buildLinearCareersAdapters,
} from "./fastRefresh/sourceFactories";
import type { FastRefreshSourceAdapter, SourceAdapter } from "./sourceAdapterContract";

export type SourcePipelineKind = "lab" | "fast" | "lane_import";

export interface SourceAdapterFactoryOptions {
  jobserveQueries: string[];
  jobserveMaxPages: number;
}

export type SourceAdapterFactory = (
  source: RegisteredJobSource,
  options: SourceAdapterFactoryOptions,
) => FastRefreshSourceAdapter[];

export interface RegisteredJobSource {
  id: string;
  label: string;
  kind: SourceAdapter["kind"];
  quality: SourceAdapter["quality"];
  pipelineKind: SourcePipelineKind;
  defaultIngest: boolean;
  defaultFastRefresh: boolean;
  buildAdapters: SourceAdapterFactory | null;
}

export const REGISTERED_JOB_SOURCES = [
  {
    id: "lab-ats",
    label: "Lab ATS",
    kind: "ats",
    quality: "high",
    pipelineKind: "lab",
    defaultIngest: true,
    defaultFastRefresh: false,
    buildAdapters: null,
  },
  {
    id: "jobserve",
    label: "JobServe",
    kind: "recruiter",
    quality: "medium",
    pipelineKind: "fast",
    defaultIngest: true,
    defaultFastRefresh: true,
    buildAdapters: buildJobServeAdapters,
  },
  {
    id: "linear-careers",
    label: "Linear Careers",
    kind: "direct_employer",
    quality: "high",
    pipelineKind: "fast",
    defaultIngest: true,
    defaultFastRefresh: true,
    buildAdapters: buildLinearCareersAdapters,
  },
  {
    id: "google-careers",
    label: "Google Careers",
    kind: "direct_employer",
    quality: "high",
    pipelineKind: "fast",
    defaultIngest: true,
    defaultFastRefresh: true,
    buildAdapters: buildGoogleCareersAdapters,
  },
  {
    id: "jobspy",
    label: "JobSpy",
    kind: "aggregator",
    quality: "medium",
    pipelineKind: "lane_import",
    defaultIngest: false,
    defaultFastRefresh: false,
    buildAdapters: null,
  },
] as const satisfies readonly RegisteredJobSource[];

export type RegisteredJobSourceId = (typeof REGISTERED_JOB_SOURCES)[number]["id"];
export type FastRefreshSourceId = Extract<
  (typeof REGISTERED_JOB_SOURCES)[number],
  { pipelineKind: "fast" }
>["id"];

export const JOB_INGEST_SOURCE_IDS = new Set<string>(
  REGISTERED_JOB_SOURCES.filter((source) => source.pipelineKind !== "lane_import").map(
    (source) => source.id,
  ),
);

export const DEFAULT_JOB_INGEST_SOURCE_IDS = REGISTERED_JOB_SOURCES.filter(
  (source) => source.defaultIngest,
).map((source) => source.id);

export const FAST_REFRESH_SOURCE_IDS = new Set<string>(
  REGISTERED_JOB_SOURCES.filter((source) => source.pipelineKind === "fast").map(
    (source) => source.id,
  ),
);

export const DEFAULT_FAST_REFRESH_SOURCE_IDS = REGISTERED_JOB_SOURCES.filter(
  (source) => source.defaultFastRefresh,
).map((source) => source.id);

export const DIRECT_EMPLOYER_FAST_REFRESH_SOURCE_IDS = new Set<string>(
  REGISTERED_JOB_SOURCES.filter(
    (source) => source.pipelineKind === "fast" && source.kind === "direct_employer",
  ).map((source) => source.id),
);

export const LANE_IMPORT_SOURCE_IDS = new Set<string>(
  REGISTERED_JOB_SOURCES.filter((source) => source.pipelineKind === "lane_import").map(
    (source) => source.id,
  ),
);

export function normalizeRegisteredSourceId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  return normalized === "linear" ? "linear-careers" : normalized;
}

export function registeredJobSource(sourceId: string): RegisteredJobSource | null {
  const normalized = normalizeRegisteredSourceId(sourceId);
  return REGISTERED_JOB_SOURCES.find((source) => source.id === normalized) ?? null;
}

export function isFastRefreshSourceId(sourceId: string): sourceId is FastRefreshSourceId {
  return FAST_REFRESH_SOURCE_IDS.has(normalizeRegisteredSourceId(sourceId));
}

export function buildRegisteredSourceAdapters(
  sourceIds: readonly string[],
  options: SourceAdapterFactoryOptions,
): FastRefreshSourceAdapter[] {
  const adapters: FastRefreshSourceAdapter[] = [];
  for (const rawSourceId of sourceIds) {
    const source = registeredJobSource(rawSourceId);
    if (!source || source.pipelineKind !== "fast" || !source.buildAdapters) {
      throw new Error(`Unknown fast-refresh source: ${rawSourceId}`);
    }
    adapters.push(...source.buildAdapters(source, options));
  }
  return adapters;
}
