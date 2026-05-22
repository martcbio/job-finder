import { afterEach, describe, expect, test } from "bun:test";
import { fetchDiscoveryWithUsage, isDiscoveryProvider } from "../discovery";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("discovery provider helpers", () => {
  test("accepts known discovery providers", () => {
    expect(isDiscoveryProvider("auto")).toBe(true);
    expect(isDiscoveryProvider("brave")).toBe(true);
    expect(isDiscoveryProvider("jina")).toBe(true);
    expect(isDiscoveryProvider("google")).toBe(false);
  });

  test("uses Brave first in auto mode and normalizes web results", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return Response.json({
        web: {
          results: [
            {
              title: "Job Application for <strong>Agentic Engineer</strong>",
              url: "https://job-boards.greenhouse.io/acme/jobs/123",
              description: "Build <strong>agents</strong> remotely.",
            },
          ],
        },
      });
    }, originalFetch);

    const call = await fetchDiscoveryWithUsage(
      '"Agentic" site:greenhouse.io remote',
      { braveApiKey: "brave-key", jinaApiKey: "jina-key" },
      { provider: "auto", count: 3 },
    );

    expect(call.usage.provider).toBe("brave");
    expect(call.usage.tokens).toBe(0);
    expect(call.usage.billableQueries).toBe(1);
    expect(call.results).toEqual([
      {
        title: "Job Application for Agentic Engineer",
        url: "https://job-boards.greenhouse.io/acme/jobs/123",
        description: "Build agents remotely.",
      },
    ]);
    expect(requestedUrls[0]).toContain("api.search.brave.com");
    expect(requestedUrls[0]).toContain("count=3");
  });

  test("fails loudly when the requested provider key is unavailable", async () => {
    await expect(fetchDiscoveryWithUsage('"Agentic"', {}, { provider: "brave" })).rejects.toThrow(
      "BRAVE_API_KEY is required for Brave discovery",
    );
  });
});
