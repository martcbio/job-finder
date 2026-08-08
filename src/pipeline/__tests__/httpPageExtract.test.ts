import { describe, expect, test } from "bun:test";
import { fetchHttpPageMarkdown, htmlToReadableMarkdown } from "../httpPageExtract";

function htmlResponse(
  body: string,
  status = 200,
  contentType = "text/html",
  finalUrl?: string,
): Response {
  const response = new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
  if (finalUrl) Object.defineProperty(response, "url", { value: finalUrl });
  return response;
}

describe("htmlToReadableMarkdown", () => {
  test("extracts title, headings, list items, and visible text", () => {
    const markdown = htmlToReadableMarkdown(
      `<!doctype html>
      <html>
        <head><title>Senior Agentic Engineer &amp; Architect</title></head>
        <body>
          <script>window.noisy = true</script>
          <h1>Senior Agentic Engineer</h1>
          <p>Build production agent systems.</p>
          <ul><li>RAG evaluation</li><li>Tool orchestration</li></ul>
        </body>
      </html>`,
      "https://jobs.example.com/42",
    );

    expect(markdown).toContain("Title: Senior Agentic Engineer & Architect");
    expect(markdown).toContain("URL Source: https://jobs.example.com/42");
    expect(markdown).toContain("# Senior Agentic Engineer");
    expect(markdown).toContain("- RAG evaluation");
    expect(markdown).not.toContain("window.noisy");
  });

  test("can scope extraction to the job content instead of page chrome", () => {
    const markdown = htmlToReadableMarkdown(
      `<!doctype html>
      <html>
        <head><title>Job page</title></head>
        <body>
          <nav><ul><li>Home</li><li>Pricing</li></ul></nav>
          <div id="job">
            <h1>Senior AI Engineer</h1>
            <p>You are currently only able to use a limited number of features of this website.</p>
            <p>Role Overview</p>
            <ul><li>Build agent workflows</li><li>Monitor model cost</li></ul>
          </div>
          <footer>Privacy Policy</footer>
        </body>
      </html>`,
      "https://jobs.example.com/42",
      { contentSelectors: ["#job"] },
    );

    expect(markdown).toContain("# Senior AI Engineer");
    expect(markdown).toContain("- Build agent workflows");
    expect(markdown).toContain("- Monitor model cost");
    expect(markdown).not.toContain("Pricing");
    expect(markdown).not.toContain("Privacy Policy");
    expect(markdown).not.toContain("limited number of features");
  });

  test("scopes a selector when the target is the first class token", () => {
    const markdown = htmlToReadableMarkdown(
      `<body>
        <div class="target"><p>Full job description</p></div>
        <div><p>Unrelated US job recommendations</p></div>
      </body>`,
      "https://jobs.example.com/42",
      { contentSelectors: [".target"] },
    );

    expect(markdown).toContain("Full job description");
    expect(markdown).not.toContain("Unrelated US job recommendations");
  });
});

describe("fetchHttpPageMarkdown", () => {
  test("returns readable markdown and metadata for HTML responses", async () => {
    const result = await fetchHttpPageMarkdown(
      "https://jobs.example.com/42",
      { timeoutMs: 1000, minTextLength: 20 },
      async () =>
        htmlResponse(
          "<html><head><title>Agent Role</title></head><body><p>Build useful agent systems for enterprise users.</p></body></html>",
        ),
    );

    expect(result.status).toBe(200);
    expect(result.contentType).toBe("text/html");
    expect(result.byteLength).toBeGreaterThan(20);
    expect(result.finalUrl).toBe("https://jobs.example.com/42");
    expect(result.markdown).toContain("Title: Agent Role");
    expect(result.markdown).toContain("Build useful agent systems");
  });

  test("rejects short extraction results", async () => {
    await expect(
      fetchHttpPageMarkdown(
        "https://jobs.example.com/short",
        { timeoutMs: 1000, minTextLength: 100 },
        async () => htmlResponse("<html><body>Too short</body></html>"),
      ),
    ).rejects.toThrow("readable character");
  });

  test("rejects unsupported content types", async () => {
    await expect(
      fetchHttpPageMarkdown(
        "https://jobs.example.com/file.pdf",
        { timeoutMs: 1000, minTextLength: 10 },
        async () => htmlResponse("%PDF", 200, "application/pdf"),
      ),
    ).rejects.toThrow("Unsupported content type");
  });

  test("rejects JobServe search, expiry, and usage-restriction pages", async () => {
    const requested = "https://www.jobserve.com/gb/en/job/ABC123";
    const cases = [
      htmlResponse(
        "<h1>Search jobs</h1><p>Many current vacancies</p>",
        200,
        "text/html",
        "https://www.jobserve.com/gb/en/JobSearch.aspx?q=AI",
      ),
      htmlResponse(
        "<title>Job Expired</title><h2>The job you have requested is no longer available</h2>",
      ),
      htmlResponse(
        "<h1>Usage Restricted</h1><p>Your IP Address has been deemed to exceed our fair usage levels.</p>",
      ),
    ];

    for (const response of cases) {
      await expect(
        fetchHttpPageMarkdown(
          requested,
          { timeoutMs: 1000, minTextLength: 10 },
          async () => response,
        ),
      ).rejects.toThrow(/JobServe (?:job is unavailable|usage restricted)/);
    }
  });

  test("rejects JobServe withdrawal copy in a secondary heading", async () => {
    await expect(
      fetchHttpPageMarkdown(
        "https://www.jobserve.com/gb/en/WABC123.jsjob",
        { timeoutMs: 1000, minTextLength: 10 },
        async () =>
          htmlResponse(
            "<title>Vacancy</title><main><h2>The job you have requested is no longer available</h2></main>",
          ),
      ),
    ).rejects.toThrow("JobServe job is unavailable");
  });

  test("rejects a JobServe detail response landing on a different job id", async () => {
    await expect(
      fetchHttpPageMarkdown(
        "https://www.jobserve.com/gb/en/WABC123.jsjob",
        { timeoutMs: 1000, minTextLength: 10 },
        async () =>
          htmlResponse(
            `<main><h1>Another role</h1><p>${"Still a long valid-looking job body. ".repeat(20)}</p></main>`,
            200,
            "text/html",
            "https://www.jobserve.com/gb/en/WXYZ999.jsjob",
          ),
      ),
    ).rejects.toThrow("unexpected URL");
  });
});
