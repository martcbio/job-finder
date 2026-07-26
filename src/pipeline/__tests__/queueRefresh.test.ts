import { describe, expect, test } from "bun:test";
import { partitionQueueRefreshSourceIds } from "../queueRefresh/plan";
import { allQueueRefreshSourceIds } from "../queueRefresh/registry";

describe("queue refresh planning", () => {
  test("partitions native feeds vs ATS search sites vs lane imports", () => {
    const plan = partitionQueueRefreshSourceIds([
      "jobserve",
      "linear-careers",
      "google-careers",
      "greenhouse",
      "lever",
      "jobspy",
      "rippling",
      "unknown-board",
    ]);

    expect(plan.fastRefreshIds).toEqual(["jobserve", "linear-careers", "google-careers"]);
    expect(plan.searchSiteIds).toEqual(["greenhouse", "lever", "rippling"]);
    expect(plan.laneImportIds).toEqual(["jobspy"]);
    expect(plan.unsupportedIds).toEqual(["unknown-board"]);
  });

  test("does not double-schedule linear through search", () => {
    const plan = partitionQueueRefreshSourceIds(["linear-careers"]);
    expect(plan.fastRefreshIds).toEqual(["linear-careers"]);
    expect(plan.searchSiteIds).toEqual([]);
  });

  test("allQueueRefreshSourceIds includes native, lane, and ATS sites", () => {
    const ids = allQueueRefreshSourceIds();
    expect(ids).toContain("jobserve");
    expect(ids).toContain("linear-careers");
    expect(ids).toContain("google-careers");
    expect(ids).toContain("jobspy");
    expect(ids).toContain("greenhouse");
    expect(ids).toContain("ashby");
    expect(ids).toContain("rippling");
  });
});
