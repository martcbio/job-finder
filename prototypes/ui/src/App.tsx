import { useState } from "react";
import { LiveBanner } from "./components/shared";
import { PROTOTYPES } from "./mockData";
import BentoCommandPrototype from "./prototypes/BentoCommandPrototype";
import CockpitPrototype from "./prototypes/CockpitPrototype";
import SwipeTriagePrototype from "./prototypes/SwipeTriagePrototype";
import TimelinePrototype from "./prototypes/TimelinePrototype";
import type { PrototypeId } from "./types";
import { useJobFinderData } from "./useJobFinderData";

export default function App() {
  const [active, setActive] = useState<PrototypeId>("cockpit");
  const data = useJobFinderData();

  const current = PROTOTYPES.find((p) => p.id === active)!;

  return (
    <div className="grain min-h-[100dvh]">
      <div className="sticky top-0 z-40 border-b border-white/5 bg-[#0c0d0f]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between md:px-6">
          <div className="flex items-center gap-3">
            <span className="font-[family-name:var(--font-display)] text-sm font-bold tracking-tight text-white">
              Job Finder
            </span>
            <span className="hidden text-zinc-700 md:inline">/</span>
            <span className="hidden text-xs text-zinc-500 md:inline">Prototype Gallery</span>
            <LiveBanner
              live={data.live}
              loading={data.loading || data.grabbing || data.refreshing}
            />
          </div>

          <nav className="flex gap-1 overflow-x-auto pb-1 md:pb-0">
            {PROTOTYPES.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setActive(p.id)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition active:scale-[0.97] ${
                  active === p.id
                    ? "text-white"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
                style={
                  active === p.id
                    ? {
                        background: `${p.accent}22`,
                        border: `1px solid ${p.accent}44`,
                        color: p.accent,
                      }
                    : { border: "1px solid transparent" }
                }
              >
                {p.name}
              </button>
            ))}
          </nav>

        </div>
      </div>

      <div key={active}>
        {active === "cockpit" && (
          <CockpitPrototype
            queue={data.queue}
            sourceHealth={data.sourceHealth}
            pipelineRuns={data.pipelineRuns}
            lastRefreshRun={data.lastRefreshRun}
            lastFastRefresh={data.lastFastRefresh}
            live={data.live}
            grabbing={data.grabbing}
            refreshing={data.refreshing}
            refreshError={data.refreshError}
            refreshFeedback={data.refreshFeedback}
            lastGrabbedAt={data.lastGrabbedAt}
            onRefresh={() => void data.grabLatest()}
            onFindNewJobs={() => void data.runFastRefresh()}
          />
        )}
        {active === "swipe" && <SwipeTriagePrototype queue={data.queue} />}
        {active === "bento" && (
          <BentoCommandPrototype
            queue={data.queue}
            sourceHealth={data.sourceHealth}
            pipelineRuns={data.pipelineRuns}
          />
        )}
        {active === "timeline" && (
          <TimelinePrototype
            queue={data.queue}
            sourceHealth={data.sourceHealth}
            pipelineRuns={data.pipelineRuns}
          />
        )}
      </div>

      <footer className="border-t border-white/5 px-6 py-4 text-center">
        <p className="text-[11px] text-zinc-600">
          Branch <code className="text-zinc-500">cursor-party-ui</code> ·{" "}
          <code className="text-zinc-500">https://job-finder.test:8443</code> ·{" "}
          {current.name} accent {current.accent}
        </p>
      </footer>
    </div>
  );
}
