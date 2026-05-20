import { describe, expect, test } from "bun:test";
import { fetchHttpPageMarkdown, htmlToReadableMarkdown } from "../httpPageExtract";

function htmlResponse(body: string, status = 200, contentType = "text/html"): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
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
});
