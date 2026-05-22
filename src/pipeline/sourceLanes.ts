export const SOURCE_LANE_IDS = ["source_search", "curated_ats", "jobspy", "jobserve"] as const;

export type SourceLaneId = (typeof SOURCE_LANE_IDS)[number];

export interface SourceLaneSpec {
  id: SourceLaneId;
  label: string;
  status: "implemented" | "planned";
  description: string;
  outputKind: "candidate_urls" | "normalized_jobs";
}

export const SOURCE_LANES: readonly SourceLaneSpec[] = [
  {
    id: "source_search",
    label: "Source search",
    status: "implemented",
    description: "Current Brian-style source search fanout over configured sites.",
    outputKind: "candidate_urls",
  },
  {
    id: "curated_ats",
    label: "Curated ATS endpoints",
    status: "planned",
    description: "Direct source-specific ATS/public endpoint adapters where available.",
    outputKind: "candidate_urls",
  },
  {
    id: "jobspy",
    label: "JobSpy aggregators",
    status: "implemented",
    description: "Import normalized JobSpy broad-board snapshots without the old UI.",
    outputKind: "normalized_jobs",
  },
  {
    id: "jobserve",
    label: "JobServe",
    status: "planned",
    description: "Old-repo UK/contract-market lane for additional non-US opportunities.",
    outputKind: "normalized_jobs",
  },
] as const;

export const DEFAULT_SOURCE_LANES: readonly SourceLaneId[] = ["source_search"] as const;

export function isSourceLaneId(value: string): value is SourceLaneId {
  return (SOURCE_LANE_IDS as readonly string[]).includes(value);
}

export function parseSourceLaneIds(
  values: readonly string[],
  fallback: readonly SourceLaneId[] = DEFAULT_SOURCE_LANES,
): SourceLaneId[] {
  const input = values.length > 0 ? values : fallback;
  const lanes: SourceLaneId[] = [];

  for (const value of input) {
    if (!isSourceLaneId(value)) {
      throw new Error(`Unsupported source lane "${value}"`);
    }
    lanes.push(value);
  }

  return [...new Set(lanes)];
}

export function implementedSourceLaneIds(lanes: readonly SourceLaneId[]): SourceLaneId[] {
  return lanes.filter((lane) => sourceLaneById(lane).status === "implemented");
}

export function plannedSourceLaneIds(lanes: readonly SourceLaneId[]): SourceLaneId[] {
  return lanes.filter((lane) => sourceLaneById(lane).status === "planned");
}

export function sourceLaneById(id: SourceLaneId): SourceLaneSpec {
  const lane = SOURCE_LANES.find((item) => item.id === id);
  if (!lane) throw new Error(`Source lane registry is missing "${id}"`);
  return lane;
}
