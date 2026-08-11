import { describe, expect, test } from "bun:test";
import { createJobFinderApiHandler } from "../server";

describe("GET /api/opportunities", () => {
  test("returns the mixed-source report used by the browser without refreshing sources", async () => {
    const handler = createJobFinderApiHandler({
      opportunityReport: async (options) => ({
        generatedAt: "2026-07-23T17:00:00.000Z",
        maxAgeDays: 30,
        rows: [
          {
            source: "Lab ATS",
            company: "Anthropic",
            title: "Software Engineer",
            location: "London",
            url: "https://example.com/anthropic",
            postedAt: new Date("2026-07-22T00:00:00.000Z"),
            discoveredAt: new Date("2026-07-22T00:00:00.000Z"),
            observedAt: new Date("2026-07-23T16:00:00.000Z"),
            terms: "employment type not assumed; inspect posting",
            screening: {
              status: "high_signal",
              reasons: [],
              summary: "strong engineering fit",
            },
            bodyAvailable: true,
          },
        ],
        recommendedUrls: ["https://example.com/anthropic"],
        recommendationDistribution: [{ source: "Lab ATS", count: 1 }],
        sourceHealth: [],
        labMissingBodyCount: 0,
        requestedLimit: options.limit,
      }),
      now: () => new Date("2026-07-23T17:00:00.000Z"),
    });

    const response = await handler(
      new Request("http://job-finder.local.test/api/opportunities?limit=50"),
    );
    const body = (await response.json()) as {
      ok: boolean;
      data: {
        rows: Array<{ title: string; url: string }>;
        recommendedUrls: string[];
        requestedLimit: number;
      };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.requestedLimit).toBe(50);
    expect(body.data.rows[0]).toMatchObject({
      title: "Software Engineer",
      url: "https://example.com/anthropic",
    });
    expect(body.data.recommendedUrls).toContain("https://example.com/anthropic");
  });
});
