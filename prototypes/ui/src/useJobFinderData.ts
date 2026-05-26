import { useCallback, useEffect, useState } from "react";
import { MOCK_PIPELINE_RUNS, MOCK_QUEUE, MOCK_SOURCE_HEALTH } from "./mockData";
import type {
  ApiEnvelope,
  ApiMeta,
  FastRefreshResult,
  PipelineRunRow,
  RefreshRunRow,
  ReviewQueueRow,
  SourceHealthRow,
} from "./types";

const API_BASE = "/api";

async function fetchApi<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, init);
    if (!res.ok) return null;
    const body = (await res.json()) as ApiEnvelope<T>;
    return body.ok && body.data !== undefined ? body.data : null;
  } catch {
    return null;
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

export interface JobFinderData {
  queue: ReviewQueueRow[];
  sourceHealth: SourceHealthRow[];
  pipelineRuns: PipelineRunRow[];
  lastRefreshRun: RefreshRunRow | null;
  meta: ApiMeta | null;
  live: boolean;
  loading: boolean;
  refreshing: boolean;
  refreshError: string | null;
  lastFastRefresh: FastRefreshResult | null;
  refresh: () => Promise<void>;
  runFastRefresh: () => Promise<void>;
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
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastFastRefresh, setLastFastRefresh] = useState<FastRefreshResult | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [health, queueData, healthData, runsData, metaData, latestRun] =
      await Promise.all([
        fetchApi<{ status: string }>("/health"),
        fetchApi<ReviewQueueRow[]>("/jobs/queue?limit=50"),
        fetchApi<SourceHealthRow[]>("/source-health"),
        fetchApi<PipelineRunRow[]>("/pipeline-runs?limit=10"),
        fetchApi<ApiMeta>("/meta"),
        fetchApi<RefreshRunRow>("/runs/latest"),
      ]);

    const isLive = health?.status === "ok";
    setLive(isLive);

    if (isLive && queueData) {
      setQueue(asArray<ReviewQueueRow>(queueData).map(normalizeQueueRow));
    } else {
      setQueue(MOCK_QUEUE);
    }

    if (isLive && healthData) {
      setSourceHealth(asArray<SourceHealthRow>(healthData).map(normalizeSourceHealth));
    } else {
      setSourceHealth(MOCK_SOURCE_HEALTH);
    }

    if (isLive && runsData) {
      setPipelineRuns(asArray<PipelineRunRow>(runsData).map(normalizePipelineRun));
    } else {
      setPipelineRuns(MOCK_PIPELINE_RUNS);
    }

    setLastRefreshRun(isLive ? latestRun : null);
    setMeta(metaData);
    setLoading(false);
  }, []);

  const runFastRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const result = await fetchApi<FastRefreshResult>("/refresh/fast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 20, classifyLimit: 250 }),
      });
      if (!result) {
        setRefreshError("Fast refresh failed — is the API running?");
        return;
      }
      setLastFastRefresh(result);
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    queue,
    sourceHealth,
    pipelineRuns,
    lastRefreshRun,
    meta,
    live,
    loading,
    refreshing,
    refreshError,
    lastFastRefresh,
    refresh,
    runFastRefresh,
  };
}
