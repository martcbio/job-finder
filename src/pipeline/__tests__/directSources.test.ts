import { describe, expect, test } from "bun:test";
import {
  extractGoogleJobMarkdown,
  extractLinearJobMarkdown,
  fetchGoogleCareersJobs,
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

  test("paginates Google Careers until it has enough relevant non-US roles", async () => {
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
      limit: 1,
      timeoutMs: 1000,
      fetcher,
    });

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.title).toBe("Senior AI Engineer");
    expect(calls).toContain(
      "https://www.google.com/about/careers/applications/jobs/results/?page=2",
    );
  });
});
