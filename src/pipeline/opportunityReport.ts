import type { CompanySignal } from "./companySignals";
import { classifyIr35Signals } from "./ir35Signals";
import type { JobScreeningDecision } from "./jobScreening";

export interface Opportunity {
  source: string;
  company: string;
  title: string;
  location: string;
  url: string;
  postedAt: Date | null;
  discoveredAt: Date;
  observedAt: Date;
  terms: string;
  screening: JobScreeningDecision;
  bodyAvailable: boolean;
  companySignals?: readonly CompanySignal[];
  companyPriority?: {
    aiNative: number;
    workingStyle: number;
    prestige: number;
    note: string;
  };
  recommendationScore?: number;
  recommendationReasons?: string[];
}

export interface OpportunityReportOptions {
  now: Date;
  limit: number;
  maxAgeDays: number;
  recommendationMinScore: number;
  expectedSources?: readonly string[];
  staleAfterHours?: number;
}

export interface OpportunitySourceHealth {
  source: string;
  rowCount: number;
  newestPostedAt: string | null;
  newestObservedAt: string | null;
  ageHours: number | null;
  status: "current" | "stale" | "missing";
  message: string;
}

export interface OpportunityReport {
  generatedAt: string;
  maxAgeDays: number;
  rows: Opportunity[];
  recommendedUrls: string[];
  recommendationDistribution: Array<{ source: string; count: number }>;
  sourceHealth: OpportunitySourceHealth[];
  labMissingBodyCount: number;
}

const EXCLUDED_RECOMMENDATION_TITLES =
  /\b(?:devops|sre|support|security|vfx|pmo|project manager|delivery manager|governance)\b/i;
const RECOMMENDATION_TITLES =
  /\b(?:engineer|engineering|architect|scientist|developer|forward deployed)\b/i;

export function buildOpportunityReport(
  opportunities: readonly Opportunity[],
  options: OpportunityReportOptions,
): OpportunityReport {
  assertPositiveInteger(options.limit, "limit");
  assertPositiveInteger(options.maxAgeDays, "maxAgeDays");
  assertPositiveInteger(options.recommendationMinScore, "recommendationMinScore");
  const currentPool = opportunities
    .filter((row) => {
      const ageMs = options.now.getTime() - recentDate(row).getTime();
      return ageMs >= 0 && ageMs <= options.maxAgeDays * 86_400_000;
    })
    .sort(compareRecentDescending);
  const recent = currentPool.filter((row) => row.bodyAvailable && isCanonicalJobUrl(row.url));
  const selected = recent.slice(0, options.limit);
  const recommendations = selectRecommendations(
    selected,
    options.recommendationMinScore,
    options.now,
  );
  const recommendationsByUrl = new Map(recommendations.map((row) => [row.url, row]));

  return {
    generatedAt: options.now.toISOString(),
    maxAgeDays: options.maxAgeDays,
    rows: selected.map((row) => recommendationsByUrl.get(row.url) ?? row),
    recommendedUrls: recommendations.map((row) => row.url),
    recommendationDistribution: countBySource(recommendations),
    sourceHealth: buildSourceHealth(currentPool, options),
    labMissingBodyCount: currentPool.filter((row) => row.source === "Lab ATS" && !row.bodyAvailable)
      .length,
  };
}

export function renderOpportunityMarkdown(report: OpportunityReport): string {
  const recommendedUrls = new Set(report.recommendedUrls);
  const lines = [
    "# Recent engineering opportunities",
    "",
    `Generated: ${report.generatedAt}`,
    `Selected across the current ${report.maxAgeDays}-day pool, then ordered by posting or first-seen date.`,
    "",
    "## Source health",
    "",
  ];
  for (const health of report.sourceHealth) {
    lines.push(`- ${health.status.toUpperCase()}: ${health.message}`);
  }
  lines.push(
    "",
    `Recommendation distribution: ${
      report.recommendationDistribution.map((item) => `${item.source} ${item.count}`).join("; ") ||
      "none"
    }`,
    "",
  );

  for (const [index, row] of report.rows.entries()) {
    const reasons =
      row.screening.reasons.length > 0
        ? row.screening.reasons.map((reason) => reason.detail).join("; ")
        : row.screening.summary;
    lines.push(
      `${index + 1}. ${escapeMarkdown(row.title)}${recommendedUrls.has(row.url) ? " — ⭐ Recommended" : ""}`,
      `   ${formatOpportunityDate(row)} | ${row.source} | ${row.company}${row.location ? ` | ${row.location}` : ""}`,
      `   URL: ${row.url}`,
      `   Verdict: ${formatVerdict(row.screening)}`,
      `   Why: ${reasons}`,
      `   Terms: ${row.terms}`,
      ...(row.companySignals && row.companySignals.length > 0
        ? [
            `   Company signals: ${row.companySignals
              .map((signal) => `${signal.kinds.join("+")} ${signal.url}`)
              .join("; ")}`,
          ]
        : []),
      ...(row.companyPriority ? [`   Company profile: ${row.companyPriority.note}`] : []),
      "",
    );
  }
  lines.push(
    "## Method and limitations",
    "",
    "- Cloud: the refresh workflow syncs the latest complete Modal lab-ATS snapshot.",
    "- On-device: direct-source acquisition, Postgres merge, body screening, live-link verification, ranking, artifact generation, and the Resend handoff.",
    "- CLI vs tokens: selection and ranking are deterministic CLI code and consume no model tokens.",
    `- Omitted before ranking: ${report.labMissingBodyCount} current Lab ATS rows without a full captured job body.`,
    "",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderOpportunityHtml(report: OpportunityReport): string {
  const recommendedUrls = new Set(report.recommendedUrls);
  const health = report.sourceHealth
    .map(
      (item) =>
        `<li><strong>${escapeHtml(item.status.toUpperCase())}:</strong> ${escapeHtml(item.message)}</li>`,
    )
    .join("");
  const rows = report.rows
    .map((row, index) => {
      const reasons =
        row.screening.reasons.length > 0
          ? row.screening.reasons.map((reason) => reason.detail).join("; ")
          : row.screening.summary;
      const signals =
        row.companySignals && row.companySignals.length > 0
          ? `<p><strong>Discovery evidence:</strong> ${row.companySignals
              .map(
                (signal) =>
                  `<a href="${escapeHtml(signal.url)}">${escapeHtml(signal.kinds.join("+"))}</a>`,
              )
              .join("; ")}</p>`
          : "";
      return `<article>
  <h2>${index + 1}. <a href="${escapeHtml(row.url)}">${escapeHtml(row.title)}</a>${
    recommendedUrls.has(row.url) ? " — ⭐ Recommended" : ""
  }</h2>
  <p>${escapeHtml(formatOpportunityDate(row))} · ${escapeHtml(row.source)} · ${escapeHtml(row.company)}${row.location ? ` · ${escapeHtml(row.location)}` : ""}</p>
  <p><strong>${escapeHtml(formatVerdict(row.screening))}</strong> — ${escapeHtml(reasons)}</p>
  <p><strong>Terms:</strong> ${escapeHtml(row.terms)}</p>
  ${signals}
</article>`;
    })
    .join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <title>Recent engineering opportunities</title>
</head>
<body style="font-family:Arial,sans-serif;line-height:1.45;color:#18202b;max-width:760px;margin:0 auto;padding:24px">
  <h1>Recent engineering opportunities</h1>
  <p>Generated ${escapeHtml(report.generatedAt)}. Every primary link is an official job-detail URL with a captured full description; social links are discovery evidence only.</p>
  <h2>Source health</h2>
  <ul>${health}</ul>
  ${rows}
  <h2>Method and limitations</h2>
  <ul>
    <li><strong>Cloud:</strong> the refresh workflow syncs the latest complete Modal lab-ATS snapshot.</li>
    <li><strong>On-device:</strong> direct-source acquisition, Postgres merge, body screening, live-link verification, ranking, artifact generation, and the Resend handoff.</li>
    <li><strong>CLI vs tokens:</strong> selection and ranking are deterministic CLI code and consume no model tokens.</li>
    <li><strong>Omitted before ranking:</strong> ${report.labMissingBodyCount} current Lab ATS rows without a full captured job body.</li>
  </ul>
</body>
</html>
`;
}

function selectRecommendations(
  rows: readonly Opportunity[],
  minimumScore: number,
  now: Date,
): Opportunity[] {
  return rows
    .filter(isRecommendationEligible)
    .map((row) => {
      const breakdown = scoreBreakdown(row, now);
      return {
        ...row,
        recommendationScore: breakdown.total,
        recommendationReasons: breakdown.reasons,
      };
    })
    .filter((row) => (row.recommendationScore ?? 0) >= minimumScore)
    .sort(
      (left, right) =>
        (right.recommendationScore ?? 0) - (left.recommendationScore ?? 0) ||
        compareRecentDescending(left, right),
    );
}

function isRecommendationEligible(row: Opportunity): boolean {
  if (row.screening.status === "rejected") return false;
  if (!row.bodyAvailable || !isCanonicalJobUrl(row.url)) return false;
  return !EXCLUDED_RECOMMENDATION_TITLES.test(row.title) && RECOMMENDATION_TITLES.test(row.title);
}

function isCanonicalJobUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (["x.com", "twitter.com", "t.co"].includes(host)) return false;
    if (host === "linkedin.com" && url.pathname.startsWith("/posts/")) return false;
    if (host === "google.com" && url.pathname === "/about/careers/applications/jobs/results/") {
      return false;
    }
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function scoreBreakdown(row: Opportunity, now: Date): { total: number; reasons: string[] } {
  const text = `${row.title}\n${row.location}\n${row.terms}`;
  const reasons: string[] = [];
  let result = row.screening.status === "high_signal" ? 5 : 3;
  const ageDays = Math.max(0, (now.getTime() - recentDate(row).getTime()) / 86_400_000);
  const recency = ageDays <= 3 ? 4 : ageDays <= 7 ? 3 : ageDays <= 14 ? 2 : ageDays <= 30 ? 1 : 0;
  result += recency;
  if (recency > 0) reasons.push(`recency ${recency}`);
  if (/\b(?:agentic|applied ai)\b/i.test(text)) {
    result += 5;
    reasons.push("agentic / applied AI signal");
  }
  if (/\b(?:generative ai|genai|machine learning|ml engineer|ai engineer)\b/i.test(text)) {
    result += 4;
    reasons.push("genAI / ML engineering signal");
  }
  if (/\bai\b/i.test(row.title)) {
    result += 3;
    reasons.push("AI in title");
  }
  if (RECOMMENDATION_TITLES.test(row.title)) {
    result += 2;
    reasons.push("engineering title");
  }
  if (row.companyPriority) {
    const priority = Math.min(
      4,
      row.companyPriority.aiNative +
        row.companyPriority.workingStyle +
        row.companyPriority.prestige,
    );
    result += priority;
    reasons.push(`company priority ${priority}`);
  }
  if (!row.bodyAvailable) result -= 3;
  const ir35 = classifyIr35Signals({
    text,
    employmentType: null,
    compensation: row.terms,
  });
  if (ir35.outside) {
    result += 3;
    reasons.push("outside IR35");
  }
  if (/\bremote\b/i.test(text)) {
    result += 3;
    reasons.push("remote");
  }
  const compensation = compensationScore(text);
  result += compensation;
  if (compensation > 0) reasons.push(`compensation ${compensation}`);
  const signalKinds = new Set(row.companySignals?.flatMap((signal) => signal.kinds) ?? []);
  if (signalKinds.has("funding")) {
    result += 2;
    reasons.push("funding signal");
  }
  if (signalKinds.has("hiring")) {
    result += 1;
    reasons.push("hiring signal");
  }
  if (row.screening.reasons.some((reason) => reason.code === "regular_hybrid_or_onsite")) {
    result -= 2;
    reasons.push("regular hybrid/onsite");
  }
  if (row.screening.reasons.some((reason) => reason.code === "inside_ir35")) {
    result -= 3;
    reasons.push("inside IR35");
  }
  if (row.screening.reasons.some((reason) => reason.code === "government_ir35_risk")) {
    result -= 3;
    reasons.push("government IR35 risk");
  }
  if (row.screening.reasons.some((reason) => reason.code === "location_or_remote_unclear")) {
    result -= 2;
    reasons.push("location / remote unclear");
  }
  return { total: result, reasons };
}

function compensationScore(text: string): number {
  const daily = text.match(/£\s?([\d,]+)(?:\.\d+)?\s*(?:a|per|\/)\s*day/i);
  if (daily?.[1]) {
    const amount = Number.parseInt(daily[1].replaceAll(",", ""), 10);
    if (amount >= 800) return 4;
    if (amount >= 650) return 3;
    if (amount >= 500) return 2;
  }

  const annual = text.match(/([£€$])\s?([\d,]+)(?:\.\d+)?\s*(?:(k)\b|per annum|annually|a year)/i);
  if (!annual?.[1] || !annual[2]) return 0;
  let amount = Number.parseFloat(annual[2].replaceAll(",", ""));
  if (annual[3]) amount *= 1000;
  const premiumThreshold = annual[1] === "$" ? 180_000 : annual[1] === "€" ? 120_000 : 120_000;
  if (amount >= premiumThreshold * 1.4) return 4;
  if (amount >= premiumThreshold) return 3;
  if (amount >= premiumThreshold * 0.75) return 2;
  return 0;
}

function buildSourceHealth(
  rows: readonly Opportunity[],
  options: OpportunityReportOptions,
): OpportunitySourceHealth[] {
  const expectedSources = options.expectedSources ?? [...new Set(rows.map((row) => row.source))];
  const staleAfterHours = options.staleAfterHours ?? 48;
  return expectedSources.map((source) => {
    const sourceRows = rows.filter((row) => row.source === source);
    if (sourceRows.length === 0) {
      return {
        source,
        rowCount: 0,
        newestPostedAt: null,
        newestObservedAt: null,
        ageHours: null,
        status: "missing",
        message: `${source} returned no current rows`,
      };
    }
    const newest = sourceRows
      .map((row) => row.postedAt)
      .filter((value): value is Date => value !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const newestObserved = sourceRows
      .map((row) => row.observedAt)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    if (!newestObserved) throw new Error(`${source} rows are missing acquisition timestamps`);
    const ageHours = Math.max(0, (options.now.getTime() - newestObserved.getTime()) / 3_600_000);
    const status = ageHours > staleAfterHours ? "stale" : "current";
    return {
      source,
      rowCount: sourceRows.length,
      newestPostedAt: newest?.toISOString() ?? null,
      newestObservedAt: newestObserved.toISOString(),
      ageHours,
      status,
      message: `${source}: ${sourceRows.length} rows; captured ${newestObserved.toISOString()} (${ageHours.toFixed(1)}h old); ${newest ? `newest posting ${newest.toISOString()}` : "posting dates unavailable"}`,
    };
  });
}

function recentDate(row: Opportunity): Date {
  return row.postedAt ?? row.discoveredAt;
}

function compareRecentDescending(left: Opportunity, right: Opportunity): number {
  return recentDate(right).getTime() - recentDate(left).getTime();
}

function countBySource(rows: readonly Opportunity[]): Array<{ source: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.source, (counts.get(row.source) ?? 0) + 1);
  return [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((left, right) => right.count - left.count || left.source.localeCompare(right.source));
}

function formatOpportunityDate(row: Opportunity): string {
  return row.postedAt
    ? `posted ${row.postedAt.toISOString().slice(0, 10)}`
    : `first seen ${row.discoveredAt.toISOString().slice(0, 10)}`;
}

function formatVerdict(screening: JobScreeningDecision): string {
  if (screening.status === "rejected") return "DISQUALIFIED";
  if (screening.status === "needs_human_review") return "CAVEAT";
  return "QUALIFIED (provisional)";
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
