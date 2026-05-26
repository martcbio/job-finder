import { formatRelative, formatState } from "../mockData";
import type { PipelineRunRow, ReviewQueueRow, SourceHealthRow } from "../types";
import { Shell } from "../components/shared";

interface Props {
  queue: ReviewQueueRow[];
  sourceHealth: SourceHealthRow[];
  pipelineRuns: PipelineRunRow[];
}

interface TimelineEvent {
  id: string;
  time: string;
  kind: "run" | "job" | "source";
  title: string;
  detail: string;
  status?: string;
}

function buildTimeline(
  queue: ReviewQueueRow[],
  runs: PipelineRunRow[],
  sources: SourceHealthRow[],
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const run of runs) {
    events.push({
      id: run.id,
      time: run.started_at,
      kind: "run",
      title: `Pipeline ${run.id}`,
      detail: `${run.step_count} steps`,
      status: run.status,
    });
  }

  for (const job of queue.slice(0, 5)) {
    if (job.latest_review_event) {
      events.push({
        id: `ev-${job.id}`,
        time: job.latest_review_event.created_at,
        kind: "job",
        title: job.title,
        detail: `${formatState(job.latest_review_event.from_state ?? "new")} → ${formatState(job.latest_review_event.to_state)}`,
        status: job.review_state,
      });
    }
  }

  for (const s of sources.slice(0, 3)) {
    events.push({
      id: `src-${s.source_id}`,
      time: new Date(Date.now() - Math.random() * 86400000 * 2).toISOString(),
      kind: "source",
      title: s.source_id,
      detail: `${s.total_results} results · ${Math.round(Number(s.success_rate) * 100)}% success`,
    });
  }

  return events.sort(
    (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime(),
  );
}

const kindColors = {
  run: "#14b8a6",
  job: "#6366f1",
  source: "#f59e0b",
};

export default function TimelinePrototype({ queue, sourceHealth, pipelineRuns }: Props) {
  const events = buildTimeline(queue, pipelineRuns, sourceHealth);

  return (
    <Shell
      title="Pipeline Timeline"
      subtitle="Runs, review events, and source activity in one chronology"
      accent="#14b8a6"
    >
      <div className="relative mx-auto max-w-2xl">
        <div className="absolute bottom-0 left-[19px] top-0 w-px bg-gradient-to-b from-teal-500/50 via-zinc-700 to-transparent" />

        <div className="space-y-6">
          {events.map((ev, i) => (
            <div
              key={ev.id}
              className="relative flex gap-6 pl-2"
              style={{ animationDelay: `${i * 80}ms` }}
            >
              <div
                className="relative z-10 mt-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 bg-[#0c0d0f] font-mono text-[10px] font-bold"
                style={{
                  borderColor: kindColors[ev.kind],
                  color: kindColors[ev.kind],
                }}
              >
                {ev.kind[0].toUpperCase()}
              </div>
              <div className="min-w-0 flex-1 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 transition hover:border-teal-500/30">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold text-zinc-200">{ev.title}</h3>
                  <time className="font-mono text-[10px] text-zinc-600">
                    {formatRelative(ev.time)}
                  </time>
                </div>
                <p className="mt-1 text-xs text-zinc-500">{ev.detail}</p>
                {ev.status && (
                  <span
                    className="mt-2 inline-block rounded-md px-2 py-0.5 font-mono text-[10px] uppercase"
                    style={{
                      background: `${kindColors[ev.kind]}18`,
                      color: kindColors[ev.kind],
                    }}
                  >
                    {formatState(ev.status)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-10 text-center text-xs text-zinc-600">
        Combines GET /api/pipeline-runs, review events, and GET /api/source-health
      </p>
    </Shell>
  );
}
