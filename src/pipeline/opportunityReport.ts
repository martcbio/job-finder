import type { CompanySignal } from "./companySignals";
import { classifyIr35Signals } from "./ir35Signals";
import type { JobScreeningDecision } from "./jobScreening";

export interface Opportunity {
  source: string;
  company: string;
  title: string;
  location: string;
  url: string;
  postedAt: Date;
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
}

export interface OpportunityReportOptions {
  now: Date;
  limit: number;
  maxAgeDays: number;
  pickCount: number;
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
  pickUrls: string[];
  pickDistribution: Array<{ source: string; count: number }>;
  sourceHealth: OpportunitySourceHealth[];
  labMissingBodyCount: number;
}

const EXCLUDED_PICK_TITLES =
  /\b(?:devops|sre|support|security|vfx|pmo|project manager|delivery manager|governance)\b/i;
const PICK_TITLES = /\b(?:engineer|engineering|architect|scientist|developer|forward deployed)\b/i;

export function buildOpportunityReport(
  opportunities: readonly Opportunity[],
  options: OpportunityReportOptions,
): OpportunityReport {
  assertPositiveInteger(options.limit, "limit");
  assertPositiveInteger(options.maxAgeDays, "maxAgeDays");
  assertPositiveInteger(options.pickCount, "pickCount");
  const currentPool = opportunities
    .filter((row) => {
      const ageMs = options.now.getTime() - row.postedAt.getTime();
      return ageMs >= 0 && ageMs <= options.maxAgeDays * 86_400_000;
    })
    .sort(comparePostedAtDescending);
  const recent = currentPool.filter((row) => row.bodyAvailable && isCanonicalJobUrl(row.url));
  const picks = selectChatGptPicks(recent, Math.min(options.pickCount, options.limit));
  const selected = selectRows(recent, picks, options.limit);

  return {
    generatedAt: options.now.toISOString(),
    maxAgeDays: options.maxAgeDays,
    rows: selected,
    pickUrls: picks.map((row) => row.url),
    pickDistribution: countBySource(picks),
    sourceHealth: buildSourceHealth(currentPool, options),
    labMissingBodyCount: currentPool.filter((row) => row.source === "Lab ATS" && !row.bodyAvailable)
      .length,
  };
}

export function renderOpportunityMarkdown(report: OpportunityReport): string {
  const pickUrls = new Set(report.pickUrls);
  const lines = [
    "# Latest engineering opportunities",
    "",
    `Generated: ${report.generatedAt}`,
    `Selected across the current ${report.maxAgeDays}-day pool, then ordered by posting date.`,
    "",
    "## Source health",
    "",
  ];
  for (const health of report.sourceHealth) {
    lines.push(`- ${health.status.toUpperCase()}: ${health.message}`);
  }
  lines.push(
    "",
    `Pick distribution: ${
      report.pickDistribution.map((item) => `${item.source} ${item.count}`).join("; ") || "none"
    }`,
    "",
  );

  for (const [index, row] of report.rows.entries()) {
    const reasons =
      row.screening.reasons.length > 0
        ? row.screening.reasons.map((reason) => reason.detail).join("; ")
        : row.screening.summary;
    lines.push(
      `${index + 1}. ${escapeMarkdown(row.title)}${pickUrls.has(row.url) ? " — ⭐ ChatGPT Pick" : ""}`,
      `   ${row.postedAt.toISOString().slice(0, 10)} | ${row.source} | ${row.company}${row.location ? ` | ${row.location}` : ""}`,
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
  const pickUrls = new Set(report.pickUrls);
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
    pickUrls.has(row.url) ? " — ⭐ ChatGPT Pick" : ""
  }</h2>
  <p>${escapeHtml(row.postedAt.toISOString().slice(0, 10))} · ${escapeHtml(row.source)} · ${escapeHtml(row.company)}${row.location ? ` · ${escapeHtml(row.location)}` : ""}</p>
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
  <title>Latest engineering opportunities</title>
</head>
<body style="font-family:Arial,sans-serif;line-height:1.45;color:#18202b;max-width:760px;margin:0 auto;padding:24px">
  <h1>Latest engineering opportunities</h1>
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

function selectRows(
  recent: readonly Opportunity[],
  picks: readonly Opportunity[],
  limit: number,
): Opportunity[] {
  const selected = [...picks];
  const selectedUrls = new Set(picks.map((row) => row.url));
  for (const row of recent) {
    if (selected.length >= limit) break;
    if (selectedUrls.has(row.url)) continue;
    selected.push(row);
    selectedUrls.add(row.url);
  }
  return selected.sort(comparePostedAtDescending);
}

function selectChatGptPicks(rows: readonly Opportunity[], count: number): Opportunity[] {
  const ranked = [...rows].sort((left, right) => score(right) - score(left));
  const picks: Opportunity[] = [];
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();
  const sourceCounts = new Map<string, number>();
  const companyCounts = new Map<string, number>();
  const sourceLimit = Math.max(1, Math.ceil(count / 2));

  const add = (
    row: Opportunity,
    enforceSourceLimit: boolean,
    enforceCompanyLimit: boolean,
  ): boolean => {
    if (!isPickEligible(row)) return false;
    if (seenUrls.has(row.url)) return false;
    const titleKey = normalizedTitle(row.title);
    if (seenTitles.has(titleKey)) return false;
    if (enforceSourceLimit && (sourceCounts.get(row.source) ?? 0) >= sourceLimit) return false;
    const companyKey = row.company.toLowerCase();
    if (enforceCompanyLimit && (companyCounts.get(companyKey) ?? 0) >= 2) return false;
    seenTitles.add(titleKey);
    seenUrls.add(row.url);
    sourceCounts.set(row.source, (sourceCounts.get(row.source) ?? 0) + 1);
    companyCounts.set(companyKey, (companyCounts.get(companyKey) ?? 0) + 1);
    picks.push(row);
    return true;
  };

  const seededSources = new Set<string>();
  for (const row of ranked) {
    if (seededSources.has(row.source)) continue;
    if (add(row, false, true)) seededSources.add(row.source);
    if (picks.length === count) return picks;
  }
  for (const row of ranked) {
    add(row, true, true);
    if (picks.length === count) return picks;
  }
  for (const row of ranked) {
    add(row, false, true);
    if (picks.length === count) return picks;
  }
  for (const row of ranked) {
    add(row, false, false);
    if (picks.length === count) return picks;
  }
  return picks;
}

function isPickEligible(row: Opportunity): boolean {
  if (row.screening.status === "rejected") return false;
  if (!row.bodyAvailable || !isCanonicalJobUrl(row.url)) return false;
  return !EXCLUDED_PICK_TITLES.test(row.title) && PICK_TITLES.test(row.title);
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

function score(row: Opportunity): number {
  const text = `${row.title}\n${row.location}\n${row.terms}`;
  let result = row.screening.status === "high_signal" ? 5 : 3;
  if (/\b(?:agentic|applied ai)\b/i.test(text)) result += 5;
  if (/\b(?:generative ai|genai|machine learning|ml engineer|ai engineer)\b/i.test(text)) {
    result += 4;
  }
  if (/\bai\b/i.test(row.title)) result += 3;
  if (PICK_TITLES.test(row.title)) result += 2;
  if (row.companyPriority) {
    result += Math.min(
      4,
      row.companyPriority.aiNative +
        row.companyPriority.workingStyle +
        row.companyPriority.prestige,
    );
  }
  if (!row.bodyAvailable) result -= 3;
  const ir35 = classifyIr35Signals({
    text,
    employmentType: null,
    compensation: row.terms,
  });
  if (ir35.outside) result += 3;
  if (/\bremote\b/i.test(text)) result += 3;
  result += compensationScore(text);
  const signalKinds = new Set(row.companySignals?.flatMap((signal) => signal.kinds) ?? []);
  if (signalKinds.has("funding")) result += 2;
  if (signalKinds.has("hiring")) result += 1;
  if (row.screening.reasons.some((reason) => reason.code === "regular_hybrid_or_onsite")) {
    result -= 2;
  }
  if (row.screening.reasons.some((reason) => reason.code === "inside_ir35")) {
    result -= 3;
  }
  if (row.screening.reasons.some((reason) => reason.code === "government_ir35_risk")) {
    result -= 3;
  }
  if (row.screening.reasons.some((reason) => reason.code === "location_or_remote_unclear")) {
    result -= 2;
  }
  return result;
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
    const newest = sourceRows
      .map((row) => row.postedAt)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    if (!newest) {
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
    const newestObserved = sourceRows
      .map((row) => row.observedAt)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    if (!newestObserved) throw new Error(`${source} rows are missing acquisition timestamps`);
    const ageHours = Math.max(0, (options.now.getTime() - newestObserved.getTime()) / 3_600_000);
    const status = ageHours > staleAfterHours ? "stale" : "current";
    return {
      source,
      rowCount: sourceRows.length,
      newestPostedAt: newest.toISOString(),
      newestObservedAt: newestObserved.toISOString(),
      ageHours,
      status,
      message: `${source}: ${sourceRows.length} rows; captured ${newestObserved.toISOString()} (${ageHours.toFixed(1)}h old); newest posting ${newest.toISOString()}`,
    };
  });
}

function comparePostedAtDescending(left: Opportunity, right: Opportunity): number {
  return right.postedAt.getTime() - left.postedAt.getTime();
}

function countBySource(rows: readonly Opportunity[]): Array<{ source: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.source, (counts.get(row.source) ?? 0) + 1);
  return [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((left, right) => right.count - left.count || left.source.localeCompare(right.source));
}

function normalizedTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^[^-]+-\s*/, "")
    .replace(/\W+/g, " ")
    .trim();
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
