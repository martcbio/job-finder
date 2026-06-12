import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MOCK_PIPELINE_RUNS, MOCK_QUEUE, MOCK_SOURCE_HEALTH } from "./mockData";
import { mergeQueueRows, sortByLastSeen } from "./queueViews";
import { postJobReview } from "./reviewApi";
import {
  allSourceIds,
  buildSourceCatalog,
  EVERGREEN_SOURCE_IDS,
  filterQueueBySources,
  loadEnabledSourceIds,
  refreshTargets,
  saveEnabledSourceIds,
  toggleSourceId,
  type SourceCatalogEntry,
} from "./sourceFilters";
import type { FastRefreshSourceInfo } from "./types";
import { useDelayedBusy } from "./useDelayedBusy";
import type {
  ApiEnvelope,
  ApiMeta,
  FastRefreshResult,
  PipelineRunRow,
  RefreshRunRow,
  ReviewQueueRow,
  SourceHealthRow,
  SourcesApiData,
} from "./types";

const API_BASE = "/api";

interface FetchResult<T> {
  data: T | null;
  error: string | null;
}

async function fetchApi<T>(path: string, init?: RequestInit): Promise<FetchResult<T>> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      cache: "no-store",
    });
    const body = (await res.json()) as ApiEnvelope<T>;
    if (!res.ok) {
      return {
        data: null,
        error: body.error?.message ?? `HTTP ${res.status}`,
      };
    }
    if (!body.ok || body.data === undefined) {
      return { data: null, error: body.error?.message ?? "Invalid API response" };
    }
    return { data: body.data, error: null };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeQueueRow(row: ReviewQueueRow): ReviewQueueRow {
  return {
    ...row,
    duplicate_candidates: row.duplicate_candidates ?? [],
    source_labels: row.source_labels ?? [],
    classification_labels: row.classification_labels ?? [],
  };
}

function normalizeSourceHealth(row: SourceHealthRow): SourceHealthRow {
  const rate =
    typeof row.success_rate === "string"
      ? Number.parseFloat(row.success_rate)
      : row.success_rate;
  return {
    ...row,
    success_rate: Number.isFinite(rate) ? rate : 0,
    lane: row.lane ?? row.source_label ?? row.source_id,
  };
}

function normalizePipelineRun(row: PipelineRunRow): PipelineRunRow {
  return {
    ...row,
    error_message: row.error_message ?? row.error_summary ?? null,
    step_count: row.step_count ?? row.steps?.length ?? 0,
  };
}

export type RefreshFeedbackKind = "idle" | "success" | "noop" | "error";

const TRIAGE_STATES_PARAM =
  "ready_for_review,duplicate_candidate,new,needs_page_ingest,needs_classification";
const EVERGREEN_STATES_PARAM = `${TRIAGE_STATES_PARAM},shortlisted`;

export interface JobFinderData {
  queue: ReviewQueueRow[];
  /** Queue after source visibility filter (full queue still in `queue`). */
  visibleQueue: ReviewQueueRow[];
  sourceCatalog: SourceCatalogEntry[];
  enabledSourceIds: string[];
  toggleSource: (sourceId: string) => void;
  selectAllSources: () => void;
  deselectAllSources: () => void;
  /** Checked sources that Update queue will POST to /api/refresh/fast. */
  refreshTargets: SourceCatalogEntry[];
  sourceHealth: SourceHealthRow[];
  pipelineRuns: PipelineRunRow[];
  lastRefreshRun: RefreshRunRow | null;
  meta: ApiMeta | null;
  live: boolean;
  loading: boolean;
  grabbing: boolean;
  refreshing: boolean;
  /** Debounced — spinners/overlays only; buttons use grabbing/refreshing for disable */
  syncingUi: boolean;
  grabbingUi: boolean;
  refreshingUi: boolean;
  refreshError: string | null;
  lastFastRefresh: FastRefreshResult | null;
  lastGrabbedAt: string | null;
  refreshFeedback: { kind: RefreshFeedbackKind; message: string } | null;
  refresh: () => Promise<void>;
  grabLatest: () => Promise<void>;
  runFastRefresh: () => Promise<void>;
  submitReview: (jobId: string, toState: string) => Promise<{ ok: boolean; error?: string }>;
}

export function useJobFinderData(): JobFinderData {
  const [queue, setQueue] = useState<ReviewQueueRow[]>(MOCK_QUEUE);
  const [sourceHealth, setSourceHealth] =
    useState<SourceHealthRow[]>(MOCK_SOURCE_HEALTH);
  const [pipelineRuns, setPipelineRuns] =
    useState<PipelineRunRow[]>(MOCK_PIPELINE_RUNS);
  const [lastRefreshRun, setLastRefreshRun] = useState<RefreshRunRow | null>(null);
  const [meta, setMeta] = useState<ApiMeta | null>(null);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [grabbing, setGrabbing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastFastRefresh, setLastFastRefresh] = useState<FastRefreshResult | null>(null);
  const [lastGrabbedAt, setLastGrabbedAt] = useState<string | null>(null);
  const [refreshFeedback, setRefreshFeedback] = useState<{
    kind: RefreshFeedbackKind;
    message: string;
  } | null>(null);
  const [refreshSources, setRefreshSources] = useState<FastRefreshSourceInfo[]>([]);
  const [refreshableSourceIds, setRefreshableSourceIds] = useState<string[]>([]);
  const [enabledSourceIds, setEnabledSourceIds] = useState<string[]>([]);

  const queueIdsBeforeRefresh = useRef<Set<string>>(new Set());

  const sourceCatalog = useMemo(
    () => buildSourceCatalog(sourceHealth, refreshSources, refreshableSourceIds),
    [sourceHealth, refreshSources, refreshableSourceIds],
  );

  const enabledSourceSet = useMemo(
    () => new Set(enabledSourceIds),
    [enabledSourceIds],
  );

  const visibleQueue = useMemo(
    () => filterQueueBySources(queue, enabledSourceSet),
    [queue, enabledSourceSet],
  );

  const refreshTargetList = useMemo(
    () => refreshTargets(enabledSourceIds, sourceCatalog),
    [enabledSourceIds, sourceCatalog],
  );

  const persistEnabled = useCallback((ids: string[]) => {
    saveEnabledSourceIds(ids);
    setEnabledSourceIds(ids);
  }, []);

  const toggleSource = useCallback(
    (sourceId: string) => {
      setEnabledSourceIds((prev) => {
        const next = toggleSourceId(prev, sourceId, sourceCatalog);
        saveEnabledSourceIds(next);
        return next;
      });
    },
    [sourceCatalog],
  );

  const selectAllSources = useCallback(() => {
    persistEnabled(allSourceIds(sourceCatalog));
  }, [sourceCatalog, persistEnabled]);

  const deselectAllSources = useCallback(() => {
    persistEnabled([]);
  }, [persistEnabled]);

  useEffect(() => {
    if (sourceCatalog.length === 0) return;
    setEnabledSourceIds((prev) => {
      const valid = new Set(sourceCatalog.map((s) => s.id));
      const kept = prev.filter((id) => valid.has(id));
      if (kept.length > 0) return kept;
      return loadEnabledSourceIds(sourceCatalog);
    });
  }, [sourceCatalog]);

  const applyLoadResult = useCallback(
    (
      health: FetchResult<{ status: string }>,
      queueData: FetchResult<ReviewQueueRow[]>,
      shortlistedData: FetchResult<ReviewQueueRow[]>,
      healthData: FetchResult<SourceHealthRow[]>,
      runsData: FetchResult<PipelineRunRow[]>,
      metaData: FetchResult<ApiMeta>,
      latestRun: FetchResult<RefreshRunRow>,
      prevCount: number,
      prevIds: Set<string>,
    ) => {
      const isLive = health.data?.status === "ok";
      setLive(isLive);

      const errors: string[] = [];
      if (health.error) errors.push(`Health: ${health.error}`);
      if (queueData.error) errors.push(`Queue: ${queueData.error}`);
      if (shortlistedData.error) errors.push(`Shortlist: ${shortlistedData.error}`);

      let newQueue = queue;
      if (isLive && (queueData.data || shortlistedData.data)) {
        const triage = asArray<ReviewQueueRow>(queueData.data ?? []).map(normalizeQueueRow);
        const shortlisted = asArray<ReviewQueueRow>(shortlistedData.data ?? []).map(
          normalizeQueueRow,
        );
        newQueue = mergeQueueRows(triage, shortlisted);
        setQueue(newQueue);
      } else if (!isLive) {
        setQueue(MOCK_QUEUE);
      }

      if (healthData.error) errors.push(`Sources: ${healthData.error}`);
      if (isLive && healthData.data) {
        setSourceHealth(asArray<SourceHealthRow>(healthData.data).map(normalizeSourceHealth));
      } else if (!isLive) {
        setSourceHealth(MOCK_SOURCE_HEALTH);
      }

      if (runsData.error) errors.push(`Runs: ${runsData.error}`);
      if (isLive && runsData.data) {
        setPipelineRuns(asArray<PipelineRunRow>(runsData.data).map(normalizePipelineRun));
      } else if (!isLive) {
        setPipelineRuns(MOCK_PIPELINE_RUNS);
      }

      setLastRefreshRun(isLive && latestRun.data ? latestRun.data : null);
      setMeta(metaData.data ?? null);

      const added = newQueue.filter((j) => !prevIds.has(j.id)).length;
      const now = new Date().toISOString();
      setLastGrabbedAt(isLive ? now : null);

      if (errors.length > 0) {
        setRefreshError(errors.join(" · "));
        setRefreshFeedback({
          kind: "error",
          message: errors[0] ?? "Refresh failed",
        });
      } else if (!isLive) {
        setRefreshFeedback({
          kind: "error",
          message: "API offline — start with: bun run api",
        });
      } else if (added > 0) {
        setRefreshFeedback({
          kind: "success",
          message: `Loaded ${newQueue.length} jobs (+${added} new)`,
        });
        queueIdsBeforeRefresh.current = new Set(newQueue.map((j) => j.id));
      } else if (newQueue.length !== prevCount) {
        setRefreshFeedback({
          kind: "success",
          message: `Loaded ${newQueue.length} jobs (was ${prevCount})`,
        });
      } else {
        setRefreshError(null);
        // Quiet success — timestamp updates via lastGrabbedAt; no banner flash.
      }
    },
    [],
  );

  const loadFromApi = useCallback(
    async (opts: { fullPageLoad: boolean }) => {
      if (opts.fullPageLoad) setLoading(true);
      else setGrabbing(true);
      setRefreshError(null);

      const prevCount = queue.length;
      const prevIds = new Set(queue.map((j) => j.id));

      const evergreenFetches = [...EVERGREEN_SOURCE_IDS].map((sourceId) =>
        fetchApi<ReviewQueueRow[]>(
          `/jobs/queue?limit=40&source=${encodeURIComponent(sourceId)}&state=${EVERGREEN_STATES_PARAM}`,
        ),
      );

      const [health, queueData, shortlistedData, ...evergreenResults] =
        await Promise.all([
          fetchApi<{ status: string }>("/health"),
          fetchApi<ReviewQueueRow[]>(`/jobs/queue?limit=80&state=${TRIAGE_STATES_PARAM}`),
          fetchApi<ReviewQueueRow[]>("/jobs/queue?limit=50&state=shortlisted"),
          ...evergreenFetches,
        ]);

      const [healthData, runsData, metaData, latestRun] = await Promise.all([
        fetchApi<SourceHealthRow[]>("/source-health"),
        fetchApi<PipelineRunRow[]>("/pipeline-runs?limit=10"),
        fetchApi<ApiMeta>("/meta"),
        fetchApi<RefreshRunRow>("/runs/latest"),
      ]);

      let mergedTriage = queueData;
      for (const row of evergreenResults) {
        if (row.data) {
          mergedTriage = {
            data: mergeQueueRows(
              asArray<ReviewQueueRow>(mergedTriage.data ?? []),
              asArray<ReviewQueueRow>(row.data),
            ),
            error: mergedTriage.error ?? row.error,
          };
        }
      }
      const queueDataMerged = mergedTriage;

      applyLoadResult(
        health,
        queueDataMerged,
        shortlistedData,
        healthData,
        runsData,
        metaData,
        latestRun,
        prevCount,
        prevIds,
      );

      setLoading(false);
      setGrabbing(false);
    },
    [queue.length, applyLoadResult],
  );

  const refresh = useCallback(async () => {
    await loadFromApi({ fullPageLoad: true });
  }, [loadFromApi]);

  const grabLatest = useCallback(async () => {
    await loadFromApi({ fullPageLoad: false });
  }, [loadFromApi]);

  const runFastRefresh = useCallback(async () => {
    const targets = refreshTargets(enabledSourceIds, sourceCatalog);
    if (targets.length === 0) {
      setRefreshFeedback({
        kind: "noop",
        message: "No sources checked — enable sources in the sidebar to refresh.",
      });
      return;
    }

    setRefreshing(true);
    setRefreshError(null);
    try {
      const sourceIds = targets.map((s) => s.id);
      const result = await fetchApi<FastRefreshResult>("/refresh/fast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          limit: 20,
          classifyLimit: 250,
          sourceIds,
        }),
      });
      if (result.error) {
        setRefreshError(result.error);
        setRefreshFeedback({ kind: "error", message: result.error });
        return;
      }
      if (!result.data) {
        setRefreshError("Find new jobs failed");
        setRefreshFeedback({ kind: "error", message: "Find new jobs failed" });
        return;
      }
      setLastFastRefresh(result.data);
      const breakdown = result.data.sources
        .map((s) => {
          const added = s.imported > 0 ? s.imported : s.discovered;
          return `${s.source.id} +${added}`;
        })
        .join(" · ");
      const addedTotal = result.data.sources.reduce(
        (sum, s) => sum + (s.imported > 0 ? s.imported : s.discovered),
        0,
      );
      setRefreshFeedback({
        kind: addedTotal > 0 ? "success" : "noop",
        message:
          addedTotal > 0
            ? `Refreshed ${targets.map((t) => t.id).join(", ")} — ${breakdown}`
            : `Refreshed ${targets.map((t) => t.id).join(", ")} — no new candidates`,
      });
      await loadFromApi({ fullPageLoad: false });
    } finally {
      setRefreshing(false);
    }
  }, [loadFromApi, enabledSourceIds, sourceCatalog]);

  useEffect(() => {
    void (async () => {
      const sourcesResult = await fetchApi<SourcesApiData>("/sources");
      const refreshList =
        sourcesResult.data?.queueRefresh ?? sourcesResult.data?.fastRefresh;
      if (refreshList) {
        setRefreshSources(refreshList);
      }
      if (sourcesResult.data?.refreshableSourceIds) {
        setRefreshableSourceIds(sourcesResult.data.refreshableSourceIds);
      } else if (refreshList) {
        setRefreshableSourceIds(refreshList.map((s) => s.id));
      }
    })();
  }, []);

  useEffect(() => {
    void grabLatest();
  }, [grabLatest]);

  const grabbingUi = useDelayedBusy(grabbing);
  const refreshingUi = useDelayedBusy(refreshing);
  const syncingUi = grabbingUi || refreshingUi;

  useEffect(() => {
    if (!refreshFeedback || refreshFeedback.kind === "error") return;
    const timer = setTimeout(() => setRefreshFeedback(null), 4500);
    return () => clearTimeout(timer);
  }, [refreshFeedback]);

  const submitReview = useCallback(
    async (jobId: string, toState: string) => {
      const applyLocal = (rows: ReviewQueueRow[]) => {
        const job = rows.find((j) => j.id === jobId);
        if (!job) return rows;
        const updated = { ...job, review_state: toState };
        return sortByLastSeen([
          updated,
          ...rows.filter((j) => j.id !== jobId),
        ]);
      };

      if (!live) {
        setQueue(applyLocal);
        return { ok: true };
      }
      const result = await postJobReview(jobId, toState);
      if (!result.ok) return { ok: false, error: result.error };
      setQueue(applyLocal);
      return { ok: true };
    },
    [live],
  );

  return {
    queue,
    visibleQueue,
    sourceCatalog,
    enabledSourceIds,
    toggleSource,
    selectAllSources,
    deselectAllSources,
    refreshTargets: refreshTargetList,
    sourceHealth,
    pipelineRuns,
    lastRefreshRun,
    meta,
    live,
    loading,
    grabbing,
    refreshing,
    syncingUi,
    grabbingUi,
    refreshingUi,
    refreshError,
    lastFastRefresh,
    lastGrabbedAt,
    refreshFeedback,
    refresh,
    grabLatest,
    runFastRefresh,
    submitReview,
  };
}
