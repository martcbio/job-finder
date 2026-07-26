import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { type CompanySignal, companySignalsFor } from "./companySignals";
import { type JobScreeningDecision, type JobScreeningReason, screenJob } from "./jobScreening";
import {
  buildJobServeRowsSql,
  filterRecentJobServeContracts,
  type JobServeContractRow,
  type RankedJobServeContract,
  rankJobServeContracts,
} from "./jobserveContracts";
import {
  buildOpportunityReport,
  type Opportunity,
  type OpportunityReport,
} from "./opportunityReport";

export interface CompanyPriority {
  aiNative: number;
  workingStyle: number;
  prestige: number;
  note: string;
}

export interface OpportunityReportPolicy {
  limit: number;
  maxAgeDays: number;
  pickCount: number;
  staleAfterHours: number;
  expectedSources: string[];
}

export interface LabOpening {
  company: string;
  title: string | null;
  location: string;
  url: string;
  postedAt: string | null;
  locationEligibility: { status: string; reasonCodes: string[] };
  roleRelevance: { status: string; reasonCodes: string[] };
  raw: Record<string, unknown>;
}

export interface DirectCareerRow {
  title: string;
  company: string | null;
  url: string;
  firstSeenAt: string;
  lastSeenAt: string;
  location: string | null;
  markdown: string;
  description: string;
  sourceId: string;
  sourceLabel: string;
}

interface LabSnapshot {
  rows: LabOpening[];
  observedAt: Date;
  runId: string;
}

export interface LoadOpportunityReportOptions {
  query: <T>(sql: string) => Promise<T>;
  now: Date;
  env?: NodeJS.ProcessEnv;
  policyPath?: string;
  limit?: number;
  maxAgeDays?: number;
  pickCount?: number;
  staleAfterHours?: number;
}

const REPO_ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_POLICY_PATH = resolve(REPO_ROOT, "config/opportunity-report.json");
const DEFAULT_LAB_RUNS_DIR = resolve(REPO_ROOT, "../../../market/lab-openings/runs");
const DEFAULT_COMPANY_SIGNALS_PATH = resolve(
  REPO_ROOT,
  "../../../market/company-signals/latest.json",
);
const DEFAULT_COMPANY_PRIORITIES_PATH = resolve(REPO_ROOT, "config/company-priorities.json");

const opportunityReportPolicySchema = z
  .object({
    limit: z.number().int().min(20).max(30),
    maxAgeDays: z.number().int().positive(),
    pickCount: z.number().int().positive(),
    staleAfterHours: z.number().int().positive(),
    expectedSources: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();
const labOpeningSchema = z
  .object({
    company: z.string(),
    title: z.string().nullable(),
    location: z.string(),
    url: z.string().url(),
    postedAt: z.string().nullable(),
    locationEligibility: z.object({
      status: z.string(),
      reasonCodes: z.array(z.string()),
    }),
    roleRelevance: z.object({
      status: z.string(),
      reasonCodes: z.array(z.string()),
    }),
    raw: z.record(z.string(), z.unknown()),
  })
  .passthrough();
const labStatusSchema = z
  .object({
    status: z.string(),
    completedAt: z.string().optional(),
    runId: z.string().optional(),
  })
  .passthrough();
const companySignalSchema = z
  .object({
    id: z.string().min(1),
    kinds: z.array(z.enum(["funding", "hiring"])),
    text: z.string(),
    url: z.string(),
    publishedAt: z.string().nullable(),
    capturedAt: z.string().nullable(),
    authorHandle: z.string(),
    companyHandles: z.array(z.string()),
    origin: z.enum(["bookmark", "hiring_thread_reply"]),
  })
  .strict();
const companySignalArtifactSchema = z
  .object({ signals: z.array(companySignalSchema) })
  .passthrough();
const companyPrioritySchema = z
  .object({
    aiNative: z.number().int(),
    workingStyle: z.number().int(),
    prestige: z.number().int(),
    note: z.string().trim().min(1),
  })
  .strict();
const companyPrioritiesSchema = z.record(z.string(), companyPrioritySchema);

export async function loadOpportunityReport(
  options: LoadOpportunityReportOptions,
): Promise<OpportunityReport> {
  const policy = await readOpportunityReportPolicy(options.policyPath ?? DEFAULT_POLICY_PATH);
  const effective = {
    ...policy,
    limit: options.limit ?? policy.limit,
    maxAgeDays: options.maxAgeDays ?? policy.maxAgeDays,
    pickCount: options.pickCount ?? policy.pickCount,
    staleAfterHours: options.staleAfterHours ?? policy.staleAfterHours,
  };
  const labSnapshot = await readLatestLabOpenings(
    options.env?.LAB_OPENINGS_RUNS_DIR ?? DEFAULT_LAB_RUNS_DIR,
  );
  const labOpportunities = labSnapshot.rows
    .filter((row) => row.title && row.postedAt)
    .filter((row) => row.locationEligibility.status !== "ineligible")
    .filter((row) => isEngineeringTitle(row.title ?? ""))
    .map((row) => toLabOpportunity(row, labSnapshot.observedAt))
    .filter((row): row is Opportunity => row !== null);
  const jobServeRows = await options.query<JobServeContractRow[]>(buildJobServeRowsSql(1000));
  const jobServeOpportunities = filterRecentJobServeContracts(
    rankJobServeContracts(jobServeRows, { limit: 1000 }),
    { maxAgeDays: effective.maxAgeDays },
  ).map(toJobServeOpportunity);
  const directRows = await options.query<DirectCareerRow[]>(buildDirectCareerRowsSql());
  const directOpportunities = directRows
    .map(toDirectCareerOpportunity)
    .filter((row): row is Opportunity => row !== null);
  const [companySignals, companyPriorities] = await Promise.all([
    readCompanySignals(options.env?.CAREERS_COMPANY_SIGNALS_PATH ?? DEFAULT_COMPANY_SIGNALS_PATH),
    readCompanyPriorities(
      options.env?.CAREERS_COMPANY_PRIORITIES_PATH ?? DEFAULT_COMPANY_PRIORITIES_PATH,
    ),
  ]);

  return buildOpportunityReport(
    attachCompanyPriorities(
      attachCompanySignals(
        [...labOpportunities, ...jobServeOpportunities, ...directOpportunities],
        companySignals,
      ),
      companyPriorities,
    ),
    {
      now: options.now,
      limit: effective.limit,
      maxAgeDays: effective.maxAgeDays,
      pickCount: effective.pickCount,
      expectedSources: effective.expectedSources,
      staleAfterHours: effective.staleAfterHours,
    },
  );
}

/** Reads and validates the report policy before it can influence ranking. */
export async function readOpportunityReportPolicy(path: string): Promise<OpportunityReportPolicy> {
  return opportunityReportPolicySchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function readLatestLabOpenings(runsRoot: string): Promise<LabSnapshot> {
  const runNames = (await readdir(runsRoot)).sort().reverse();
  const failures: string[] = [];
  for (const runName of runNames) {
    const statusPath = resolve(runsRoot, runName, "status.json");
    const openingsPath = resolve(runsRoot, runName, "openings.jsonl");
    try {
      const status = labStatusSchema.parse(JSON.parse(await readFile(statusPath, "utf8")));
      if (status.status !== "complete") continue;
      if (!status.completedAt) {
        throw new Error(`${statusPath} is complete but has no completedAt`);
      }
      return {
        rows: (await readFile(openingsPath, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line, index) => {
            try {
              return labOpeningSchema.parse(JSON.parse(line));
            } catch (error) {
              throw new Error(`${openingsPath}:${index + 1} is not a valid lab opening`, {
                cause: error,
              });
            }
          }),
        observedAt: new Date(status.completedAt),
        runId: status.runId ?? runName,
      };
    } catch (error) {
      failures.push(`${runName}: ${errorMessage(error)}`);
    }
  }
  throw new Error(
    `No complete lab-openings generation found under ${runsRoot}${
      failures.length > 0 ? `\n${failures.slice(0, 5).join("\n")}` : ""
    }`,
  );
}

export function toLabOpportunity(row: LabOpening, observedAt: Date): Opportunity | null {
  const title = row.title?.trim();
  if (!title || !row.postedAt) return null;
  if (isUnitedStates(primaryAddressCountry(row.raw))) return null;
  const body = ["descriptionPlain", "description", "content"]
    .map((key) => row.raw[key])
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const bodyAvailable = body.trim().length >= 100;
  const bodyScreening: JobScreeningDecision = bodyAvailable
    ? screenJob({
        title,
        companyHint: row.company,
        canonicalUrl: row.url,
        locationHint: row.location,
        markdown: body,
      })
    : {
        status: "needs_human_review" as const,
        reasons: [
          {
            code: "missing_job_body",
            detail: "ATS board row did not include the full job body",
          },
        ],
        summary: "needs human review: missing_job_body",
      };
  const screening = reconcileLabLocation(bodyScreening, row);
  if (screening.reasons.some((reason) => reason.code === "us_remote_or_auth")) return null;
  return {
    source: "Lab ATS",
    company: row.company,
    title,
    location: row.location,
    url: row.url,
    postedAt: new Date(row.postedAt),
    observedAt,
    terms: ["employment type not assumed; inspect posting", extractCompensation(body)]
      .filter(Boolean)
      .join("; "),
    screening,
    bodyAvailable,
  };
}

export function buildDirectCareerRowsSql(): string {
  return `SELECT COALESCE(json_agg(row_to_json(rows)), '[]'::json)
FROM (
  SELECT
    j.title_normalized AS title,
    j.company_hint AS company,
    j.canonical_url AS url,
    j.first_seen_at::text AS "firstSeenAt",
    j.last_seen_at::text AS "lastSeenAt",
    COALESCE(
      substring(
        COALESCE(jp.markdown, '')
        FROM '(?im)^- Location:\\s*([^\\n]+)'
      ),
      ''
    ) AS location,
    COALESCE(jp.markdown, '') AS markdown,
    COALESCE(string_agg(DISTINCT sr.description_raw, E'\\n'), '') AS description,
    sq.source_id AS "sourceId",
    sq.source_label AS "sourceLabel"
  FROM job_search.jobs j
  JOIN job_search.job_observations jo ON jo.job_id = j.id
  JOIN job_search.search_results sr ON sr.id = jo.search_result_id
  JOIN job_search.search_queries sq ON sq.id = sr.query_id
  LEFT JOIN LATERAL (
    SELECT candidate_page.markdown
    FROM job_search.job_pages candidate_page
    WHERE candidate_page.job_id = j.id
      AND candidate_page.status = 'success'
    ORDER BY candidate_page.fetched_at DESC, candidate_page.id DESC
    LIMIT 1
  ) jp ON true
  WHERE sq.source_id IN ('linear-careers', 'google-careers')
  GROUP BY j.id, j.title_normalized, j.company_hint, j.canonical_url, j.first_seen_at, j.last_seen_at,
    sq.source_id, sq.source_label
    , jp.markdown
  ORDER BY j.last_seen_at DESC, j.id DESC
) rows;`;
}

export function toDirectCareerOpportunity(row: DirectCareerRow): Opportunity | null {
  const title = row.title.replace(/^\s*Linear\s+-\s+/i, "").trim();
  if (!title) return null;
  const body = row.markdown.trim().length >= 100 ? row.markdown : row.description;
  const observedAt = new Date(row.lastSeenAt);
  if (Number.isNaN(observedAt.getTime())) return null;
  const location = row.location?.trim() ?? extractMetadata(body, "Location") ?? "";
  return {
    source: row.sourceLabel,
    company: row.company ?? "Unknown company",
    title,
    location,
    url: row.url,
    postedAt: observedAt,
    observedAt,
    terms: [
      "posting date unavailable; last verified open",
      extractMetadata(body, "Employment type"),
      extractMetadata(body, "Compensation"),
      extractCompensation(body),
    ]
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index)
      .join("; "),
    screening: screenJob({
      title,
      companyHint: row.company,
      canonicalUrl: row.url,
      locationHint: location,
      markdown: body,
    }),
    bodyAvailable: body.trim().length >= 100,
  };
}

export function attachCompanySignals(
  opportunities: readonly Opportunity[],
  signals: readonly CompanySignal[],
): Opportunity[] {
  return opportunities.map((opportunity) => {
    const matched = companySignalsFor(opportunity.company, signals);
    return matched.length > 0 ? { ...opportunity, companySignals: matched } : opportunity;
  });
}

/** Reads validated bookmark-derived company signals. */
export async function readCompanySignals(path: string): Promise<CompanySignal[]> {
  const parsed = companySignalArtifactSchema.parse(JSON.parse(await readFile(path, "utf8")));
  return parsed.signals;
}

/** Reads validated explicit company-priority overrides. */
export async function readCompanyPriorities(path: string): Promise<Map<string, CompanyPriority>> {
  const parsed = companyPrioritiesSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const priorities = new Map<string, CompanyPriority>();
  for (const [company, priority] of Object.entries(parsed)) {
    priorities.set(normalizeCompany(company), priority);
  }
  return priorities;
}

export function attachCompanyPriorities(
  opportunities: readonly Opportunity[],
  priorities: ReadonlyMap<string, CompanyPriority>,
): Opportunity[] {
  return opportunities.map((opportunity) => {
    const priority = priorities.get(normalizeCompany(opportunity.company));
    return priority ? { ...opportunity, companyPriority: priority } : opportunity;
  });
}

function reconcileLabLocation(
  screening: JobScreeningDecision,
  row: LabOpening,
): JobScreeningDecision {
  if (screening.status === "rejected") return screening;
  if (row.locationEligibility.status === "eligible") {
    const reasons = screening.reasons.filter(
      (reason) => reason.code !== "location_or_remote_unclear",
    );
    if (reasons.length === 0) {
      return {
        status: "high_signal",
        reasons: [],
        summary: "high signal: no deterministic blocker found",
      };
    }
    return {
      status: "needs_human_review",
      reasons,
      summary: `needs human review: ${reasons.map((reason) => reason.code).join(", ")}`,
    };
  }
  if (
    row.locationEligibility.status !== "undecided" ||
    screening.reasons.some((reason) => reason.code === "location_or_remote_unclear")
  ) {
    return screening;
  }
  const locationReason: JobScreeningReason = {
    code: "location_or_remote_unclear",
    detail: `ATS location ${row.location || "unknown"} has not been cleared as workable`,
  };
  const reasons = [locationReason, ...screening.reasons];
  return {
    status: "needs_human_review",
    reasons,
    summary: `needs human review: ${reasons.map((reason) => reason.code).join(", ")}`,
  };
}

function primaryAddressCountry(raw: Record<string, unknown>): string | null {
  const address = raw.address;
  if (!address || typeof address !== "object") return null;
  const postalAddress = (address as Record<string, unknown>).postalAddress;
  if (!postalAddress || typeof postalAddress !== "object") return null;
  const country = (postalAddress as Record<string, unknown>).addressCountry;
  return typeof country === "string" ? country : null;
}

function isUnitedStates(country: string | null): boolean {
  return /^(?:US|USA|United States|United States of America)$/i.test(country?.trim() ?? "");
}

function toJobServeOpportunity(row: RankedJobServeContract): Opportunity {
  const location = extractMetadata(row.markdown, "Location") ?? "";
  const body = [row.markdown, row.description].filter(Boolean).join("\n");
  const compensation = extractMetadata(row.markdown, "Compensation");
  return {
    source: "JobServe",
    company: row.company ?? "Unknown recruiter",
    title: row.title,
    location,
    url: row.url,
    postedAt: row.postedAt ?? new Date(row.lastSeenAt),
    observedAt: new Date(row.lastSeenAt),
    terms: [
      row.tier <= 2
        ? `contract; advertised outside IR35; tier ${row.tier}`
        : `contract; IR35 unclear; tier ${row.tier}`,
      compensation,
    ]
      .filter(Boolean)
      .join("; "),
    screening: screenJob({
      title: row.title,
      companyHint: row.company,
      canonicalUrl: row.url,
      locationHint: location,
      markdown: body,
    }),
    bodyAvailable: body.trim().length >= 100,
  };
}

function isEngineeringTitle(title: string): boolean {
  return /\b(?:software|ai|ml|machine learning|data|research|inference|platform|full.?stack|backend|front.?end|developer|engineer|engineering|architect|technical|scientist|member of technical staff)\b/i.test(
    title,
  );
}

function extractMetadata(markdown: string, label: string): string | null {
  const match = markdown.match(new RegExp(`^- ${label}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? null;
}

function extractCompensation(text: string): string | null {
  const metadata = extractMetadata(text, "Compensation");
  if (metadata) return metadata;
  const plain = text
    .replaceAll(/&lt;/gi, "<")
    .replaceAll(/&gt;/gi, ">")
    .replaceAll(/&amp;/gi, "&")
    .replaceAll(/&#39;|&apos;/gi, "'")
    .replaceAll(/&quot;/gi, '"')
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  const amountPattern =
    /[£€$]\s?\d[\d,]*(?:\.\d+)?\s*(?:k\b)?(?:\s*(?:-|–|—|to)\s*[£€$]?\s?\d[\d,]*(?:\.\d+)?\s*(?:k\b)?)?(?:\s*(?:per annum|annually|a year|per year|\/year|a day|per day|\/day|an hour|per hour|\/hour))?/gi;
  for (const match of plain.matchAll(amountPattern)) {
    const index = match.index ?? 0;
    const context = plain.slice(Math.max(0, index - 120), index + match[0].length + 120);
    if (
      /\b(?:salary|compensation|base pay|pay range|annual base|day rate|hourly rate|per annum|annually|a year|per year|a day|per day|\/day)\b/i.test(
        context,
      )
    ) {
      return `advertised compensation ${match[0].replaceAll(/\s+/g, " ").trim()}`;
    }
  }
  return null;
}

function normalizeCompany(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
