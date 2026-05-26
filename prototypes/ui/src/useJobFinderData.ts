import { useCallback, useEffect, useRef, useState } from "react";
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

export interface JobFinderData {
  queue: ReviewQueueRow[];
  sourceHealth: SourceHealthRow[];
  pipelineRuns: PipelineRunRow[];
  lastRefreshRun: RefreshRunRow | null;
  meta: ApiMeta | null;
  live: boolean;
  loading: boolean;
  grabbing: boolean;
  refreshing: boolean;
  refreshError: string | null;
  lastFastRefresh: FastRefreshResult | null;
  lastGrabbedAt: string | null;
  refreshFeedback: { kind: RefreshFeedbackKind; message: string } | null;
  refresh: () => Promise<void>;
  grabLatest: () => Promise<void>;
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
  const [grabbing, setGrabbing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastFastRefresh, setLastFastRefresh] = useState<FastRefreshResult | null>(null);
  const [lastGrabbedAt, setLastGrabbedAt] = useState<string | null>(null);
  const [refreshFeedback, setRefreshFeedback] = useState<{
    kind: RefreshFeedbackKind;
    message: string;
  } | null>(null);

  const queueIdsBeforeRefresh = useRef<Set<string>>(new Set());

  const applyLoadResult = useCallback(
    (
      health: FetchResult<{ status: string }>,
      queueData: FetchResult<ReviewQueueRow[]>,
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

      let newQueue = queue;
      if (isLive && queueData.data) {
        newQueue = asArray<ReviewQueueRow>(queueData.data).map(normalizeQueueRow);
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
        setRefreshFeedback({
          kind: "noop",
          message: `Up to date · ${newQueue.length} jobs (nothing new)`,
        });
      }
    },
    [],
  );

  const loadFromApi = useCallback(
    async (opts: { fullPageLoad: boolean }) => {
      if (opts.fullPageLoad) setLoading(true);
      else setGrabbing(true);
      setRefreshError(null);
      setRefreshFeedback(null);

      const prevCount = queue.length;
      const prevIds = new Set(queue.map((j) => j.id));

      const [health, queueData, healthData, runsData, metaData, latestRun] =
        await Promise.all([
          fetchApi<{ status: string }>("/health"),
          fetchApi<ReviewQueueRow[]>("/jobs/queue?limit=50"),
          fetchApi<SourceHealthRow[]>("/source-health"),
          fetchApi<PipelineRunRow[]>("/pipeline-runs?limit=10"),
          fetchApi<ApiMeta>("/meta"),
          fetchApi<RefreshRunRow>("/runs/latest"),
        ]);

      applyLoadResult(health, queueData, healthData, runsData, metaData, latestRun, prevCount, prevIds);

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
    setRefreshing(true);
    setRefreshError(null);
    setRefreshFeedback({ kind: "idle", message: "Searching sources…" });
    try {
      const result = await fetchApi<FastRefreshResult>("/refresh/fast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 20, classifyLimit: 250 }),
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
      await loadFromApi({ fullPageLoad: false });
    } finally {
      setRefreshing(false);
    }
  }, [loadFromApi]);

  useEffect(() => {
    void grabLatest();
  }, [grabLatest]);

  return {
    queue,
    sourceHealth,
    pipelineRuns,
    lastRefreshRun,
    meta,
    live,
    loading,
    grabbing,
    refreshing,
    refreshError,
    lastFastRefresh,
    lastGrabbedAt,
    refreshFeedback,
    refresh,
    grabLatest,
    runFastRefresh,
  };
}
