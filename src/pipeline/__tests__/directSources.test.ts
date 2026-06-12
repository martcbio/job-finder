import { describe, expect, test } from "bun:test";
import { extractLinearJobMarkdown, parseLinearCareersListings } from "../directSources";

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
});
