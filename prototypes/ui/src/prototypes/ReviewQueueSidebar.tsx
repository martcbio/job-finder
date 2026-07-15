import { useState } from "react";
import type { PrototypeId, PrototypeInfo } from "../types";
import type { QueueSavedView } from "./reviewQueueModel";

type IconName =
  | "overview"
  | "queue"
  | "shortlist"
  | "duplicates"
  | "analytics"
  | "saved"
  | "settings"
  | "help";

const ICON_PATHS: Record<IconName, string> = {
  overview: "M3 11.5 12 4l9 7.5M5.5 10v9h13v-9M9.5 19v-5h5v5",
  queue: "M8 4h8M9 3v3m6-3v3M6 5.5h12v15H6zM9 10h6m-6 4h6m-6 4h4",
  shortlist: "m12 3 2.7 5.5 6 .9-4.4 4.3 1 6.1-5.3-2.9-5.3 2.9 1-6.1-4.4-4.3 6-.9z",
  duplicates: "M4 7h10v12H4zM10 4h10v12h-3M7 10h4m-4 4h4",
  analytics: "M5 20V11m7 9V4m7 16v-6",
  saved: "M6 4.5h12v16l-6-3.5-6 3.5z",
  settings:
    "M12 8.5A3.5 3.5 0 1 0 12 15a3.5 3.5 0 0 0 0-6.5ZM19 12l2-1-2-3-2 .2-1.2-1.7.6-2.1-3.4-1.2-1.4 1.5.2 2.1L7 8.2 5 8 3 11l2 1-2 1 2 3 2-.2 1.2 1.7-.6 2.1 3.4 1.2 1.4-1.5-.2-2.1 1.8-1.2 2 .2 2-3-2-1z",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-2.4-12a2.5 2.5 0 1 1 3.8 2.1c-.9.6-1.4 1.1-1.4 2.4m0 3h.01",
};

function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-3 px-3 py-1">
      <svg aria-hidden="true" viewBox="0 0 30 24" className="h-7 w-8 text-[#28df82]">
        <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M3 13v-3" />
          <path d="M8 18V6" />
          <path d="M13 21V3" />
          <path d="M18 17V7" />
          <path d="M23 14v-4" />
          <path d="M28 12v-1" />
        </g>
      </svg>
      <span className="text-[17px] font-semibold tracking-[-0.025em] text-white">
        Signal Cockpit
      </span>
    </div>
  );
}

interface Props {
  queueCount: number;
  shortlistCount: number;
  duplicateCount: number;
  savedViews: QueueSavedView[];
  savedCounts: Map<string, number>;
  prototypes: readonly PrototypeInfo[];
  onApplyView: (view: QueueSavedView) => void;
  onSaveView: () => void;
  onSelectPrototype: (id: PrototypeId) => void;
}

export default function ReviewQueueSidebar({
  queueCount,
  shortlistCount,
  duplicateCount,
  savedViews,
  savedCounts,
  prototypes,
  onApplyView,
  onSaveView,
  onSelectPrototype,
}: Props) {
  const [showAllViews, setShowAllViews] = useState(false);
  const nav = [
    { label: "Overview", icon: "overview" as const },
    { label: "Review Queue", icon: "queue" as const, count: queueCount, active: true },
    { label: "Shortlist", icon: "shortlist" as const, count: shortlistCount },
    { label: "Duplicates", icon: "duplicates" as const, count: duplicateCount },
    { label: "Analytics", icon: "analytics" as const },
  ];

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-white/10 bg-[#07131d] text-[#aab5c0] lg:flex">
      <div className="px-4 pb-5 pt-6">
        <Brand />
      </div>

      <nav className="space-y-1 px-3" aria-label="Signal Cockpit">
        {nav.map((item) => (
          <button
            key={item.label}
            type="button"
            disabled={!item.active}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] transition ${
              item.active
                ? "bg-emerald-400/10 font-semibold text-white ring-1 ring-inset ring-emerald-400/5"
                : "cursor-default text-[#aab5c0]"
            }`}
          >
            <Icon
              name={item.icon}
              className={item.active ? "h-[18px] w-[18px] text-[#35df87]" : "h-[18px] w-[18px]"}
            />
            <span>{item.label}</span>
            {item.count !== undefined && (
              <span
                className={`ml-auto rounded-md px-2 py-0.5 text-[11px] tabular-nums ${item.active ? "bg-emerald-400/10 text-emerald-200" : "bg-white/7 text-[#b9c2cb]"}`}
              >
                {item.count}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="mx-5 mt-7 border-t border-white/10 pt-5">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#71808d]">
            Saved views
          </p>
          <button
            type="button"
            onClick={onSaveView}
            aria-label="Save current filters as a view"
            className="grid h-7 w-7 place-items-center rounded-md border border-white/10 text-lg leading-none text-[#b5c0c9] transition hover:border-emerald-400/30 hover:text-emerald-300"
          >
            +
          </button>
        </div>
        <div className="max-h-52 space-y-0.5 overflow-y-auto">
          {(showAllViews ? savedViews : savedViews.slice(0, 5)).map((view) => (
            <button
              key={view.id}
              type="button"
              onClick={() => onApplyView(view)}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-2 text-left text-[12px] text-[#b5c0c9] transition hover:bg-white/5 hover:text-white"
            >
              <Icon name="saved" className="h-3.5 w-3.5 text-[#7f8d99]" />
              <span className="min-w-0 flex-1 truncate">{view.name}</span>
              <span className="text-[11px] tabular-nums text-[#82909c]">
                {savedCounts.get(view.id) ?? 0}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowAllViews((value) => !value)}
          className="mt-1 px-1.5 py-2 text-[11px] text-[#8f9ba6] hover:text-white"
        >
          {showAllViews ? "Show fewer views" : "View all saved views"}
        </button>
      </div>

      <div className="mt-auto px-5 pb-5">
        <div className="space-y-1 border-b border-white/10 pb-4">
          <button
            type="button"
            disabled
            className="flex w-full cursor-default items-center gap-3 py-2 text-[12px]"
          >
            <Icon name="settings" className="h-[18px] w-[18px]" /> Settings
          </button>
          <button
            type="button"
            disabled
            className="flex w-full cursor-default items-center gap-3 py-2 text-[12px]"
          >
            <Icon name="help" className="h-[18px] w-[18px]" /> Help &amp; feedback
          </button>
        </div>

        <label
          className="mt-4 block text-[9px] uppercase tracking-[0.14em] text-[#60707c]"
          htmlFor="prototype-gallery"
        >
          Prototype gallery
        </label>
        <select
          id="prototype-gallery"
          value="cockpit"
          onChange={(event) => onSelectPrototype(event.target.value as PrototypeId)}
          className="mt-1.5 w-full rounded-md border border-white/10 bg-[#0b1924] px-2.5 py-2 text-[11px] text-[#b8c2cb] outline-none focus:border-emerald-400/40"
        >
          {prototypes.map((prototype) => (
            <option key={prototype.id} value={prototype.id}>
              {prototype.name}
            </option>
          ))}
        </select>

        <div className="mt-4 flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-[#172733] text-xs font-semibold text-white">
            AC
          </div>
          <div className="min-w-0">
            <p className="truncate text-[12px] font-semibold text-white">Alex Carter</p>
            <p className="truncate text-[10px] text-[#70808c]">Local workspace</p>
          </div>
          <span className="ml-auto text-[#71808d]">⌄</span>
        </div>
      </div>
    </aside>
  );
}
