import { useEffect, useState } from "react";
import { formatRelative } from "../mockData";
import type { PipelineRunRow, ReviewQueueRow, SourceHealthRow } from "../types";
import { Shell } from "../components/shared";

interface Props {
  queue: ReviewQueueRow[];
  sourceHealth: SourceHealthRow[];
  pipelineRuns: PipelineRunRow[];
}

const PROMPTS = [
  "agentic engineer remote EU",
  "RAG platform staff engineer",
  "forward deployed AI customer-facing",
];

export default function BentoCommandPrototype({ queue, sourceHealth, pipelineRuns }: Props) {
  const [promptIdx, setPromptIdx] = useState(0);
  const [typed, setTyped] = useState("");
  const [notify, setNotify] = useState(false);

  useEffect(() => {
    const target = PROMPTS[promptIdx];
    let i = 0;
    setTyped("");
    const id = setInterval(() => {
      i += 1;
      setTyped(target.slice(0, i));
      if (i >= target.length) {
        clearInterval(id);
        setTimeout(() => setPromptIdx((p) => (p + 1) % PROMPTS.length), 1200);
      }
    }, 45);
    return () => clearInterval(id);
  }, [promptIdx]);

  useEffect(() => {
    const id = setInterval(() => {
      setNotify(true);
      setTimeout(() => setNotify(false), 2800);
    }, 6000);
    return () => clearInterval(id);
  }, []);

  const topJob = queue.find((j) => j.review_state === "ready_for_review") ?? queue[0];

  return (
    <Shell
      title="Bento Command"
      subtitle="Living tiles — queue, search, sources, runs"
      accent="#0ea5e9"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:grid-rows-2">
        {/* Intelligent list */}
        <div className="md:col-span-1 md:row-span-2">
          <p className="mb-2 text-xs text-zinc-500">Priority queue</p>
          <div className="rounded-[2.5rem] border border-slate-200/10 bg-white/[0.03] p-6 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.4)]">
            <div className="space-y-3">
              {queue.slice(0, 4).map((job, i) => (
                <div
                  key={job.id}
                  className="flex items-center gap-3 rounded-2xl border border-white/5 bg-white/[0.02] p-3 transition-transform"
                  style={{
                    animation: `float ${3 + i * 0.5}s ease-in-out infinite`,
                    animationDelay: `${i * 0.3}s`,
                  }}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-sky-500/20 font-mono text-xs text-sky-300">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{job.title}</p>
                    <p className="truncate text-xs text-zinc-500">{job.company_hint}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Command input */}
        <div className="md:col-span-2">
          <p className="mb-2 text-xs text-zinc-500">Sweep command</p>
          <div className="rounded-[2.5rem] border border-slate-200/10 bg-white/[0.03] p-8 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.4)]">
            <div className="flex items-center gap-3 rounded-2xl border border-sky-500/20 bg-sky-500/5 px-5 py-4">
              <span className="text-sky-400">/</span>
              <span className="font-mono text-sm text-zinc-300">
                {typed}
                <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-sky-400" />
              </span>
            </div>
            <p className="mt-4 text-xs text-zinc-600">
              Dry-run via POST /api/pipeline-runs — execution gated by confirm string
            </p>
          </div>
        </div>

        {/* Live status */}
        <div>
          <p className="mb-2 text-xs text-zinc-500">Live status</p>
          <div className="relative rounded-[2.5rem] border border-slate-200/10 bg-white/[0.03] p-8 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.4)]">
            <div className="flex items-center gap-3">
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-400" />
              </span>
              <span className="text-sm text-zinc-300">Fast refresh idle</span>
            </div>
            {notify && topJob && (
              <div
                className="absolute -right-2 -top-2 rounded-2xl border border-sky-500/30 bg-sky-950 px-4 py-2 text-xs shadow-lg"
                style={{ animation: "float 0.6s ease-out" }}
              >
                New: {topJob.title.slice(0, 28)}...
              </div>
            )}
            <p className="mt-4 font-mono text-2xl tabular-nums text-white">
              {queue.filter((j) => j.review_state === "ready_for_review").length}
            </p>
            <p className="text-xs text-zinc-500">jobs awaiting review</p>
          </div>
        </div>

        {/* Data stream */}
        <div>
          <p className="mb-2 text-xs text-zinc-500">Source stream</p>
          <div className="overflow-hidden rounded-[2.5rem] border border-slate-200/10 bg-white/[0.03] p-6 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.4)]">
            <div className="flex gap-4" style={{ animation: "marquee 18s linear infinite" }}>
              {[...sourceHealth, ...sourceHealth].map((s, i) => (
                <div
                  key={`${s.source_id}-${i}`}
                  className="shrink-0 rounded-xl border border-white/5 bg-white/[0.04] px-4 py-3"
                >
                  <p className="font-mono text-[10px] text-zinc-500">{s.source_id}</p>
                  <p className="font-mono text-lg text-sky-300">{s.total_results}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {pipelineRuns[0] && (
        <p className="mt-6 text-center text-xs text-zinc-600">
          Last run {pipelineRuns[0].id} · {formatRelative(pipelineRuns[0].started_at)}
        </p>
      )}
    </Shell>
  );
}
