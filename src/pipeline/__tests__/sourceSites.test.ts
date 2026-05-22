import { describe, expect, test } from "bun:test";
import { buildSearchTargets } from "../searchTargets";
import {
  buildJobSourceSearchTarget,
  DRAFT_JOB_SOURCE_IDS,
  isDraftJobSourceSite,
  JOB_SOURCE_SITES,
  REQUIRED_JOB_SOURCE_SITES,
  resolveJobSourceSites,
} from "../sourceSites";

describe("Source registry", () => {
  test("resolves all captured configured sources without duplicates", () => {
    const sites = resolveJobSourceSites(["all"]);
    const ids = sites.map((site) => site.id);

    expect(sites).toHaveLength(JOB_SOURCE_SITES.length);
    expect(new Set(ids).size).toBe(JOB_SOURCE_SITES.length);
    expect(ids).toContain("greenhouse");
    expect(ids).toContain("linear-careers");
    expect(ids).toContain("workday");
    expect(ids).toContain("glassdoor");
    expect(ids).toContain("other-pages");
  });

  test("builds one coverage search target for every configured source", () => {
    const targets = buildSearchTargets({
      keywords: ["Agentic"],
      domains: [],
      sites: resolveJobSourceSites(["all"]),
      timeFilter: "24hours",
      includeRemote: true,
      location: null,
    });

    expect(targets).toHaveLength(JOB_SOURCE_SITES.length);
    expect(new Set(targets.map((target) => target.sourceId)).size).toBe(JOB_SOURCE_SITES.length);

    for (const target of targets) {
      if (target.kind === "search-query") {
        expect(target.query).toContain('"Agentic"');
        expect(target.query).toContain("remote");
        expect(target.query).toContain('-"United States"');
        expect(target.query).toContain("-LATAM");
        expect(target.filter).toBeFunction();
      } else {
        expect(target.url).toMatch(/^https:\/\//);
      }
    }
  });

  test("separates required sources from draft/opportunistic sources", () => {
    const requiredIds = REQUIRED_JOB_SOURCE_SITES.map((site) => site.id);

    expect(DRAFT_JOB_SOURCE_IDS).toEqual([
      "linkedin",
      "glassdoor",
      "wellfound",
      "remote-rocketship",
    ]);
    expect(requiredIds).not.toContain("linkedin");
    expect(requiredIds).not.toContain("glassdoor");
    expect(requiredIds).not.toContain("wellfound");
    expect(requiredIds).not.toContain("remote-rocketship");
    expect(REQUIRED_JOB_SOURCE_SITES.length).toBe(
      JOB_SOURCE_SITES.length - DRAFT_JOB_SOURCE_IDS.length,
    );
    const linkedin = resolveJobSourceSites(["linkedin"])[0];
    const greenhouse = resolveJobSourceSites(["greenhouse"])[0];
    if (!linkedin || !greenhouse) {
      throw new Error("Expected LinkedIn and Greenhouse sources to resolve");
    }

    expect(isDraftJobSourceSite(linkedin)).toBe(true);
    expect(isDraftJobSourceSite(greenhouse)).toBe(false);
  });

  test("filters search results to source-specific job URLs when known", () => {
    const targets = buildSearchTargets({
      keywords: ["Agentic"],
      domains: [],
      sites: resolveJobSourceSites(["greenhouse", "gem", "oracle-cloud"]),
      timeFilter: "24hours",
      includeRemote: true,
      location: null,
    });

    const greenhouse = targets.find((target) => target.sourceId === "greenhouse");
    const gem = targets.find((target) => target.sourceId === "gem");
    const oracle = targets.find((target) => target.sourceId === "oracle-cloud");

    if (
      greenhouse?.kind !== "search-query" ||
      gem?.kind !== "search-query" ||
      oracle?.kind !== "search-query"
    ) {
      throw new Error("Expected search-query targets");
    }

    expect(
      greenhouse.filter([
        {
          title: "AI Engineer",
          url: "https://job-boards.greenhouse.io/sezzle/jobs/7633951003",
          description: "",
        },
        {
          title: "Company blog",
          url: "https://greenhouse.io/blog/agentic-recruiting",
          description: "",
        },
      ]),
    ).toHaveLength(1);

    expect(
      gem.filter([
        { title: "Gem homepage", url: "https://www.gem.com/?i=1", description: "" },
        { title: "Gem role", url: "https://www.gem.com/jobs/agentic-engineer", description: "" },
      ]),
    ).toEqual([
      { title: "Gem role", url: "https://www.gem.com/jobs/agentic-engineer", description: "" },
    ]);

    expect(
      oracle.filter([
        {
          title: "OCI Agent Development Kit",
          url: "https://docs.oracle.com/en-us/iaas/Content/generative-ai-agent/adk.htm",
          description: "",
        },
        {
          title: "Software Engineer",
          url: "https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/123456",
          description: "",
        },
      ]),
    ).toHaveLength(1);
  });

  test("recognizes Linear Careers job URLs without letting the careers index through", () => {
    const targets = buildSearchTargets({
      keywords: ["Agentic"],
      domains: [],
      sites: resolveJobSourceSites(["linear-careers"]),
      timeFilter: "24hours",
      includeRemote: true,
      location: null,
    });
    const linear = targets.find((target) => target.sourceId === "linear-careers");
    if (linear?.kind !== "search-query") {
      throw new Error("Expected Linear Careers search-query target");
    }

    expect(linear.query).toContain('"Agentic" site:linear.app/careers');
    expect(
      linear.filter([
        {
          title: "We're hiring",
          url: "https://linear.app/careers",
          description: "Open roles",
        },
        {
          title: "Senior / Staff Product Engineer, AI",
          url: "https://linear.app/careers/069c4628-88d7-4e4d-b393-c996fc7f3076",
          description: "Europe, North America",
        },
      ]),
    ).toEqual([
      {
        title: "Senior / Staff Product Engineer, AI",
        url: "https://linear.app/careers/069c4628-88d7-4e4d-b393-c996fc7f3076",
        description: "Europe, North America",
      },
    ]);
  });

  test("filters obvious stale or ineligible search-result snippets before persistence", () => {
    const targets = buildSearchTargets({
      keywords: ["Agentic"],
      domains: [],
      sites: resolveJobSourceSites(["lever"]),
      timeFilter: "24hours",
      includeRemote: true,
      location: null,
    });
    const lever = targets.find((target) => target.sourceId === "lever");
    if (lever?.kind !== "search-query") {
      throw new Error("Expected Lever search-query target");
    }

    expect(
      lever.filter([
        {
          title: "Agentic AI Architect - Remote, Latin America",
          url: "https://jobs.lever.co/acme/89c314c1-4e6e-4b41-87ba-61a9ea3bc5d6",
          description: "Remote role for LATAM.",
        },
        {
          title: "Senior Agentic Engineer",
          url: "https://jobs.lever.co/acme/19c314c1-4e6e-4b41-87ba-61a9ea3bc5d6",
          description: "This job has expired.",
        },
        {
          title: "Controller - Redpanda Data | Built In",
          url: "https://jobs.lever.co/acme/39c314c1-4e6e-4b41-87ba-61a9ea3bc5d6",
          description: "Hiring Remotely in United States.",
        },
        {
          title: "Sr. Agentic AI Sales Executive",
          url: "https://jobs.lever.co/acme/49c314c1-4e6e-4b41-87ba-61a9ea3bc5d6",
          description: "Remote - US.",
        },
        {
          title: "DevOps Engineer Consultant (US/Canada)",
          url: "https://jobs.lever.co/acme/59c314c1-4e6e-4b41-87ba-61a9ea3bc5d6",
          description: "Build agentic automation.",
        },
        {
          title: "Sr. Director, Analyst AI-Native, Agentic and Low-Code",
          url: "https://jobs.lever.co/acme/remote---united-states/69c314c1-4e6e-4b41-87ba-61a9ea3bc5d6",
          description: "Remote UK and Ireland also appear in the page title.",
        },
        {
          title: "Senior Agentic Engineer",
          url: "https://jobs.lever.co/acme/29c314c1-4e6e-4b41-87ba-61a9ea3bc5d6",
          description: "Remote across Europe.",
        },
      ]),
    ).toEqual([
      {
        title: "Senior Agentic Engineer",
        url: "https://jobs.lever.co/acme/29c314c1-4e6e-4b41-87ba-61a9ea3bc5d6",
        description: "Remote across Europe.",
      },
    ]);
  });

  test("keeps source-specific query shapes and date-sensitive direct URLs explicit", () => {
    const linkedin = JOB_SOURCE_SITES.find((site) => site.id === "linkedin");
    const adp = JOB_SOURCE_SITES.find((site) => site.id === "adp");
    const otherPages = JOB_SOURCE_SITES.find((site) => site.id === "other-pages");
    if (!linkedin || !adp || !otherPages) {
      throw new Error("Expected LinkedIn, ADP, and Other Pages sources to be registered");
    }

    const linkedinRecent = buildJobSourceSearchTarget(linkedin, {
      keyword: "Agentic",
      includeRemote: true,
      location: null,
      timeFilter: "24hours",
    });
    expect(linkedinRecent.kind).toBe("direct-url");
    if (linkedinRecent.kind === "direct-url") {
      expect(linkedinRecent.url).toContain("f_TPR=r86400");
    }

    const linkedinOlder = buildJobSourceSearchTarget(linkedin, {
      keyword: "Agentic",
      includeRemote: true,
      location: null,
      timeFilter: "older3months",
    });
    expect(linkedinOlder.kind).toBe("search-query");
    if (linkedinOlder.kind === "search-query") {
      expect(linkedinOlder.query).toContain("site:linkedin.com/jobs/view");
    }

    const adpTarget = buildJobSourceSearchTarget(adp, {
      keyword: "Agentic",
      includeRemote: true,
      location: "Europe",
      timeFilter: "week",
    });
    expect(adpTarget.kind).toBe("search-query");
    if (adpTarget.kind === "search-query") {
      expect(adpTarget.query).toContain("site:workforcenow.adp.com OR site:myjobs.adp.com");
      expect(adpTarget.query).toContain("remote Europe");
      expect(adpTarget.query).toContain('-"US Remote"');
    }

    const otherTarget = buildJobSourceSearchTarget(otherPages, {
      keyword: "Agentic",
      includeRemote: false,
      location: null,
      timeFilter: "week",
    });
    expect(otherTarget.kind).toBe("search-query");
    if (otherTarget.kind === "search-query") {
      expect(otherTarget.query).toContain("site:*/employment/*");
      expect(otherTarget.query).not.toContain("remote");
    }
  });
});
