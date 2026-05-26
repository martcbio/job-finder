import { formatRelative, formatState } from "../mockData";
import type { PipelineRunRow, ReviewQueueRow, SourceHealthRow } from "../types";
import { JobMeta, Shell, SourcePills, StateBadge } from "../components/shared";

interface Props {
  queue: ReviewQueueRow[];
  sourceHealth: SourceHealthRow[];
  pipelineRuns: PipelineRunRow[];
}

export default function CockpitPrototype({ queue, sourceHealth, pipelineRuns }: Props) {
  const ready = queue.filter((j) => j.review_state === "ready_for_review").length;
  const shortlisted = queue.filter((j) => j.review_state === "shortlisted").length;
  const dups = queue.filter((j) => j.duplicate_candidates.length > 0).length;
  const latestRun = pipelineRuns[0];

  return (
    <Shell
      title="Signal Cockpit"
      subtitle="Every signal on one screen — ops density over decoration"
      accent="#22c55e"
    >
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800 md:grid-cols-4">
        {[
          { label: "Queue", value: queue.length, sub: "total jobs" },
          { label: "Review", value: ready, sub: "awaiting human" },
          { label: "Shortlist", value: shortlisted, sub: "active candidates" },
          { label: "Dup flags", value: dups, sub: "need decision" },
        ].map((m) => (
          <div key={m.label} className="bg-[#0f1114] p-4 md:p-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
              {m.label}
            </p>
            <p className="mt-1 font-mono text-3xl font-semibold tabular-nums text-emerald-400">
              {m.value}
            </p>
            <p className="text-[11px] text-zinc-600">{m.sub}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_280px]">
        <section>
          <div className="mb-3 flex items-center justify-between border-b border-zinc-800 pb-2">
            <h2 className="font-mono text-xs uppercase tracking-widest text-zinc-500">
              Review queue
            </h2>
            <span className="font-mono text-[10px] text-zinc-600">sorted by last_seen</span>
          </div>
          <div className="divide-y divide-zinc-800/80">
            {queue.map((job) => (
              <article
                key={job.id}
                className="grid grid-cols-1 gap-2 py-3 transition-colors hover:bg-white/[0.02] md:grid-cols-[1fr_auto_auto] md:items-center md:gap-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-200">{job.title}</p>
                  <JobMeta job={job} />
                </div>
                <SourcePills labels={job.source_labels.slice(0, 2)} />
                <StateBadge state={job.review_state} />
              </article>
            ))}
          </div>
        </section>

        <aside className="space-y-6">
          <div>
            <h2 className="mb-3 font-mono text-xs uppercase tracking-widest text-zinc-500">
              Source yield
            </h2>
            <div className="space-y-2">
              {sourceHealth.map((s) => (
                <div
                  key={s.source_id}
                  className="flex items-center justify-between border-t border-zinc-800 py-2 text-xs"
                >
                  <span className="font-mono text-zinc-400">{s.source_id}</span>
                  <span className="font-mono tabular-nums text-emerald-400">
                    {Math.round(s.success_rate * 100)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
          {latestRun && (
            <div className="border-t border-zinc-800 pt-4">
              <p className="font-mono text-[10px] uppercase text-zinc-600">Last pipeline</p>
              <p className="mt-1 font-mono text-sm text-zinc-300">{latestRun.id}</p>
              <p className="text-xs text-zinc-500">
                {formatState(latestRun.status)} · {formatRelative(latestRun.started_at)}
              </p>
            </div>
          )}
        </aside>
      </div>
    </Shell>
  );
}
