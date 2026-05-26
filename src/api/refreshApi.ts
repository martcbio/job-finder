import { listFastRefreshSources } from "../pipeline/fastRefresh";
import { ApiError } from "./errors";

export function uniqueFastRefreshSources(): ReturnType<typeof listFastRefreshSources> {
  const sources = new Map<string, ReturnType<typeof listFastRefreshSources>[number]>();
  for (const source of listFastRefreshSources()) {
    if (!sources.has(source.id)) sources.set(source.id, source);
  }
  return [...sources.values()];
}

export function fastRefreshSourceId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  const sourceId = normalized === "linear" ? "linear-careers" : normalized;
  const valid = new Set(uniqueFastRefreshSources().map((source) => source.id));
  if (!valid.has(sourceId)) {
    throw new ApiError(400, "invalid_source", `Unsupported refresh source "${value}"`, {
      valid: [...valid],
    });
  }
  return sourceId;
}
