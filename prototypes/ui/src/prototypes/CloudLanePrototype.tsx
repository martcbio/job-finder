import { useEffect, useState } from "react";
import type {
  ApiEnvelope,
  CloudOpeningRow,
  CloudRowsResult,
  CloudRunRow,
  CloudUnavailableCode,
} from "../types";

interface CloudLaneData {
  openings: CloudOpeningRow[];
  runs: CloudRunRow[];
}

type CloudLaneState =
  | { status: "loading" }
  | { status: "available"; data: CloudLaneData }
  | {
      status: "cloud_unavailable";
      reason: { code: CloudUnavailableCode; message: string; upstreamStatus?: number };
    };

const unavailableStyles: Record<CloudUnavailableCode, { label: string; classes: string }> = {
  cloud_not_configured: {
    label: "Cloud not configured",
    classes: "border-amber-400/25 bg-amber-400/8 text-amber-200",
  },
  cloud_schema_not_exposed: {
    label: "Cloud lane not serving yet",
    classes: "border-sky-400/25 bg-sky-400/8 text-sky-200",
  },
  cloud_upstream_error: {
    label: "Cloud upstream unavailable",
    classes: "border-rose-400/25 bg-rose-400/8 text-rose-200",
  },
};

const healthStyles: Record<CloudRunRow["health"], string> = {
  complete: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  degraded: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  failed: "border-rose-400/25 bg-rose-400/10 text-rose-300",
};

function displayDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

async function fetchCloudRows<T>(path: string): Promise<CloudRowsResult<T>> {
  try {
    const response = await fetch(`/api/cloud/${path}`);
    const envelope = (await response.json()) as ApiEnvelope<CloudRowsResult<T>>;
    if (!response.ok || !envelope.ok || !envelope.data) {
      return {
        status: "cloud_unavailable",
        reason: {
          code: "cloud_upstream_error",
          message: envelope.error?.message ?? `Cloud API returned HTTP ${response.status}.`,
          upstreamStatus: response.status,
        },
      };
    }
    return envelope.data;
  } catch (error) {
    return {
      status: "cloud_unavailable",
      reason: {
        code: "cloud_upstream_error",
        message: error instanceof Error ? error.message : "Cloud API request failed.",
      },
    };
  }
}

const POLL_INTERVAL_MS = 60_000;

export default function CloudLanePrototype() {
  const [state, setState] = useState<CloudLaneState>({ status: "loading" });
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    let active = true;
    const load = () =>
      void Promise.all([
        fetchCloudRows<CloudRunRow>("runs?limit=5"),
        fetchCloudRows<CloudOpeningRow>("openings?limit=100"),
      ]).then(([runs, openings]) => {
        if (!active) return;
        if (runs.status === "cloud_unavailable") {
          setState(runs);
          return;
        }
        if (openings.status === "cloud_unavailable") {
          setState(openings);
          return;
        }
        setState({
          status: "available",
          data: { runs: runs.rows, openings: openings.rows },
        });
        setLastUpdatedAt(new Date());
      });
    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  if (state.status === "loading") {
    return (
      <main className="mx-auto max-w-[1400px] px-4 py-8 md:px-6">
        <div className="shimmer h-52 rounded-2xl border border-white/5" />
      </main>
    );
  }

  if (state.status === "cloud_unavailable") {
    const style = unavailableStyles[state.reason.code];
    return (
      <main className="mx-auto max-w-[1400px] px-4 py-8 md:px-6">
        <section className={`rounded-2xl border p-8 ${style.classes}`}>
          <p className="font-mono text-[10px] uppercase tracking-[0.24em] opacity-70">Cloud lane</p>
          <h1 className="mt-3 font-[family-name:var(--font-display)] text-2xl font-bold">
            {style.label}
          </h1>
          <p className="mt-2 max-w-2xl text-sm opacity-75">{state.reason.message}</p>
          {state.reason.upstreamStatus !== undefined && (
            <p className="mt-4 font-mono text-[10px] opacity-60">
              upstream HTTP {state.reason.upstreamStatus}
            </p>
          )}
        </section>
      </main>
    );
  }

  const latestRun = state.data.runs[0];
  return (
    <main className="mx-auto max-w-[1400px] space-y-6 px-4 py-8 md:px-6">
      <header>
        <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-violet-300">
          Cloud shadow arm
        </p>
        <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl font-bold text-white">
          Cloud Lane
        </h1>
        <p className="mt-1 text-sm text-zinc-500">Modal scans, Supabase evidence, local review.</p>
        {lastUpdatedAt !== null && (
          <p className="mt-1 font-mono text-[10px] text-zinc-600">
            updated {displayDate(lastUpdatedAt.toISOString())} · refreshes every minute
          </p>
        )}
      </header>

      <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
        {state.data.runs.map((run) => (
          <article key={run.run_id} className="rounded-xl border border-white/8 bg-white/[0.025] p-4">
            <div className="flex items-center justify-between gap-2">
              <span
                className={`rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase ${healthStyles[run.health]}`}
              >
                {run.health}
              </span>
              <span className="font-mono text-[9px] uppercase text-zinc-600">{run.substrate}</span>
            </div>
            <p className="mt-4 text-2xl font-semibold text-white">{run.matched_openings_count}</p>
            <p className="text-[11px] text-zinc-500">matched openings</p>
            <p className="mt-3 font-mono text-[9px] text-zinc-600">{displayDate(run.completed_at)}</p>
          </article>
        ))}
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/8 bg-white/[0.02]">
        <div className="flex items-center justify-between border-b border-white/8 px-5 py-4">
          <div>
            <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold text-white">
              Openings
            </h2>
            <p className="text-xs text-zinc-600">Newest sightings first</p>
          </div>
          <span className="font-mono text-xs text-zinc-500">{state.data.openings.length} rows</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-left">
            <thead className="font-mono text-[9px] uppercase tracking-wider text-zinc-600">
              <tr className="border-b border-white/5">
                <th className="px-5 py-3 font-medium">Opening</th>
                <th className="px-4 py-3 font-medium">Company / org</th>
                <th className="px-4 py-3 font-medium">Location</th>
                <th className="px-4 py-3 font-medium">First seen</th>
                <th className="px-5 py-3 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {state.data.openings.map((opening) => {
                const isLatestRun = opening.first_seen_run_id === latestRun?.run_id;
                return (
                  <tr
                    key={`${opening.org}:${opening.ats}:${opening.external_id}`}
                    className="border-b border-white/5 text-sm last:border-0 hover:bg-white/[0.025]"
                  >
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2">
                        <a
                          href={opening.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium text-zinc-100 decoration-violet-400/60 underline-offset-4 hover:text-violet-300 hover:underline"
                        >
                          {opening.title ?? "Untitled opening"}
                        </a>
                        {isLatestRun && (
                          <span className="rounded-full border border-violet-400/25 bg-violet-400/10 px-2 py-0.5 font-mono text-[8px] uppercase text-violet-300">
                            new latest run
                          </span>
                        )}
                      </div>
                      <p className="mt-1 font-mono text-[9px] uppercase text-zinc-600">{opening.ats}</p>
                    </td>
                    <td className="px-4 py-4 text-zinc-400">
                      {opening.company}
                      <span className="ml-1 text-zinc-700">/ {opening.org}</span>
                    </td>
                    <td className="px-4 py-4 text-zinc-400">{opening.location}</td>
                    <td className="px-4 py-4 font-mono text-[10px] text-zinc-500">
                      {displayDate(opening.first_seen_at)}
                    </td>
                    <td className="px-5 py-4 font-mono text-[10px] text-zinc-500">
                      {displayDate(opening.last_seen_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
