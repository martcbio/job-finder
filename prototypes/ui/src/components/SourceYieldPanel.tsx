import type { SourceCatalogEntry } from "../sourceFilters";
import { isEvergreenSource } from "../sourceFilters";

interface Props {
  catalog: SourceCatalogEntry[];
  enabledSourceIds: string[];
  refreshTargets: SourceCatalogEntry[];
  onToggle: (sourceId: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  disabled?: boolean;
}

function successRate(rate: number): number {
  return Math.round(rate * 100);
}

export function SourceYieldPanel({
  catalog,
  enabledSourceIds,
  refreshTargets,
  onToggle,
  onSelectAll,
  onDeselectAll,
  disabled = false,
}: Props) {
  const enabled = new Set(enabledSourceIds);
  const allSelected = catalog.length > 0 && enabled.size === catalog.length;
  const noneSelected = enabled.size === 0;

  const refreshable = catalog.filter((s) => s.refreshable);
  const legacyOnly = catalog.filter((s) => !s.refreshable);

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h2 className="font-mono text-xs uppercase tracking-widest text-zinc-500">
          Sources
        </h2>
        {catalog.length > 0 && (
          <span className="font-mono text-[10px] tabular-nums text-zinc-600">
            {enabled.size}/{catalog.length}
          </span>
        )}
      </div>
      <p className="mb-2 text-[10px] leading-relaxed text-zinc-600">
        Checked sources filter the queue and run on <span className="text-zinc-400">Update queue</span>
        (live feeds + ATS search). Unchecked sources are hidden.
      </p>
      {refreshable.length > 0 && (
        <p className="mb-2 font-mono text-[10px] text-emerald-400/90">
          Will refresh:{" "}
          {refreshTargets.length > 0
            ? refreshTargets.map((s) => s.id).join(", ")
            : "none (check sources below)"}
        </p>
      )}
      {catalog.length > 0 && (
        <div className="mb-3 flex gap-3 font-mono text-[10px]">
          <button
            type="button"
            disabled={disabled || allSelected}
            onClick={onSelectAll}
            className="text-zinc-500 transition hover:text-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Select all
          </button>
          <span className="text-zinc-800">·</span>
          <button
            type="button"
            disabled={disabled || noneSelected}
            onClick={onDeselectAll}
            className="text-zinc-500 transition hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Deselect all
          </button>
        </div>
      )}
      {catalog.length === 0 ? (
        <p className="text-xs text-zinc-600">No source history yet.</p>
      ) : noneSelected ? (
        <p className="text-xs text-zinc-500">No sources selected — choose Select all or check sources below.</p>
      ) : (
        <div className="max-h-[min(60vh,520px)] space-y-3 overflow-y-auto pr-1">
          {refreshable.length > 0 && (
            <ul>
              {refreshable.map((source) => (
                <SourceRow
                  key={source.id}
                  source={source}
                  checked={enabled.has(source.id)}
                  disabled={disabled}
                  onToggle={() => onToggle(source.id)}
                  willRefresh={refreshTargets.some((t) => t.id === source.id)}
                />
              ))}
            </ul>
          )}
          {legacyOnly.length > 0 && (
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-600">
                In database only
              </p>
              <p className="mb-2 text-[10px] text-zinc-600">
                Historical rows — filter queue only, not refreshed by Update queue.
              </p>
              <ul>
                {legacyOnly.map((source) => (
                  <SourceRow
                    key={source.id}
                    source={source}
                    checked={enabled.has(source.id)}
                    disabled={disabled}
                    onToggle={() => onToggle(source.id)}
                    willRefresh={false}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SourceRow({
  source,
  checked,
  disabled,
  onToggle,
  willRefresh,
}: {
  source: SourceCatalogEntry;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  willRefresh: boolean;
}) {
  const inputId = `source-${source.id}`;
  return (
    <li className="border-t border-zinc-800/80 first:border-t-0">
      <label
        htmlFor={inputId}
        className={`flex cursor-pointer items-start gap-2.5 py-2 text-xs transition ${
          disabled ? "cursor-not-allowed opacity-50" : "hover:bg-white/[0.02]"
        }`}
      >
        <input
          id={inputId}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-zinc-600 bg-zinc-900 text-emerald-600 focus:ring-emerald-500/40"
        />
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-zinc-300">{source.id}</span>
          <span className="text-[10px] text-zinc-600">
            {willRefresh ? "runs on Update queue" : "queue filter only"}
            {source.evergreen || isEvergreenSource(source.id) ? " · evergreen" : ""}
          </span>
        </span>
        <span className="shrink-0 font-mono tabular-nums text-emerald-400/90">
          {successRate(source.successRate)}%
        </span>
      </label>
    </li>
  );
}
