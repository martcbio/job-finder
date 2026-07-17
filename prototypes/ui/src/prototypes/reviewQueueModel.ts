import { parseIr35Metadata, stripIr35MetadataLines } from "../../../../src/pipeline/ir35Signals";
import { deriveIr35Status, deriveJobSignals, extractPostedDate } from "../jobSignals";
import type { ReviewQueueRow } from "../types";

export type FacetId =
  | "it_relevance"
  | "type"
  | "location"
  | "workplace"
  | "seniority"
  | "role"
  | "tech"
  | "salary"
  | "confidence"
  | "posted"
  | "source"
  | "ir35";

export type QuickFilterId =
  | "lab"
  | "junk"
  | "non_it"
  | "contract"
  | "permanent"
  | "outside"
  | "inside"
  | "remote"
  | "onsite"
  | "hybrid"
  | "confidence"
  | "posted";

export interface QueueFilter {
  facet: FacetId;
  value: string;
}

export interface QueueSavedView {
  id: string;
  name: string;
  query: string;
  filters: QueueFilter[];
  quick: QuickFilterId[];
  builtIn?: boolean;
}

export interface QueueJobView {
  job: ReviewQueueRow;
  location: string;
  workplace: string;
  seniority: string;
  role: string;
  tech: string[];
  salary: string;
  source: string;
  confidence: number;
  postedAt: Date;
  postedAgeDays: number;
  ir35: "inside" | "outside" | "unknown";
  signalConflict: "ir35_on_permanent" | null;
  itRelevance: ItRelevance;
  employmentType: EmploymentType;
  queueSource: "local" | "lab";
  junk: boolean;
  searchText: string;
}

export type ItRelevance = "it" | "non_it" | "unclear";
export type EmploymentType = "contract" | "permanent" | "unknown";

export function isCrossSourceDuplicate(job: ReviewQueueRow): boolean {
  return job.duplicate_candidates.some(
    (candidate) =>
      candidate.kind === "cross_source" || candidate.reason.startsWith("cross_source_exact;"),
  );
}

export const FACETS: Array<{ id: Exclude<FacetId, "ir35">; label: string }> = [
  { id: "it_relevance", label: "IT relevance" },
  { id: "type", label: "Type" },
  { id: "location", label: "Location / country" },
  { id: "workplace", label: "Workplace" },
  { id: "seniority", label: "Seniority" },
  { id: "role", label: "Role family" },
  { id: "tech", label: "Tech tag" },
  { id: "salary", label: "Salary / rate" },
  { id: "confidence", label: "Confidence" },
  { id: "posted", label: "Posted age" },
  { id: "source", label: "Source" },
];

export const FACET_LABELS: Record<FacetId, string> = {
  it_relevance: "IT relevance",
  type: "Type",
  location: "Location",
  workplace: "Workplace",
  seniority: "Seniority",
  role: "Role",
  tech: "Tech",
  salary: "Salary",
  confidence: "Confidence",
  posted: "Posted",
  source: "Source",
  ir35: "IR35",
};

const IT_TITLE_PATTERNS = [
  /\bsoftware\b/i,
  /\b(?:web|application|mobile) developer\b/i,
  /\b(?:front[ -]?end|back[ -]?end|full[ -]?stack)\b/i,
  /\bdata (?:engineer|scientist|analyst|architect|platform)\b/i,
  /\bplatform engineer\b/i,
  /\bdevops\b/i,
  /\bcloud (?:engineer|architect|developer|consultant)\b/i,
  /\b(?:ai|ml|machine learning) (?:engineer|developer|scientist|architect)\b/i,
  /\b(?:qa|test automation|automation test)\b/i,
  /\b(?:sre|site reliability)\b/i,
  /\b(?:cyber|information|application|cloud) security\b/i,
  /\b(?:security|network|infrastructure|systems) engineer\b/i,
  /\b(?:solutions?|software|data|cloud) architect\b/i,
  /\b(?:it|technical) support\b/i,
] as const;

const IT_TITLE_ONLY_PATTERNS = [/\b(?:ai|ml|artificial intelligence|machine learning)\b/i] as const;

const NON_IT_TITLE_PATTERNS = [
  /\b(?:mechanical|civil|structural|maintenance|electrical) engineer\b/i,
  /\bfield service engineer\b/i,
  /\bservice engineer\b/i,
  /\bshift engineer\b/i,
  /\bgas engineer\b/i,
  /\bmulti[ -]?skilled engineer\b/i,
  /\b(?:hvac|plumbing|automotive|fabrication|cnc|hydraulic)\b/i,
  /\baerospace stress\b/i,
  /\bquantity surveyor\b/i,
] as const;

const IT_SUPPORTING_PATTERNS = [
  ...IT_TITLE_PATTERNS,
  /\b(?:developer|programming|coding|source code|data platform|data engineering)\b/i,
  /\b(?:aws|azure|gcp|kubernetes|docker|terraform|react|typescript|javascript|python|java)\b/i,
  /\b(?:\.net|sql|database|microservices?|rest api|ci\/cd|github|gitlab)\b/i,
  /\b(?:artificial intelligence|machine learning|large language model|llm)\b/i,
] as const;

const NON_IT_SUPPORTING_PATTERNS = [
  ...NON_IT_TITLE_PATTERNS,
  /\b(?:mechanical|civil|structural|maintenance|hvac|plumbing|automotive)\b/i,
  /\b(?:aerospace stress|quantity surveyor|fabrication|cnc|hydraulic|pneumatic)\b/i,
  /\b(?:electrical installation|electrical maintenance|electrical systems?)\b/i,
  /\b(?:field service|shift engineer|service engineer|gas engineer|multi[ -]?skilled)\b/i,
] as const;

const CONTRACT_PATTERNS = [
  /\bcontract(?:or|ing)?\b/i,
  /\bday rate\b/i,
  /(?:£|\$|€)\s?\d[\d,.]*\s*(?:\/|per\s+)(?:day|daily)\b/i,
  /\b\d[\d,.]*\s*(?:pd|p\/d)\b/i,
  /\bfixed[ -]?term\b/i,
] as const;

const IR35_PATTERN = /\b(?:inside|outside|in[ -]?scope of)\s*ir3[45]\b/i;

const PERMANENT_PATTERNS = [
  /\bpermanent\b/i,
  /\bperm\b/i,
  /\bfull[ -]?time\b/i,
  /\bsalar(?:y|ied)\b/i,
  /(?:£|\$|€)\s?\d[\d,.]*\s*(?:k|000)?\s*(?:per annum|p\.?\s*a\.?)\b/i,
] as const;

function queueJobText(job: ReviewQueueRow): {
  title: string;
  body: string;
  metadata: string;
  all: string;
} {
  const metadata = [
    job.category,
    job.rag_focus,
    job.enterprise_focus,
    ...job.classification_labels.map((label) => label.label),
  ]
    .map((value) => value.replace(/[_-]+/g, " "))
    .join("\n");
  const description = job.description_sample ?? "";
  const body = description
    .split("\n")
    .filter(
      (line) =>
        !/^-\s*(?:source|job url|source url|search|search term|location|employment type|posted date|reference|jobserve id|apply url|detail url):/i.test(
          line,
        ),
    )
    .join("\n");
  return {
    title: job.title,
    body,
    metadata,
    all: [job.title, description, metadata].join("\n"),
  };
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

const ROLE_SHAPED_TITLE =
  /\b(?:engineer|developer|architect|analyst|scientist|researcher|designer|manager|director|consultant|specialist|administrator|coordinator|recruiter|technician|lead|head|officer|product|sales|marketing|support|operations|intern|assistant)\b/i;

function normalizedEntityName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function withoutGenericEntityWords(value: string): string {
  return normalizedEntityName(value)
    .split(" ")
    .filter(
      (token) =>
        ![
          "job",
          "jobs",
          "career",
          "careers",
          "hiring",
          "recruitment",
          "board",
          "company",
          "limited",
          "ltd",
          "inc",
          "llc",
          "plc",
        ].includes(token),
    )
    .join(" ");
}

function entityNamesNearlyEqual(left: string, right: string): boolean {
  const normalizedLeft = normalizedEntityName(left);
  const normalizedRight = normalizedEntityName(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  const compactLeft = withoutGenericEntityWords(left);
  const compactRight = withoutGenericEntityWords(right);
  return compactLeft.length >= 3 && compactLeft === compactRight;
}

export function isJunkQueueRow(job: ReviewQueueRow): boolean {
  if (job.queue_source === "lab" || ROLE_SHAPED_TITLE.test(job.title)) return false;
  const identities = [job.company_hint, ...job.source_labels].filter((value): value is string =>
    Boolean(value?.trim()),
  );
  return identities.some((identity) => entityNamesNearlyEqual(job.title, identity));
}

export function deriveItRelevance(job: ReviewQueueRow): ItRelevance {
  const text = queueJobText(job);
  if (matchesAny(text.title, IT_TITLE_PATTERNS) || matchesAny(text.title, IT_TITLE_ONLY_PATTERNS)) {
    return "it";
  }
  if (matchesAny(text.title, NON_IT_TITLE_PATTERNS)) return "non_it";
  if (matchesAny(text.body, IT_SUPPORTING_PATTERNS)) return "it";
  if (matchesAny(text.body, NON_IT_SUPPORTING_PATTERNS)) return "non_it";
  if (matchesAny(text.metadata, IT_SUPPORTING_PATTERNS)) return "it";
  if (matchesAny(text.metadata, NON_IT_SUPPORTING_PATTERNS)) return "non_it";
  return "unclear";
}

export function deriveEmploymentType(job: ReviewQueueRow): EmploymentType {
  const { all } = queueJobText(job);
  if (matchesAny(job.title, CONTRACT_PATTERNS)) return "contract";

  const employmentMetadata = all.match(/^-\s*Employment type:\s*([^\n]+)/im)?.[1]?.trim() ?? "";
  if (/\bcontract\b/i.test(employmentMetadata)) return "contract";
  if (/\b(?:permanent|perm|full[ -]?time)\b/i.test(employmentMetadata)) return "permanent";

  const body = stripIr35MetadataLines(all);
  if (matchesAny(body, CONTRACT_PATTERNS)) return "contract";
  if (matchesAny(all, PERMANENT_PATTERNS)) return "permanent";

  const ir35Metadata = parseIr35Metadata(all);
  if (ir35Metadata.inside === true || ir35Metadata.outside === true) return "contract";
  if (IR35_PATTERN.test(body)) return "contract";
  return "unknown";
}

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeWorkplace(value: string | null): string {
  const lower = value?.toLowerCase() ?? "";
  if (lower.includes("hybrid")) return "Hybrid";
  if (lower.includes("onsite") || lower.includes("on-site") || lower.includes("in-office")) {
    return "Onsite";
  }
  if (lower.includes("remote")) return "Remote";
  return "—";
}

function deriveSeniority(job: ReviewQueueRow): string {
  const text = [job.title, ...job.classification_labels.map((label) => label.label)].join(" ");
  if (/\b(principal|staff|lead|head|director)\b/i.test(text)) return "Senior+";
  if (/\b(senior|sr\.?|expert)\b/i.test(text)) return "Senior";
  if (/\b(mid|intermediate)\b/i.test(text)) return "Mid";
  if (/\b(junior|jr\.?|entry)\b/i.test(text)) return "Junior";
  return "—";
}

function deriveConfidence(value: string | number | null): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed <= 1 ? parsed * 100 : parsed);
}

function deriveSalary(sample: string | null): string {
  const match = sample?.match(
    /(?:£|\$|€)\s?\d[\d,.]*\s?(?:k|K)?(?:\s*[-–]\s*(?:£|\$|€)?\s?\d[\d,.]*\s?(?:k|K)?)?/,
  );
  return match?.[0]?.replace(/\s+/g, " ") ?? "—";
}

function derivePostedAt(job: ReviewQueueRow): Date {
  const rawPosted = extractPostedDate(job.description_sample);
  const absolute = rawPosted ? new Date(rawPosted) : null;
  if (absolute && !Number.isNaN(absolute.getTime())) return absolute;

  const relative = rawPosted?.match(/(\d+)\s*(minute|hour|day|week)s?\s*ago/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs: Record<string, number> = {
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
      week: 604_800_000,
    };
    return new Date(Date.now() - amount * (unitMs[relative[2].toLowerCase()] ?? 0));
  }

  const fallback = new Date(job.last_seen_at);
  return Number.isNaN(fallback.getTime()) ? new Date(0) : fallback;
}

function normalizedLocation(raw: string | null): string {
  if (!raw) return "—";
  return raw
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}

export function toQueueJobView(job: ReviewQueueRow, now = Date.now()): QueueJobView {
  const employmentType = deriveEmploymentType(job);
  const detectedIr35 = deriveIr35Status(job);
  const signalConflict =
    employmentType === "permanent" && detectedIr35 !== "unknown"
      ? ("ir35_on_permanent" as const)
      : null;
  const signals = deriveJobSignals(job);
  const postedAt = derivePostedAt(job);
  const role = signals.categoryShort ?? (job.category ? titleCase(job.category) : "—");
  const location = normalizedLocation(signals.location);
  const workplace = normalizeWorkplace(signals.workplace);
  const seniority = deriveSeniority(job);
  const source = job.source_labels[0] ?? "—";
  const tech = job.classification_labels.map((label) => titleCase(label.label));
  const salary = deriveSalary(job.description_sample);
  const confidence = deriveConfidence(job.classification_confidence);
  const ir35 = employmentType === "contract" ? detectedIr35 : "unknown";
  const itRelevance = deriveItRelevance(job);
  const queueSource = job.queue_source === "lab" ? "lab" : "local";
  const junk = isJunkQueueRow(job);
  const postedAgeDays = Math.max(0, (now - postedAt.getTime()) / 86_400_000);
  const searchText = [
    job.title,
    job.company_hint ?? "",
    location,
    workplace,
    seniority,
    role,
    source,
    ...tech,
    job.description_sample ?? "",
  ]
    .join(" ")
    .toLowerCase();

  return {
    job,
    location,
    workplace,
    seniority,
    role,
    tech,
    salary,
    source,
    confidence,
    postedAt,
    postedAgeDays,
    ir35,
    signalConflict,
    itRelevance,
    employmentType,
    queueSource,
    junk,
    searchText,
  };
}

function facetValues(job: QueueJobView, facet: FacetId): string[] {
  if (facet === "it_relevance") {
    return [job.itRelevance === "it" ? "IT" : job.itRelevance === "non_it" ? "Non-IT" : "Unclear"];
  }
  if (facet === "type") return [titleCase(job.employmentType)];
  if (facet === "tech") return job.tech;
  if (facet === "confidence") {
    if (job.confidence >= 90) return ["90%+"];
    if (job.confidence >= 80) return ["80–89%"];
    if (job.confidence >= 60) return ["60–79%"];
    return ["Below 60%"];
  }
  if (facet === "posted") {
    if (job.postedAgeDays <= 1) return ["Past 24 hours"];
    if (job.postedAgeDays <= 7) return ["Past 7 days"];
    if (job.postedAgeDays <= 30) return ["Past 30 days"];
    return ["Older"];
  }
  if (facet === "ir35") {
    if (job.employmentType !== "contract") return [];
    return [
      job.ir35 === "outside" ? "Outside IR35" : job.ir35 === "inside" ? "Inside IR35" : "Unknown",
    ];
  }
  return [job[facet]];
}

function matchesFilter(job: QueueJobView, filter: QueueFilter): boolean {
  return facetValues(job, filter.facet).some(
    (value) => value.toLowerCase() === filter.value.toLowerCase(),
  );
}

function matchesQuick(job: QueueJobView, quick: QuickFilterId): boolean {
  if (quick === "lab") return job.queueSource === "lab";
  if (quick === "junk") return job.junk;
  if (quick === "non_it") return job.itRelevance === "non_it";
  if (quick === "contract") return job.employmentType === "contract";
  if (quick === "permanent") return job.employmentType === "permanent";
  if (quick === "outside") return job.ir35 === "outside";
  if (quick === "inside") return job.ir35 === "inside";
  if (quick === "remote") return job.workplace === "Remote";
  if (quick === "onsite") return job.workplace === "Onsite";
  if (quick === "hybrid") return job.workplace === "Hybrid";
  if (quick === "confidence") return job.confidence >= 80;
  return job.postedAgeDays <= 7;
}

export function filterQueueJobs(
  jobs: QueueJobView[],
  query: string,
  filters: QueueFilter[],
  quick: QuickFilterId[],
): QueueJobView[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const nonItRequested =
    quick.includes("non_it") ||
    filters.some(
      (filter) => filter.facet === "it_relevance" && filter.value.toLowerCase() === "non-it",
    );
  const labRequested = quick.includes("lab");
  const junkRequested = quick.includes("junk");
  return jobs.filter(
    (job) =>
      (!job.junk || junkRequested) &&
      (job.itRelevance !== "non_it" || nonItRequested || labRequested || junkRequested) &&
      terms.every((term) => job.searchText.includes(term)) &&
      filters.every((filter) => matchesFilter(job, filter)) &&
      quick.every((filter) => matchesQuick(job, filter)),
  );
}

export function facetCounts(jobs: QueueJobView[], facet: FacetId): Array<[string, number]> {
  const counts = new Map<string, number>();
  const countedJobs =
    facet === "it_relevance" ? jobs.filter((job) => !job.junk) : filterQueueJobs(jobs, "", [], []);
  for (const job of countedJobs) {
    for (const value of new Set(facetValues(job, facet))) {
      if (value === "—") continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function defaultSavedViews(jobs: QueueJobView[]): QueueSavedView[] {
  const defaults: QueueSavedView[] = [
    { id: "everything", name: "Everything", query: "", filters: [], quick: [], builtIn: true },
    {
      id: "outside-remote",
      name: "Outside IR35 · Remote",
      query: "",
      filters: [],
      quick: ["outside", "remote"],
      builtIn: true,
    },
  ];
  if (jobs.some((job) => job.searchText.includes("lab"))) {
    defaults.unshift({
      id: "lab-openings",
      name: "Lab openings",
      query: "lab",
      filters: [],
      quick: [],
      builtIn: true,
    });
  } else {
    defaults.unshift({
      id: "high-confidence",
      name: "High confidence",
      query: "",
      filters: [],
      quick: ["confidence"],
      builtIn: true,
    });
  }
  return defaults;
}
