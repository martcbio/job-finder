import { useEffect, useMemo, useState } from "react";
import { isShortlistedJob, isTriageQueueJob } from "../queueViews";
import type { PrototypeId, PrototypeInfo, ReviewQueueRow } from "../types";
import ReviewQueueFilters from "./ReviewQueueFilters";
import ReviewQueueSidebar from "./ReviewQueueSidebar";
import {
  defaultSavedViews,
  filterQueueJobs,
  type QueueFilter,
  type QueueJobView,
  type QueueSavedView,
  type QuickFilterId,
  toQueueJobView,
} from "./reviewQueueModel";

const SAVED_VIEWS_KEY = "signal-cockpit:review-queue-views:v1";
const THEME_KEY = "signal-cockpit:theme";
const PAGE_SIZE = 25;

interface Props {
  queue: ReviewQueueRow[];
  live: boolean;
  loadError: string | null;
  lastUpdatedAt: string | null;
  prototypes: readonly PrototypeInfo[];
  onSelectPrototype: (id: PrototypeId) => void;
}

type Theme = "light" | "dark";
type SortMode = "latest" | "oldest" | "confidence";

function initialTheme(): Theme {
  const saved = window.localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function relativeTime(date: Date, now: number): string {
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function avatarHue(value: string): number {
  return [...value].reduce((total, character) => total + character.charCodeAt(0), 0) % 360;
}

function StatIcon({ kind }: { kind: "queue" | "review" | "shortlist" | "duplicate" }) {
  const paths = {
    queue: "M8 4h8m-7-1v3m6-3v3M6 5.5h12v15H6zM9 10h6m-6 4h6m-6 4h4",
    review: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9v-2a6 6 0 0 1 12 0v2",
    shortlist: "M7 3.5h10v17l-5-3-5 3z",
    duplicate: "M6 21V4l6 2 6-2v10l-6 2-6-2",
  };
  const tones = {
    queue: "text-emerald-500",
    review: "text-amber-500",
    shortlist: "text-blue-500",
    duplicate: "text-rose-500",
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={`h-7 w-7 ${tones[kind]}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[kind]} />
    </svg>
  );
}

function ThemeIcon({ theme }: { theme: Theme }) {
  return theme === "dark" ? (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path d="M20.4 15.6A9 9 0 0 1 8.4 3.6 9 9 0 1 0 20.4 15.6Z" />
    </svg>
  ) : (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M19 5l-1.5 1.5m-11 11L5 19" />
    </svg>
  );
}

function loadSavedViews(jobs: QueueJobView[]): QueueSavedView[] {
  const raw = window.localStorage.getItem(SAVED_VIEWS_KEY);
  if (!raw) return defaultSavedViews(jobs);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as QueueSavedView[];
    console.warn("Saved review queue views were not an array; defaults restored.");
  } catch (error) {
    console.warn("Saved review queue views could not be parsed; defaults restored.", error);
  }
  return defaultSavedViews(jobs);
}

function sortJobs(jobs: QueueJobView[], mode: SortMode): QueueJobView[] {
  return [...jobs].sort((a, b) => {
    if (mode === "confidence") return b.confidence - a.confidence;
    if (mode === "oldest") return a.postedAt.getTime() - b.postedAt.getTime();
    return b.postedAt.getTime() - a.postedAt.getTime();
  });
}

function statusLabel(job: QueueJobView): string {
  if (job.job.review_state === "duplicate_candidate" || job.job.duplicate_candidates.length > 0) {
    return "Duplicate candidate";
  }
  if (job.job.review_state === "shortlisted") return "Shortlisted";
  return "Ready for review";
}

function Ir35Badge({ value }: { value: QueueJobView["ir35"] }) {
  if (value === "unknown") return <span className="text-[var(--rq-muted)]">—</span>;
  const outside = value === "outside";
  return (
    <span
      className={`inline-flex rounded px-2 py-1 text-[10px] font-medium ${outside ? "bg-emerald-500/12 text-emerald-500" : "bg-amber-500/12 text-amber-500"}`}
    >
      {outside ? "Outside IR35" : "Inside IR35"}
    </span>
  );
}

function Confidence({ value }: { value: number }) {
  const high = value >= 80;
  return (
    <div className="w-[82px]">
      <span className="text-[11px] tabular-nums text-[var(--rq-text-soft)]">
        {value || "—"}
        {value ? "%" : ""}
      </span>
      <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-[var(--rq-progress)]">
        <div
          className={`h-full rounded-full ${high ? "bg-emerald-500" : "bg-amber-500"}`}
          style={{ width: `${Math.max(value, 4)}%` }}
        />
      </div>
    </div>
  );
}

function JobTable({
  jobs,
  now,
  selected,
  onToggle,
  onTogglePage,
}: {
  jobs: QueueJobView[];
  now: number;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onTogglePage: () => void;
}) {
  const allSelected = jobs.length > 0 && jobs.every((job) => selected.has(job.job.id));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1270px] border-collapse text-left">
        <thead>
          <tr className="border-b border-[var(--rq-border)] text-[10px] font-semibold text-[var(--rq-muted)]">
            <th className="w-12 px-4 py-3.5">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onTogglePage}
                aria-label="Select page"
              />
            </th>
            <th className="w-[270px] px-2 py-3.5">Job</th>
            <th className="px-3 py-3.5">IR35 Status</th>
            <th className="px-3 py-3.5">Location</th>
            <th className="px-3 py-3.5">Workplace</th>
            <th className="px-3 py-3.5">Seniority</th>
            <th className="px-3 py-3.5">Role</th>
            <th className="px-3 py-3.5">Source</th>
            <th className="px-3 py-3.5">Confidence</th>
            <th className="px-3 py-3.5">Posted</th>
            <th className="px-3 py-3.5">Status / Actions</th>
            <th className="w-10 px-3 py-3.5" />
          </tr>
        </thead>
        <tbody>
          {jobs.map((view) => {
            const job = view.job;
            const company = job.company_hint ?? "Unknown company";
            const status = statusLabel(view);
            const duplicate = status === "Duplicate candidate";
            return (
              <tr
                key={job.id}
                className="border-b border-[var(--rq-border)] text-[11px] text-[var(--rq-text-soft)] last:border-b-0 hover:bg-[var(--rq-hover)]"
              >
                <td className="px-4 py-3.5">
                  <input
                    type="checkbox"
                    checked={selected.has(job.id)}
                    onChange={() => onToggle(job.id)}
                    aria-label={`Select ${job.title}`}
                  />
                </td>
                <td className="px-2 py-3.5">
                  <div className="flex items-center gap-3">
                    <div
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-xs font-bold text-white shadow-sm"
                      style={{
                        background: `linear-gradient(145deg, hsl(${avatarHue(company)} 68% 55%), hsl(${avatarHue(company) + 35} 75% 42%))`,
                      }}
                    >
                      {initials(company)}
                    </div>
                    <div className="min-w-0">
                      <a
                        href={job.canonical_url}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate font-semibold text-[var(--rq-text)] hover:text-emerald-500 hover:underline"
                      >
                        {job.title}
                      </a>
                      <span className="mt-0.5 block truncate text-[10px] text-[var(--rq-muted)]">
                        {company}
                      </span>
                    </div>
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-3.5">
                  <Ir35Badge value={view.ir35} />
                </td>
                <td className="max-w-[145px] truncate px-3 py-3.5" title={view.location}>
                  {view.location}
                </td>
                <td className="px-3 py-3.5">{view.workplace}</td>
                <td className="px-3 py-3.5">{view.seniority}</td>
                <td className="max-w-[130px] truncate px-3 py-3.5" title={view.role}>
                  {view.role}
                </td>
                <td className="max-w-[120px] truncate px-3 py-3.5" title={view.source}>
                  {view.source}
                </td>
                <td className="px-3 py-3.5">
                  <Confidence value={view.confidence} />
                </td>
                <td className="whitespace-nowrap px-3 py-3.5">
                  {relativeTime(view.postedAt, now)}
                </td>
                <td className="whitespace-nowrap px-3 py-3.5">
                  <button
                    type="button"
                    className={`rounded-md border px-3 py-2 text-[10px] font-semibold ${duplicate ? "border-amber-500/65 text-amber-500" : "border-emerald-500/55 text-emerald-500"}`}
                  >
                    {status}
                  </button>
                </td>
                <td className="px-3 py-3.5">
                  <button
                    type="button"
                    aria-label={`More actions for ${job.title}`}
                    className="rounded px-2 py-1 text-lg leading-none text-[var(--rq-muted)] hover:bg-[var(--rq-hover-strong)]"
                  >
                    ⋮
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Pagination({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
}) {
  if (pages <= 1) return null;
  const candidates = [1, page - 1, page, page + 1, pages].filter(
    (value) => value >= 1 && value <= pages,
  );
  const visible = [...new Set(candidates)].sort((a, b) => a - b);
  return (
    <nav className="flex items-center gap-1.5" aria-label="Pagination">
      <button
        type="button"
        disabled={page === 1}
        onClick={() => onPage(page - 1)}
        className="rq-page"
      >
        ‹
      </button>
      {visible.map((number, index) => (
        <span key={number} className="contents">
          {index > 0 && number - visible[index - 1] > 1 && (
            <span className="px-1 text-[var(--rq-muted)]">…</span>
          )}
          <button
            type="button"
            onClick={() => onPage(number)}
            className={`rq-page ${page === number ? "rq-page-active" : ""}`}
          >
            {number}
          </button>
        </span>
      ))}
      <button
        type="button"
        disabled={page === pages}
        onClick={() => onPage(page + 1)}
        className="rq-page"
      >
        ›
      </button>
    </nav>
  );
}

export default function CockpitPrototype({
  queue,
  live,
  loadError,
  lastUpdatedAt,
  prototypes,
  onSelectPrototype,
}: Props) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<QueueFilter[]>([]);
  const [quick, setQuick] = useState<QuickFilterId[]>([]);
  const [sortMode, setSortMode] = useState<SortMode>("latest");
  const [page, setPage] = useState(1);
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const queueRows = useMemo(() => queue.filter(isTriageQueueJob), [queue]);
  const jobs = useMemo(() => queueRows.map((job) => toQueueJobView(job, now)), [queueRows, now]);
  const [savedViews, setSavedViews] = useState<QueueSavedView[]>(() => loadSavedViews(jobs));
  const filtered = useMemo(
    () => sortJobs(filterQueueJobs(jobs, query, filters, quick), sortMode),
    [jobs, query, filters, quick, sortMode],
  );

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const pageJobs = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const shortlistCount = queue.filter(isShortlistedJob).length;
  const duplicateCount = queueRows.filter(
    (job) => job.review_state === "duplicate_candidate" || job.duplicate_candidates.length > 0,
  ).length;
  const inReviewCount = queueRows.filter((job) => job.review_state === "ready_for_review").length;
  const savedCounts = useMemo(
    () =>
      new Map(
        savedViews.map((view) => [
          view.id,
          filterQueueJobs(jobs, view.query, view.filters, view.quick).length,
        ]),
      ),
    [jobs, savedViews],
  );

  useEffect(() => {
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(savedViews));
  }, [savedViews]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => setPage(1), [query, filters, quick, sortMode]);

  const saveView = () => {
    const name = window.prompt("Name this saved view");
    if (!name?.trim()) return;
    setSavedViews((current) => [
      ...current,
      { id: `saved-${Date.now()}`, name: name.trim(), query, filters, quick },
    ]);
  };

  const applyView = (view: QueueSavedView) => {
    setQuery(view.query);
    setFilters(view.filters);
    setQuick(view.quick);
    setPage(1);
  };

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePage = () => {
    setSelected((current) => {
      const next = new Set(current);
      const allSelected = pageJobs.every((job) => next.has(job.job.id));
      for (const job of pageJobs) {
        if (allSelected) next.delete(job.job.id);
        else next.add(job.job.id);
      }
      return next;
    });
  };

  const updatedLabel = lastUpdatedAt ? relativeTime(new Date(lastUpdatedAt), now) : null;
  const statCards = [
    {
      label: "Queue",
      value: queueRows.length,
      sub: "jobs awaiting review",
      kind: "queue" as const,
      primary: true,
    },
    {
      label: "In Review",
      value: inReviewCount,
      sub: "currently in review",
      kind: "review" as const,
    },
    { label: "Shortlisted", value: shortlistCount, sub: "shortlisted", kind: "shortlist" as const },
    {
      label: "Duplicate Flags",
      value: duplicateCount,
      sub: "duplicate flags",
      kind: "duplicate" as const,
    },
  ];

  return (
    <div
      className="rq-root min-h-[100dvh] bg-[var(--rq-bg)] text-[var(--rq-text)]"
      data-theme={theme}
    >
      <ReviewQueueSidebar
        queueCount={queueRows.length}
        shortlistCount={shortlistCount}
        duplicateCount={duplicateCount}
        savedViews={savedViews}
        savedCounts={savedCounts}
        prototypes={prototypes}
        onApplyView={applyView}
        onSaveView={saveView}
        onSelectPrototype={onSelectPrototype}
      />

      <main className="min-h-[100dvh] lg:ml-64">
        <div className="mx-auto max-w-[1540px] px-5 pb-10 pt-7 sm:px-7 lg:px-8">
          <header className="mb-6 flex items-start justify-between gap-4">
            <div>
              <p className="mb-2 text-[10px] text-[var(--rq-muted)] lg:hidden">
                Signal Cockpit · Review Queue
              </p>
              <h1 className="text-[27px] font-bold tracking-[-0.035em] text-[var(--rq-text)]">
                Review Queue
              </h1>
              <p className="mt-1 text-[12px] text-[var(--rq-muted)]">
                Review and manage job applications from your local job database.
              </p>
              <p
                className={`mt-1.5 text-[9px] ${loadError ? "text-rose-500" : "text-[var(--rq-faint)]"}`}
              >
                {loadError ??
                  (updatedLabel
                    ? `updated ${updatedLabel} · refreshes every minute`
                    : live
                      ? "loading latest queue…"
                      : "connecting to local API…")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setTheme((value) => (value === "light" ? "dark" : "light"))}
                aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
                className="grid h-9 w-9 place-items-center rounded-full border border-[var(--rq-border)] bg-[var(--rq-surface)] text-[var(--rq-text-soft)] hover:border-emerald-500/40 hover:text-emerald-500"
              >
                <ThemeIcon theme={theme} />
              </button>
              <div className="grid h-9 w-9 place-items-center rounded-full border border-[var(--rq-border)] bg-[var(--rq-surface)] text-[11px] font-semibold">
                AC
              </div>
              <span className="text-[var(--rq-muted)]">⌄</span>
            </div>
          </header>

          <section
            className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
            aria-label="Queue statistics"
          >
            {statCards.map((card) => (
              <article
                key={card.label}
                className={`rq-stat flex min-h-[124px] items-center justify-between rounded-xl border p-5 shadow-[var(--rq-shadow)] ${card.primary ? "rq-stat-primary" : "border-[var(--rq-border)] bg-[var(--rq-surface)]"}`}
              >
                <div>
                  <p
                    className={`text-[11px] font-semibold ${card.primary ? "text-emerald-400" : "text-[var(--rq-muted)]"}`}
                  >
                    {card.label}
                  </p>
                  <p className="mt-1 text-[29px] font-bold tracking-[-0.04em] tabular-nums">
                    {card.value}
                  </p>
                  <p
                    className={`mt-0.5 text-[10px] ${card.primary ? "text-slate-400" : "text-[var(--rq-muted)]"}`}
                  >
                    {card.sub}
                  </p>
                </div>
                <StatIcon kind={card.kind} />
              </article>
            ))}
          </section>

          <ReviewQueueFilters
            jobs={jobs}
            query={query}
            filters={filters}
            quick={quick}
            onQueryChange={setQuery}
            onFiltersChange={setFilters}
            onQuickChange={setQuick}
            onSaveView={saveView}
          />

          <div className="mb-3 mt-4 flex items-center justify-between gap-3">
            <span className="text-[10px] tabular-nums text-[var(--rq-muted)]">
              {filtered.length} matches
            </span>
            <label className="flex items-center gap-2 text-[10px] text-[var(--rq-text-soft)]">
              Sort by
              <select
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as SortMode)}
                className="rounded-lg border border-[var(--rq-border)] bg-[var(--rq-surface)] px-3 py-2 text-[10px] font-medium text-[var(--rq-text)] outline-none focus:border-emerald-500/50"
              >
                <option value="latest">Latest first</option>
                <option value="oldest">Oldest first</option>
                <option value="confidence">Confidence</option>
              </select>
            </label>
          </div>

          <section
            className="overflow-hidden rounded-xl border border-[var(--rq-border)] bg-[var(--rq-surface)] shadow-[var(--rq-shadow)]"
            aria-label="Review queue results"
          >
            {pageJobs.length > 0 ? (
              <JobTable
                jobs={pageJobs}
                now={now}
                selected={selected}
                onToggle={toggleSelected}
                onTogglePage={togglePage}
              />
            ) : (
              <div className="grid min-h-64 place-items-center px-6 text-center">
                <div>
                  <p className="text-sm font-semibold text-[var(--rq-text)]">No matching jobs</p>
                  <p className="mt-1 text-xs text-[var(--rq-muted)]">
                    Remove a filter or broaden the search.
                  </p>
                </div>
              </div>
            )}
          </section>

          <footer className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[11px] text-[var(--rq-muted)]">
              Showing {filtered.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1} to{" "}
              {Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length} results
            </p>
            <Pagination page={safePage} pages={pages} onPage={setPage} />
          </footer>
        </div>
      </main>
    </div>
  );
}
