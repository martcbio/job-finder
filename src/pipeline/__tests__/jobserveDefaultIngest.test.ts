import { describe, expect, test } from "bun:test";
import { type JobIngestSourceReceipt, runJobIngest } from "../jobIngest";

function receipt(
  id: string,
  overrides: Partial<JobIngestSourceReceipt> = {},
): JobIngestSourceReceipt {
  return {
    id,
    label: id,
    status: "complete",
    runId: 1,
    discovered: 1,
    imported: 1,
    evidencePath: null,
    errors: [],
    elapsedMs: 1,
    ...overrides,
  };
}

describe("default JobServe raw-ingest contract", () => {
  test("attempts JobServe by default and preserves its failed receipt", async () => {
    const sourceRequests: string[][] = [];

    const result = await runJobIngest(
      {},
      {
        ensureReady: async () => {},
        runLab: async () => receipt("lab-ats"),
        runSources: async (options) => {
          sourceRequests.push(options.sourceIds);
          return [
            receipt("jobserve", {
              label: "JobServe",
              status: "failed",
              runId: null,
              discovered: 0,
              imported: 0,
              errors: ["JobServe fair-use restriction page"],
            }),
            receipt("linear-careers", { label: "Linear Careers" }),
            receipt("google-careers", { label: "Google Careers" }),
          ];
        },
      },
    );

    expect(sourceRequests).toEqual([["jobserve", "linear-careers", "google-careers"]]);
    expect(result.status).toBe("degraded");
    expect(result.sources).toContainEqual(
      expect.objectContaining({
        id: "jobserve",
        label: "JobServe",
        status: "failed",
        errors: ["JobServe fair-use restriction page"],
      }),
    );
  });
});
