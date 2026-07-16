import { normalizeQueueRefreshSourceId, queueRefreshKindFor } from "./registry";

export { allQueueRefreshSourceIds, FAST_REFRESH_SOURCE_IDS } from "./registry";

export function partitionQueueRefreshSourceIds(sourceIds: readonly string[]): {
  fastRefreshIds: string[];
  searchSiteIds: string[];
  laneImportIds: string[];
  unsupportedIds: string[];
} {
  const fastRefreshIds: string[] = [];
  const searchSiteIds: string[] = [];
  const laneImportIds: string[] = [];
  const unsupportedIds: string[] = [];

  for (const raw of sourceIds) {
    const id = normalizeQueueRefreshSourceId(raw);
    if (!id) continue;

    const kind = queueRefreshKindFor(id);
    if (kind === "fast") {
      fastRefreshIds.push(id);
    } else if (kind === "search") {
      searchSiteIds.push(id);
    } else if (kind === "lane_import") {
      laneImportIds.push(id);
    } else {
      unsupportedIds.push(id);
    }
  }

  return {
    fastRefreshIds: [...new Set(fastRefreshIds)],
    searchSiteIds: [...new Set(searchSiteIds)],
    laneImportIds: [...new Set(laneImportIds)],
    unsupportedIds: [...new Set(unsupportedIds)],
  };
}
