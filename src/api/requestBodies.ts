import { type FastRefreshOptions, normalizeFastRefreshOptions } from "../pipeline/fastRefresh";
import type { SavedSweepInput } from "../pipeline/savedSweeps";
import {
  asOptionalString,
  nonEmptyStringArray,
  nullableString,
  optionalBoolean,
  optionalTimeFilter,
  positiveFloatValue,
  positiveIntValue,
  requiredString,
} from "./parse";
import { fastRefreshSourceId } from "./refreshApi";

export function savedSweepInputFromBody(body: Record<string, unknown>): SavedSweepInput {
  return {
    name: requiredString(body.name, "name"),
    keywords: nonEmptyStringArray(body.keywords, "keywords", ["Agentic"]),
    sites: nonEmptyStringArray(body.sites, "sites", ["greenhouse", "lever"]),
    timeFilter: optionalTimeFilter(asOptionalString(body.timeFilter), "24hours"),
    includeRemote: optionalBoolean(body.includeRemote, true),
    location: nullableString(body.location, "location"),
    maxQueries: positiveIntValue(body.maxQueries, "maxQueries", 12, 500),
    searchLimit: positiveIntValue(body.searchLimit, "searchLimit", 5, 50),
    searchTimeoutMs: positiveIntValue(body.searchTimeoutMs, "searchTimeoutMs", 30000, 300000),
    pageLimit: positiveIntValue(body.pageLimit, "pageLimit", 10, 500),
    pageTimeoutMs: positiveIntValue(body.pageTimeoutMs, "pageTimeoutMs", 45000, 300000),
    classifyLimit: positiveIntValue(body.classifyLimit, "classifyLimit", 50, 1000),
    duplicateLimit: positiveIntValue(body.duplicateLimit, "duplicateLimit", 250, 5000),
    duplicateThreshold: positiveFloatValue(body.duplicateThreshold, "duplicateThreshold", 0.82),
    queueLimit: positiveIntValue(body.queueLimit, "queueLimit", 25, 250),
    enabled: optionalBoolean(body.enabled, true),
  };
}

export function fastRefreshOptionsFromBody(
  body: Record<string, unknown>,
): Partial<FastRefreshOptions> {
  return normalizeFastRefreshOptions({
    ...(body.limit === undefined ? {} : { limit: positiveIntValue(body.limit, "limit", 20, 250) }),
    ...(body.sourceIds === undefined
      ? {}
      : {
          sourceIds: nonEmptyStringArray(body.sourceIds, "sourceIds", []).map(fastRefreshSourceId),
        }),
    ...(body.jobserveQueries === undefined
      ? {}
      : {
          jobserveQueries: nonEmptyStringArray(body.jobserveQueries, "jobserveQueries", []),
        }),
    ...(body.jobserveMaxPages === undefined
      ? {}
      : { jobserveMaxPages: positiveIntValue(body.jobserveMaxPages, "jobserveMaxPages", 2, 2) }),
    ...(body.jobserveImportLimitPerQuery === undefined
      ? {}
      : {
          jobserveImportLimitPerQuery: positiveIntValue(
            body.jobserveImportLimitPerQuery,
            "jobserveImportLimitPerQuery",
            5,
            5,
          ),
        }),
    ...(body.timeoutMs === undefined
      ? {}
      : { timeoutMs: positiveIntValue(body.timeoutMs, "timeoutMs", 20000, 300000) }),
    ...(body.classifyLimit === undefined
      ? {}
      : { classifyLimit: positiveIntValue(body.classifyLimit, "classifyLimit", 250, 5000) }),
  });
}
