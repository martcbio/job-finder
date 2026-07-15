import type { SourceCatalogEntry } from "../sourceFilters";

interface Props {
  catalog: SourceCatalogEntry[];
  enabledSourceIds: string[];
  onToggle: (sourceId: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}

function successRate(rate: number): number {
  return Math.round(rate * 100);
}

export function SourceYieldPanel({
  catalog,
  enabledSourceIds,
  onToggle,
  onSelectAll,
  onDeselectAll,
}: Props) {
  const enabled = new Set(enabledSourceIds);
  const allSelected = catalog.length > 0 && enabled.size === catalog.length;
  const noneSelected = enabled.size === 0;

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
        Checked sources are shown in the review queue. Unchecked sources are hidden.
      </p>
      {catalog.length > 0 && (
        <div className="mb-3 flex gap-3 font-mono text-[10px]">
          <button
            type="button"
            disabled={allSelected}
            onClick={onSelectAll}
            className="text-zinc-500 transition hover:text-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Select all
          </button>
          <span className="text-zinc-800">·</span>
          <button
            type="button"
            disabled={noneSelected}
            onClick={onDeselectAll}
            className="text-zinc-500 transition hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Deselect all
          </button>
        </div>
      )}
      {catalog.length === 0 ? (
        <p className="text-xs text-zinc-600">No source history yet.</p>
      ) : (
        <div className="max-h-[min(60vh,520px)] overflow-y-auto pr-1">
          <ul>
            {catalog.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                checked={enabled.has(source.id)}
                onToggle={() => onToggle(source.id)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SourceRow({
  source,
  checked,
  onToggle,
}: {
  source: SourceCatalogEntry;
  checked: boolean;
  onToggle: () => void;
}) {
  const inputId = `source-${source.id}`;
  return (
    <li className="border-t border-zinc-800/80 first:border-t-0">
      <label
        htmlFor={inputId}
        className="flex cursor-pointer items-start gap-2.5 py-2 text-xs transition hover:bg-white/[0.02]"
      >
        <input
          id={inputId}
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-zinc-600 bg-zinc-900 text-emerald-600 focus:ring-emerald-500/40"
        />
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-zinc-300">{source.id}</span>
          <span className="text-[10px] text-zinc-600">queue filter</span>
        </span>
        <span className="shrink-0 font-mono tabular-nums text-emerald-400/90">
          {successRate(source.successRate)}%
        </span>
      </label>
    </li>
  );
}
