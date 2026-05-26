import { screenJob, type JobScreeningDecision } from "../jobScreening";
import {
  type JobServeContractRow,
  type RankedJobServeContract,
  rankJobServeContract,
} from "../jobserveContracts";
import type { SourceAdapter } from "../sourceAdapterContract";
import type {
  FastRefreshCosts,
  FastRefreshJobRow,
  FastRefreshSourceSummary,
  JobSummary,
  JobSummaryLink,
} from "./types";
import { JINA_READER_COST_UNKNOWN as JINA_COST, ZERO_COSTS as ZERO } from "./types";
import {
  extractLocation,
  extractMarkdownMetadata,
  extractPostedAt,
  hostname,
  numberOrNull,
  numberOrZero,
  sourceIdFromUrl,
  titleCase,
} from "./utils";

export function jobRowToSummary(
  row: FastRefreshJobRow,
  rankingOverride?: RankedJobServeContract,
): JobSummary {
  const labels = Array.isArray(row.labels) ? row.labels : [];
  const screening = screenJob({
    title: row.title,
    companyHint: row.company,
    canonicalUrl: row.canonical_url,
    markdown: row.markdown,
    descriptionSample: row.description_sample,
    labels,
  });
  const ranked = rankingOverride ?? inferredJobServeRanking(row);

  return {
    id: Number(row.id),
    title: row.title,
    company: row.company,
    location: extractLocation(row.markdown, row.description_sample),
    source: sourceAdapterFor(row.source_id, row.source_label, row.canonical_url),
    links: linksForJob(row),
    classification: {
      category: row.category,
      labels: labels.map((label) => label.label),
      ragFocus: row.rag_focus,
      enterpriseFocus: row.enterprise_focus,
      confidence: numberOrNull(row.classification_confidence),
      reason: row.classification_reason,
    },
    eligibility: eligibilityFromScreening(screening),
    ingest: {
      fullTextStatus: fullTextStatus(row),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      postedAt: ranked?.postedAt?.toISOString() ?? extractPostedAt(row.markdown),
    },
    ranking: rankingForJob(row, ranked),
    reviewState: row.review_state,
    dedupe: {
      candidateCount: row.duplicate_candidates.length,
      groups: row.duplicate_candidates.map((candidate) => ({
        id: candidate.id,
        state: candidate.state,
        confidence: numberOrZero(candidate.confidence),
        reason: candidate.reason,
      })),
    },
    cost: costsForJob(row),
  };
}

export function orderJobSummaries(
  rows: FastRefreshJobRow[],
  orderedIds: number[],
  rankedById: Map<number, RankedJobServeContract>,
): JobSummary[] {
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const ordered = orderedIds
    .map((id) => rowsById.get(id))
    .filter((row): row is FastRefreshJobRow => row !== undefined)
    .map((row) => jobRowToSummary(row, rankedById.get(row.id)));
  const seen = new Set<number>();
  return ordered.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

export function mergeJobRows(...groups: FastRefreshJobRow[][]): FastRefreshJobRow[] {
  const rows = new Map<number, FastRefreshJobRow>();
  for (const group of groups) {
    for (const row of group) rows.set(row.id, row);
  }
  return [...rows.values()];
}

export function jobRowToJobServeContract(row: FastRefreshJobRow): JobServeContractRow {
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    url: row.canonical_url,
    lastSeenAt: row.last_seen_at,
    markdown: row.markdown ?? "",
    description: row.description_sample ?? "",
  };
}

export function aggregateCosts(rows: FastRefreshSourceSummary[]): FastRefreshCosts {
  return rows.reduce(
    (costs, row) => ({
      jinaSearchTokens: addNullable(costs.jinaSearchTokens, row.costs.jinaSearchTokens),
      jinaReaderTokens: addNullable(costs.jinaReaderTokens, row.costs.jinaReaderTokens),
      openAiTokens: addNullable(costs.openAiTokens, row.costs.openAiTokens),
      billableSearchApiCalls: addNullable(
        costs.billableSearchApiCalls,
        row.costs.billableSearchApiCalls,
      ),
    }),
    { ...ZERO },
  );
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return left + right;
}

function linksForJob(row: FastRefreshJobRow): JobSummaryLink[] {
  const links: JobSummaryLink[] = [];
  pushLink(links, "canonical", row.canonical_url);
  if (row.observed_url && row.observed_url !== row.canonical_url)
    pushLink(links, "source", row.observed_url);
  for (const [kind, label] of [
    ["apply", "Apply URL"],
    ["source", "Source URL"],
    ["employer", "Detail URL"],
  ] as const) {
    const url = extractMarkdownMetadata(row.markdown, label);
    if (url) pushLink(links, kind, url, linkBlockStatus(url));
  }
  return links;
}

function pushLink(
  links: JobSummaryLink[],
  kind: JobSummaryLink["kind"],
  url: string | null,
  blocked?: { blocked: boolean; note: string } | null,
): void {
  if (!url || links.some((link) => link.url === url && link.kind === kind)) return;
  links.push({ kind, url, ...(blocked ?? {}) });
}

function linkBlockStatus(url: string): { blocked: boolean; note: string } | null {
  const host = hostname(url);
  if (host.includes("jobg8.com")) {
    return {
      blocked: true,
      note: "JobG8 traffic/apply hops are often CAPTCHA-gated; keep source evidence but prefer readable canonical detail link.",
    };
  }
  if (host.includes("indeed.com")) {
    return {
      blocked: false,
      note: "Indeed link retained only when no better direct link is present.",
    };
  }
  return null;
}

function fullTextStatus(
  row: FastRefreshJobRow,
): "success" | "snippet_only" | "blocked" | "expired" | "error" | "pending" {
  if (row.page_status === "success" && row.markdown?.trim()) return "success";
  const error = `${row.page_error ?? ""}\n${row.markdown ?? ""}`;
  if (/captcha|access denied|verify you are human/i.test(error)) return "blocked";
  if (/expired|closed|no longer accepting/i.test(error)) return "expired";
  if (row.page_status === "error" || row.page_ingest_status === "error") return "error";
  if (row.description_sample?.trim()) return "snippet_only";
  return "pending";
}

function rankingForJob(
  row: FastRefreshJobRow,
  ranked: RankedJobServeContract | null | undefined,
): JobSummary["ranking"] {
  if (ranked) {
    return {
      tier: ranked.tier,
      score: 100 - ranked.tier * 10,
      reasons: ranked.whyMatched,
      softened: ranked.whySoftened,
    };
  }
  if (row.source_id === "linear-careers") {
    return {
      tier: null,
      score: 72,
      reasons: [
        "direct employer",
        "current careers page",
        ...row.labels.map((label) => label.label),
      ],
      softened: null,
    };
  }
  return {
    tier: null,
    score: row.labels.length > 0 ? 55 : null,
    reasons: row.labels.map((label) => label.label),
    softened: null,
  };
}

function inferredJobServeRanking(row: FastRefreshJobRow): RankedJobServeContract | null {
  if (row.source_id !== "jobserve") return null;
  return rankJobServeContract({
    id: row.id,
    title: row.title,
    company: row.company,
    url: row.canonical_url,
    lastSeenAt: row.last_seen_at,
    markdown: row.markdown ?? "",
    description: row.description_sample ?? "",
  });
}

function eligibilityFromScreening(screening: JobScreeningDecision): JobSummary["eligibility"] {
  const status =
    screening.status === "high_signal"
      ? "likely_ok"
      : screening.status === "needs_human_review"
        ? "needs_review"
        : "likely_reject";
  return {
    status,
    flags: screening.reasons.map((reason) => reason.code),
    reasons: screening.reasons.map((reason) => reason.detail),
    summary: screening.summary,
  };
}

function costsForJob(row: FastRefreshJobRow): FastRefreshCosts {
  const usage = numberOrNull(row.page_usage_tokens);
  if (usage === null) return ZERO;
  return { ...JINA_COST, jinaReaderTokens: usage };
}

export function sourceAdapterFor(
  sourceId: string | null,
  sourceLabel: string | null,
  url: string,
): SourceAdapter {
  const id = sourceId ?? sourceIdFromUrl(url);
  if (id === "linear-careers") {
    return {
      id,
      label: sourceLabel ?? "Linear Careers",
      kind: "direct_employer",
      quality: "high",
    };
  }
  if (id === "jobserve") {
    return {
      id,
      label: sourceLabel ?? "JobServe",
      kind: "recruiter",
      quality: "medium",
    };
  }
  if (["greenhouse", "lever", "ashby", "workable", "smartrecruiters"].includes(id)) {
    return {
      id,
      label: sourceLabel ?? titleCase(id),
      kind: "ats",
      quality: "high",
    };
  }
  if (["linkedin", "glassdoor", "wellfound", "remote-rocketship"].includes(id)) {
    return {
      id,
      label: sourceLabel ?? titleCase(id),
      kind: "protected",
      quality: "opportunistic",
    };
  }
  return {
    id,
    label: sourceLabel ?? titleCase(id),
    kind: "aggregator",
    quality: "medium",
  };
}
