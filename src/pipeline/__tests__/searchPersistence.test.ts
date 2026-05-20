import { describe, expect, test } from "bun:test";
import { canonicalizeJobUrl, companyHintFromUrl } from "../searchPersistence";

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
