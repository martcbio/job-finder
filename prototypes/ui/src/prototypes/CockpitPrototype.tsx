import { formatRelative, formatState } from "../mockData";
import type {
  FastRefreshResult,
  PipelineRunRow,
  RefreshRunRow,
  ReviewQueueRow,
  SourceHealthRow,
} from "../types";
import { JobMeta, Shell, SourcePills, StateBadge } from "../components/shared";

interface Props {
  queue: ReviewQueueRow[];
  sourceHealth: SourceHealthRow[];
  pipelineRuns: PipelineRunRow[];
  lastRefreshRun: RefreshRunRow | null;
  lastFastRefresh: FastRefreshResult | null;
  live: boolean;
  refreshing: boolean;
  refreshError: string | null;
  onRefreshData: () => void;
  onRunFastRefresh: () => void;
}

function successRate(rate: number | string): number {
  const value = typeof rate === "string" ? Number.parseFloat(rate) : rate;
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

function openJobPosting(url: string | null | undefined): void {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

export default function CockpitPrototype({
  queue,
  sourceHealth,
  pipelineRuns,
  lastRefreshRun,
  lastFastRefresh,
  live,
  refreshing,
  refreshError,
  onRefreshData,
  onRunFastRefresh,
}: Props) {
  const ready = queue.filter((j) => j.review_state === "ready_for_review").length;
  const shortlisted = queue.filter((j) => j.review_state === "shortlisted").length;
  const dups = queue.filter((j) => j.duplicate_candidates.length > 0).length;
  const latestPipeline = pipelineRuns[0];
  const imported =
    lastFastRefresh?.sources.reduce((sum, s) => sum + s.imported, 0) ?? null;

  return (
    <Shell
      title="Signal Cockpit"
      subtitle={
        live
          ? "Live Postgres queue — refresh native sources without a full pipeline sweep"
          : "Mock data — start bun run api for live queue"
      }
      accent="#22c55e"
      headerExtra={
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onRefreshData}
              disabled={refreshing}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 disabled:opacity-50"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={onRunFastRefresh}
              disabled={!live || refreshing}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-black transition disabled:opacity-50"
              style={{ background: refreshing ? "#166534" : "#22c55e" }}
            >
              {refreshing ? "Refreshing…" : "Fast refresh"}
            </button>
          </div>
          {refreshError && (
            <p className="max-w-xs text-right text-[11px] text-red-400">{refreshError}</p>
          )}
          {lastFastRefresh && (
            <p className="text-right font-mono text-[10px] text-zinc-500">
              Last refresh {Math.round(lastFastRefresh.elapsedMs / 1000)}s
              {imported !== null ? ` · ${imported} imported` : ""}
            </p>
          )}
        </div>
      }
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
          {queue.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">
              Queue empty — run fast refresh to pull JobServe and Linear Careers.
            </p>
          ) : (
            <div className="divide-y divide-zinc-800/80">
              {queue.map((job) => (
                <article
                  key={job.id}
                  role="link"
                  tabIndex={job.canonical_url ? 0 : -1}
                  aria-label={
                    job.canonical_url
                      ? `Open ${job.title} posting`
                      : `${job.title} (no posting URL)`
                  }
                  onClick={() => openJobPosting(job.canonical_url)}
                  onKeyDown={(event) => {
                    if (
                      job.canonical_url &&
                      (event.key === "Enter" || event.key === " ")
                    ) {
                      event.preventDefault();
                      openJobPosting(job.canonical_url);
                    }
                  }}
                  className={`grid grid-cols-1 gap-2 py-3 transition-colors md:grid-cols-[1fr_auto_auto] md:items-center md:gap-4 ${
                    job.canonical_url
                      ? "cursor-pointer hover:bg-white/[0.04] focus-visible:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/40"
                      : "hover:bg-white/[0.02]"
                  }`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-200">
                      {job.title}
                      {job.canonical_url && (
                        <span className="ml-2 text-[10px] text-zinc-600">↗</span>
                      )}
                    </p>
                    <JobMeta job={job} />
                  </div>
                  <SourcePills labels={(job.source_labels ?? []).slice(0, 2)} />
                  <StateBadge state={job.review_state} />
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="space-y-6">
          <div>
            <h2 className="mb-3 font-mono text-xs uppercase tracking-widest text-zinc-500">
              Source yield
            </h2>
            {sourceHealth.length === 0 ? (
              <p className="text-xs text-zinc-600">No source attempts yet.</p>
            ) : (
              <div className="space-y-2">
                {sourceHealth.map((s) => (
                  <div
                    key={s.source_id}
                    className="flex items-center justify-between border-t border-zinc-800 py-2 text-xs"
                  >
                    <span className="font-mono text-zinc-400">{s.source_id}</span>
                    <span className="font-mono tabular-nums text-emerald-400">
                      {successRate(s.success_rate)}%
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {lastRefreshRun && (
            <div className="border-t border-zinc-800 pt-4">
              <p className="font-mono text-[10px] uppercase text-zinc-600">Last source run</p>
              <p className="mt-1 font-mono text-sm text-zinc-300">#{lastRefreshRun.id}</p>
              <p className="text-xs text-zinc-500">
                {formatState(lastRefreshRun.status)} · {lastRefreshRun.keyword} ·{" "}
                {formatRelative(lastRefreshRun.startedAt)}
              </p>
            </div>
          )}

          {latestPipeline && (
            <div className="border-t border-zinc-800 pt-4">
              <p className="font-mono text-[10px] uppercase text-zinc-600">Last pipeline</p>
              <p className="mt-1 font-mono text-sm text-zinc-300">{latestPipeline.id}</p>
              <p className="text-xs text-zinc-500">
                {formatState(latestPipeline.status)} · {formatRelative(latestPipeline.started_at)}
              </p>
            </div>
          )}
        </aside>
      </div>
    </Shell>
  );
}
