import { formatState, stateColor } from "../mockData";
import type { ReviewQueueRow } from "../types";
import { JobMeta, Shell } from "../components/shared";

interface Props {
  queue: ReviewQueueRow[];
}

const LANES = [
  "ready_for_review",
  "shortlisted",
  "needs_cv_tailoring",
  "ready_to_apply",
  "duplicate_candidate",
] as const;

export default function KanbanPrototype({ queue }: Props) {
  const grouped = LANES.map((lane) => ({
    lane,
    jobs: queue.filter((j) => j.review_state === lane),
  }));

  const overflow = queue.filter(
    (j) => !LANES.includes(j.review_state as (typeof LANES)[number]),
  );

  return (
    <Shell
      title="Review Board"
      subtitle="Kanban lanes keyed to review_state from GET /api/meta"
      accent="#ec4899"
    >
      <div className="flex gap-4 overflow-x-auto pb-4">
        {grouped.map(({ lane, jobs }) => (
          <div
            key={lane}
            className="flex w-[260px] shrink-0 flex-col rounded-2xl border border-zinc-800 bg-zinc-950/30"
          >
            <header
              className="border-b border-zinc-800 px-4 py-3"
              style={{ borderTopColor: stateColor(lane), borderTopWidth: 3 }}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                  {formatState(lane)}
                </h3>
                <span className="font-mono text-xs text-zinc-600">{jobs.length}</span>
              </div>
            </header>
            <ul className="flex flex-1 flex-col gap-3 p-3">
              {jobs.map((job) => (
                <li
                  key={job.id}
                  className="cursor-grab rounded-xl border border-white/5 bg-white/[0.03] p-3 transition hover:border-pink-500/30 active:scale-[0.98]"
                >
                  <p className="text-sm font-medium leading-snug text-zinc-200">
                    {job.title}
                  </p>
                  <p className="mt-1 text-xs text-pink-300/70">{job.company_hint}</p>
                  <div className="mt-2">
                    <JobMeta job={job} />
                  </div>
                  {job.duplicate_candidates.length > 0 && (
                    <p className="mt-2 rounded-md bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">
                      Dup flag
                    </p>
                  )}
                </li>
              ))}
              {jobs.length === 0 && (
                <li className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-600">
                  Empty lane
                </li>
              )}
            </ul>
          </div>
        ))}

        {overflow.length > 0 && (
          <div className="flex w-[260px] shrink-0 flex-col rounded-2xl border border-dashed border-zinc-700">
            <header className="border-b border-zinc-800 px-4 py-3">
              <h3 className="text-xs font-semibold uppercase text-zinc-600">Other</h3>
            </header>
            <ul className="flex flex-col gap-3 p-3">
              {overflow.map((job) => (
                <li
                  key={job.id}
                  className="rounded-xl border border-white/5 bg-white/[0.02] p-3 text-sm text-zinc-400"
                >
                  {job.title}
                  <span className="mt-1 block text-[10px] text-zinc-600">
                    {formatState(job.review_state)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <p className="mt-4 text-xs text-zinc-600">
        Drag-and-drop would POST review transitions — human confirmation required for merges
      </p>
    </Shell>
  );
}
