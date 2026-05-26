import { useState } from "react";
import { formatRelative, formatState } from "../mockData";
import type { ReviewQueueRow } from "../types";
import {
  DupWarning,
  JobMeta,
  Shell,
  SourcePills,
  StateBadge,
} from "../components/shared";

interface Props {
  queue: ReviewQueueRow[];
}

export default function SplitFocusPrototype({ queue }: Props) {
  const [selectedId, setSelectedId] = useState(queue[0]?.id ?? "");
  const selected = queue.find((j) => j.id === selectedId) ?? queue[0];

  return (
    <Shell
      title="Split Focus"
      subtitle="Queue rail + detail pane — classic review workflow"
      accent="#6366f1"
    >
      <div className="grid min-h-[70dvh] overflow-hidden rounded-2xl border border-zinc-800 lg:grid-cols-[340px_1fr]">
        <nav className="overflow-y-auto border-b border-zinc-800 bg-zinc-950/50 lg:border-b-0 lg:border-r">
          <div className="sticky top-0 border-b border-zinc-800 bg-zinc-950/90 px-4 py-3 backdrop-blur">
            <input
              type="search"
              placeholder="Filter queue..."
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none"
            />
          </div>
          <ul>
            {queue.map((job) => (
              <li key={job.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(job.id)}
                  className={`w-full border-b border-zinc-800/50 px-4 py-4 text-left transition active:scale-[0.99] ${
                    selected?.id === job.id
                      ? "bg-indigo-500/10 border-l-2 border-l-indigo-400"
                      : "hover:bg-white/[0.02]"
                  }`}
                >
                  <p className="truncate text-sm font-medium text-zinc-200">{job.title}</p>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">{job.company_hint}</p>
                  <div className="mt-2">
                    <StateBadge state={job.review_state} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {selected && (
          <div className="overflow-y-auto p-6 md:p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight text-white md:text-3xl">
                  {selected.title}
                </h2>
                <JobMeta job={selected} />
              </div>
              <StateBadge state={selected.review_state} />
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
              <SourcePills labels={selected.source_labels} />
            </div>

            <p className="mt-6 max-w-[70ch] text-base leading-relaxed text-zinc-400">
              {selected.description_sample}
            </p>

            <div className="mt-6">
              <DupWarning job={selected} />
            </div>

            {selected.classification_labels.length > 0 && (
              <div className="mt-8">
                <h3 className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
                  Classification labels
                </h3>
                <div className="mt-3 flex flex-wrap gap-2">
                  {selected.classification_labels.map((l) => (
                    <span
                      key={`${l.label}-${l.source_stage}`}
                      className="rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-3 py-1.5 text-xs text-indigo-200"
                    >
                      {l.label}{" "}
                      <span className="text-indigo-400/60">({l.source_stage})</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {selected.latest_review_event && (
              <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
                  Latest review event
                </h3>
                <p className="mt-2 text-sm text-zinc-300">
                  {selected.latest_review_event.from_state
                    ? `${formatState(selected.latest_review_event.from_state)} → `
                    : ""}
                  {formatState(selected.latest_review_event.to_state)}
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  {selected.latest_review_event.actor} ·{" "}
                  {formatRelative(selected.latest_review_event.created_at)}
                </p>
              </div>
            )}

            <div className="mt-8 flex flex-wrap gap-3">
              {["Shortlist", "Not relevant", "CV tailoring", "Open URL"].map((action) => (
                <button
                  key={action}
                  type="button"
                  className="rounded-xl border border-zinc-700 bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-zinc-300 transition active:scale-[0.98] hover:border-indigo-500/40 hover:text-white"
                >
                  {action}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}
