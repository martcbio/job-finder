import { describe, expect, test } from "bun:test";
import {
  buildOpportunityReport,
  type Opportunity,
  renderOpportunityHtml,
  renderOpportunityMarkdown,
} from "../opportunityReport";

function opportunity(
  input: Partial<Opportunity> & Pick<Opportunity, "title" | "url">,
): Opportunity {
  const { title, url, ...overrides } = input;
  return {
    source: "JobServe",
    company: "Recruiter",
    title,
    location: "London, UK",
    url,
    postedAt: new Date("2026-07-23T09:00:00Z"),
    discoveredAt: new Date("2026-07-23T09:00:00Z"),
    observedAt: new Date("2026-07-23T10:00:00Z"),
    terms: "contract; IR35 unclear",
    screening: {
      status: "high_signal",
      reasons: [],
      summary: "high signal: no deterministic blocker found",
    },
    bodyAvailable: true,
    ...overrides,
  };
}

describe("opportunity report", () => {
  test("keeps the recent list chronological instead of injecting an older recommendation", () => {
    const rows = [
      opportunity({ title: "Recent Python Developer", url: "https://example.com/recent" }),
      opportunity({
        source: "Lab ATS",
        company: "Anthropic",
        title: "Applied AI Engineer",
        url: "https://example.com/anthropic",
        postedAt: new Date("2026-07-14T09:00:00Z"),
        terms: "employment type unknown",
      }),
      opportunity({
        title: "Recent Project Manager",
        url: "https://example.com/project-manager",
        screening: {
          status: "rejected",
          reasons: [{ code: "not_target_role", detail: "not an engineering role" }],
          summary: "rejected: not_target_role",
        },
      }),
    ];

    const report = buildOpportunityReport(rows, {
      now: new Date("2026-07-23T12:00:00Z"),
      limit: 2,
      maxAgeDays: 30,
      recommendationMinScore: 12,
    });

    expect(report.rows.map((row) => row.url)).toEqual([
      "https://example.com/recent",
      "https://example.com/project-manager",
    ]);
    expect(report.recommendedUrls).toEqual([]);
    expect(report.rows.map((row) => row.url)).not.toContain("https://example.com/anthropic");
  });

  test("renders every decision field and source-health diagnostics", () => {
    const report = buildOpportunityReport(
      [
        opportunity({
          source: "Lab ATS",
          company: "OpenAI",
          title: "AI Deployment Engineer",
          url: "https://example.com/openai",
          location: "Singapore",
          terms: "employment type unknown",
          screening: {
            status: "needs_human_review",
            reasons: [
              {
                code: "regular_hybrid_or_onsite",
                detail: "regular office attendance",
              },
            ],
            summary: "needs human review: regular_hybrid_or_onsite",
          },
        }),
      ],
      {
        now: new Date("2026-07-23T12:00:00Z"),
        limit: 50,
        maxAgeDays: 30,
        recommendationMinScore: 10,
        expectedSources: ["JobServe", "Lab ATS"],
        staleAfterHours: 48,
      },
    );

    const markdown = renderOpportunityMarkdown(report);
    const html = renderOpportunityHtml(report);
    expect(markdown).toContain("URL: https://example.com/openai");
    expect(markdown).toContain("Verdict: CAVEAT");
    expect(markdown).toContain("Why: regular office attendance");
    expect(markdown).toContain("Terms: employment type unknown");
    expect(markdown).toContain("⭐ Recommended");
    expect(markdown).toContain("MISSING: JobServe returned no current rows");
    expect(markdown).toContain("Recommendation distribution: Lab ATS 1");
    expect(markdown).toContain("## Method and limitations");
    expect(markdown).toContain("deterministic CLI code");
    expect(html).toContain('<a href="https://example.com/openai">');
    expect(html).toContain("CAVEAT");
    expect(html).toContain("⭐ Recommended");
    expect(html).toContain("Method and limitations");
  });

  test("prefers a qualified role over an otherwise similar caveated role", () => {
    const caveated = opportunity({
      title: "Agentic AI Engineer",
      url: "https://example.com/caveated",
      screening: {
        status: "needs_human_review",
        reasons: [
          {
            code: "regular_hybrid_or_onsite",
            detail: "listing appears to require regular hybrid or on-site attendance",
          },
        ],
        summary: "needs human review: regular_hybrid_or_onsite",
      },
    });
    const qualified = opportunity({
      title: "Applied AI Engineer",
      url: "https://example.com/qualified",
    });

    const report = buildOpportunityReport([caveated, qualified], {
      now: new Date("2026-07-23T12:00:00Z"),
      limit: 2,
      maxAgeDays: 30,
      recommendationMinScore: 1,
    });

    expect(report.recommendedUrls).toEqual([
      "https://example.com/qualified",
      "https://example.com/caveated",
    ]);
  });

  test("uses recency as part of recommendation ranking", () => {
    const report = buildOpportunityReport(
      [
        opportunity({
          title: "Applied AI Engineer",
          url: "https://example.com/older",
          postedAt: new Date("2026-07-10T09:00:00Z"),
          discoveredAt: new Date("2026-07-10T09:00:00Z"),
        }),
        opportunity({
          title: "Applied AI Engineer",
          url: "https://example.com/newer",
          postedAt: new Date("2026-07-23T09:00:00Z"),
          discoveredAt: new Date("2026-07-23T09:00:00Z"),
        }),
      ],
      {
        now: new Date("2026-07-23T12:00:00Z"),
        limit: 2,
        maxAgeDays: 30,
        recommendationMinScore: 1,
      },
    );

    expect(report.recommendedUrls).toEqual([
      "https://example.com/newer",
      "https://example.com/older",
    ]);
  });

  test("can recommend a caveated role because caveats are not disqualifiers", () => {
    const caveated = opportunity({
      source: "Lab ATS",
      company: "Anthropic",
      title: "Staff Applied AI Engineer",
      url: "https://example.com/anthropic-hybrid",
      terms: "£180,000; hybrid",
      screening: {
        status: "needs_human_review",
        reasons: [
          {
            code: "regular_hybrid_or_onsite",
            detail: "listing appears to require regular hybrid or on-site attendance",
          },
        ],
        summary: "needs human review: regular_hybrid_or_onsite",
      },
    });

    const report = buildOpportunityReport([caveated], {
      now: new Date("2026-07-23T12:00:00Z"),
      limit: 1,
      maxAgeDays: 30,
      recommendationMinScore: 19,
    });

    expect(report.recommendedUrls).toEqual(["https://example.com/anthropic-hybrid"]);
  });

  test("ranks role, compensation, and work mode above source branding", () => {
    const branded = opportunity({
      source: "Lab ATS",
      company: "OpenAI",
      title: "Software Engineer",
      location: "London",
      url: "https://example.com/branded",
      terms: "compensation not stated; work mode unclear",
    });
    const premium = opportunity({
      source: "Direct Careers",
      company: "Acme AI",
      title: "Staff Applied AI Engineer",
      location: "Remote Europe",
      url: "https://example.com/premium",
      terms: "£180,000; remote across Europe",
    });

    const report = buildOpportunityReport([branded, premium], {
      now: new Date("2026-07-23T12:00:00Z"),
      limit: 2,
      maxAgeDays: 30,
      recommendationMinScore: 20,
    });

    expect(report.recommendedUrls).toEqual(["https://example.com/premium"]);
  });

  test("recognises k-suffixed annual compensation", () => {
    const premium = opportunity({
      title: "Staff Backend Engineer",
      url: "https://example.com/140k",
      terms: "£140k per annum",
    });
    const ordinary = opportunity({
      title: "Staff Platform Engineer",
      url: "https://example.com/ordinary",
      terms: "£80,000 per annum",
    });

    const report = buildOpportunityReport([premium, ordinary], {
      now: new Date("2026-07-23T12:00:00Z"),
      limit: 2,
      maxAgeDays: 30,
      recommendationMinScore: 14,
    });

    expect(report.recommendedUrls).toEqual(["https://example.com/140k"]);
  });

  test("does not reward negated outside-IR35 text", () => {
    const negated = opportunity({
      title: "Staff Software Engineer",
      url: "https://example.com/not-outside",
      terms: "contract; not outside IR35; inside IR35; £700 per day",
    });
    const outside = opportunity({
      title: "Staff Software Engineer, Applied AI",
      url: "https://example.com/outside",
      terms: "contract; outside IR35; £700 per day",
    });

    const report = buildOpportunityReport([negated, outside], {
      now: new Date("2026-07-23T12:00:00Z"),
      limit: 2,
      maxAgeDays: 30,
      recommendationMinScore: 20,
    });

    expect(report.recommendedUrls).toEqual(["https://example.com/outside"]);
  });

  test("returns every displayed row above the recommendation threshold without a fixed cap", () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, index) =>
        opportunity({
          title: `Agentic AI Engineer ${index}`,
          url: `https://jobserve.example/${index}`,
        }),
      ),
      opportunity({
        source: "Lab ATS",
        company: "Anthropic",
        title: "Staff Software Engineer",
        url: "https://labs.example/anthropic",
      }),
      opportunity({
        source: "Linear Careers",
        company: "Linear",
        title: "Senior Product Engineer",
        url: "https://linear.example/engineer",
      }),
    ];

    const report = buildOpportunityReport(rows, {
      now: new Date("2026-07-23T12:00:00Z"),
      limit: 6,
      maxAgeDays: 30,
      recommendationMinScore: 11,
    });

    expect(report.recommendedUrls).toHaveLength(6);
    expect(
      report.recommendationDistribution.find((item) => item.source === "JobServe")?.count,
    ).toBe(4);
    expect(report.recommendationDistribution).toContainEqual({ source: "Lab ATS", count: 1 });
    expect(report.recommendationDistribution).toContainEqual({
      source: "Linear Careers",
      count: 1,
    });
  });

  test("uses explicit AI-native and working-style company intelligence as a secondary signal", () => {
    const genericLab = opportunity({
      source: "Lab ATS",
      company: "OpenAI",
      title: "Software Engineer",
      url: "https://example.com/generic-lab",
    });
    const aiNativeTransition = opportunity({
      source: "Lab ATS",
      company: "Ramp",
      title: "Software Engineer, International",
      url: "https://example.com/ramp",
      companyPriority: {
        aiNative: 2,
        workingStyle: 2,
        prestige: 1,
        note: "AI-native transition with strong product-engineering operating model",
      },
    });

    const report = buildOpportunityReport([genericLab, aiNativeTransition], {
      now: new Date("2026-07-23T12:00:00Z"),
      limit: 2,
      maxAgeDays: 30,
      recommendationMinScore: 15,
    });

    expect(report.recommendedUrls).toEqual(["https://example.com/ramp"]);
  });

  test("measures source freshness from acquisition time rather than job posting date", () => {
    const report = buildOpportunityReport(
      [
        opportunity({
          title: "AI Engineer",
          url: "https://example.com/stale-capture",
          postedAt: new Date("2026-07-23T11:00:00Z"),
          observedAt: new Date("2026-07-20T11:00:00Z"),
        }),
      ],
      {
        now: new Date("2026-07-23T12:00:00Z"),
        limit: 10,
        maxAgeDays: 30,
        recommendationMinScore: 1,
        expectedSources: ["JobServe"],
        staleAfterHours: 48,
      },
    );

    expect(report.sourceHealth[0]?.status).toBe("stale");
    expect(report.sourceHealth[0]?.ageHours).toBe(73);
  });

  test("reports missing Lab ATS bodies across the full pool, not only displayed rows", () => {
    const report = buildOpportunityReport(
      [
        opportunity({
          source: "Lab ATS",
          title: "Applied AI Engineer",
          url: "https://example.com/body",
        }),
        opportunity({
          source: "Lab ATS",
          title: "Solutions Architect",
          url: "https://example.com/no-body",
          bodyAvailable: false,
        }),
      ],
      {
        now: new Date("2026-07-23T12:00:00Z"),
        limit: 1,
        maxAgeDays: 30,
        recommendationMinScore: 1,
      },
    );

    expect(report.labMissingBodyCount).toBe(1);
    expect(report.rows.map((row) => row.url)).toEqual(["https://example.com/body"]);
  });

  test("never emits rows without a checked description or an official job URL", () => {
    const report = buildOpportunityReport(
      [
        opportunity({
          title: "Verified Applied AI Engineer",
          url: "https://careers.example.com/jobs/verified",
        }),
        opportunity({
          title: "Body missing",
          url: "https://careers.example.com/jobs/body-missing",
          bodyAvailable: false,
        }),
        opportunity({
          title: "Vanished social lead",
          url: "https://x.com/example/status/123",
        }),
      ],
      {
        now: new Date("2026-07-23T12:00:00Z"),
        limit: 3,
        maxAgeDays: 30,
        recommendationMinScore: 1,
      },
    );

    expect(report.rows.map((row) => row.url)).toEqual([
      "https://careers.example.com/jobs/verified",
    ]);
    expect(report.recommendedUrls).toEqual(["https://careers.example.com/jobs/verified"]);
  });
});
