import { useMemo, useState } from "react";
import type {
  ApplicationActor,
  ApplicationRow,
  ApplicationStatus,
} from "../types";
import type { ApplicationLifecycleState } from "../useApplicationLifecycle";
import {
  applicationAge,
  BOARD_STATUSES,
  groupApplications,
  nextApplicationStatus,
} from "./applicationBoardModel";

interface Props {
  applications: ApplicationRow[];
  state: ApplicationLifecycleState;
  error: string | null;
  updatedAt: string | null;
  now: number;
  onTransition: (
    id: string,
    to: ApplicationStatus,
    by: ApplicationActor,
    note?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  onStageCv: (id: string) => Promise<{ ok: boolean; error?: string }>;
}

function label(status: string): string {
  return status.replace(/_/g, " ");
}

function syncWhisper(
  state: ApplicationLifecycleState,
  error: string | null,
  updatedAt: string | null,
  now: number,
): string {
  if (error) return error;
  if (state === "loading") return "loading application pipeline…";
  if (!updatedAt) return "live pipeline · refreshes every minute";
  const seconds = Math.max(0, Math.floor((now - Date.parse(updatedAt)) / 1_000));
  return `live pipeline · synced ${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`} ago · refreshes every minute`;
}

export default function ApplicationPipelineBoard({
  applications,
  state,
  error,
  updatedAt,
  now,
  onTransition,
  onStageCv,
}: Props) {
  const grouped = useMemo(() => groupApplications(applications), [applications]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const move = async (application: ApplicationRow, to: ApplicationStatus) => {
    const by: ApplicationActor = "owner";
    if (to === "sent") {
      const confirmed = window.confirm(
        `Confirm that you personally sent the application for ${application.title} at ${application.company}.`,
      );
      if (!confirmed) return;
    }
    setBusyId(application.id);
    setActionError(null);
    const result = await onTransition(application.id, to, by);
    setBusyId(null);
    if (!result.ok) setActionError(result.error ?? "Unable to move application");
  };

  const close = async (application: ApplicationRow) => {
    const reason = window.prompt(`Why is ${application.company} · ${application.title} closed?`);
    if (!reason?.trim()) return;
    setBusyId(application.id);
    setActionError(null);
    const result = await onTransition(application.id, "closed", "owner", reason.trim());
    setBusyId(null);
    if (!result.ok) setActionError(result.error ?? "Unable to close application");
  };

  const stageCv = async (application: ApplicationRow) => {
    setBusyId(application.id);
    setActionError(null);
    const result = await onStageCv(application.id);
    setBusyId(null);
    if (!result.ok) setActionError(result.error ?? "Unable to stage CV");
  };

  return (
    <section aria-label="Application pipeline">
      <p
        className={`mb-4 text-[9px] ${error || actionError ? "text-rose-500" : "text-[var(--rq-faint)]"}`}
        aria-live="polite"
      >
        {actionError ?? syncWhisper(state, error, updatedAt, now)}
      </p>

      {state === "cloud_unavailable" && applications.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--rq-border)] px-5 py-12 text-center text-[11px] text-[var(--rq-muted)]">
          The application board will appear when the careers applications schema is available.
        </div>
      ) : (
        <div className="grid min-w-[1200px] grid-cols-6 gap-3 overflow-x-auto pb-4">
          {BOARD_STATUSES.map((status) => (
            <section
              key={status}
              className="min-h-[520px] rounded-xl border border-[var(--rq-border)] bg-[var(--rq-hover)] p-3"
              aria-label={`${label(status)} applications`}
            >
              <header className="mb-3 flex items-center justify-between gap-2 px-1">
                <h2 className="text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--rq-text-soft)]">
                  {label(status)}
                </h2>
                <span className="rounded-full bg-[var(--rq-surface)] px-2 py-0.5 text-[9px] tabular-nums text-[var(--rq-muted)]">
                  {grouped[status].length}
                </span>
              </header>
              <div className="space-y-2.5">
                {grouped[status].map((application) => {
                  const next = nextApplicationStatus(application.status);
                  const sentAction = next === "sent";
                  const stageAction = application.status === "shortlisted";
                  const busy = busyId === application.id;
                  return (
                    <article
                      key={application.id}
                      className="rounded-lg border border-[var(--rq-border)] bg-[var(--rq-surface)] p-3 shadow-[var(--rq-shadow)]"
                    >
                      <p className="truncate text-[9px] font-semibold uppercase tracking-[0.06em] text-emerald-500">
                        {application.company}
                      </p>
                      <a
                        href={application.url ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 block text-[11px] font-semibold leading-snug text-[var(--rq-text)] hover:text-emerald-500"
                      >
                        {application.title}
                      </a>
                      <p className="mt-2 text-[9px] text-[var(--rq-faint)]">
                        tracked {applicationAge(application.created_at, now)} ago
                      </p>
                      {application.status === "cv_staged" && application.cv_ref && (
                        <div className="mt-2 rounded-md bg-[var(--rq-hover)] px-2 py-1.5">
                          <p className="break-all font-mono text-[8px] text-[var(--rq-text-soft)]">
                            {application.cv_ref}
                          </p>
                          <p className="mt-1 text-[8px] font-semibold text-violet-500">
                            dummy rendered
                          </p>
                        </div>
                      )}
                      <div className="mt-3 flex flex-col gap-1.5">
                        {stageAction ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void stageCv(application)}
                            className="rounded-md border border-violet-500/45 px-2.5 py-2 text-[9px] font-bold text-violet-500 transition hover:bg-violet-500/10 disabled:opacity-50"
                          >
                            {busy ? "Staging CV…" : "Stage CV"}
                          </button>
                        ) : next ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void move(application, next)}
                            className={`rounded-md border px-2.5 py-2 text-[9px] font-bold transition disabled:opacity-50 ${
                              sentAction
                                ? "border-amber-500/60 bg-amber-500/12 text-amber-600 hover:bg-amber-500/20"
                                : "border-emerald-500/35 text-emerald-600 hover:bg-emerald-500/10"
                            }`}
                          >
                            {sentAction ? "Mark sent — I sent this" : `Move to ${label(next)}`}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void close(application)}
                          className="rounded-md px-2 py-1.5 text-[8px] text-[var(--rq-faint)] hover:bg-[var(--rq-hover-strong)] hover:text-rose-500 disabled:opacity-50"
                        >
                          Close…
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
