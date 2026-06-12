import { formatRelative, formatState } from "../mockData";
import type {
  FastRefreshResult,
  PipelineRunRow,
  RefreshRunRow,
  ReviewQueueRow,
} from "../types";
import { deriveJobSignals } from "../jobSignals";
import {
  cockpitQueueJobs,
  isShortlistedJob,
  isTriageQueueJob,
} from "../queueViews";
import {
  InlineSpinner,
  JobMeta,
  Shell,
  SignalChip,
  SourcePills,
  StateBadge,
} from "../components/shared";
import { SourceYieldPanel } from "../components/SourceYieldPanel";
import { formatRefreshTargetSummary, type SourceCatalogEntry } from "../sourceFilters";

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
  pipelineRuns: PipelineRunRow[];
  lastRefreshRun: RefreshRunRow | null;
  lastFastRefresh: FastRefreshResult | null;
  live: boolean;
  grabbing: boolean;
  refreshing: boolean;
  grabbingUi: boolean;
  refreshingUi: boolean;
  syncingUi: boolean;
  refreshError: string | null;
  lastGrabbedAt: string | null;
  refreshFeedback: { kind: string; message: string } | null;
  sourceCatalog: SourceCatalogEntry[];
  enabledSourceIds: string[];
  refreshTargets: SourceCatalogEntry[];
  onToggleSource: (sourceId: string) => void;
  onSelectAllSources: () => void;
  onDeselectAllSources: () => void;
  onUpdateQueue: () => void;
  onReloadFromDb: () => void;
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

function openJobPosting(url: string | null | undefined): void {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

function JobRow({
  job,
  onOpen,
}: {
  job: ReviewQueueRow;
  onOpen: (url: string | null | undefined) => void;
}) {
  const signals = deriveJobSignals(job);
  return (
    <article
      role={job.canonical_url ? "link" : undefined}
      tabIndex={job.canonical_url ? 0 : undefined}
      onClick={() => onOpen(job.canonical_url)}
      onKeyDown={(e) => {
        if (job.canonical_url && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen(job.canonical_url);
        }
      }}
      className={`grid grid-cols-1 gap-2 py-3 transition-colors md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-start md:gap-4 ${
        isShortlistedJob(job) ? "border-l-2 border-emerald-500/40 pl-3" : ""
      } ${
        job.canonical_url
          ? "cursor-pointer hover:bg-white/[0.04] focus-visible:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/40"
          : "hover:bg-white/[0.02]"
      }`}
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-zinc-200">
          {job.title}
          {job.canonical_url && <span className="ml-2 text-[10px] text-zinc-600">↗</span>}
        </p>
        <p className="mt-0.5 truncate text-xs text-zinc-400">
          {job.company_hint ?? "Unknown company"}
        </p>
        {signals.chips.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {signals.chips.map((chip) => (
              <SignalChip key={`${job.id}-${chip}`} label={chip} tone={chipTone(chip)} />
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
    </article>
  );
}

function QueueToolbar({
  queueCount,
  live,
  grabbing,
  refreshing,
  grabbingUi,
  refreshingUi,
  refreshError,
  refreshFeedback,
  lastGrabbedAt,
  lastFindCount,
  refreshTargetSummary,
  canSearch,
  onUpdateQueue,
  onReloadFromDb,
}: {
  queueCount: number;
  live: boolean;
  grabbing: boolean;
  refreshing: boolean;
  grabbingUi: boolean;
  refreshingUi: boolean;
  refreshError: string | null;
  refreshFeedback: { kind: string; message: string } | null;
  lastGrabbedAt: string | null;
  lastFindCount: number | null;
  refreshTargetSummary: string;
  canSearch: boolean;
  onUpdateQueue: () => void;
  onReloadFromDb: () => void;
}) {
  const busy = grabbing || refreshing;

  return (
    <div className="mb-4 rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
      {!live ? (
        <p className="text-[11px] text-amber-400/90">
          API offline — queue is sample data. Run{" "}
          <code className="text-zinc-500">bun run api</code> in the project root.
        </p>
      ) : (
        <button
          type="button"
          onClick={onReloadFromDb}
          disabled={busy}
          title="Reload queue from Postgres (no new search)"
          className="font-mono text-[11px] text-zinc-500 transition hover:text-zinc-300 disabled:opacity-50"
        >
          {queueCount} job{queueCount === 1 ? "" : "s"}
          {lastGrabbedAt ? ` · updated ${formatRelative(lastGrabbedAt)}` : ""}
          <span className="ml-1 text-zinc-600">↻</span>
        </button>
      )}

      <div
        className={`overflow-hidden transition-all duration-300 ease-out ${
          refreshFeedback ? "mt-2 max-h-12 opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        {refreshFeedback && (
          <p
            className={`rounded-md border px-2.5 py-1.5 font-mono text-[11px] ${feedbackTone(refreshFeedback.kind)}`}
          >
            {refreshFeedback.message}
          </p>
        )}
      </div>

      {refreshError && (
        <p className="mt-2 text-[11px] text-red-400">{refreshError}</p>
      )}

      {lastFindCount !== null && lastFindCount > 0 && !busy && (
        <p className="mt-2 text-[11px] text-zinc-500">
          Last search imported {lastFindCount} job{lastFindCount === 1 ? "" : "s"}.
        </p>
      )}

      {live && (
        <p className="mt-2 font-mono text-[10px] text-zinc-500">
          Update queue refreshes:{" "}
          <span className={canSearch ? "text-emerald-400/90" : "text-amber-400/90"}>
            {refreshTargetSummary}
          </span>
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onUpdateQueue}
          disabled={!live || busy || !canSearch}
          title={
            canSearch
              ? `Search ${refreshTargetSummary}`
              : "Check at least one refreshable source in the sidebar"
          }
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {(refreshingUi || grabbingUi) && <InlineSpinner />}
          Update queue
        </button>
      </div>
    </div>
  );
}

export default function CockpitPrototype({
  queue,
  pipelineRuns,
  lastRefreshRun,
  lastFastRefresh,
  live,
  grabbing,
  refreshing,
  grabbingUi,
  refreshingUi,
  syncingUi,
  refreshError,
  refreshFeedback,
  lastGrabbedAt,
  sourceCatalog,
  enabledSourceIds,
  refreshTargets: refreshTargetEntries,
  onToggleSource,
  onSelectAllSources,
  onDeselectAllSources,
  onUpdateQueue,
  onReloadFromDb,
}: Props) {
  const displayJobs = cockpitQueueJobs(queue);
  const triageJobs = displayJobs.filter(isTriageQueueJob);
  const shortlistedJobs = displayJobs.filter(isShortlistedJob);
  const ready = triageJobs.filter((j) => j.review_state === "ready_for_review").length;
  const inQueue = triageJobs.filter((j) =>
    ["ready_for_review", "duplicate_candidate"].includes(j.review_state),
  ).length;
  const shortlisted = shortlistedJobs.length;
  const dups = triageJobs.filter((j) => j.duplicate_candidates.length > 0).length;
  const latestPipeline = pipelineRuns[0];
  const lastFindCount =
    lastFastRefresh?.sources.reduce((sum, s) => sum + s.imported, 0) ?? null;
  const refreshTargetSummary = formatRefreshTargetSummary(refreshTargetEntries);
  const canSearch = refreshTargetEntries.length > 0;

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
          { label: "Queue", value: inQueue, sub: "needs triage" },
          { label: "Review", value: ready, sub: "awaiting human" },
          { label: "Shortlist", value: shortlisted, sub: "from triage" },
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
            queueCount={displayJobs.length}
            live={live}
            grabbing={grabbing}
            refreshing={refreshing}
            grabbingUi={grabbingUi}
            refreshingUi={refreshingUi}
            refreshError={refreshError}
            refreshFeedback={refreshFeedback}
            lastGrabbedAt={lastGrabbedAt}
            lastFindCount={lastFindCount}
            refreshTargetSummary={refreshTargetSummary}
            canSearch={canSearch}
            onUpdateQueue={onUpdateQueue}
            onReloadFromDb={onReloadFromDb}
          />

          <div className="mb-3 mt-4 flex items-center justify-between border-b border-zinc-800 pb-2">
            <h2 className="font-mono text-xs uppercase tracking-widest text-zinc-500">
              Review queue
            </h2>
            <span className="font-mono text-[10px] text-zinc-600">
              latest first
              {shortlistedJobs.length > 0 && (
                <span className="text-emerald-500/80">
                  {" "}
                  · {shortlistedJobs.length} shortlisted
                </span>
              )}
            </span>
          </div>

          {displayJobs.length === 0 ? (
            <p className="py-12 text-center text-sm text-zinc-500">
              {live ? (
                <>
                  Queue is empty.
                  <br />
                  <button
                    type="button"
                    onClick={onUpdateQueue}
                    disabled={refreshing}
                    className="mt-3 text-emerald-400 underline decoration-emerald-400/40 underline-offset-2 hover:text-emerald-300 disabled:opacity-50"
                  >
                    Update queue
                  </button>
                </>
              ) : (
                "Start the API to connect."
              )}
            </p>
          ) : (
            <div
              className={`divide-y divide-zinc-800/80 transition-opacity duration-300 ease-out ${
                syncingUi ? "pointer-events-none opacity-55" : "opacity-100"
              }`}
            >
              {displayJobs.map((job) => (
                <JobRow key={job.id} job={job} onOpen={openJobPosting} />
              ))}
            </div>
          )}
        </section>

        <aside className="space-y-6">
          <SourceYieldPanel
            catalog={sourceCatalog}
            enabledSourceIds={enabledSourceIds}
            refreshTargets={refreshTargetEntries}
            onToggle={onToggleSource}
            onSelectAll={onSelectAllSources}
            onDeselectAll={onDeselectAllSources}
            disabled={grabbing || refreshing}
          />

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
