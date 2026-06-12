import { useMemo, useState } from "react";
import type { ReviewQueueRow } from "../types";
import { isShortlistedJob } from "../queueViews";
import { DupWarning, JobMeta, Shell, SourcePills, StateBadge } from "../components/shared";

const TRIAGE_STATES = new Set(["ready_for_review", "duplicate_candidate"]);

type View = "triage" | "shortlist";

interface Props {
  queue: ReviewQueueRow[];
  live: boolean;
  onReview: (jobId: string, state: string) => Promise<{ ok: boolean; error?: string }>;
}

function buildDeck(
  queue: ReviewQueueRow[],
  skipped: Set<string>,
  deferred: string[],
): ReviewQueueRow[] {
  const candidates = queue.filter(
    (j) => TRIAGE_STATES.has(j.review_state) && !skipped.has(j.id),
  );
  const deferredSet = new Set(deferred);
  const now = candidates.filter((j) => !deferredSet.has(j.id));
  const later = deferred
    .map((id) => candidates.find((j) => j.id === id))
    .filter((j): j is ReviewQueueRow => j !== undefined);
  return [...now, ...later];
}

function openJobPosting(url: string | null | undefined): void {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

function TriageCard({
  job,
  layer,
}: {
  job: ReviewQueueRow;
  layer: number;
}) {
  const isFront = layer === 0;
  const canOpen = isFront && Boolean(job.canonical_url);

  return (
    <div
      role={canOpen ? "link" : undefined}
      tabIndex={canOpen ? 0 : undefined}
      aria-label={canOpen ? `Open ${job.title} posting in new tab` : undefined}
      onClick={canOpen ? () => openJobPosting(job.canonical_url) : undefined}
      onKeyDown={
        canOpen
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openJobPosting(job.canonical_url);
              }
            }
          : undefined
      }
      className={`absolute inset-x-0 rounded-[2rem] border border-white/10 bg-gradient-to-b from-zinc-900 to-zinc-950 p-8 shadow-2xl transition-all duration-300 ${
        canOpen
          ? "cursor-pointer hover:border-orange-500/35 hover:shadow-orange-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40"
          : ""
      }`}
      style={{
        top: layer * 12,
        transform: `scale(${1 - layer * 0.04}) rotate(${(layer - 1) * 1.5}deg)`,
        zIndex: 3 - layer,
        opacity: layer === 0 ? 1 : 0.6 - layer * 0.15,
        pointerEvents: isFront ? "auto" : "none",
      }}
    >
      {isFront && (
        <>
          <div className="mb-4 flex items-start justify-between gap-3">
            <StateBadge state={job.review_state} />
            <span className="font-mono text-[10px] text-zinc-600">{job.id}</span>
          </div>
          <h2 className="font-[family-name:var(--font-display)] text-2xl font-bold leading-tight tracking-tight text-white">
            {job.title}
            {job.canonical_url && (
              <span className="ml-2 text-base font-normal text-zinc-600">↗</span>
            )}
          </h2>
          <p className="mt-2 text-lg text-orange-300/90">{job.company_hint}</p>
          <JobMeta job={job} />
          <p className="mt-4 line-clamp-4 text-sm leading-relaxed text-zinc-400">
            {job.description_sample}
          </p>
          <div className="mt-4">
            <SourcePills labels={job.source_labels} />
          </div>
          <div className="mt-4">
            <DupWarning job={job} />
          </div>
          {job.canonical_url && (
            <p className="mt-5 text-center text-[11px] text-zinc-600">
              Tap card to open posting — return here to reject, maybe, or shortlist
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default function SwipeTriagePrototype({ queue, live, onReview }: Props) {
  const [view, setView] = useState<View>("triage");
  const [index, setIndex] = useState(0);
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [deferred, setDeferred] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const shortlisted = useMemo(
    () =>
      queue
        .filter(isShortlistedJob)
        .sort((a, b) => (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? "")),
    [queue],
  );

  const deck = useMemo(
    () => buildDeck(queue, skipped, deferred),
    [queue, skipped, deferred],
  );

  const job = deck[index % Math.max(deck.length, 1)];
  const remaining = deck.length;

  async function decide(action: "shortlisted" | "not_relevant" | "maybe") {
    if (!job || pending) return;
    setLastError(null);

    if (action === "maybe") {
      setDeferred((ids) => [...ids.filter((id) => id !== job.id), job.id]);
      setIndex((i) => i + 1);
      return;
    }

    setPending(true);
    const result = await onReview(job.id, action);
    setPending(false);

    if (!result.ok) {
      setLastError(result.error ?? "Review failed");
      return;
    }

    setSkipped((prev) => new Set(prev).add(job.id));
    setDeferred((ids) => ids.filter((id) => id !== job.id));
    setIndex((i) => i + 1);
  }

  const headerStats = (
    <div className="font-mono text-sm text-zinc-500">
      {view === "triage" ? (
        <p className="text-right">
          <span className="tabular-nums text-zinc-300">{remaining}</span>
          <span className="text-zinc-600"> in queue</span>
          <span className="text-zinc-700"> · </span>
          <button
            type="button"
            onClick={() => shortlisted.length > 0 && setView("shortlist")}
            disabled={shortlisted.length === 0}
            className="tabular-nums text-emerald-400 transition hover:text-emerald-300 disabled:cursor-default disabled:text-emerald-400/50"
          >
            {shortlisted.length} shortlisted
          </button>
          <span className="text-zinc-700"> · </span>
          <span className="tabular-nums text-orange-400">{deferred.length} maybe</span>
        </p>
      ) : (
        <button
          type="button"
          onClick={() => setView("triage")}
          className="text-orange-400 transition hover:text-orange-300"
        >
          ← Back to triage
        </button>
      )}
    </div>
  );

  if (view === "shortlist") {
    return (
      <Shell
        title="Swipe Triage"
        subtitle="Your shortlist from this session"
        accent="#f97316"
        headerExtra={headerStats}
      >
        {shortlisted.length === 0 ? (
          <p className="text-zinc-500">Nothing shortlisted yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-800/80">
            {shortlisted.map((j) => (
              <li key={j.id}>
                <button
                  type="button"
                  onClick={() => openJobPosting(j.canonical_url)}
                  className="flex w-full flex-col gap-1 py-3 text-left transition hover:bg-white/[0.03] md:flex-row md:items-center md:justify-between md:gap-4"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-200">
                      {j.title}
                      {j.canonical_url && (
                        <span className="ml-2 text-[10px] text-zinc-600">↗</span>
                      )}
                    </p>
                    <p className="truncate text-xs text-zinc-500">
                      {j.company_hint ?? "Unknown company"}
                    </p>
                  </div>
                  <StateBadge state="shortlisted" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Shell>
    );
  }

  if (!job) {
    return (
      <Shell title="Swipe Triage" subtitle="All caught up" accent="#f97316" headerExtra={headerStats}>
        <p className="text-zinc-500">
          No jobs waiting for triage.
          {deferred.length > 0 && " Maybe-deferred jobs will return on the next pass."}
        </p>
        {shortlisted.length > 0 && (
          <button
            type="button"
            onClick={() => setView("shortlist")}
            className="mt-4 text-sm text-emerald-400 underline decoration-emerald-400/40"
          >
            View {shortlisted.length} shortlisted
          </button>
        )}
      </Shell>
    );
  }

  return (
    <Shell
      title="Swipe Triage"
      subtitle="Open the card for full details, then reject, maybe, or shortlist"
      accent="#f97316"
      headerExtra={headerStats}
    >
      <div className="mx-auto flex max-w-md flex-col items-center">
        <div className="relative h-[420px] w-full">
          {[2, 1, 0].map((layer) => {
            const j = deck[(index + layer) % deck.length];
            if (!j) return null;
            return <TriageCard key={`${j.id}-${layer}`} job={j} layer={layer} />;
          })}
        </div>

        {lastError && (
          <p className="mt-4 text-center text-xs text-red-400">{lastError}</p>
        )}

        <div className="mt-8 flex w-full gap-3">
          {[
            { label: "Reject", action: "not_relevant" as const, color: "border-red-500/40 text-red-400" },
            { label: "Maybe", action: "maybe" as const, color: "border-amber-500/40 text-amber-300" },
            {
              label: "Shortlist",
              action: "shortlisted" as const,
              color: "border-emerald-500/40 text-emerald-400",
            },
          ].map((btn) => (
            <button
              key={btn.label}
              type="button"
              disabled={pending}
              onClick={() => void decide(btn.action)}
              className={`flex-1 rounded-2xl border bg-white/[0.02] py-4 text-sm font-semibold transition active:scale-[0.98] disabled:opacity-40 ${btn.color}`}
            >
              {btn.label}
            </button>
          ))}
        </div>

        <p className="mt-6 text-center text-xs text-zinc-600">
          {live ? (
            <>
              Reject and shortlist save via{" "}
              <code className="text-zinc-500">POST /api/jobs/:id/review</code>. Maybe keeps the
              job in the stack for a later pass.
            </>
          ) : (
            "Mock mode — decisions update locally only."
          )}
        </p>
      </div>
    </Shell>
  );
}
