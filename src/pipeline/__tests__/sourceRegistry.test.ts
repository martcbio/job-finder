import { describe, expect, test } from "bun:test";
import {
  buildRegisteredSourceAdapters,
  DEFAULT_FAST_REFRESH_SOURCE_IDS,
  DEFAULT_JOB_INGEST_SOURCE_IDS,
  FAST_REFRESH_SOURCE_IDS,
  JOB_INGEST_SOURCE_IDS,
  LANE_IMPORT_SOURCE_IDS,
  REGISTERED_JOB_SOURCES,
  registeredJobSource,
} from "../sourceRegistry";

describe("job source registry", () => {
  test("owns ingest, fast-refresh, and lane membership", () => {
    expect(DEFAULT_JOB_INGEST_SOURCE_IDS).toEqual([
      "lab-ats",
      "jobserve",
      "linear-careers",
      "google-careers",
    ]);
    expect(DEFAULT_FAST_REFRESH_SOURCE_IDS).toEqual([
      "jobserve",
      "linear-careers",
      "google-careers",
    ]);
    expect([...JOB_INGEST_SOURCE_IDS]).toEqual([
      "lab-ats",
      "jobserve",
      "linear-careers",
      "google-careers",
    ]);
    expect([...FAST_REFRESH_SOURCE_IDS]).toEqual(["jobserve", "linear-careers", "google-careers"]);
    expect([...LANE_IMPORT_SOURCE_IDS]).toEqual(["jobspy"]);
  });

  test("contains unique source ids and canonical metadata", () => {
    const ids = REGISTERED_JOB_SOURCES.map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(registeredJobSource("linear")).toMatchObject({
      id: "linear-careers",
      label: "Linear Careers",
      kind: "direct_employer",
      quality: "high",
    });
  });

  test("constructs adapters from registry entries", () => {
    const adapters = buildRegisteredSourceAdapters(
      ["jobserve", "linear-careers", "google-careers"],
      {
        jobserveQueries: ["agentic", "rag"],
        jobserveMaxPages: 2,
      },
    );
    expect(adapters.map((adapter) => adapter.id)).toEqual([
      "jobserve",
      "jobserve",
      "linear-careers",
      "google-careers",
    ]);
    expect(() =>
      buildRegisteredSourceAdapters(["unknown"], {
        jobserveQueries: [],
        jobserveMaxPages: 1,
      }),
    ).toThrow("Unknown fast-refresh source: unknown");
  });
});
