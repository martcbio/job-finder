import type { ReviewQueueRow } from "../types";
import { formatRelative, formatState } from "../mockData";
import { DupWarning, Shell, StateBadge } from "../components/shared";

interface Props {
  queue: ReviewQueueRow[];
}

export default function EditorialPrototype({ queue }: Props) {
  const featured = queue[0];
  const rest = queue.slice(1, 5);

  return (
    <Shell
      title="Editorial Ledger"
      subtitle="Read jobs like a magazine — evidence first"
      accent="#d4a574"
    >
      <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr]">
        <article className="border-l-2 border-amber-600/40 pl-8">
          <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-amber-600/80">
            Featured role
          </p>
          <h2 className="mt-4 font-[family-name:var(--font-editorial)] text-4xl italic leading-[1.1] text-white md:text-5xl">
            {featured.title}
          </h2>
          <p className="mt-4 text-xl text-amber-200/70">{featured.company_hint}</p>
          <div className="mt-6 flex flex-wrap gap-4">
            <StateBadge state={featured.review_state} />
            <span className="text-sm text-zinc-500">{formatRelative(featured.last_seen_at)}</span>
          </div>
          <p className="mt-8 max-w-[55ch] text-base leading-relaxed text-zinc-400">
            {featured.description_sample}
          </p>
          <div className="mt-8 grid grid-cols-2 gap-6 border-t border-zinc-800 pt-6 text-sm">
            <div>
              <p className="font-mono text-[10px] uppercase text-zinc-600">Category</p>
              <p className="mt-1 text-zinc-300">{formatState(featured.category)}</p>
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase text-zinc-600">RAG focus</p>
              <p className="mt-1 text-zinc-300">{featured.rag_focus}</p>
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase text-zinc-600">Sources</p>
              <p className="mt-1 text-zinc-300">{featured.source_labels.join(", ")}</p>
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase text-zinc-600">Confidence</p>
              <p className="mt-1 font-mono text-zinc-300">
                {featured.classification_confidence
                  ? `${Math.round(Number(featured.classification_confidence) * 100)}%`
                  : "—"}
              </p>
            </div>
          </div>
          <div className="mt-6">
            <DupWarning job={featured} />
          </div>
        </article>

        <aside>
          <p className="mb-6 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">
            Also in queue
          </p>
          <div className="space-y-8">
            {rest.map((job, i) => (
              <div
                key={job.id}
                className="group cursor-pointer border-b border-zinc-800/80 pb-6 transition-colors hover:border-amber-600/30"
              >
                <div className="flex items-baseline gap-4">
                  <span className="font-[family-name:var(--font-editorial)] text-3xl italic text-zinc-700 transition-colors group-hover:text-amber-700/60">
                    {String(i + 2).padStart(2, "0")}
                  </span>
                  <div>
                    <h3 className="font-[family-name:var(--font-dm)] text-lg font-medium text-zinc-200">
                      {job.title}
                    </h3>
                    <p className="text-sm text-zinc-500">
                      {job.company_hint} · {formatRelative(job.last_seen_at)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </Shell>
  );
}
