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
            url: "https://uk.indeed.com/viewjob?jk=abc123",
            raw_jobspy: {
              job_url: "https://uk.indeed.com/viewjob?jk=abc123",
              job_url_direct: "https://jobs.example.com/jobs/1",
            },
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
    expect(jobs[0]?.url).toBe("https://jobs.example.com/jobs/1");
    expect(jobs[0]?.sourceUrl).toBe("https://uk.indeed.com/viewjob?jk=abc123");
    expect(jobs[0]?.description).toContain("agentic");
  });

  test("falls back to Indeed when no direct URL is available", () => {
    const [job] = normalizeExternalJobPayload(
      {
        roles: [
          {
            title: "Applied AI Engineer",
            url: "https://uk.indeed.com/viewjob?jk=abc123",
            raw_jobspy: {
              job_url: "https://uk.indeed.com/viewjob?jk=abc123",
            },
          },
        ],
      },
      "jobspy",
    );

    expect(job?.url).toBe("https://uk.indeed.com/viewjob?jk=abc123");
    expect(job?.sourceUrl).toBeNull();
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
    expect(markdown).toContain("- Job URL: https://example.com/jobs/2");
    expect(markdown).toContain("- Location: Singapore");
    expect(markdown).toContain("Ship AI systems");
  });

  test("preserves JobServe contract metadata in rendered full text", () => {
    const [job] = normalizeExternalJobPayload(
      {
        roles: [
          {
            title: "Forward Deployed AI Engineer",
            employer_name: "Investigo",
            url: "https://www.jobserve.com/gb/en/search-jobs-in-London/FORWARD-DEPLOYED-AI-ENGINEER-abc/",
            summary_snippet: "Forward deployed AI engineer contract.",
            job_type: "Contract",
            rate: "£800 - 1k per day",
            posted_date: "20/05/2026 13:29:08",
            duration: "6 months",
            reference: "JS123",
            job_id: "ABC123",
            apply_url: "https://www.jobserve.com/gb/en/WABC123.jsap",
            detail_fetch_url: "https://www.jobserve.com/gb/en/WABC123.jsjob",
            outside_ir35: true,
            inside_ir35: false,
            remote_signal: false,
            priority_notes: ["contract", "outside_ir35"],
          },
        ],
      },
      "jobserve",
    );

    expect(job).toBeDefined();
    if (!job) throw new Error("Expected normalized job");
    expect(job.sourceLabel).toBe("JobServe");
    const markdown = normalizedJobMarkdown(job);
    expect(markdown).toContain("- Source: JobServe");
    expect(markdown).toContain("- Compensation: £800 - 1k per day");
    expect(markdown).toContain("- Posted date: 20/05/2026 13:29:08");
    expect(markdown).toContain("- Outside IR35: yes");
    expect(markdown).toContain("- Inside IR35: no");
    expect(markdown).toContain("- Priority notes: contract, outside_ir35");
  });

  test("fails loudly for malformed rows", () => {
    expect(() => normalizeExternalJobPayload({ roles: [{ title: "No URL" }] }, "jobspy")).toThrow(
      'Invalid jobspy job at index 0: External job "No URL" is missing a URL',
    );
  });
});
