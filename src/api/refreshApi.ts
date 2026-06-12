import { SEARCH_KEYWORDS } from "../config/search";
import { listFastRefreshSources } from "../pipeline/fastRefresh";
import { sourceAdapterFor } from "../pipeline/fastRefresh/summaries";
import type { SourceAdapterDescriptor } from "../pipeline/sourceAdapterContract";
import { JOB_SOURCE_SITES } from "../pipeline/sourceSites";
import {
  allQueueRefreshSourceIds,
  FAST_REFRESH_SOURCE_IDS,
  LANE_IMPORT_SOURCE_IDS,
} from "../pipeline/queueRefresh/registry";
import { ApiError } from "./errors";

export function uniqueFastRefreshSources(): ReturnType<typeof listFastRefreshSources> {
  const sources = new Map<string, ReturnType<typeof listFastRefreshSources>[number]>();
  for (const source of listFastRefreshSources()) {
    if (!sources.has(source.id)) sources.set(source.id, source);
  }
  return [...sources.values()];
}

/** All sources Update queue can refresh: native feeds + configured ATS/search sites. */
export function listQueueRefreshSources(): SourceAdapterDescriptor[] {
  const fast = uniqueFastRefreshSources();
  const seen = new Set(fast.map((source) => source.id));
  const defaultKeyword = SEARCH_KEYWORDS[0] ?? "Agentic";
  const defaultIncluded = new Set([
    "jobserve",
    "linear-careers",
    "jobspy",
    "greenhouse",
    "lever",
    "ashby",
    "workable",
    "smartrecruiters",
    "rippling",
  ]);

  const siteDescriptors: SourceAdapterDescriptor[] = [];
  for (const site of JOB_SOURCE_SITES) {
    if (seen.has(site.id)) continue;
    seen.add(site.id);
    const adapter = sourceAdapterFor(site.id, site.label, null);
    siteDescriptors.push({
      id: adapter.id,
      label: adapter.label,
      kind: adapter.kind,
      quality: adapter.quality,
      defaultKeyword,
      defaultIncluded: defaultIncluded.has(site.id),
      supportsSourceScopedRefresh: true,
    });
  }

  const laneDescriptors: SourceAdapterDescriptor[] = [];
  for (const laneId of LANE_IMPORT_SOURCE_IDS) {
    if (seen.has(laneId)) continue;
    seen.add(laneId);
    const adapter = sourceAdapterFor(laneId, null, null);
    laneDescriptors.push({
      id: adapter.id,
      label: adapter.label,
      kind: adapter.kind,
      quality: adapter.quality,
      defaultKeyword: laneId,
      defaultIncluded: defaultIncluded.has(laneId),
      supportsSourceScopedRefresh: true,
    });
  }

  return [...fast, ...siteDescriptors, ...laneDescriptors];
}

export function listRefreshableSourceIds(): string[] {
  return allQueueRefreshSourceIds();
}

export function fastRefreshSourceId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  const sourceId = normalized === "linear" ? "linear-careers" : normalized;
  const valid = new Set(listQueueRefreshSources().map((source) => source.id));
  if (!valid.has(sourceId)) {
    throw new ApiError(400, "invalid_source", `Unsupported refresh source "${value}"`, {
      valid: [...valid],
    });
  }
  return sourceId;
}

export function isFastRefreshSourceId(sourceId: string): boolean {
  return FAST_REFRESH_SOURCE_IDS.has(sourceId);
}
