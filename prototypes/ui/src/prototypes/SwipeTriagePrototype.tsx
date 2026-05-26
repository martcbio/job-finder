import { useState } from "react";
import type { ReviewQueueRow } from "../types";
import { DupWarning, JobMeta, Shell, SourcePills, StateBadge } from "../components/shared";

interface Props {
  queue: ReviewQueueRow[];
}

export default function SwipeTriagePrototype({ queue }: Props) {
  const actionable = queue.filter(
    (j) => !["not_relevant", "rejected_by_us", "applied"].includes(j.review_state),
  );
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, string>>({});

  const job = actionable[index % Math.max(actionable.length, 1)];
  const remaining = actionable.length - Object.keys(decisions).length;

  function decide(action: string) {
    if (!job) return;
    setDecisions((d) => ({ ...d, [job.id]: action }));
    setIndex((i) => i + 1);
  }

  if (!job) {
    return (
      <Shell title="Swipe Triage" subtitle="All caught up" accent="#f97316">
        <p className="text-zinc-500">No jobs left in the triage stack.</p>
      </Shell>
    );
  }

  return (
    <Shell
      title="Swipe Triage"
      subtitle="Fast human review — one job at a time"
      accent="#f97316"
      headerExtra={
        <div className="font-mono text-sm text-zinc-500">
          <span className="text-orange-400">{remaining}</span> remaining
        </div>
      }
    >
      <div className="mx-auto flex max-w-md flex-col items-center">
        <div className="relative h-[420px] w-full">
          {[2, 1, 0].map((layer) => {
            const j = actionable[(index + layer) % actionable.length];
            if (!j) return null;
            return (
              <div
                key={`${j.id}-${layer}`}
                className="absolute inset-x-0 rounded-[2rem] border border-white/10 bg-gradient-to-b from-zinc-900 to-zinc-950 p-8 shadow-2xl transition-transform duration-300"
                style={{
                  top: layer * 12,
                  transform: `scale(${1 - layer * 0.04}) rotate(${(layer - 1) * 1.5}deg)`,
                  zIndex: 3 - layer,
                  opacity: layer === 0 ? 1 : 0.6 - layer * 0.15,
                }}
              >
                {layer === 0 && (
                  <>
                    <div className="mb-4 flex items-start justify-between gap-3">
                      <StateBadge state={j.review_state} />
                      <span className="font-mono text-[10px] text-zinc-600">{j.id}</span>
                    </div>
                    <h2 className="font-[family-name:var(--font-display)] text-2xl font-bold leading-tight tracking-tight text-white">
                      {j.title}
                    </h2>
                    <p className="mt-2 text-lg text-orange-300/90">{j.company_hint}</p>
                    <JobMeta job={j} />
                    <p className="mt-4 line-clamp-4 text-sm leading-relaxed text-zinc-400">
                      {j.description_sample}
                    </p>
                    <div className="mt-4">
                      <SourcePills labels={j.source_labels} />
                    </div>
                    <div className="mt-4">
                      <DupWarning job={j} />
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-8 flex w-full gap-3">
          {[
            { label: "Skip", action: "stale", color: "border-zinc-700 text-zinc-400" },
            { label: "Reject", action: "not_relevant", color: "border-red-500/40 text-red-400" },
            { label: "Shortlist", action: "shortlisted", color: "border-emerald-500/40 text-emerald-400" },
          ].map((btn) => (
            <button
              key={btn.action}
              type="button"
              onClick={() => decide(btn.action)}
              className={`flex-1 rounded-2xl border bg-white/[0.02] py-4 text-sm font-semibold transition active:scale-[0.98] ${btn.color}`}
            >
              {btn.label}
            </button>
          ))}
        </div>

        <p className="mt-6 text-center text-xs text-zinc-600">
          Actions map to <code className="text-zinc-500">POST /api/jobs/:id/review</code> in production
        </p>
      </div>
    </Shell>
  );
}
