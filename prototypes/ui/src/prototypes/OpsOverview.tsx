import { useEffect, useMemo, useState } from "react";
import type {
  ApiEnvelope,
  CloudOpsPayload,
  OpsDoctorRow,
  OpsParityRow,
  OpsRunRow,
  ReviewQueueRow,
} from "../types";
import { deriveParityComparisons } from "./parityModel";
import { toQueueJobView } from "./reviewQueueModel";

const POLL_INTERVAL_MS = 60_000;

function relativeTime(value: string | null, now: number): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function groupKey(task: string, substrate: string | null): string {
  return `${task}\u0000${substrate ?? "unknown"}`;
}

function substrateTone(substrate: string | null): string {
  return substrate === "modal" ? "bg-violet-500/10 text-violet-500" : "bg-sky-500/10 text-sky-500";
}

function doctorTone(row: OpsDoctorRow): { dot: string; label: string } {
  if (row.unhealthy || row.stale) return { dot: "bg-rose-500", label: "Unhealthy" };
  if ((row.failure_rate_24h ?? 0) > 0 || (row.last_exit_status ?? 0) !== 0) {
    return { dot: "bg-amber-500", label: "Warning" };
  }
  return { dot: "bg-emerald-500", label: "Healthy" };
}

function SectionHeader({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <h2 className="text-[12px] font-bold tracking-[-0.01em] text-[var(--rq-text)]">{title}</h2>
      {detail && <p className="text-[9px] text-[var(--rq-faint)]">{detail}</p>}
    </div>
  );
}

function EmptyState({ children }: { children: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--rq-border)] px-5 py-8 text-center text-[11px] text-[var(--rq-muted)]">
      {children}
    </div>
  );
}

function HealthStrip({ rows, now }: { rows: OpsDoctorRow[]; now: number }) {
  if (rows.length === 0) return <EmptyState>No monitored task pairs reported.</EmptyState>;
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {rows.map((row) => {
        const health = doctorTone(row);
        return (
          <article
            key={groupKey(row.task, row.substrate)}
            className="rounded-xl border border-[var(--rq-border)] bg-[var(--rq-surface)] p-4 shadow-[var(--rq-shadow)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${health.dot}`}
                    title={health.label}
                  />
                  <h3 className="truncate text-[12px] font-semibold text-[var(--rq-text)]">
                    {row.task}
                  </h3>
                </div>
                <p className="ml-4 mt-1 text-[9px] text-[var(--rq-muted)]">
                  success {relativeTime(row.latest_success_at, now)}
                </p>
              </div>
              <span
                className={`rounded px-2 py-1 text-[9px] font-semibold ${substrateTone(row.substrate)}`}
              >
                {row.substrate ?? "unknown"}
              </span>
            </div>
            <div className="mt-4 flex items-center gap-4 border-t border-[var(--rq-border)] pt-3 text-[9px] text-[var(--rq-muted)]">
              <span>
                failures{" "}
                <b className="font-semibold tabular-nums text-[var(--rq-text-soft)]">
                  {Math.round((row.failure_rate_24h ?? 0) * 100)}%
                </b>
              </span>
              {(row.missed_beats_24h ?? 0) > 0 && (
                <span className="text-amber-500">
                  <b className="font-semibold tabular-nums">{row.missed_beats_24h}</b> missed beats
                </span>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function RunHistory({ rows }: { rows: OpsRunRow[] }) {
  const groups = useMemo(() => {
    const grouped = new Map<string, OpsRunRow[]>();
    for (const row of rows) {
      const key = groupKey(row.task, row.substrate);
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    return [...grouped.values()].map((group) => group.slice(0, 20).reverse());
  }, [rows]);
  if (groups.length === 0) return <EmptyState>No recent operations runs.</EmptyState>;
  return (
    <div className="space-y-2 rounded-xl border border-[var(--rq-border)] bg-[var(--rq-surface)] p-4 shadow-[var(--rq-shadow)]">
      {groups.map((runs) => {
        const latest = runs[runs.length - 1];
        if (!latest) return null;
        return (
          <div key={groupKey(latest.task, latest.substrate)} className="flex items-center gap-3">
            <div className="w-44 min-w-0">
              <p className="truncate text-[10px] font-semibold text-[var(--rq-text-soft)]">
                {latest.task}
              </p>
              <p className="text-[8px] text-[var(--rq-faint)]">{latest.substrate ?? "unknown"}</p>
            </div>
            <ul
              className="m-0 flex min-w-0 flex-1 list-none justify-end gap-1 p-0"
              aria-label={`${latest.task} run history`}
            >
              {runs.map((run) => {
                const tone =
                  run.finished_at === null
                    ? "bg-slate-400"
                    : run.exit_status === 0
                      ? "bg-emerald-500"
                      : "bg-rose-500";
                const stamp = run.finished_at ?? run.started_at ?? "unknown time";
                return (
                  <li
                    key={`${latest.task}-${latest.substrate}-${stamp}`}
                    className={`h-3 w-3 rounded-[2px] ${tone}`}
                    title={`${stamp} · ${run.finished_at === null ? "running" : `exit ${run.exit_status ?? "unknown"}`}`}
                  />
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function ParityPanel({ rows }: { rows: OpsParityRow[] }) {
  const comparisons = useMemo(() => deriveParityComparisons(rows), [rows]);
  if (comparisons.length === 0) return <EmptyState>No parity checks reported.</EmptyState>;
  return (
    <div className="divide-y divide-[var(--rq-border)] overflow-hidden rounded-xl border border-[var(--rq-border)] bg-[var(--rq-surface)] shadow-[var(--rq-shadow)]">
      {comparisons.map((comparison) => {
        const awaiting = comparison.status.startsWith("awaiting_")
          ? comparison.status.replace("awaiting_", "")
          : null;
        return (
          <div
            key={comparison.runDate}
            className="flex items-center justify-between gap-4 px-4 py-3"
          >
            <div>
              <p className="text-[10px] font-semibold text-[var(--rq-text)]">
                {comparison.runDate}
              </p>
              <p className="mt-0.5 text-[9px] tabular-nums text-[var(--rq-muted)]">
                mac {comparison.mac?.openings_count ?? "—"} · modal{" "}
                {comparison.modal?.openings_count ?? "—"}
              </p>
            </div>
            {awaiting ? (
              <span className="text-[9px] font-medium text-[var(--rq-muted)]">
                awaiting {awaiting}
              </span>
            ) : comparison.status === "no_comparable_window" ? (
              <span className="text-[9px] font-medium text-[var(--rq-muted)]">
                no comparable window
              </span>
            ) : comparison.status === "in_sync" ? (
              <span className="text-[9px] font-semibold text-emerald-500">✓ in sync</span>
            ) : (
              <span className="text-[9px] font-semibold text-amber-500">divergence</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DataQuality({ queue }: { queue: ReviewQueueRow[] }) {
  const metrics = useMemo(() => {
    const views = queue.map((row) => toQueueJobView(row));
    return {
      total: views.length,
      nonIt: views.filter((view) => view.itRelevance === "non_it").length,
      conflict: views.filter((view) => view.signalConflict === "ir35_on_permanent").length,
      unknown: views.filter((view) => view.employmentType === "unknown").length,
    };
  }, [queue]);
  const items = [
    ["Queue rows", metrics.total, false],
    ["Non-IT", metrics.nonIt, false],
    ["IR35 on permanent", metrics.conflict, metrics.conflict > 0],
    ["Unknown type", metrics.unknown, false],
  ] as const;
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--rq-border)] bg-[var(--rq-border)] shadow-[var(--rq-shadow)] sm:grid-cols-4">
      {items.map(([label, value, warn]) => (
        <div key={label} className="bg-[var(--rq-surface)] px-4 py-5">
          <p
            className={`text-2xl font-bold tabular-nums ${warn ? "text-amber-500" : "text-[var(--rq-text)]"}`}
          >
            {value}
          </p>
          <p className="mt-1 text-[9px] text-[var(--rq-muted)]">{label}</p>
        </div>
      ))}
    </div>
  );
}

export default function OpsOverview({ queue, now }: { queue: ReviewQueueRow[]; now: number }) {
  const [ops, setOps] = useState<CloudOpsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/cloud/ops", { cache: "no-store" });
        const body = (await response.json()) as ApiEnvelope<CloudOpsPayload>;
        if (!response.ok || !body.ok || !body.data)
          throw new Error(body.error?.message ?? `HTTP ${response.status}`);
        if (active) {
          setOps(body.data);
          setError(null);
          setUpdatedAt(new Date().toISOString());
        }
      } catch (caught) {
        if (active)
          setError(caught instanceof Error ? caught.message : "Unable to load operations data");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const doctorRows =
    ops?.doctor.status === "available" || ops?.doctor.status === "doctor_not_deployed"
      ? ops.doctor.rows
      : [];
  const runs = ops?.runs.status === "available" ? ops.runs.rows : [];
  const parity = ops?.parity.status === "available" ? ops.parity.rows : [];
  const alerts = ops?.alerts.status === "available" ? ops.alerts.rows : [];

  return (
    <>
      <p className={`mb-5 text-[9px] ${error ? "text-rose-500" : "text-[var(--rq-faint)]"}`}>
        {error ??
          (updatedAt
            ? `updated ${relativeTime(updatedAt, now)} · refreshes every minute`
            : "loading operations data…")}
      </p>

      <section className="mb-7" aria-label="Pipeline health">
        <SectionHeader
          title="Pipeline health"
          detail={
            ops?.doctor.status === "doctor_not_deployed" ? "doctor v2 pending migration" : undefined
          }
        />
        {ops?.doctor.status === "unavailable" ? (
          <EmptyState>{ops.doctor.reason.message}</EmptyState>
        ) : (
          <HealthStrip rows={doctorRows} now={now} />
        )}
      </section>

      <section className="mb-7" aria-label="Run history">
        <SectionHeader title="Run history" detail="newest run on the right" />
        {ops?.runs.status === "unavailable" ? (
          <EmptyState>{ops.runs.reason.message}</EmptyState>
        ) : (
          <RunHistory rows={runs} />
        )}
      </section>

      <div className="mb-7 grid gap-6 xl:grid-cols-2">
        <section aria-label="Open alerts">
          <SectionHeader title="Open alerts" />
          {ops?.alerts.status === "alerts_unavailable" ? (
            <EmptyState>Alerts will appear when the ops schema is exposed.</EmptyState>
          ) : alerts.length === 0 ? (
            <EmptyState>No open alerts.</EmptyState>
          ) : (
            <div className="divide-y divide-[var(--rq-border)] overflow-hidden rounded-xl border border-[var(--rq-border)] bg-[var(--rq-surface)] shadow-[var(--rq-shadow)]">
              {alerts.map((alert) => (
                <article key={alert.id} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <span
                      className={`rounded px-2 py-1 text-[8px] font-bold uppercase ${alert.severity === "critical" ? "bg-rose-500/12 text-rose-500" : "bg-amber-500/12 text-amber-500"}`}
                    >
                      {alert.severity}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] leading-relaxed text-[var(--rq-text-soft)]">
                        {alert.message}
                      </p>
                      <p className="mt-1 text-[8px] text-[var(--rq-faint)]">
                        {alert.occurrences} occurrences · last seen{" "}
                        {relativeTime(alert.last_seen, now)}
                      </p>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section aria-label="Parity">
          <SectionHeader title="Mac / Modal parity" />
          {ops?.parity.status === "unavailable" ? (
            <EmptyState>{ops.parity.reason.message}</EmptyState>
          ) : (
            <ParityPanel rows={parity} />
          )}
        </section>
      </div>

      <section aria-label="Data quality">
        <SectionHeader title="Data quality" detail="derived from the current review queue" />
        <DataQuality queue={queue} />
      </section>
    </>
  );
}
