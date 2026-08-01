import { describe, expect, test } from "bun:test";
import {
  assertSourceDiscoveryResultContract,
  describeSourceAdapter,
  type FastRefreshSourceAdapter,
  sourceAttemptStatus,
} from "../sourceAdapterContract";

const fixtureAdapter: FastRefreshSourceAdapter = {
  id: "fixture-board",
  label: "Fixture Board",
  kind: "aggregator",
  quality: "low",
  defaultKeyword: "agentic",
  async discover(input) {
    return {
      source: {
        id: "fixture-board",
        label: "Fixture Board",
        kind: "aggregator",
        quality: "low",
      },
      keyword: input.keyword,
      outcome: "success",
      discovered: 1,
      excluded: 0,
      pagesFetched: null,
      costs: {
        jinaSearchTokens: 0,
        jinaReaderTokens: 0,
        openAiTokens: 0,
        billableSearchApiCalls: 0,
      },
      errors: [],
      blockedReason: null,
      jobs: [
        {
          sourceId: "fixture-board",
          sourceLabel: "Fixture Board",
          searchLabel: "Fixture Board agentic",
          searchTerm: input.keyword,
          title: "Agentic Systems Engineer",
          company: "Example AI",
          url: "https://example.ai/careers/agentic-systems-engineer",
          sourceUrl: "https://fixture.example/jobs/123",
          description: "Build agentic workflows for enterprise customers.",
          location: "Remote, Europe",
          employmentType: "Full time",
          compensation: null,
          raw: {
            discoveredAt: "2026-05-23T00:00:00.000Z",
            fetchStrategy: "fixture_api",
            remoteHint: "remote_europe",
          },
        },
      ],
    };
  },
};

describe("source adapter contract", () => {
  test("describes a new adapter without changing the API response shape", () => {
    expect(describeSourceAdapter(fixtureAdapter, false)).toEqual({
      id: "fixture-board",
      label: "Fixture Board",
      kind: "aggregator",
      quality: "low",
      defaultKeyword: "agentic",
      defaultIncluded: false,
      supportsSourceScopedRefresh: true,
    });
  });

  test("validates fixture adapter discovery into normalized candidate evidence", async () => {
    const result = await fixtureAdapter.discover({
      keyword: "agentic",
      limit: 1,
      timeoutMs: 1000,
    });
    const snapshot = assertSourceDiscoveryResultContract(result);

    expect(snapshot).toMatchObject({
      source: {
        id: "fixture-board",
        label: "Fixture Board",
        kind: "aggregator",
        quality: "low",
      },
      keyword: "agentic",
      status: "success",
      outcome: "success",
      discovered: 1,
      excluded: 0,
      candidateCount: 1,
      pagesFetched: null,
      costs: {
        jinaSearchTokens: 0,
        jinaReaderTokens: 0,
        openAiTokens: 0,
        billableSearchApiCalls: 0,
      },
      errors: [],
      blockedReason: null,
    });
    expect(snapshot.candidates[0]).toEqual({
      sourceId: "fixture-board",
      sourceLabel: "Fixture Board",
      candidateUrl: "https://fixture.example/jobs/123",
      canonicalUrl: "https://example.ai/careers/agentic-systems-engineer",
      title: "Agentic Systems Engineer",
      company: "Example AI",
      location: "Remote, Europe",
      remoteHint: "remote_europe",
      discoveredAt: "2026-05-23T00:00:00.000Z",
      searchTerm: "agentic",
      rawPresent: true,
      fetchStrategy: "fixture_api",
      failureReason: null,
    });
  });

  test("fails loudly when an adapter omits required normalized fields", () => {
    expect(() =>
      assertSourceDiscoveryResultContract({
        source: {
          id: "fixture-board",
          label: "Fixture Board",
          kind: "aggregator",
          quality: "low",
        },
        keyword: "agentic",
        outcome: "success",
        discovered: 1,
        excluded: 0,
        pagesFetched: null,
        costs: {
          jinaSearchTokens: 0,
          jinaReaderTokens: 0,
          openAiTokens: 0,
          billableSearchApiCalls: 0,
        },
        errors: [],
        blockedReason: null,
        jobs: [
          {
            sourceId: "fixture-board",
            sourceLabel: "Fixture Board",
            searchLabel: null,
            searchTerm: "agentic",
            title: "",
            company: null,
            url: "https://example.ai/careers/agentic-systems-engineer",
            sourceUrl: null,
            description: "Missing title.",
            location: null,
            employmentType: null,
            compensation: null,
            raw: {},
          },
        ],
      }),
    ).toThrow("jobs[0].title must be a non-empty string");
  });

  test("fails loudly when success and zero-results outcomes are internally inconsistent", () => {
    expect(() =>
      assertSourceDiscoveryResultContract({
        source: {
          id: "fixture-board",
          label: "Fixture Board",
          kind: "aggregator",
          quality: "low",
        },
        keyword: "agentic",
        outcome: "success",
        discovered: 0,
        excluded: 0,
        pagesFetched: null,
        costs: {
          jinaSearchTokens: 0,
          jinaReaderTokens: 0,
          openAiTokens: 0,
          billableSearchApiCalls: 0,
        },
        errors: [],
        blockedReason: null,
        jobs: [],
      }),
    ).toThrow("result.outcome success requires at least one normalized job; use zero_results");

    expect(() =>
      assertSourceDiscoveryResultContract({
        source: {
          id: "fixture-board",
          label: "Fixture Board",
          kind: "aggregator",
          quality: "low",
        },
        keyword: "agentic",
        outcome: "zero_results",
        discovered: 1,
        excluded: 0,
        pagesFetched: null,
        costs: {
          jinaSearchTokens: 0,
          jinaReaderTokens: 0,
          openAiTokens: 0,
          billableSearchApiCalls: 0,
        },
        errors: [],
        blockedReason: null,
        jobs: [
          {
            sourceId: "fixture-board",
            sourceLabel: "Fixture Board",
            searchLabel: null,
            searchTerm: "agentic",
            title: "Agentic Systems Engineer",
            company: null,
            url: "https://example.ai/careers/agentic-systems-engineer",
            sourceUrl: null,
            description: "Should not exist for zero_results.",
            location: null,
            employmentType: null,
            compensation: null,
            raw: {},
          },
        ],
      }),
    ).toThrow("result.outcome zero_results cannot include normalized jobs");
  });

  test("does not let an error snippet override partially imported jobs", () => {
    expect(sourceAttemptStatus("http_error", 1, ["HTTP 401 from a later page"])).toBe("partial");
    expect(sourceAttemptStatus("http_error", 1, ["HTTP 429 rate limited"])).toBe("partial");
    expect(sourceAttemptStatus("http_error", 0, ["HTTP 401"])).toBe("auth_required");
    expect(sourceAttemptStatus("http_error", 0, ["HTTP 429 rate limited"])).toBe("rate_limited");
    expect(sourceAttemptStatus("http_error", 0, ["Job URL includes /roles/429/engineer"])).toBe(
      "partial",
    );
    expect(sourceAttemptStatus("http_error", 0, ["salary rate was unavailable"])).toBe("partial");
  });
});
