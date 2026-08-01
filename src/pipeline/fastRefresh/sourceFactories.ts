import { fetchGoogleCareersJobs, fetchLinearCareersJobs } from "../directSources";
import { fetchLiveJobServeRoles, jobServeRoleToNormalizedJob } from "../jobserveLive";
import type { SourceOutcome } from "../sourceAdapterContract";
import type { RegisteredJobSource, SourceAdapterFactory } from "../sourceRegistry";
import type { FastRefreshCosts } from "./types";

const ZERO_COSTS: FastRefreshCosts = {
  jinaSearchTokens: 0,
  jinaReaderTokens: 0,
  openAiTokens: 0,
  billableSearchApiCalls: 0,
};

export const buildJobServeAdapters: SourceAdapterFactory = (source, options) => {
  let runWideBlockedReason: string | null = null;
  return options.jobserveQueries.map((query) => ({
    ...adapterMetadata(source),
    defaultKeyword: query,
    async discover(input) {
      if (runWideBlockedReason) {
        return {
          source: adapterMetadata(source),
          keyword: query,
          outcome: "blocked_robots_or_waf",
          discovered: 0,
          excluded: 0,
          jobs: [],
          pagesFetched: 0,
          costs: ZERO_COSTS,
          errors: [
            `JobServe query skipped because an earlier JobServe query was usage-restricted: ${runWideBlockedReason}`,
          ],
          blockedReason: runWideBlockedReason,
        };
      }

      const result = await fetchLiveJobServeRoles({
        query,
        maxPages: options.jobserveMaxPages,
        timeoutMs: input.timeoutMs,
        detailLimit: input.limit,
      });
      if (result.blockedReason) runWideBlockedReason = result.blockedReason;
      const jobs = result.roles.map((role) => jobServeRoleToNormalizedJob(role, query));
      return {
        source: adapterMetadata(source),
        keyword: query,
        outcome: discoveryOutcome(jobs.length, result.errors, result.blockedReason),
        discovered: result.roles.length,
        excluded: 0,
        jobs,
        pagesFetched: result.pagesFetched,
        costs: ZERO_COSTS,
        errors: result.errors,
        blockedReason: result.blockedReason,
      };
    },
  }));
};

export const buildLinearCareersAdapters: SourceAdapterFactory = (source) => [
  {
    ...adapterMetadata(source),
    defaultKeyword: source.id,
    async discover(input) {
      const result = await fetchLinearCareersJobs({
        timeoutMs: input.timeoutMs,
      });
      return {
        source: adapterMetadata(source),
        keyword: source.id,
        outcome: discoveryOutcome(result.jobs.length, result.errors, null),
        discovered: result.discovered,
        excluded: Math.max(0, result.discovered - result.jobs.length),
        jobs: result.jobs,
        pagesFetched: result.pagesFetched,
        costs: ZERO_COSTS,
        errors: result.errors,
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
        timeoutMs: input.timeoutMs,
      });
      return {
        source: adapterMetadata(source),
        keyword: source.id,
        outcome: discoveryOutcome(result.jobs.length, result.errors, null, result.truncated),
        discovered: result.discovered,
        excluded: Math.max(0, result.discovered - result.jobs.length),
        jobs: result.jobs,
        pagesFetched: result.pagesFetched,
        costs: ZERO_COSTS,
        errors: result.errors,
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

export function discoveryOutcome(
  jobCount: number,
  errors: readonly string[],
  blockedReason: string | null,
  truncated = false,
): SourceOutcome {
  if (blockedReason) return "blocked_robots_or_waf";
  if (truncated) return "partial";
  if (errors.length > 0) return "http_error";
  return jobCount > 0 ? "success" : "zero_results";
}
