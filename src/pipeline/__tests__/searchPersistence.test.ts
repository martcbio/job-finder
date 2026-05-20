import { describe, expect, test } from "bun:test";
import {
  atsIdentityFromUrl,
  buildPersistSearchResultSql,
  canonicalizeJobUrl,
  companyHintFromUrl,
} from "../searchPersistence";

describe("canonicalizeJobUrl", () => {
  test("normalizes scheme, host, fragments, tracking params, and trailing slash", () => {
    expect(
      canonicalizeJobUrl("http://WWW.JOBS.LEVER.CO/netomi/c81f?utm_source=x&b=2&a=1#apply"),
    ).toBe("https://jobs.lever.co/netomi/c81f?a=1&b=2");
  });

  test("keeps meaningful query params", () => {
    expect(canonicalizeJobUrl("https://example.com/job?id=123&source=indeed")).toBe(
      "https://example.com/job?id=123",
    );
  });
});

describe("atsIdentityFromUrl", () => {
  test("extracts stable identities for supported ATS URLs", () => {
    expect(atsIdentityFromUrl("https://job-boards.greenhouse.io/webflow/jobs/123")).toEqual({
      source: "greenhouse",
      org: "webflow",
      jobId: "123",
      canonicalKey: "ats:greenhouse:webflow:123",
    });
    expect(atsIdentityFromUrl("https://jobs.lever.co/netomi/c81f")).toEqual({
      source: "lever",
      org: "netomi",
      jobId: "c81f",
      canonicalKey: "ats:lever:netomi:c81f",
    });
    expect(atsIdentityFromUrl("https://jobs.ashbyhq.com/render/abc")).toEqual({
      source: "ashby",
      org: "render",
      jobId: "abc",
      canonicalKey: "ats:ashby:render:abc",
    });
    expect(atsIdentityFromUrl("https://apply.workable.com/acme/j/ABC123/")).toEqual({
      source: "workable",
      org: "acme",
      jobId: "ABC123",
      canonicalKey: "ats:workable:acme:abc123",
    });
  });

  test("returns null for unsupported URLs", () => {
    expect(atsIdentityFromUrl("https://example.com/jobs/42")).toBeNull();
  });
});

describe("buildPersistSearchResultSql", () => {
  test("persists ATS identity and uses it to find existing jobs", () => {
    const sql = buildPersistSearchResultSql({
      queryId: 7,
      rank: 1,
      sourceLabel: "Greenhouse",
      item: {
        title: "Staff AI Engineer",
        description: "Build agent systems",
        url: "https://job-boards.greenhouse.io/webflow/jobs/123?gh_src=x",
      },
    });

    expect(sql).toContain("ats_source");
    expect(sql).toContain("'greenhouse'");
    expect(sql).toContain("'webflow'");
    expect(sql).toContain("'123'");
    expect(sql).toContain("'ats:greenhouse:webflow:123'");
    expect(sql).toContain("existing_job AS");
  });
});

describe("companyHintFromUrl", () => {
  test("extracts common ATS company hints", () => {
    expect(
      companyHintFromUrl("Lever", "https://jobs.lever.co/netomi/abc", "Netomi - Engineer"),
    ).toBe("Netomi");
    expect(
      companyHintFromUrl("Greenhouse", "https://job-boards.greenhouse.io/webflow/jobs/1", ""),
    ).toBe("Webflow");
    expect(companyHintFromUrl("Ashby", "https://jobs.ashbyhq.com/render/abc", "")).toBe("Render");
  });

  test("falls back to title prefix or host", () => {
    expect(companyHintFromUrl("Other", "https://example.com/jobs/1", "Acme - Engineer")).toBe(
      "Acme",
    );
    expect(companyHintFromUrl("Other", "https://example.com/jobs/1", "Engineer")).toBe("Example");
  });
});
