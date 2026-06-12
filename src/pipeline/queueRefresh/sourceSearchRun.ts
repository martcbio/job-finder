import { SEARCH_KEYWORDS } from "../../config/search";
import { planMigrations } from "../../db/migrations";
import { fetchDiscoveryWithUsage } from "../discovery";
import {
  completeSearchQuery,
  completeSearchRun,
  createSearchQuery,
  createSearchRun,
  persistSearchResult,
} from "../searchPersistence";
import { buildSearchTargets } from "../searchTargets";
import type { TimeFilter } from "../searchEngines";
import { resolveJobSourceSites } from "../sourceSites";
import { sourceAdapterFor } from "../fastRefresh/summaries";
import type { FastRefreshSourceSummary } from "../fastRefresh/types";
import { ZERO_COSTS } from "../fastRefresh/types";
import { sourceAttemptStatus } from "../sourceAdapterContract";
import type { SourceOutcome } from "../sourceAdapterContract";

export interface SourceSearchRunOptions {
  siteIds: string[];
  keywords?: string[];
  timeFilter?: TimeFilter;
  includeRemote?: boolean;
  location?: string | null;
  maxQueries?: number;
  limitPerQuery?: number;
  timeoutMs?: number;
}

export interface SourceSearchRunResult {
  runId: number;
  status: string;
  targets: number;
  successfulQueries: number;
  totalResults: number;
  totalReportedTokens: number;
  errors: Array<{ label: string; error: string }>;
  perSite: Array<{ sourceId: string; results: number; status: SourceOutcome }>;
}

function errorStatus(message: string): "timeout" | "error" {
  return message.toLowerCase().includes("timed out") ? "timeout" : "error";
}

async function assertMigrationsReady(): Promise<void> {
  const plan = await planMigrations();
  if (plan.pending.length > 0) {
    throw new Error(
      `Database has ${plan.pending.length} pending migration(s). Run bun run db:migrate.`,
    );
  }
}

export async function runSourceSearchForSites(
  input: SourceSearchRunOptions,
): Promise<SourceSearchRunResult | null> {
  if (input.siteIds.length === 0) return null;

  await assertMigrationsReady();

  const sites = resolveJobSourceSites(input.siteIds);
  const defaultKeyword = SEARCH_KEYWORDS[0];
  if (!defaultKeyword) throw new Error("SEARCH_KEYWORDS must contain at least one keyword");

  const keywords = input.keywords?.length ? input.keywords : [defaultKeyword];
  const timeFilter = input.timeFilter ?? "24hours";
  const includeRemote = input.includeRemote ?? true;
  const location = input.location ?? null;
  const limitPerQuery = input.limitPerQuery ?? 6;
  const timeoutMs = input.timeoutMs ?? 20000;

  const targets = buildSearchTargets({
    keywords,
    domains: [],
    sites,
    timeFilter,
    includeRemote,
    location,
  });
  const maxQueries = input.maxQueries ?? Math.min(targets.length, 40);
  const selectedTargets = targets.slice(0, maxQueries);

  const runId = await createSearchRun({
    keyword: keywords.join(", "),
    sourceSet: sites.map((site) => site.id),
    timeFilter,
    includeRemote,
    location,
    limitPerQuery,
    timeoutMs,
  });

  const errors: Array<{ label: string; error: string }> = [];
  const perSite = new Map<string, { results: number; status: SourceOutcome }>();
  let successfulQueries = 0;
  let totalReportedTokens = 0;
  let totalResults = 0;

  for (const target of selectedTargets) {
    const queryId = await createSearchQuery({ runId, target });
    const siteId = target.sourceId;

    if (target.kind === "direct-url") {
      await persistSearchResult({
        queryId,
        rank: 1,
        sourceLabel: target.label,
        item: { title: target.label, url: target.url, description: "" },
      });
      successfulQueries += 1;
      totalResults += 1;
      bumpSite(perSite, siteId, 1, "success");
      continue;
    }

    try {
      const call = await fetchDiscoveryWithUsage(
        target.query,
        {
          braveApiKey: process.env.BRAVE_API_KEY ?? "",
          jinaApiKey: process.env.JINA_API_KEY ?? "",
        },
        { timeoutMs, provider: "auto", count: limitPerQuery },
      );
      const items = target.filter(call.results).slice(0, limitPerQuery);

      for (const [itemIndex, item] of items.entries()) {
        await persistSearchResult({
          queryId,
          rank: itemIndex + 1,
          sourceLabel: target.label,
          item,
        });
      }

      await completeSearchQuery({
        queryId,
        status: "success",
        usageTokens: call.usage.tokens,
        decompressedBytes: call.usage.decompressedContentLength,
        error: null,
      });

      if (call.usage.tokens !== null) totalReportedTokens += call.usage.tokens;
      totalResults += items.length;
      successfulQueries += 1;
      bumpSite(
        perSite,
        siteId,
        items.length,
        items.length > 0 ? "success" : "zero_results",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ label: target.label, error: message });
      await completeSearchQuery({
        queryId,
        status: errorStatus(message),
        usageTokens: null,
        decompressedBytes: null,
        error: message,
      });
      bumpSite(perSite, siteId, 0, errorStatus(message) === "timeout" ? "timeout" : "http_error");
    }
  }

  const status =
    errors.length === 0 ? "completed" : successfulQueries > 0 ? "completed_with_errors" : "failed";
  await completeSearchRun({
    runId,
    status,
    totalReportedTokens,
    errorSummary:
      errors.length > 0 ? errors.map((e) => `${e.label}: ${e.error}`).join("\n") : null,
  });

  return {
    runId,
    status,
    targets: selectedTargets.length,
    successfulQueries,
    totalResults,
    totalReportedTokens,
    errors,
    perSite: [...perSite.entries()].map(([sourceId, value]) => ({ sourceId, ...value })),
  };
}

function bumpSite(
  perSite: Map<string, { results: number; status: SourceOutcome }>,
  sourceId: string,
  results: number,
  status: SourceOutcome,
): void {
  const prev = perSite.get(sourceId);
  if (!prev) {
    perSite.set(sourceId, { results, status });
    return;
  }
  perSite.set(sourceId, {
    results: prev.results + results,
    status: prev.status === "success" || status === "success" ? "success" : status,
  });
}

export function searchRunToSourceSummaries(
  run: SourceSearchRunResult,
): FastRefreshSourceSummary[] {
  return run.perSite.map((site) => {
    const adapter = sourceAdapterFor(site.sourceId, null, null);
    const errors = run.errors
      .filter((e) => e.label.toLowerCase().includes(site.sourceId.replace(/-/g, " ")))
      .map((e) => e.error);
    return {
      source: adapter,
      keyword: SEARCH_KEYWORDS[0] ?? "search",
      runId: run.runId,
      outcome: site.status,
      status: sourceAttemptStatus(site.status, site.results, errors),
      discovered: site.results,
      imported: 0,
      fullText: { persisted: 0, fetchedPages: null, status: "pending" as const },
      classification: { classified: 0 },
      costs: {
        ...ZERO_COSTS,
        jinaSearchTokens: run.totalReportedTokens,
        billableSearchApiCalls: run.successfulQueries,
      },
      elapsedMs: 0,
      errors,
      blockedReason: null,
    };
  });
}
