import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mergeCloudOpeningsIntoQueue } from "./cloudQueue";
import { MOCK_PIPELINE_RUNS, MOCK_QUEUE, MOCK_SOURCE_HEALTH } from "./mockData";
import { mergeQueueRows, sortByLastSeen } from "./queueViews";
import { postJobReview } from "./reviewApi";
import {
  allSourceIds,
  buildSourceCatalog,
  EVERGREEN_SOURCE_IDS,
  filterQueueBySources,
  hasSavedSourceSelection,
  loadEnabledSourceIds,
  type SourceCatalogEntry,
  saveEnabledSourceIds,
  toggleSourceId,
} from "./sourceFilters";
import type {
  ApiEnvelope,
  ApiMeta,
  CloudOpeningRow,
  CloudRowsResult,
  CloudRunRow,
  FastRefreshSourceInfo,
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
    typeof row.success_rate === "string" ? Number.parseFloat(row.success_rate) : row.success_rate;
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

const TRIAGE_STATES_PARAM =
  "ready_for_review,duplicate_candidate,new,needs_page_ingest,needs_classification";
const EVERGREEN_STATES_PARAM = `${TRIAGE_STATES_PARAM},shortlisted`;
const QUEUE_POLL_INTERVAL_MS = 60_000;

export interface JobFinderData {
  queue: ReviewQueueRow[];
  /** Queue after source visibility filter (full queue still in `queue`). */
  visibleQueue: ReviewQueueRow[];
  sourceCatalog: SourceCatalogEntry[];
  enabledSourceIds: string[];
  toggleSource: (sourceId: string) => void;
  selectAllSources: () => void;
  deselectAllSources: () => void;
  sourceHealth: SourceHealthRow[];
  pipelineRuns: PipelineRunRow[];
  lastRefreshRun: RefreshRunRow | null;
  meta: ApiMeta | null;
  live: boolean;
  loading: boolean;
  loadError: string | null;
  lastUpdatedAt: string | null;
  submitReview: (jobId: string, toState: string) => Promise<{ ok: boolean; error?: string }>;
}

export function useJobFinderData(): JobFinderData {
  const [queue, setQueue] = useState<ReviewQueueRow[]>(MOCK_QUEUE);
  const [sourceHealth, setSourceHealth] = useState<SourceHealthRow[]>(MOCK_SOURCE_HEALTH);
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRunRow[]>(MOCK_PIPELINE_RUNS);
  const [lastRefreshRun, setLastRefreshRun] = useState<RefreshRunRow | null>(null);
  const [meta, setMeta] = useState<ApiMeta | null>(null);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [refreshSources, setRefreshSources] = useState<FastRefreshSourceInfo[]>([]);
  const [enabledSourceIds, setEnabledSourceIds] = useState<string[]>([]);

  const hasPersistedSourceSelection = useRef<boolean | null>(null);

  const sourceCatalog = useMemo(
    () => buildSourceCatalog(sourceHealth, refreshSources),
    [sourceHealth, refreshSources],
  );

  const enabledSourceSet = useMemo(() => new Set(enabledSourceIds), [enabledSourceIds]);

  const visibleQueue = useMemo(
    () => filterQueueBySources(queue, enabledSourceSet),
    [queue, enabledSourceSet],
  );

  const persistEnabled = useCallback((ids: string[]) => {
    hasPersistedSourceSelection.current = true;
    saveEnabledSourceIds(ids);
    setEnabledSourceIds(ids);
  }, []);

  const toggleSource = useCallback(
    (sourceId: string) => {
      hasPersistedSourceSelection.current = true;
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
      if (hasPersistedSourceSelection.current === null) {
        hasPersistedSourceSelection.current = hasSavedSourceSelection();
        return loadEnabledSourceIds(sourceCatalog);
      }
      if (!hasPersistedSourceSelection.current) return allSourceIds(sourceCatalog);
      const valid = new Set(sourceCatalog.map((s) => s.id));
      const kept = prev.filter((id) => valid.has(id));
      return kept;
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
      cloudOpenings: FetchResult<CloudRowsResult<CloudOpeningRow>>,
      cloudRuns: FetchResult<CloudRowsResult<CloudRunRow>>,
    ) => {
      const isLive = health.data?.status === "ok";
      setLive(isLive);

      const errors: string[] = [];
      if (health.error) errors.push(`Health: ${health.error}`);
      if (queueData.error) errors.push(`Queue: ${queueData.error}`);
      if (shortlistedData.error) errors.push(`Shortlist: ${shortlistedData.error}`);
      if (cloudOpenings.error) errors.push(`Labs: ${cloudOpenings.error}`);
      if (cloudOpenings.data?.status === "cloud_unavailable") {
        errors.push(`Labs: ${cloudOpenings.data.reason.message}`);
      }
      if (cloudRuns.error) errors.push(`Lab runs: ${cloudRuns.error}`);
      if (cloudRuns.data?.status === "cloud_unavailable") {
        errors.push(`Lab runs: ${cloudRuns.data.reason.message}`);
      }
      const queueLoaded = isLive && queueData.data !== null && shortlistedData.data !== null;

      if (isLive && (queueData.data || shortlistedData.data)) {
        const triage = asArray<ReviewQueueRow>(queueData.data ?? []).map(normalizeQueueRow);
        const shortlisted = asArray<ReviewQueueRow>(shortlistedData.data ?? []).map(
          normalizeQueueRow,
        );
        const localRows = mergeQueueRows(triage, shortlisted);
        const openings = cloudOpenings.data?.status === "available" ? cloudOpenings.data.rows : [];
        const latestCloudRunId =
          cloudRuns.data?.status === "available" ? cloudRuns.data.rows[0]?.run_id : undefined;
        setQueue(mergeCloudOpeningsIntoQueue(localRows, openings, latestCloudRunId));
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
      if (queueLoaded) setLastUpdatedAt(new Date().toISOString());

      if (errors.length > 0) {
        setLoadError(errors.join(" · "));
      } else if (!isLive) {
        setLoadError("API offline — start with: bun run api");
      } else {
        setLoadError(null);
      }
    },
    [],
  );

  const loadFromApi = useCallback(async () => {
    const evergreenFetches = [...EVERGREEN_SOURCE_IDS].map((sourceId) =>
      fetchApi<ReviewQueueRow[]>(
        `/jobs/queue?limit=40&source=${encodeURIComponent(sourceId)}&state=${EVERGREEN_STATES_PARAM}`,
      ),
    );

    const [health, queueData, shortlistedData, ...evergreenResults] = await Promise.all([
      fetchApi<{ status: string }>("/health"),
      fetchApi<ReviewQueueRow[]>(`/jobs/queue?limit=80&state=${TRIAGE_STATES_PARAM}`),
      fetchApi<ReviewQueueRow[]>("/jobs/queue?limit=50&state=shortlisted"),
      ...evergreenFetches,
    ]);

    const [healthData, runsData, metaData, latestRun, cloudRuns] = await Promise.all([
      fetchApi<SourceHealthRow[]>("/source-health"),
      fetchApi<PipelineRunRow[]>("/pipeline-runs?limit=10"),
      fetchApi<ApiMeta>("/meta"),
      fetchApi<RefreshRunRow>("/runs/latest"),
      fetchApi<CloudRowsResult<CloudRunRow>>("/cloud/runs?limit=1"),
    ]);
    const latestCloudRunId =
      cloudRuns.data?.status === "available" ? cloudRuns.data.rows[0]?.run_id : undefined;
    const cloudOpenings = await fetchApi<CloudRowsResult<CloudOpeningRow>>(
      `/cloud/openings?limit=2000${latestCloudRunId ? `&run_id=${encodeURIComponent(latestCloudRunId)}` : ""}`,
    );

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
      cloudOpenings,
      cloudRuns,
    );

    setLoading(false);
  }, [applyLoadResult]);

  useEffect(() => {
    void (async () => {
      const sourcesResult = await fetchApi<SourcesApiData>("/sources");
      const refreshList = sourcesResult.data?.queueRefresh ?? sourcesResult.data?.fastRefresh;
      if (refreshList) {
        setRefreshSources(refreshList);
      }
    })();
  }, []);

  useEffect(() => {
    void loadFromApi();
    const timer = window.setInterval(() => void loadFromApi(), QUEUE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadFromApi]);

  const submitReview = useCallback(
    async (jobId: string, toState: string) => {
      const applyLocal = (rows: ReviewQueueRow[]) => {
        const job = rows.find((j) => j.id === jobId);
        if (!job) return rows;
        const updated = { ...job, review_state: toState };
        return sortByLastSeen([updated, ...rows.filter((j) => j.id !== jobId)]);
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
    sourceHealth,
    pipelineRuns,
    lastRefreshRun,
    meta,
    live,
    loading,
    loadError,
    lastUpdatedAt,
    submitReview,
  };
}
