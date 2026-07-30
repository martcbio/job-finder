import { fetchGoogleCareersJobs, fetchLinearCareersJobs } from "../directSources";
import { fetchLiveJobServeRoles, jobServeRoleToNormalizedJob } from "../jobserveLive";
import type { RegisteredJobSource, SourceAdapterFactory } from "../sourceRegistry";
import type { FastRefreshCosts } from "./types";

const ZERO_COSTS: FastRefreshCosts = {
  jinaSearchTokens: 0,
  jinaReaderTokens: 0,
  openAiTokens: 0,
  billableSearchApiCalls: 0,
};

export const buildJobServeAdapters: SourceAdapterFactory = (source, options) =>
  options.jobserveQueries.map((query) => ({
    ...adapterMetadata(source),
    defaultKeyword: query,
    async discover(input) {
      const result = await fetchLiveJobServeRoles({
        query,
        maxPages: options.jobserveMaxPages,
        timeoutMs: input.timeoutMs,
        detailLimit: input.limit,
      });
      const jobs = result.roles
        .slice(0, input.limit)
        .map((role) => jobServeRoleToNormalizedJob(role, query));
      return {
        source: adapterMetadata(source),
        keyword: query,
        outcome: result.blockedReason
          ? "blocked_robots_or_waf"
          : jobs.length > 0
            ? "success"
            : "zero_results",
        discovered: result.roles.length + result.excludedRoles.length,
        excluded: result.excludedRoles.length,
        jobs,
        pagesFetched: result.pagesFetched,
        costs: ZERO_COSTS,
        errors: result.errors,
        blockedReason: result.blockedReason,
      };
    },
  }));

export const buildLinearCareersAdapters: SourceAdapterFactory = (source) => [
  {
    ...adapterMetadata(source),
    defaultKeyword: source.id,
    async discover(input) {
      const result = await fetchLinearCareersJobs({
        limit: input.limit,
        timeoutMs: input.timeoutMs,
      });
      return {
        source: adapterMetadata(source),
        keyword: source.id,
        outcome: result.jobs.length > 0 ? "success" : "zero_results",
        discovered: result.discovered,
        excluded: 0,
        jobs: result.jobs,
        pagesFetched: null,
        costs: ZERO_COSTS,
        errors: [],
        blockedReason: null,
      };
    },
  },
];

export const buildGoogleCareersAdapters: SourceAdapterFactory = (source) => [
  {
    ...adapterMetadata(source),
    defaultKeyword: source.id,
    async discover(input) {
      const result = await fetchGoogleCareersJobs({
        limit: input.limit,
        timeoutMs: input.timeoutMs,
      });
      return {
        source: adapterMetadata(source),
        keyword: source.id,
        outcome: result.jobs.length > 0 ? "success" : "zero_results",
        discovered: result.discovered,
        excluded: Math.max(0, result.discovered - result.jobs.length),
        jobs: result.jobs,
        pagesFetched: result.jobs.length + 1,
        costs: ZERO_COSTS,
        errors: [],
        blockedReason: null,
      };
    },
  },
];

function adapterMetadata(source: RegisteredJobSource) {
  return {
    id: source.id,
    label: source.label,
    kind: source.kind,
    quality: source.quality,
  };
}
