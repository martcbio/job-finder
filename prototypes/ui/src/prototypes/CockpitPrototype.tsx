import { formatRelative, formatState } from "../mockData";
import type {
  FastRefreshResult,
  PipelineRunRow,
  RefreshRunRow,
  ReviewQueueRow,
  SourceHealthRow,
} from "../types";
import { deriveJobSignals } from "../jobSignals";
import { JobMeta, Shell, SignalChip, SourcePills, StateBadge } from "../components/shared";

function chipTone(
  label: string,
): "neutral" | "good" | "warn" | "bad" {
  const lower = label.toLowerCase();
  if (lower.includes("ir35") || lower.includes("onsite") || lower.includes("hybrid")) {
    return "warn";
  }
  if (lower.includes("remote")) return "good";
  if (lower.includes("unclear") || lower.includes("?")) return "warn";
  return "neutral";
}

interface Props {
  queue: ReviewQueueRow[];
  sourceHealth: SourceHealthRow[];
  pipelineRuns: PipelineRunRow[];
  lastRefreshRun: RefreshRunRow | null;
  lastFastRefresh: FastRefreshResult | null;
  live: boolean;
  grabbing: boolean;
  refreshing: boolean;
  refreshError: string | null;
  lastGrabbedAt: string | null;
  refreshFeedback: { kind: string; message: string } | null;
  onRefresh: () => void;
  onFindNewJobs: () => void;
}

function feedbackTone(kind: string): string {
  switch (kind) {
    case "success":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
    case "noop":
      return "border-zinc-600/50 bg-zinc-800/40 text-zinc-400";
    case "error":
      return "border-red-500/30 bg-red-500/10 text-red-300";
    default:
      return "border-zinc-700/50 bg-zinc-900/30 text-zinc-500";
  }
}

function successRate(rate: number | string): number {
  const value = typeof rate === "string" ? Number.parseFloat(rate) : rate;
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

function openJobPosting(url: string | null | undefined): void {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

function QueueToolbar({
  live,
  grabbing,
  refreshing,
  refreshError,
  refreshFeedback,
  lastGrabbedAt,
  lastFindCount,
  onRefresh,
  onFindNewJobs,
}: {
  live: boolean;
  grabbing: boolean;
  refreshing: boolean;
  refreshError: string | null;
  refreshFeedback: { kind: string; message: string } | null;
  lastGrabbedAt: string | null;
  lastFindCount: number | null;
  onRefresh: () => void;
  onFindNewJobs: () => void;
}) {
  const busy = grabbing || refreshing;

  return (
    <div className="mb-4 rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
      {!live && (
        <p className="text-[11px] text-amber-400/90">
          API offline — queue is sample data. Run{" "}
          <code className="text-zinc-500">bun run api</code> in the project root.
        </p>
      )}

      {refreshFeedback && !busy && (
        <p
          className={`mt-2 rounded-md border px-2.5 py-1.5 font-mono text-[11px] ${feedbackTone(refreshFeedback.kind)}`}
        >
          {refreshFeedback.message}
        </p>
      )}

      {refreshError && (
        <p className="mt-2 text-[11px] text-red-400">{refreshError}</p>
      )}

      {busy && (
        <p className="mt-2 font-mono text-[11px] text-zinc-500">
          {refreshing ? "Searching JobServe and Linear…" : "Loading from database…"}
        </p>
      )}

      {!busy && live && lastGrabbedAt && !refreshFeedback && (
        <p className="mt-2 font-mono text-[11px] text-zinc-600">
          Last loaded {formatRelative(lastGrabbedAt)}
        </p>
      )}

      {lastFindCount !== null && lastFindCount > 0 && !refreshing && !busy && (
        <p className="mt-2 text-[11px] text-emerald-400/90">
          Last search imported {lastFindCount} job{lastFindCount === 1 ? "" : "s"}.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onRefresh}
          disabled={!live || busy}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {grabbing ? "Refreshing…" : "Refresh"}
        </button>
        <button
          type="button"
          onClick={onFindNewJobs}
          disabled={!live || busy}
          className="rounded-lg border border-zinc-600 bg-zinc-800/60 px-4 py-2 text-sm text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {refreshing ? "Searching…" : "Find new jobs"}
        </button>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
        <span className="text-zinc-500">Refresh</span> reloads what is already in Postgres.{" "}
        <span className="text-zinc-500">Find new jobs</span> runs a new search (~15s).
      </p>
    </div>
  );
}

export default function CockpitPrototype({
  queue,
  sourceHealth,
  pipelineRuns,
  lastRefreshRun,
  lastFastRefresh,
  live,
  grabbing,
  refreshing,
  refreshError,
  refreshFeedback,
  lastGrabbedAt,
  onRefresh,
  onFindNewJobs,
}: Props) {
  const ready = queue.filter((j) => j.review_state === "ready_for_review").length;
  const shortlisted = queue.filter((j) => j.review_state === "shortlisted").length;
  const dups = queue.filter((j) => j.duplicate_candidates.length > 0).length;
  const latestPipeline = pipelineRuns[0];
  const lastFindCount =
    lastFastRefresh?.sources.reduce((sum, s) => sum + s.imported, 0) ?? null;

  return (
    <Shell
      title="Signal Cockpit"
      subtitle={
        live
          ? "Review queue from your local job database"
          : "Connect the API to load your queue"
      }
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
          <QueueToolbar
            live={live}
            grabbing={grabbing}
            refreshing={refreshing}
            refreshError={refreshError}
            refreshFeedback={refreshFeedback}
            lastGrabbedAt={lastGrabbedAt}
            lastFindCount={lastFindCount}
            onRefresh={onRefresh}
            onFindNewJobs={onFindNewJobs}
          />

          <div className="mb-3 mt-4 flex items-center justify-between border-b border-zinc-800 pb-2">
            <h2 className="font-mono text-xs uppercase tracking-widest text-zinc-500">
              Review queue
            </h2>
            <span className="font-mono text-[10px] text-zinc-600">sorted by last seen</span>
          </div>

          {queue.length === 0 ? (
            <p className="py-12 text-center text-sm text-zinc-500">
              {live ? (
                <>
                  Queue is empty.
                  <br />
                  <button
                    type="button"
                    onClick={onFindNewJobs}
                    disabled={refreshing}
                    className="mt-3 text-emerald-400 underline decoration-emerald-400/40 underline-offset-2 hover:text-emerald-300 disabled:opacity-50"
                  >
                    Find new jobs
                  </button>
                </>
              ) : (
                "Start the API to connect."
              )}
            </p>
          ) : (
            <div className="divide-y divide-zinc-800/80">
              {queue.map((job) => (
                <article
                  key={job.id}
                  role={job.canonical_url ? "link" : undefined}
                  tabIndex={job.canonical_url ? 0 : undefined}
                  onClick={() => openJobPosting(job.canonical_url)}
                  onKeyDown={(e) => {
                    if (
                      job.canonical_url &&
                      (e.key === "Enter" || e.key === " ")
                    ) {
                      e.preventDefault();
                      openJobPosting(job.canonical_url);
                    }
                  }}
                  className={`grid grid-cols-1 gap-2 py-3 transition-colors md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-start md:gap-4 ${
                    job.canonical_url
                      ? "cursor-pointer hover:bg-white/[0.04] focus-visible:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/40"
                      : "hover:bg-white/[0.02]"
                  }`}
                >
                  {(() => {
                    const signals = deriveJobSignals(job);
                    return (
                      <>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-zinc-200">
                            {job.title}
                            {job.canonical_url && (
                              <span className="ml-2 text-[10px] text-zinc-600">↗</span>
                            )}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-zinc-400">
                            {job.company_hint ?? "Unknown company"}
                          </p>
                          {signals.chips.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {signals.chips.map((chip) => (
                                <SignalChip
                                  key={`${job.id}-${chip}`}
                                  label={chip}
                                  tone={chipTone(chip)}
                                />
                              ))}
                            </div>
                          )}
                          <div className="mt-1.5">
                            <JobMeta job={job} />
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5 md:justify-end">
                          <SourcePills labels={(job.source_labels ?? []).slice(0, 2)} />
                        </div>
                        <StateBadge state={job.review_state} />
                      </>
                    );
                  })()}
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
              <p className="font-mono text-[10px] uppercase text-zinc-600">Last search</p>
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
