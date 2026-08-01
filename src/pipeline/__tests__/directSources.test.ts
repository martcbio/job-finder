import { describe, expect, test } from "bun:test";
import {
  DIRECT_DETAIL_CONCURRENCY,
  extractGoogleJobMarkdown,
  extractLinearJobMarkdown,
  fetchGoogleCareersJobs,
  fetchLinearCareersJobs,
  parseGoogleCareersListings,
  parseLinearCareersListings,
} from "../directSources";

describe("direct source adapters", () => {
  test("parses Linear careers listing links into direct job URLs", () => {
    const listings = parseLinearCareersListings(`
      <a href="/careers/d3bc1ced-3ce4-4086-a050-555055dbb1ff">
        Senior / Staff Fullstack Engineer
        Europe, North America
        Learn more →
      </a>
      <a href="/careers/b4a7764e-c680-4bdf-9956-dc78f2ca94d5">
        Senior / Staff Product Engineer, AI
        North America
        Learn more →
      </a>
    `);

    expect(listings).toEqual([
      {
        title: "Senior / Staff Fullstack Engineer",
        location: "Europe, North America",
        url: "https://linear.app/careers/d3bc1ced-3ce4-4086-a050-555055dbb1ff",
      },
      {
        title: "Senior / Staff Product Engineer, AI",
        location: "North America",
        url: "https://linear.app/careers/b4a7764e-c680-4bdf-9956-dc78f2ca94d5",
      },
    ]);
  });

  test("decodes ampersands in direct-careers card text", () => {
    const [listing] = parseLinearCareersListings(`
      <a href="/careers/d3bc1ced-3ce4-4086-a050-555055dbb1ff">
        R&amp;D Engineer Europe Learn more →
      </a>
    `);

    expect(listing?.title).toBe("R&D Engineer");
  });

  test("persists every Linear listing without a direct acquisition limit", async () => {
    const listingId = (index: number) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const listings = Array.from({ length: 18 }, (_, index) => {
      const title =
        index % 2 === 0 ? `Senior Engineer ${index + 1}` : `Product Manager ${index + 1}`;
      return `<a href="/careers/${listingId(index + 1)}">${title} Europe Learn more →</a>`;
    }).join("\n");
    const fetcher = Object.assign(
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://linear.app/careers") return new Response(listings);
        return new Response(`<main><h1>Role detail</h1><p>${url}</p></main>`);
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;

    const result = await fetchLinearCareersJobs({
      timeoutMs: 1000,
      fetcher,
    });

    expect(result.discovered).toBe(18);
    expect(result.jobs).toHaveLength(18);
    expect(result.jobs.map((job) => job.title)).toContain("Product Manager 18");
    expect(result.errors).toEqual([]);
  });

  test("retains Linear listings and reports individual detail failures", async () => {
    const listings = `
      <a href="/careers/00000000-0000-4000-8000-000000000001">Senior Engineer Europe Learn more →</a>
      <a href="/careers/00000000-0000-4000-8000-000000000002">Product Manager Europe Learn more →</a>
    `;
    const fetcher = Object.assign(
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://linear.app/careers") return new Response(listings);
        if (url.endsWith("000000000002"))
          return new Response("temporarily unavailable", { status: 503 });
        return new Response("<main><h1>Senior Engineer</h1><p>Build systems.</p></main>");
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;

    const result = await fetchLinearCareersJobs({
      timeoutMs: 1000,
      fetcher,
    });

    expect(result.jobs).toHaveLength(2);
    expect(result.jobs[1]?.raw).toMatchObject({
      detail_status: "error",
      failureReason: "HTTP 503: https://linear.app/careers/00000000-0000-4000-8000-000000000002",
    });
    expect(result.errors).toEqual([
      "Linear Careers detail fetch failed for https://linear.app/careers/00000000-0000-4000-8000-000000000002: HTTP 503: https://linear.app/careers/00000000-0000-4000-8000-000000000002",
    ]);
  });

  test("extracts Linear career content from main and preserves lists", () => {
    const markdown = extractLinearJobMarkdown(
      `<!doctype html>
      <html>
        <head><title>Senior / Staff Product Engineer, AI - Linear Careers</title></head>
        <body>
          <header>Product Resources Customers Pricing Now Contact Docs Open app</header>
          <main>
            <h1>Senior / Staff Product Engineer, AI</h1>
            <p>Build AI-powered product features that feel native.</p>
            <h2>What You'll Do</h2>
            <ul>
              <li>Build intelligent workflows</li>
              <li>Evaluate model behaviour in production</li>
            </ul>
          </main>
          <footer>Product Intake Plan Build Diffs Monitor Pricing Security Features Legal Privacy Terms</footer>
        </body>
      </html>`,
      "https://linear.app/careers/example",
    );

    expect(markdown).toContain("# Senior / Staff Product Engineer, AI");
    expect(markdown).toContain("## What You'll Do");
    expect(markdown).toContain("- Build intelligent workflows");
    expect(markdown).toContain("- Evaluate model behaviour in production");
    expect(markdown).not.toContain("Product Resources Customers");
    expect(markdown).not.toContain("Legal Privacy Terms");
  });

  test("parses Google Careers cards into canonical detail URLs", () => {
    const listings = parseGoogleCareersListings(`
      <li class="lLd3Je" ssk="17:81546170060415686">
        <h3 class="QJPWVe">Senior Software Engineer, Vertex AI</h3>
        <span class="r0wTof">London, UK</span>
        <a
          href="jobs/results/81546170060415686-senior-software-engineer-vertex-ai"
          aria-label="Learn more about Senior Software Engineer, Vertex AI"
        ></a>
      </li>
    `);

    expect(listings).toEqual([
      {
        title: "Senior Software Engineer, Vertex AI",
        location: "London, UK",
        url: "https://www.google.com/about/careers/applications/jobs/results/81546170060415686-senior-software-engineer-vertex-ai",
      },
    ]);
  });

  test("extracts the full Google job description used for blocker screening", () => {
    const markdown = extractGoogleJobMarkdown(
      `<!doctype html>
      <html>
        <head><title>Senior Software Engineer, Vertex AI — Google Careers</title></head>
        <body>
          <header>Google Careers Search jobs</header>
          <main>
            <h1>Senior Software Engineer, Vertex AI</h1>
            <div class="KwJkGe">
              <h3>Minimum qualifications:</h3>
              <ul><li>5 years of software development experience.</li></ul>
            </div>
            <div class="aG5W3">
              <h3>About the job</h3>
              <p>Build and operate production AI systems for customers across Europe.</p>
            </div>
            <div class="BDNOWe">
              <h3>Responsibilities</h3>
              <ul><li>Design reliable distributed systems.</li></ul>
            </div>
          </main>
          <footer>Privacy Terms</footer>
        </body>
      </html>`,
      "https://www.google.com/about/careers/applications/jobs/results/example",
    );

    expect(markdown).toContain("# Senior Software Engineer, Vertex AI");
    expect(markdown).toContain("## Minimum qualifications:");
    expect(markdown).toContain("- 5 years of software development experience.");
    expect(markdown).toContain("## About the job");
    expect(markdown).toContain("## Responsibilities");
    expect(markdown).not.toContain("Google Careers Search jobs");
    expect(markdown).not.toContain("Privacy Terms");
  });

  test("acquires all Google Careers cards without profile filtering", async () => {
    const calls: string[] = [];
    const listing = (id: string, title: string, location: string) => `
      <li class="lLd3Je">
        <h3 class="QJPWVe">${title}</h3>
        <span class="r0wTof">${location}</span>
        <a href="jobs/results/${id}-${title.toLowerCase().replaceAll(" ", "-")}"
           aria-label="Learn more about ${title}"></a>
      </li>`;
    const detail = (title: string) => `
      <html><head><title>${title} — Google Careers</title></head><body>
        <div class="KwJkGe"><h3>Minimum qualifications:</h3><p>${"Engineering experience. ".repeat(20)}</p></div>
        <div class="aG5W3"><h3>About the job</h3><p>${"Build AI systems. ".repeat(20)}</p></div>
        <div class="BDNOWe"><h3>Responsibilities</h3><p>${"Ship reliable software. ".repeat(20)}</p></div>
      </body></html>`;
    const fetcher = Object.assign(
      async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/results/")) {
          return new Response(listing("1", "Product Manager, AI", "London, UK"));
        }
        if (url.endsWith("?page=2")) {
          return new Response(listing("2", "Senior AI Engineer", "London, UK"));
        }
        return new Response(detail("Senior AI Engineer"));
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;

    const result = await fetchGoogleCareersJobs({
      timeoutMs: 1000,
      fetcher,
    });

    expect(result.jobs).toHaveLength(2);
    expect(result.jobs[0]?.title).toBe("Product Manager, AI");
    expect(result.jobs[1]?.title).toBe("Senior AI Engineer");
    expect(result.pagesFetched).toBe(3);
    expect(calls).toContain(
      "https://www.google.com/about/careers/applications/jobs/results/?page=2",
    );
  });

  test("reports Google discovery truncation when its five-page safety guard remains nonempty", async () => {
    const listing = (page: number) => `
      <li class="lLd3Je">
        <h3 class="QJPWVe">Engineer ${page}</h3>
        <span class="r0wTof">London, UK</span>
        <a href="jobs/results/${page}-engineer-${page}"
           aria-label="Learn more about Engineer ${page}"></a>
      </li>`;
    const detail = `
      <html><head><title>Engineer — Google Careers</title></head><body>
        <div class="KwJkGe"><p>${"Engineering experience. ".repeat(20)}</p></div>
      </body></html>`;
    const fetcher = Object.assign(
      async (input: string | URL | Request) => {
        const url = String(input);
        const page = Number.parseInt(url.match(/[?&]page=(\d+)/)?.[1] ?? "1", 10);
        if (url.endsWith("/results/") || url.includes("/results/?page=")) {
          return new Response(listing(page));
        }
        return new Response(detail);
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;

    const result = await fetchGoogleCareersJobs({
      timeoutMs: 1000,
      fetcher,
    });

    expect(result.discovered).toBe(5);
    expect(result.jobs).toHaveLength(5);
    expect(result.pagesFetched).toBe(5);
    expect(result.errors).toEqual([
      "Google Careers discovery stopped at the 5-page safety cap while the final page still contained listings.",
    ]);
    expect(result.truncated).toBe(true);
  });

  test("bounds direct detail fetches while retaining every parsed card", async () => {
    const listingId = (index: number) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const listings = Array.from(
      { length: DIRECT_DETAIL_CONCURRENCY + 2 },
      (_, index) =>
        `<a href="/careers/${listingId(index + 1)}">Engineer ${index + 1} Europe Learn more →</a>`,
    ).join("\n");
    let inFlight = 0;
    let peakInFlight = 0;
    const fetcher = Object.assign(
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://linear.app/careers") return new Response(listings);
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await Bun.sleep(5);
        inFlight--;
        return new Response("<main><h1>Engineer</h1><p>Build systems.</p></main>");
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;

    const result = await fetchLinearCareersJobs({ timeoutMs: 1000, fetcher });

    expect(result.jobs).toHaveLength(DIRECT_DETAIL_CONCURRENCY + 2);
    expect(peakInFlight).toBe(DIRECT_DETAIL_CONCURRENCY);
  });
});
