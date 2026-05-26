import type { ReactNode } from "react";
import { formatRelative, formatState, stateColor } from "../mockData";
import type { ReviewQueueRow } from "../types";

export function StateBadge({ state }: { state: string }) {
  const color = stateColor(state);
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide"
      style={{
        background: `${color}22`,
        color,
        border: `1px solid ${color}44`,
      }}
    >
      {formatState(state)}
    </span>
  );
}

export function SourcePills({ labels }: { labels: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {labels.map((label) => (
        <span
          key={label}
          className="rounded-md bg-white/5 px-2 py-0.5 font-mono text-[10px] text-zinc-400"
        >
          {label}
        </span>
      ))}
    </div>
  );
}

export function DupWarning({ job }: { job: ReviewQueueRow }) {
  if (job.duplicate_candidates.length === 0) return null;
  const dup = job.duplicate_candidates[0];
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
      Possible duplicate of &ldquo;{dup.other_title}&rdquo; ({Math.round(Number(dup.confidence) * 100)}%)
    </div>
  );
}

export function SignalChip({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const styles = {
    neutral: "border-zinc-700/80 bg-zinc-800/50 text-zinc-400",
    good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-200",
    bad: "border-red-500/30 bg-red-500/10 text-red-300",
  }[tone];

  return (
    <span
      className={`inline-flex shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[10px] leading-none ${styles}`}
    >
      {label}
    </span>
  );
}

export function JobMeta({ job }: { job: ReviewQueueRow }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
      <span>{formatRelative(job.last_seen_at)}</span>
      {job.classification_confidence && (
        <>
          <span className="text-zinc-700">|</span>
          <span className="font-mono">{Math.round(Number(job.classification_confidence) * 100)}% conf</span>
        </>
      )}
    </div>
  );
}

export function LiveBanner({ live, loading }: { live: boolean; loading: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium ${
        live
          ? "bg-emerald-500/15 text-emerald-400"
          : "bg-zinc-800 text-zinc-400"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-400" : "bg-zinc-500"} ${loading ? "animate-pulse" : ""}`}
      />
      {loading ? "Connecting..." : live ? "Live API" : "Mock data (API offline)"}
    </div>
  );
}

export function Shell({
  title,
  subtitle,
  accent,
  children,
  headerExtra,
}: {
  title: string;
  subtitle: string;
  accent: string;
  children: ReactNode;
  headerExtra?: ReactNode;
}) {
  return (
    <div className="min-h-[100dvh] bg-[#0c0d0f]">
      <header
        className="border-b border-white/5 px-6 py-5"
        style={{ borderBottomColor: `${accent}22` }}
      >
        <div className="mx-auto flex max-w-[1400px] items-end justify-between gap-4">
          <div>
            <p
              className="mb-1 font-mono text-[10px] uppercase tracking-[0.2em]"
              style={{ color: accent }}
            >
              Prototype
            </p>
            <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight text-white md:text-3xl">
              {title}
            </h1>
            <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>
          </div>
          {headerExtra}
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-6 md:px-6">{children}</main>
    </div>
  );
}
