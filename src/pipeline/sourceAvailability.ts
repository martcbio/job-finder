import {
  type SourceCoverageRow,
  sourceCoverageOutcome,
  sourceCoverageReasons,
} from "./sourceCoverage";

export interface SourceAvailabilityAttempt {
  keyword: string;
  runIndex: number;
  runId: number;
  rows: SourceCoverageRow[];
}

export interface SourceAvailabilitySourceSummary {
  sourceId: string;
  sourceLabel: string;
  attempts: number;
  availableAttempts: number;
  discoveryFailures: number;
  candidateJobs: number;
  fullTextJobs: number;
  classifiedJobs: number;
  searchReportedTokens: number;
  pageReportedTokens: number;
  availabilityRate: number;
  fullTextRate: number | null;
  classificationRate: number | null;
  outcomes: Record<string, number>;
  reasons: string[];
}

export interface SourceAvailabilitySummary {
  attempts: SourceAvailabilityAttempt[];
  sources: SourceAvailabilitySourceSummary[];
  availabilityTarget: number;
  fullTextTarget: number;
}

export function buildSourceAvailabilitySummary(
  attempts: SourceAvailabilityAttempt[],
  options: { availabilityTarget?: number; fullTextTarget?: number } = {},
): SourceAvailabilitySummary {
  const availabilityTarget = options.availabilityTarget ?? 0.95;
  const fullTextTarget = options.fullTextTarget ?? 0.99;
  const sourceMap = new Map<string, SourceAvailabilitySourceSummary>();

  for (const attempt of attempts) {
    for (const row of attempt.rows) {
      const existing = sourceMap.get(row.source_id) ?? {
        sourceId: row.source_id,
        sourceLabel: row.source_label,
        attempts: 0,
        availableAttempts: 0,
        discoveryFailures: 0,
        candidateJobs: 0,
        fullTextJobs: 0,
        classifiedJobs: 0,
        searchReportedTokens: 0,
        pageReportedTokens: 0,
        availabilityRate: 0,
        fullTextRate: null,
        classificationRate: null,
        outcomes: {},
        reasons: [],
      };

      const outcome = sourceCoverageOutcome(row);
      existing.attempts += 1;
      existing.candidateJobs += row.job_count;
      existing.fullTextJobs += usableFullTextCount(row);
      existing.classifiedJobs += row.classified_job_count;
      existing.searchReportedTokens += Number(row.search_reported_tokens);
      existing.pageReportedTokens += Number(row.page_reported_tokens);
      existing.outcomes[outcome] = (existing.outcomes[outcome] ?? 0) + 1;

      if (row.query_count > 0 && row.search_errors.length === 0) {
        existing.availableAttempts += 1;
      } else {
        existing.discoveryFailures += 1;
      }

      for (const reason of sourceCoverageReasons(row)) {
        if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      }

      sourceMap.set(row.source_id, existing);
    }
  }

  const sources = [...sourceMap.values()]
    .map((source) => ({
      ...source,
      availabilityRate: source.attempts === 0 ? 0 : source.availableAttempts / source.attempts,
      fullTextRate: source.candidateJobs === 0 ? null : source.fullTextJobs / source.candidateJobs,
      classificationRate:
        source.candidateJobs === 0 ? null : source.classifiedJobs / source.candidateJobs,
    }))
    .sort((left, right) => left.sourceLabel.localeCompare(right.sourceLabel));

  return { attempts, sources, availabilityTarget, fullTextTarget };
}

export function renderSourceAvailabilityMarkdown(summary: SourceAvailabilitySummary): string {
  const totalAttempts = summary.sources.reduce((sum, source) => sum + source.attempts, 0);
  const availableAttempts = summary.sources.reduce(
    (sum, source) => sum + source.availableAttempts,
    0,
  );
  const candidateJobs = summary.sources.reduce((sum, source) => sum + source.candidateJobs, 0);
  const fullTextJobs = summary.sources.reduce((sum, source) => sum + source.fullTextJobs, 0);
  const classifiedJobs = summary.sources.reduce((sum, source) => sum + source.classifiedJobs, 0);
  const searchTokens = summary.sources.reduce(
    (sum, source) => sum + source.searchReportedTokens,
    0,
  );
  const pageTokens = summary.sources.reduce((sum, source) => sum + source.pageReportedTokens, 0);
  const belowAvailability = summary.sources.filter(
    (source) => source.availabilityRate < summary.availabilityTarget,
  );
  const belowFullText = summary.sources.filter(
    (source) =>
      source.candidateJobs > 0 &&
      (source.fullTextRate === null || source.fullTextRate < summary.fullTextTarget),
  );
  const belowClassification = summary.sources.filter(
    (source) =>
      source.candidateJobs > 0 &&
      (source.classificationRate === null || source.classificationRate < summary.fullTextTarget),
  );

  const lines = [
    "# Source Availability",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Run IDs: ${summary.attempts.map((attempt) => attempt.runId).join(", ")}`,
    "",
    "## Summary",
    "",
    `- Availability target: ${(summary.availabilityTarget * 100).toFixed(1)}%`,
    `- Full-text/classification target: ${(summary.fullTextTarget * 100).toFixed(1)}%`,
    `- Source-keyword-run attempts: ${totalAttempts}`,
    `- Available attempts: ${availableAttempts}`,
    `- Candidate jobs: ${candidateJobs}`,
    `- Usable full-text jobs: ${fullTextJobs}`,
    `- Classified jobs: ${classifiedJobs}`,
    `- Search reported tokens: ${searchTokens}`,
    `- Page reported tokens: ${pageTokens}`,
    `- Below availability target: ${belowAvailability.length}`,
    `- Below full-text target: ${belowFullText.length}`,
    `- Below classification target: ${belowClassification.length}`,
    "",
    "## Attempts",
    "",
    "| Keyword | Run | Search Run ID |",
    "|---|---:|---:|",
  ];

  for (const attempt of summary.attempts) {
    lines.push(`${escapeTableCell(attempt.keyword)} | ${attempt.runIndex} | ${attempt.runId}`);
  }

  lines.push("");
  lines.push("## Sources");
  lines.push("");
  lines.push(
    "| Source | Attempts | Available | Availability | Jobs | Usable Full Text | Classified | Search Tokens | Page Tokens | Outcomes | Status | Reasons |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|");

  for (const source of summary.sources) {
    const status = sourceStatus(source, summary);
    lines.push(
      [
        escapeTableCell(source.sourceLabel),
        source.attempts,
        source.availableAttempts,
        formatRate(source.availabilityRate),
        source.candidateJobs,
        source.fullTextJobs,
        source.classifiedJobs,
        source.searchReportedTokens,
        source.pageReportedTokens,
        escapeTableCell(formatOutcomes(source.outcomes)),
        status,
        escapeTableCell(source.reasons.slice(0, 4).join("; ") || "none"),
      ].join(" | "),
    );
  }

  return `${lines.join("\n")}\n`;
}

function sourceStatus(
  source: SourceAvailabilitySourceSummary,
  summary: SourceAvailabilitySummary,
): string {
  if (source.availabilityRate < summary.availabilityTarget) return "below availability target";
  if (
    source.candidateJobs > 0 &&
    (source.fullTextRate === null || source.fullTextRate < summary.fullTextTarget)
  ) {
    return "below full-text target";
  }
  if (
    source.candidateJobs > 0 &&
    (source.classificationRate === null || source.classificationRate < summary.fullTextTarget)
  ) {
    return "below classification target";
  }
  return source.candidateJobs === 0 ? "explicit zero-results covered" : "covered";
}

function usableFullTextCount(row: SourceCoverageRow): number {
  return row.usable_full_text_job_count ?? row.full_text_job_count;
}

function formatOutcomes(outcomes: Record<string, number>): string {
  return Object.entries(outcomes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([outcome, count]) => `${outcome}:${count}`)
    .join(", ");
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
