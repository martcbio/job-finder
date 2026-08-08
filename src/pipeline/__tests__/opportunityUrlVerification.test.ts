import { describe, expect, test } from "bun:test";
import type { Opportunity } from "../opportunityReport";
import { verifyOpportunityUrls } from "../opportunityUrlVerification";

function row(url: string): Opportunity {
  return {
    source: "Google Careers",
    company: "Google",
    title: "Senior Software Engineer, AI",
    location: "London, UK",
    url,
    postedAt: new Date("2026-07-26T08:00:00Z"),
    observedAt: new Date("2026-07-26T09:00:00Z"),
    terms: "employment type unknown",
    screening: {
      status: "high_signal",
      reasons: [],
      summary: "high signal: no deterministic blocker found",
    },
    bodyAvailable: true,
  };
}

describe("opportunity URL verification", () => {
  test("removes definitely dead detail pages but retains WAF-blocked official URLs", async () => {
    const fetcher = Object.assign(
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/gone")) return new Response("not found", { status: 404 });
        if (url.endsWith("/withdrawn")) {
          return new Response("This job is no longer available.", { status: 200 });
        }
        if (url.endsWith("/waf")) return new Response("blocked", { status: 403 });
        return new Response("Current job description and apply button.", { status: 200 });
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;

    const result = await verifyOpportunityUrls(
      [
        row("https://careers.example.com/jobs/current"),
        row("https://careers.example.com/jobs/gone"),
        row("https://careers.example.com/jobs/withdrawn"),
        row("https://careers.example.com/jobs/waf"),
      ],
      { fetcher, timeoutMs: 1000, concurrency: 2 },
    );

    expect(result.rows.map((item) => item.url)).toEqual([
      "https://careers.example.com/jobs/current",
      "https://careers.example.com/jobs/waf",
    ]);
    expect(result.dead.map((item) => item.url)).toEqual([
      "https://careers.example.com/jobs/gone",
      "https://careers.example.com/jobs/withdrawn",
    ]);
    expect(result.unverified.map((item) => item.url)).toEqual([
      "https://careers.example.com/jobs/waf",
    ]);
  });

  test("requires a prominent or early withdrawal verdict instead of footer boilerplate", async () => {
    const fetcher = Object.assign(
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/heading")) {
          return new Response("<h1>This position has been filled</h1>", { status: 200 });
        }
        if (url.endsWith("/related-h3")) {
          return new Response(
            "<main><h1>Senior Software Engineer, AI</h1><h3>This position has been filled</h3></main>",
            { status: 200 },
          );
        }
        return new Response(
          `<main><h1>Senior Software Engineer, AI</h1><p>${"Current role details. ".repeat(100)}</p></main><footer>This job is no longer available.</footer>`,
          { status: 200 },
        );
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;

    const result = await verifyOpportunityUrls(
      [
        row("https://careers.example.com/jobs/footer-boilerplate"),
        row("https://careers.example.com/jobs/related-h3"),
        row("https://careers.example.com/jobs/heading"),
      ],
      { fetcher, timeoutMs: 1000, concurrency: 1 },
    );

    expect(result.rows.map((item) => item.url)).toEqual([
      "https://careers.example.com/jobs/footer-boilerplate",
      "https://careers.example.com/jobs/related-h3",
    ]);
    expect(result.dead.map((item) => item.url)).toEqual([
      "https://careers.example.com/jobs/heading",
    ]);
  });

  test("detects JobServe expired copy and redirects while preserving usage restrictions as unverified", async () => {
    const fetcher = Object.assign(
      async (input: string | URL | Request) => {
        const requested = String(input);
        if (requested.endsWith("/redirected")) {
          const response = new Response("<h1>Search jobs</h1>", { status: 200 });
          Object.defineProperty(response, "url", {
            value: "https://www.jobserve.com/gb/en/JobSearch.aspx?q=AI",
          });
          return response;
        }
        if (requested.endsWith("/restricted")) {
          return new Response(
            "<h1>Usage Restricted</h1><p>Your IP Address has been deemed to exceed our fair usage levels.</p>",
            { status: 200 },
          );
        }
        return new Response(
          "<title>Job Expired</title><h2>The job you have requested is no longer available</h2>",
          { status: 200 },
        );
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;

    const result = await verifyOpportunityUrls(
      [
        row("https://www.jobserve.com/gb/en/job/expired-copy"),
        row("https://www.jobserve.com/gb/en/job/redirected"),
        row("https://www.jobserve.com/gb/en/job/restricted"),
      ],
      { fetcher, timeoutMs: 1000, concurrency: 3, jobServeDelayMs: 0 },
    );

    expect(result.dead.map((item) => item.url)).toEqual([
      "https://www.jobserve.com/gb/en/job/expired-copy",
      "https://www.jobserve.com/gb/en/job/redirected",
    ]);
    expect(result.unverified).toEqual([
      { url: "https://www.jobserve.com/gb/en/job/restricted", reason: "JobServe usage restricted" },
    ]);
  });

  test("does not treat a generic live page mentioning a reposted expired job as withdrawn", async () => {
    const fetcher = Object.assign(
      async () =>
        new Response(
          "<main><h1>Senior Software Engineer</h1><p>This job expired and was reposted. Apply to this current opening.</p></main>",
          { status: 200 },
        ),
      { preconnect: fetch.preconnect },
    ) as typeof fetch;

    const current = row("https://careers.example.com/jobs/reposted");
    const result = await verifyOpportunityUrls([current], {
      fetcher,
      timeoutMs: 1000,
      concurrency: 1,
    });
    expect(result.rows).toEqual([current]);
    expect(result.dead).toEqual([]);
  });
});
