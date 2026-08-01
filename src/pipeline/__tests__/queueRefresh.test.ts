import { describe, expect, test } from "bun:test";
import { partitionQueueRefreshSourceIds } from "../queueRefresh/plan";
import { allQueueRefreshSourceIds } from "../queueRefresh/registry";
import { resolveQueueRefreshSourceIds } from "../queueRefresh/run";
import { DEFAULT_FAST_REFRESH_SOURCE_IDS } from "../sourceRegistry";

describe("queue refresh planning", () => {
  test("uses every shared fast-refresh source by default", () => {
    expect(resolveQueueRefreshSourceIds(undefined)).toEqual(DEFAULT_FAST_REFRESH_SOURCE_IDS);
    expect(resolveQueueRefreshSourceIds(undefined)).toContain("google-careers");
  });

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
