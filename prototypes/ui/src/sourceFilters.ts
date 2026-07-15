import type { FastRefreshSourceInfo, ReviewQueueRow, SourceHealthRow } from "./types";

const STORAGE_KEY = "job-finder.sourceFilters.v3";

/** Direct employer boards stay useful longer than high-churn recruiter feeds. */
export const EVERGREEN_SOURCE_IDS = new Set(["linear-careers"]);

export interface SourceCatalogEntry {
  id: string;
  label: string;
  successRate: number;
  evergreen: boolean;
}

export function isEvergreenSource(sourceId: string): boolean {
  return EVERGREEN_SOURCE_IDS.has(sourceId);
}

function normalizeSourceId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

export function buildSourceCatalog(
  health: SourceHealthRow[],
  refreshSources: FastRefreshSourceInfo[],
): SourceCatalogEntry[] {
  const refreshById = new Map(refreshSources.map((s) => [normalizeSourceId(s.id), s]));
  const seen = new Set<string>();
  const entries: SourceCatalogEntry[] = [];

  const sorted = [...health].sort((a, b) => {
    const ar =
      typeof a.success_rate === "string" ? Number.parseFloat(a.success_rate) : a.success_rate;
    const br =
      typeof b.success_rate === "string" ? Number.parseFloat(b.success_rate) : b.success_rate;
    return (Number.isFinite(br) ? br : 0) - (Number.isFinite(ar) ? ar : 0);
  });

  for (const row of sorted) {
    const id = row.source_id;
    if (seen.has(id)) continue;
    seen.add(id);
    const refresh = refreshById.get(normalizeSourceId(id));
    const rate =
      typeof row.success_rate === "string" ? Number.parseFloat(row.success_rate) : row.success_rate;
    entries.push({
      id,
      label: row.source_label ?? refresh?.label ?? id,
      successRate: Number.isFinite(rate) ? rate : 0,
      evergreen: isEvergreenSource(id),
    });
  }

  for (const refresh of refreshSources) {
    if (seen.has(refresh.id)) continue;
    entries.push({
      id: refresh.id,
      label: refresh.label,
      successRate: 0,
      evergreen: isEvergreenSource(refresh.id),
    });
  }

  return entries;
}

export function loadEnabledSourceIds(catalog: SourceCatalogEntry[]): string[] {
  if (catalog.length === 0) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return catalog.map((s) => s.id);
    const parsed = JSON.parse(raw) as { enabledSourceIds?: string[] };
    const valid = new Set(catalog.map((s) => s.id));
    const saved = (parsed.enabledSourceIds ?? []).filter((id) => valid.has(id));
    return saved.length > 0 ? saved : catalog.map((s) => s.id);
  } catch {
    return catalog.map((s) => s.id);
  }
}

export function hasSavedSourceSelection(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function saveEnabledSourceIds(ids: string[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabledSourceIds: ids }));
}

function normalizeSourceToken(value: string): string {
  return value.toLowerCase().replace(/[\s_]+/g, "-");
}

export function jobMatchesSourceId(job: ReviewQueueRow, sourceId: string): boolean {
  const target = normalizeSourceToken(sourceId);
  return (job.source_labels ?? []).some((label) => normalizeSourceToken(label) === target);
}

export function jobMatchesAnyEnabledSource(job: ReviewQueueRow, enabledIds: Set<string>): boolean {
  if (enabledIds.size === 0) return false;
  for (const id of enabledIds) {
    if (jobMatchesSourceId(job, id)) return true;
  }
  return false;
}

export function allSourceIds(catalog: SourceCatalogEntry[]): string[] {
  return catalog.map((s) => s.id);
}

export function filterQueueBySources(
  queue: ReviewQueueRow[],
  enabledIds: Set<string>,
): ReviewQueueRow[] {
  return queue.filter((job) => jobMatchesAnyEnabledSource(job, enabledIds));
}

export function toggleSourceId(
  enabled: string[],
  sourceId: string,
  catalog: SourceCatalogEntry[],
): string[] {
  const set = new Set(enabled);
  if (set.has(sourceId)) set.delete(sourceId);
  else set.add(sourceId);
  const order = catalog.map((s) => s.id);
  return order.filter((id) => set.has(id));
}
