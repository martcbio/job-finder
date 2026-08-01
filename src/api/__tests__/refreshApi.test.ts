import { expect, test } from "bun:test";
import { DEFAULT_FAST_REFRESH_SOURCE_IDS } from "../../pipeline/sourceRegistry";
import { listQueueRefreshSources } from "../refreshApi";

test("refresh defaults come only from the registered source defaults", () => {
  const defaultIncluded = listQueueRefreshSources()
    .filter((source) => source.defaultIncluded)
    .map((source) => source.id)
    .sort();

  expect(defaultIncluded).toEqual([...DEFAULT_FAST_REFRESH_SOURCE_IDS].sort());
});
