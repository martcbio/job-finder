import { deriveIr35Status, deriveJobSignals, extractPostedDate } from "../jobSignals";
import type { ReviewQueueRow } from "../types";

export type FacetId =
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
  searchText: string;
}

export const FACETS: Array<{ id: Exclude<FacetId, "ir35">; label: string }> = [
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
  const ir35 = deriveIr35Status(job);
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
    searchText,
  };
}

function facetValues(job: QueueJobView, facet: FacetId): string[] {
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
  if (facet === "ir35")
    return [
      job.ir35 === "outside" ? "Outside IR35" : job.ir35 === "inside" ? "Inside IR35" : "Unknown",
    ];
  return [job[facet]];
}

function matchesFilter(job: QueueJobView, filter: QueueFilter): boolean {
  return facetValues(job, filter.facet).some(
    (value) => value.toLowerCase() === filter.value.toLowerCase(),
  );
}

function matchesQuick(job: QueueJobView, quick: QuickFilterId): boolean {
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
  return jobs.filter(
    (job) =>
      terms.every((term) => job.searchText.includes(term)) &&
      filters.every((filter) => matchesFilter(job, filter)) &&
      quick.every((filter) => matchesQuick(job, filter)),
  );
}

export function facetCounts(jobs: QueueJobView[], facet: FacetId): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const job of jobs) {
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
