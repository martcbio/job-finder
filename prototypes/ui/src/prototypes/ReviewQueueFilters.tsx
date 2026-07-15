import { useEffect, useMemo, useRef, useState } from "react";
import {
  FACET_LABELS,
  FACETS,
  facetCounts,
  filterQueueJobs,
  type QueueFilter,
  type QueueJobView,
  type QuickFilterId,
} from "./reviewQueueModel";

interface Props {
  jobs: QueueJobView[];
  query: string;
  filters: QueueFilter[];
  quick: QuickFilterId[];
  onQueryChange: (query: string) => void;
  onFiltersChange: (filters: QueueFilter[]) => void;
  onQuickChange: (quick: QuickFilterId[]) => void;
  onSaveView: () => void;
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </svg>
  );
}

function FacetMenu({
  jobs,
  query,
  facetIndex,
  valueIndex,
  activePane,
  onFacetIndex,
  onValueIndex,
  onActivePane,
  onAdd,
  onSearchAll,
}: {
  jobs: QueueJobView[];
  query: string;
  facetIndex: number;
  valueIndex: number;
  activePane: "facets" | "values";
  onFacetIndex: (index: number) => void;
  onValueIndex: (index: number) => void;
  onActivePane: (pane: "facets" | "values") => void;
  onAdd: (filter: QueueFilter) => void;
  onSearchAll: () => void;
}) {
  const facet = FACETS[facetIndex];
  const allValues = useMemo(() => facetCounts(jobs, facet.id), [jobs, facet.id]);
  const normalizedQuery = query.trim().toLowerCase();
  const values = useMemo(() => {
    if (!normalizedQuery || facet.label.toLowerCase().includes(normalizedQuery)) return allValues;
    const matched = allValues.filter(([value]) => value.toLowerCase().includes(normalizedQuery));
    return matched.length > 0 ? matched : allValues;
  }, [allValues, facet.label, normalizedQuery]);

  return (
    <div
      id="review-queue-facet-menu"
      className="rq-menu absolute left-0 top-[calc(100%+8px)] z-50 grid w-[min(620px,calc(100vw-48px))] grid-cols-[255px_1fr] overflow-hidden rounded-xl border border-[var(--rq-border-strong)] bg-[var(--rq-surface)] shadow-[0_22px_60px_rgba(0,0,0,.24)]"
    >
      <div className="border-r border-[var(--rq-border)] p-2">
        <p className="px-2 pb-1.5 pt-1 text-[9px] font-bold uppercase tracking-[0.13em] text-[var(--rq-muted)]">
          Suggestions
        </p>
        <button
          type="button"
          onClick={onSearchAll}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] text-[var(--rq-text-soft)] hover:bg-[var(--rq-hover)]"
        >
          <SearchIcon />
          <span className="font-medium text-[var(--rq-text)]">{query || "Search"}</span>
          <span className="truncate text-[var(--rq-muted)]">search all fields</span>
        </button>
        <div className="my-1 border-t border-[var(--rq-border)]" />
        <p className="px-2 pb-1.5 pt-2 text-[9px] font-bold uppercase tracking-[0.13em] text-[var(--rq-muted)]">
          Facets
        </p>
        {FACETS.map((item, index) => (
          <button
            key={item.id}
            type="button"
            onMouseEnter={() => {
              onFacetIndex(index);
              onValueIndex(0);
            }}
            onClick={() => {
              onFacetIndex(index);
              onValueIndex(0);
              onActivePane("values");
            }}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-[7px] text-left text-[11px] ${
              facetIndex === index
                ? "bg-[var(--rq-hover-strong)] font-medium text-[var(--rq-text)]"
                : "text-[var(--rq-text-soft)] hover:bg-[var(--rq-hover)]"
            } ${activePane === "facets" && facetIndex === index ? "ring-1 ring-inset ring-emerald-500/25" : ""}`}
          >
            <span className="grid h-4 w-4 place-items-center rounded-full border border-current text-[8px] opacity-70">
              {index + 1}
            </span>
            {item.label}
          </button>
        ))}
      </div>

      <div className="min-h-[392px] p-3">
        <p className="px-1 pb-2 text-[9px] font-bold uppercase tracking-[0.13em] text-[var(--rq-muted)]">
          {facet.label}
        </p>
        {values.length === 0 ? (
          <p className="px-1 py-6 text-xs text-[var(--rq-muted)]">No values in this queue.</p>
        ) : (
          <div className="space-y-0.5">
            {values.slice(0, 8).map(([value, count], index) => (
              <button
                key={value}
                type="button"
                onMouseEnter={() => onValueIndex(index)}
                onClick={() => onAdd({ facet: facet.id, value })}
                className={`flex w-full items-center justify-between rounded-md px-1.5 py-2 text-left text-[12px] ${
                  activePane === "values" && valueIndex === index
                    ? "bg-[var(--rq-hover-strong)] text-[var(--rq-text)] ring-1 ring-inset ring-emerald-500/20"
                    : "text-[var(--rq-text-soft)] hover:bg-[var(--rq-hover)]"
                }`}
              >
                <span className="truncate pr-4">{value}</span>
                <span className="tabular-nums text-[var(--rq-muted)]">{count}</span>
              </button>
            ))}
          </div>
        )}
        <div className="mt-2 border-t border-[var(--rq-border)] pt-2">
          <button
            type="button"
            className="flex w-full items-center justify-between px-1.5 py-2 text-left text-[11px] font-medium text-[var(--rq-text-soft)]"
          >
            View all {facet.label.toLowerCase()} <span>›</span>
          </button>
        </div>
      </div>
    </div>
  );
}

const QUICK_FILTERS: Array<{ id: QuickFilterId; label: string }> = [
  { id: "non_it", label: "Non-IT" },
  { id: "contract", label: "Contract" },
  { id: "permanent", label: "Permanent" },
  { id: "outside", label: "Outside IR35" },
  { id: "inside", label: "Inside IR35" },
  { id: "remote", label: "Remote" },
  { id: "onsite", label: "Onsite" },
  { id: "hybrid", label: "Hybrid" },
  { id: "confidence", label: "Conf. 80%+" },
  { id: "posted", label: "Posted 7d" },
];

export default function ReviewQueueFilters({
  jobs,
  query,
  filters,
  quick,
  onQueryChange,
  onFiltersChange,
  onQuickChange,
  onSaveView,
}: Props) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [facetIndex, setFacetIndex] = useState(0);
  const [valueIndex, setValueIndex] = useState(0);
  const [activePane, setActivePane] = useState<"facets" | "values">("facets");
  const shellRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onGlobalKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: MouseEvent) => {
      if (!shellRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onGlobalKey);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onGlobalKey);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, []);

  const currentValues = facetCounts(jobs, FACETS[facetIndex].id);
  const quickCounts = useMemo(
    () =>
      new Map(
        QUICK_FILTERS.map((item) => [item.id, filterQueueJobs(jobs, "", [], [item.id]).length]),
      ),
    [jobs],
  );
  const defaultVisibleCount = useMemo(() => filterQueueJobs(jobs, "", [], []).length, [jobs]);

  const addFilter = (filter: QueueFilter) => {
    if (
      !filters.some((current) => current.facet === filter.facet && current.value === filter.value)
    ) {
      onFiltersChange([...filters, filter]);
    }
    onQueryChange("");
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && ["ArrowDown", "ArrowUp", "ArrowRight"].includes(event.key)) setOpen(true);
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setActivePane("values");
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setActivePane("facets");
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (activePane === "facets") {
        setFacetIndex((index) => (index + direction + FACETS.length) % FACETS.length);
        setValueIndex(0);
      } else {
        setValueIndex(
          (index) =>
            (index + direction + Math.max(currentValues.length, 1)) %
            Math.max(currentValues.length, 1),
        );
      }
      return;
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      if (activePane === "facets") {
        setActivePane("values");
      } else {
        const selected = currentValues[valueIndex];
        if (selected) addFilter({ facet: FACETS[facetIndex].id, value: selected[0] });
      }
    }
  };

  const toggleQuick = (id: QuickFilterId) => {
    onQuickChange(quick.includes(id) ? quick.filter((item) => item !== id) : [...quick, id]);
  };

  return (
    <div
      ref={shellRef}
      className="relative rounded-xl border border-[var(--rq-border)] bg-[var(--rq-surface)] shadow-[var(--rq-shadow)]"
    >
      <div className="flex min-h-[70px] flex-wrap items-center gap-2.5 px-4 py-3.5">
        {!collapsed && (
          <div className="relative min-w-[280px] flex-1 basis-[360px]">
            <span className="pointer-events-none absolute left-3 top-3 z-10 text-[var(--rq-muted)]">
              <SearchIcon />
            </span>
            <input
              ref={inputRef}
              value={query}
              onFocus={() => setOpen(true)}
              onChange={(event) => {
                const next = event.target.value;
                onQueryChange(next);
                setOpen(true);
                const matchingFacet = FACETS.findIndex((facet) =>
                  facet.label.toLowerCase().includes(next.toLowerCase().trim()),
                );
                if (next.trim() && matchingFacet >= 0) setFacetIndex(matchingFacet);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search by job title, company, or keyword…"
              role="combobox"
              aria-label="Search queue and add facet filters"
              aria-expanded={open}
              aria-controls="review-queue-facet-menu"
              className="absolute inset-0 h-10 w-full rounded-lg border border-[var(--rq-border-strong)] bg-[var(--rq-input)] py-2 pl-10 pr-12 text-[12px] text-[var(--rq-text)] outline-none transition placeholder:text-[var(--rq-muted)] focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/10"
            />
            <kbd className="pointer-events-none absolute right-3 top-[11px] text-[10px] text-[var(--rq-muted)]">
              ⌘K
            </kbd>
            <div className="h-10" />
            {open && (
              <FacetMenu
                jobs={jobs}
                query={query}
                facetIndex={facetIndex}
                valueIndex={valueIndex}
                activePane={activePane}
                onFacetIndex={setFacetIndex}
                onValueIndex={setValueIndex}
                onActivePane={setActivePane}
                onAdd={addFilter}
                onSearchAll={() => setOpen(false)}
              />
            )}
          </div>
        )}

        {!collapsed &&
          filters.map((filter) => (
            <button
              key={`${filter.facet}:${filter.value}`}
              type="button"
              onClick={() => onFiltersChange(filters.filter((item) => item !== filter))}
              className="h-9 rounded-lg border border-[var(--rq-border)] bg-[var(--rq-chip)] px-3 text-[11px] font-medium text-[var(--rq-text-soft)] transition hover:border-rose-400/40"
            >
              {FACET_LABELS[filter.facet]}: {filter.value}{" "}
              <span className="ml-1 text-[var(--rq-muted)]">×</span>
            </button>
          ))}

        {!collapsed && (
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              inputRef.current?.focus();
            }}
            className="h-9 px-2 text-[11px] font-medium text-[var(--rq-text-soft)] hover:text-emerald-500"
          >
            ＋ Add filter
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onSaveView}
            className="h-10 rounded-lg border border-[var(--rq-border)] px-4 text-[11px] font-semibold text-[var(--rq-text-soft)] hover:border-emerald-500/40 hover:text-emerald-500"
          >
            ♧ <span className="ml-1">Save view</span>
          </button>
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="h-10 rounded-lg border border-[var(--rq-border)] px-4 text-[11px] font-medium text-[var(--rq-text-soft)]"
          >
            {collapsed ? "Show filters" : "Hide filters"}{" "}
            <span className="ml-1">{collapsed ? "⌄" : "⌃"}</span>
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--rq-border)] px-4 py-3">
          <button
            type="button"
            onClick={() => onQuickChange([])}
            className={`rq-quick ${quick.length === 0 ? "rq-quick-active" : ""}`}
          >
            All <span>({defaultVisibleCount})</span>
          </button>
          {QUICK_FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => toggleQuick(item.id)}
              title={item.id === "non_it" ? "Non-IT jobs are hidden by default" : undefined}
              className={`rq-quick ${quick.includes(item.id) ? "rq-quick-active" : ""}`}
            >
              {item.label} <span>({quickCounts.get(item.id) ?? 0})</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
