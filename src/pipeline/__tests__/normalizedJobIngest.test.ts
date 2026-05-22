import { describe, expect, test } from "bun:test";
import { normalizedJobMarkdown, normalizeExternalJobPayload } from "../normalizedJobIngest";

describe("normalized job ingest", () => {
  test("normalizes old JobSpy snapshot roles", () => {
    const jobs = normalizeExternalJobPayload(
      {
        roles: [
          {
            title: "Applied AI Engineer",
            company: "Taktile",
            url: "https://example.com/jobs/1",
            description: "Build reusable agentic products.",
            location: "London",
            job_type: "fulltime",
            compensation: "GBP 120000",
            search_label: "uk_forward_deployed_ai",
            search_term: '"forward deployed engineer" AI',
          },
        ],
      },
      "jobspy",
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.sourceLabel).toBe("JobSpy");
    expect(jobs[0]?.company).toBe("Taktile");
    expect(jobs[0]?.description).toContain("agentic");
  });

  test("renders full text with source metadata", () => {
    const [job] = normalizeExternalJobPayload(
      [
        {
          title: "Forward Deployed Engineer",
          employer_name: "Example AI",
          job_url: "https://example.com/jobs/2",
          summary_snippet: "Ship AI systems with customers.",
          location: "Singapore",
        },
      ],
      "jobspy",
    );

    expect(job).toBeDefined();
    if (!job) throw new Error("Expected normalized job");
    const markdown = normalizedJobMarkdown(job);
    expect(markdown).toContain("# Example AI - Forward Deployed Engineer");
    expect(markdown).toContain("- Source: JobSpy");
    expect(markdown).toContain("- Location: Singapore");
    expect(markdown).toContain("Ship AI systems");
  });

  test("fails loudly for malformed rows", () => {
    expect(() => normalizeExternalJobPayload({ roles: [{ title: "No URL" }] }, "jobspy")).toThrow(
      'Invalid jobspy job at index 0: External job "No URL" is missing a URL',
    );
  });
});
