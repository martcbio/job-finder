import { useCallback, useEffect, useState } from "react";
import { MOCK_PIPELINE_RUNS, MOCK_QUEUE, MOCK_SOURCE_HEALTH } from "./mockData";
import type {
  ApiEnvelope,
  ApiMeta,
  PipelineRunRow,
  ReviewQueueRow,
  SourceHealthRow,
} from "./types";

const API_BASE = "/api";

async function fetchApi<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) return null;
    const body = (await res.json()) as ApiEnvelope<T>;
    return body.ok && body.data ? body.data : null;
  } catch {
    return null;
  }
}

export interface JobFinderData {
  queue: ReviewQueueRow[];
  sourceHealth: SourceHealthRow[];
  pipelineRuns: PipelineRunRow[];
  meta: ApiMeta | null;
  live: boolean;
  loading: boolean;
  refresh: () => void;
}

export function useJobFinderData(): JobFinderData {
  const [queue, setQueue] = useState<ReviewQueueRow[]>(MOCK_QUEUE);
  const [sourceHealth, setSourceHealth] =
    useState<SourceHealthRow[]>(MOCK_SOURCE_HEALTH);
  const [pipelineRuns, setPipelineRuns] =
    useState<PipelineRunRow[]>(MOCK_PIPELINE_RUNS);
  const [meta, setMeta] = useState<ApiMeta | null>(null);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [health, queueData, healthData, runsData, metaData] =
      await Promise.all([
        fetchApi<{ status: string }>("/health"),
        fetchApi<{ jobs: ReviewQueueRow[] }>("/jobs/queue?limit=25"),
        fetchApi<{ sources: SourceHealthRow[] }>("/source-health"),
        fetchApi<{ runs: PipelineRunRow[] }>("/pipeline-runs"),
        fetchApi<ApiMeta>("/meta"),
      ]);

    const isLive = health?.status === "ok";
    setLive(isLive);

    if (isLive && queueData?.jobs) setQueue(queueData.jobs);
    else setQueue(MOCK_QUEUE);

    if (isLive && healthData?.sources) setSourceHealth(healthData.sources);
    else setSourceHealth(MOCK_SOURCE_HEALTH);

    if (isLive && runsData?.runs) setPipelineRuns(runsData.runs);
    else setPipelineRuns(MOCK_PIPELINE_RUNS);

    setMeta(metaData);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { queue, sourceHealth, pipelineRuns, meta, live, loading, refresh };
}
