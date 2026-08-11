import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  attachCompanySignals,
  buildDirectCareerRowsSql,
  type DirectCareerRow,
  type LabOpening,
  readCompanyPriorities,
  readCompanySignals,
  readOpportunityReportPolicy,
  toDirectCareerOpportunity,
  toLabOpportunity,
} from "../opportunityReportData";

function labOpening(overrides: Partial<LabOpening> = {}): LabOpening {
  return {
    company: "Databricks",
    title: "AI Engineer",
    location: "Pune, India",
    url: "https://example.com/databricks",
    postedAt: "2026-07-23T09:00:00Z",
    locationEligibility: {
      status: "undecided",
      reasonCodes: ["location.unrecognized"],
    },
    roleRelevance: { status: "relevant", reasonCodes: ["role.technical"] },
    raw: {},
    ...overrides,
  };
}

describe("opportunity report data", () => {
  test("turns structured unresolved locations and missing bodies into explicit caveats", () => {
    const row = toLabOpportunity(labOpening(), new Date("2026-07-24T06:00:00Z"));

    expect(row?.screening).toEqual({
      status: "needs_human_review",
      reasons: [
        {
          code: "location_or_remote_unclear",
          detail: "ATS location Pune, India has not been cleared as workable",
        },
        {
          code: "missing_job_body",
          detail: "ATS board row did not include the full job body",
        },
      ],
      summary: "needs human review: location_or_remote_unclear, missing_job_body",
    });
  });

  test("trusts an eligible structured ATS location over a generic body-screen caveat", () => {
    const row = toLabOpportunity(
      labOpening({
        location: "Dublin, Ireland",
        locationEligibility: {
          status: "eligible",
          reasonCodes: ["location.europe_or_uk"],
        },
        raw: {
          descriptionPlain: `About the role. Responsibilities and requirements. ${"Build reliable AI systems. ".repeat(60)}`,
        },
      }),
      new Date("2026-07-24T06:00:00Z"),
    );

    expect(row?.screening).toEqual({
      status: "high_signal",
      reasons: [],
      summary: "high signal: no deterministic blocker found",
    });
  });

  test("drops a US-primary ATS URL even when secondary locations are eligible", () => {
    const row = toLabOpportunity(
      labOpening({
        location: "San Francisco",
        locationEligibility: {
          status: "eligible",
          reasonCodes: ["location.europe_or_uk"],
        },
        raw: {
          address: {
            postalAddress: {
              addressCountry: "United States",
            },
          },
        },
      }),
      new Date("2026-07-24T06:00:00Z"),
    );

    expect(row).toBeNull();
  });

  test("keeps direct-source discovery and observation times separate from posting time", () => {
    const direct: DirectCareerRow = {
      title: "Linear - Senior / Staff Product Engineer, AI",
      company: "Linear",
      url: "https://linear.app/careers/example",
      firstSeenAt: "2026-05-23T02:00:00Z",
      lastSeenAt: "2026-07-25T05:00:00Z",
      location: "Europe",
      markdown: `About the role\nResponsibilities\n${"Build AI product systems. ".repeat(60)}`,
      description: "",
      sourceId: "linear-careers",
      sourceLabel: "Linear Careers",
    };

    const row = toDirectCareerOpportunity(direct);

    expect(row?.source).toBe("Linear Careers");
    expect(row?.title).toBe("Senior / Staff Product Engineer, AI");
    expect(row?.postedAt).toBeNull();
    expect(row?.discoveredAt.toISOString()).toBe("2026-05-23T02:00:00.000Z");
    expect(row?.observedAt.toISOString()).toBe("2026-07-25T05:00:00.000Z");
    expect(row?.terms).toContain("last verified open");
  });

  test("screens the newest full page instead of concatenated stale search descriptions", () => {
    const direct: DirectCareerRow = {
      title: "Google - Senior Applied AI/ML Engineer",
      company: "Google",
      url: "https://www.google.com/about/careers/applications/jobs/results/123-ai-engineer",
      firstSeenAt: "2026-07-26T05:00:00Z",
      lastSeenAt: "2026-07-26T08:00:00Z",
      location: "Bengaluru, Karnataka, India",
      markdown: [
        "About the role",
        "Build production AI systems and reliable customer-facing services.",
        "Responsibilities include architecture, implementation, evaluation, and operations.",
        "Requirements include distributed systems, TypeScript, Python, and applied AI.",
      ]
        .join(" ")
        .repeat(8),
      description: "Old noisy snapshot: work from anywhere worldwide.",
      sourceId: "google-careers",
      sourceLabel: "Google Careers",
    };

    const row = toDirectCareerOpportunity(direct);

    expect(row?.screening.status).toBe("needs_human_review");
    expect(row?.screening.reasons.map((reason) => reason.code)).toContain(
      "location_or_remote_unclear",
    );
  });

  test("loads both first-class direct careers sources from the database", () => {
    const sql = buildDirectCareerRowsSql();

    expect(sql).toContain("'linear-careers', 'google-careers'");
    expect(sql).toContain('sq.source_id AS "sourceId"');
    expect(sql).toContain('sq.source_label AS "sourceLabel"');
    expect(sql).toContain("ORDER BY candidate_page.fetched_at DESC");
    expect(sql).not.toContain("MAX(jp.markdown)");
  });

  test("extracts a concise compensation range from one-line encoded ATS HTML", () => {
    const row = toLabOpportunity(
      labOpening({
        location: "London",
        locationEligibility: { status: "eligible", reasonCodes: ["location.europe_or_uk"] },
        raw: {
          description:
            "&lt;p&gt;For sales roles, compensation is variable. The expected annual base salary range for this role is £180,000 - £220,000 per year, subject to experience.&lt;/p&gt;" +
            " Build reliable AI systems. ".repeat(60),
        },
      }),
      new Date("2026-07-24T06:00:00Z"),
    );

    expect(row?.terms).toContain("advertised compensation £180,000 - £220,000 per year");
    expect(row?.terms).not.toContain("&lt;p&gt;");
    expect(row?.terms.length).toBeLessThan(150);
  });

  test("attaches recent bookmark intelligence by company name", () => {
    const opportunity = toLabOpportunity(
      labOpening({
        company: "Conduct AI",
        location: "London",
        locationEligibility: { status: "eligible", reasonCodes: ["location.europe_or_uk"] },
        raw: {
          descriptionPlain: `About the role. Responsibilities and requirements. ${"Build reliable AI systems. ".repeat(60)}`,
        },
      }),
      new Date("2026-07-24T06:00:00Z"),
    );
    expect(opportunity).not.toBeNull();
    if (!opportunity) throw new Error("Expected a lab opportunity");

    const [enriched] = attachCompanySignals(
      [opportunity],
      [
        {
          id: "signal-1",
          kinds: ["funding", "hiring"],
          text: "Conduct AI raised a Series A and is hiring.",
          url: "https://x.com/founder/status/signal-1",
          publishedAt: "2026-07-23T10:00:00Z",
          capturedAt: "2026-07-23T11:00:00Z",
          authorHandle: "founder",
          companyHandles: [],
          origin: "bookmark",
        },
      ],
    );

    expect(enriched?.companySignals?.[0]?.id).toBe("signal-1");
  });

  test("rejects malformed report policy and company intelligence artifacts", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "opportunity-schema-"));
    try {
      const policyPath = resolve(directory, "policy.json");
      const signalsPath = resolve(directory, "signals.json");
      const prioritiesPath = resolve(directory, "priorities.json");
      await writeFile(policyPath, JSON.stringify({ limit: "50" }));
      await writeFile(signalsPath, JSON.stringify({ signals: [{ id: 1 }] }));
      await writeFile(
        prioritiesPath,
        JSON.stringify({ Acme: { aiNative: 2, workingStyle: "high", prestige: 1, note: "x" } }),
      );

      await expect(readOpportunityReportPolicy(policyPath)).rejects.toThrow();
      await expect(readCompanySignals(signalsPath)).rejects.toThrow();
      await expect(readCompanyPriorities(prioritiesPath)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("enforces the normal 20–30-role selection range in report policy", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "opportunity-policy-"));
    const base = {
      maxAgeDays: 45,
      recommendationMinScore: 12,
      staleAfterHours: 48,
      expectedSources: ["JobServe"],
    };
    try {
      const tooSmall = resolve(directory, "too-small.json");
      const tooLarge = resolve(directory, "too-large.json");
      await writeFile(tooSmall, JSON.stringify({ ...base, limit: 19 }));
      await writeFile(tooLarge, JSON.stringify({ ...base, limit: 31 }));

      await expect(readOpportunityReportPolicy(tooSmall)).rejects.toThrow();
      await expect(readOpportunityReportPolicy(tooLarge)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
