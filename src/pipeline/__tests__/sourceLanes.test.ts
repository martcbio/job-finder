import { describe, expect, test } from "bun:test";
import {
  implementedSourceLaneIds,
  parseSourceLaneIds,
  plannedSourceLaneIds,
  SOURCE_LANES,
  sourceLaneById,
} from "../sourceLanes";

describe("source lanes", () => {
  test("keeps source_search as the default lane and marks normalized imports executable", () => {
    expect(parseSourceLaneIds([])).toEqual(["source_search"]);
    expect(sourceLaneById("source_search").status).toBe("implemented");
    expect(sourceLaneById("jobspy").status).toBe("implemented");
    expect(sourceLaneById("jobserve").status).toBe("implemented");
    expect(implementedSourceLaneIds(["source_search", "jobspy", "jobserve"])).toEqual([
      "source_search",
      "jobspy",
      "jobserve",
    ]);
  });

  test("tracks implemented and planned lane status explicitly", () => {
    expect(SOURCE_LANES.map((lane) => lane.id)).toEqual([
      "source_search",
      "curated_ats",
      "jobspy",
      "jobserve",
    ]);
    expect(plannedSourceLaneIds(["source_search", "curated_ats", "jobserve"])).toEqual([
      "curated_ats",
    ]);
  });

  test("deduplicates lanes and rejects unsupported values", () => {
    expect(parseSourceLaneIds(["jobspy", "jobspy", "source_search"])).toEqual([
      "jobspy",
      "source_search",
    ]);
    expect(() => parseSourceLaneIds(["indeed_ui"])).toThrow('Unsupported source lane "indeed_ui"');
  });
});
