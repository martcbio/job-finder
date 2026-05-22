import { describe, expect, test } from "bun:test";
import { validateCandidateBeforePersist } from "../candidateValidation";

function result(url: string, title = "Senior Agentic Engineer") {
  return { title, url, description: "Remote across Europe" };
}

function jsonFetcher(status: number, body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

describe("validateCandidateBeforePersist", () => {
  test("accepts unsupported sources for normal downstream handling", async () => {
    const decision = await validateCandidateBeforePersist(result("https://example.com/jobs/1"));

    expect(decision.accepted).toBe(true);
  });

  test("rejects supported ATS candidates that are not live via the ATS API", async () => {
    const decision = await validateCandidateBeforePersist(
      result("https://jobs.lever.co/acme/89c314c1-4e6e-4b41-87ba-61a9ea3bc5d6"),
      jsonFetcher(404, { error: "not found" }),
    );

    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.reason).toContain("lever API");
    }
  });

  test("accepts supported ATS candidates that return structured data", async () => {
    const decision = await validateCandidateBeforePersist(
      result("https://jobs.lever.co/acme/89c314c1-4e6e-4b41-87ba-61a9ea3bc5d6"),
      jsonFetcher(200, {
        categories: { location: "Remote - Europe", allLocations: ["Remote - Europe"] },
        workplaceType: "remote",
        country: null,
      }),
    );

    expect(decision.accepted).toBe(true);
  });
});
