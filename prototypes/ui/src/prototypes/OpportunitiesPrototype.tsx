import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiEnvelope, OpportunityReport, OpportunityRow } from "../types";

type Filter = "recent" | "picks" | "qualified" | "caveat" | "disqualified";

function verdict(row: OpportunityRow): Exclude<Filter, "recent" | "picks"> {
  if (row.screening.status === "rejected") return "disqualified";
  if (row.screening.status === "needs_human_review") return "caveat";
  return "qualified";
}

function sourceMatch(row: OpportunityRow, source: string): boolean {
  const expected = source.toLowerCase();
  if (expected === "jobserve") return row.source === "JobServe";
  if (expected === "lab ats") return row.source === "Lab ATS";
  if (expected === "linear careers") return row.source === "Linear Careers";
  if (expected === "google careers") return row.source === "Google Careers";
  return false;
}

const verdictStyle = {
  qualified: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  caveat: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  disqualified: "border-rose-400/25 bg-rose-400/10 text-rose-300",
} as const;

function date(value: string): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date(value));
}

function displayDate(row: OpportunityRow): string {
  return row.postedAt ? date(row.postedAt) : `First seen ${date(row.discoveredAt)}`;
}

export default function OpportunitiesPrototype() {
  const [report, setReport] = useState<OpportunityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("recent");
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/opportunities?limit=50", { cache: "no-store" });
      const envelope = (await response.json()) as ApiEnvelope<OpportunityReport>;
      if (!response.ok || !envelope.ok || !envelope.data) {
        throw new Error(envelope.error?.message ?? `HTTP ${response.status}`);
      }
      setReport(envelope.data);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load opportunities");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const recommendedUrls = useMemo(
    () => new Set(report?.recommendedUrls ?? []),
    [report],
  );
  const rows = useMemo(() => {
    if (!report) return [];
    const bySource = sourceFilter === null
      ? report.rows
      : report.rows.filter((row) => sourceMatch(row, sourceFilter));
    if (filter === "recent") return bySource;
    if (filter === "picks") {
      return bySource
        .filter((row) => recommendedUrls.has(row.url))
        .sort(
          (left, right) =>
            (right.recommendationScore ?? 0) - (left.recommendationScore ?? 0),
        );
    }
    return bySource.filter((row) => verdict(row) === filter);
  }, [filter, recommendedUrls, report, sourceFilter]);

  if (loading && !report) {
    return (
      <main className="mx-auto max-w-[1400px] px-4 py-8 md:px-6">
        <div className="shimmer h-52 rounded-2xl border border-white/5" />
      </main>
    );
  }

  if (!report) {
    return (
      <main className="mx-auto max-w-[1400px] px-4 py-8 md:px-6">
        <section className="rounded-2xl border border-rose-400/25 bg-rose-400/8 p-8 text-rose-200">
          <h1 className="text-2xl font-bold">Opportunity list unavailable</h1>
          <p className="mt-2 text-sm opacity-80">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-5 rounded-full border border-rose-300/30 px-4 py-2 text-xs"
          >
            Retry local data
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-[1400px] space-y-5 px-4 py-8 md:px-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-amber-300">
            Local data · no source refresh
          </p>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl font-bold text-white">
            Recent engineering opportunities
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Jobs with verified bodies, ordered by source posting date or honest first-seen date.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="self-start rounded-full border border-white/10 px-4 py-2 text-xs text-zinc-300 hover:border-amber-300/40 hover:text-amber-200"
        >
          Reload local data
        </button>
      </header>

      <section className="grid gap-3 md:grid-cols-3">
        {report.sourceHealth.map((source) => {
          const active = sourceFilter === source.source;
          return (
            <button
              key={source.source}
              type="button"
              onClick={() => setSourceFilter(active ? null : source.source)}
              className={`rounded-xl border p-4 text-left transition ${
                active
                  ? "border-amber-300/40 bg-amber-300/[0.06]"
                  : "border-white/8 bg-white/[0.025] hover:border-white/20"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">{source.source}</span>
                <span
                  className={`rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase ${
                    source.status === "current"
                      ? verdictStyle.qualified
                      : source.status === "stale"
                        ? verdictStyle.caveat
                        : verdictStyle.disqualified
                  }`}
                >
                  {source.status}
                </span>
              </div>
              <p className="mt-3 text-2xl font-semibold text-white">{source.rowCount}</p>
              <p className="text-xs text-zinc-500">
                {source.ageHours === null
                  ? "No capture"
                  : `captured ${source.ageHours.toFixed(1)}h ago`}
              </p>
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={filter === "picks"}
          onClick={() => setFilter(filter === "picks" ? "recent" : "picks")}
          className={`rounded-xl border p-4 text-left transition ${
            filter === "picks"
              ? "border-amber-300/40 bg-amber-300/[0.10]"
              : "border-amber-400/20 bg-amber-400/[0.06] hover:border-amber-300/35"
          }`}
        >
          <span className="font-semibold text-amber-200">Picks</span>
          <p className="mt-3 text-2xl font-semibold text-white">{report.recommendedUrls.length}</p>
          <p className="text-xs text-zinc-500">
            {report.recommendationDistribution
              .map((item) => `${item.source} ${item.count}`)
              .join(" · ") || "No current jobs qualify as Picks"}
          </p>
        </button>
      </section>

      <section className="flex flex-wrap gap-2">
        {(["recent", "picks", "qualified", "caveat", "disqualified"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(filter === value && value !== "recent" ? "recent" : value)}
            className={`rounded-full border px-3 py-1.5 text-xs capitalize ${
              filter === value
                ? "border-amber-300/40 bg-amber-300/10 text-amber-200"
                : "border-white/8 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {value}
          </button>
        ))}
        <span className="ml-auto self-center font-mono text-[10px] text-zinc-600">
          {sourceFilter ? `${sourceFilter} · ` : ""}
          {rows.length} of {report.rows.length}
        </span>
      </section>

      {error && (
        <p className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-xs text-amber-200">
          Reload failed; showing previous local data: {error}
        </p>
      )}

      <section className="overflow-hidden rounded-2xl border border-white/8 bg-white/[0.02]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1050px] border-collapse text-left">
            <thead className="font-mono text-[9px] uppercase tracking-wider text-zinc-600">
              <tr className="border-b border-white/5">
                <th className="px-5 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Date / source</th>
                <th className="px-4 py-3 font-medium">Location</th>
                <th className="px-4 py-3 font-medium">Verdict</th>
                <th className="px-5 py-3 font-medium">Why / terms</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const decision = verdict(row);
                const why =
                  row.screening.reasons.map((reason) => reason.detail).join("; ") ||
                  row.screening.summary;
                const isPick = recommendedUrls.has(row.url);
                return (
                  <tr
                    key={row.url}
                    className="border-b border-white/5 align-top last:border-0 group relative"
                  >
                    <td className="px-5 py-4">
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noreferrer"
                        className="stretched-link font-medium text-zinc-100 underline-offset-4 group-hover:text-amber-200 group-hover:underline"
                      >
                        {row.title}
                      </a>
                      {isPick && row.recommendationScore !== undefined && (
                        <p className="mt-1 text-[10px] font-semibold text-amber-300">
                          ★ Pick · score {row.recommendationScore}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-zinc-500">{row.company}</p>
                      {isPick &&
                        row.recommendationReasons &&
                        row.recommendationReasons.length > 0 && (
                        <p className="mt-1 text-[10px] leading-4 text-amber-200/70">
                          {row.recommendationReasons.join(" · ")}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-4 text-xs text-zinc-400">
                      {displayDate(row)}
                      <p className="mt-1 font-mono text-[9px] uppercase text-zinc-600">
                        {row.source}
                      </p>
                    </td>
                    <td className="px-4 py-4 text-xs text-zinc-400">{row.location || "Unstated"}</td>
                    <td className="px-4 py-4">
                      <span
                        className={`rounded-full border px-2 py-1 font-mono text-[9px] uppercase ${verdictStyle[decision]}`}
                      >
                        {decision}
                      </span>
                    </td>
                    <td className="max-w-xl px-5 py-4 text-xs leading-5 text-zinc-400">
                      <p>{why}</p>
                      <p className="mt-1 text-zinc-600">{row.terms}</p>
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
