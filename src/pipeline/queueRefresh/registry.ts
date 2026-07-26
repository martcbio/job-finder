import { JOB_SOURCE_SITES, resolveJobSourceSites } from "../sourceSites";

export const FAST_REFRESH_SOURCE_IDS = new Set(["jobserve", "linear-careers", "google-careers"]);

/** Normalized imports (snapshot file) rather than live search. */
export const LANE_IMPORT_SOURCE_IDS = new Set(["jobspy"]);

export function normalizeQueueRefreshSourceId(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, "-");
}

let cachedIds: Set<string> | null = null;

export function allQueueRefreshSourceIds(): string[] {
  const ids = new Set<string>([...FAST_REFRESH_SOURCE_IDS, ...LANE_IMPORT_SOURCE_IDS]);
  for (const site of JOB_SOURCE_SITES) ids.add(site.id);
  return [...ids];
}

export function allQueueRefreshSourceIdSet(): Set<string> {
  if (!cachedIds) {
    cachedIds = new Set(allQueueRefreshSourceIds().map(normalizeQueueRefreshSourceId));
  }
  return cachedIds;
}

export function isQueueRefreshSourceId(sourceId: string): boolean {
  return allQueueRefreshSourceIdSet().has(normalizeQueueRefreshSourceId(sourceId));
}

export type QueueRefreshKind = "fast" | "search" | "lane_import";

export function queueRefreshKindFor(sourceId: string): QueueRefreshKind | null {
  const id = normalizeQueueRefreshSourceId(sourceId);
  if (FAST_REFRESH_SOURCE_IDS.has(id)) return "fast";
  if (LANE_IMPORT_SOURCE_IDS.has(id)) return "lane_import";
  try {
    resolveJobSourceSites([id]);
    return "search";
  } catch {
    return null;
  }
}
