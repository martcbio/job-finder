import { extractLocation } from "../../../src/pipeline/fastRefresh/utils";
import { isInsideIr35, parseIr35Metadata } from "../../../src/pipeline/ir35Signals";
import { screenJob } from "../../../src/pipeline/jobScreening";
import type { ReviewQueueRow } from "./types";

export interface JobListingSignals {
  location: string | null;
  workplace: string | null;
  insideIr35: boolean;
  categoryShort: string | null;
  chips: string[];
}

export type Ir35Status = "inside" | "outside" | "unknown";

const CATEGORY_SHORT: Record<string, string> = {
  agentic_engineer: "Agentic",
  agentic_architect: "Architect",
  fde: "FDE",
  inference_engineer: "Inference",
  rag_engineer: "RAG",
  ml_platform: "ML platform",
  solutions_architect: "Solutions",
  unclassified: "Unclassified",
  other: "Other",
};

/** From ingest metadata line `- Posted date: …` in description_sample. */
export function extractPostedDate(sample: string | null | undefined): string | null {
  if (!sample) return null;
  const match = sample.match(/(?:^|\n)-?\s*Posted date:\s*([^\n]+)/i);
  return match?.[1]?.trim() ?? null;
}

export function deriveJobSignals(job: ReviewQueueRow): JobListingSignals {
  const text = [job.title, job.company_hint ?? "", job.description_sample ?? ""].join("\n");
  const screening = screenJob({
    title: job.title,
    companyHint: job.company_hint,
    canonicalUrl: job.canonical_url,
    descriptionSample: job.description_sample ?? undefined,
    markdown: null,
    labels: job.classification_labels,
  });

  const location = extractLocation(null, job.description_sample) ?? extractLocationFromText(text);

  const insideIr35 = deriveIr35Status(job) === "inside";

  const workplace = inferWorkplaceLabel(screening, text, insideIr35);
  const categoryShort =
    job.category && job.category !== "unclassified"
      ? (CATEGORY_SHORT[job.category] ?? formatToken(job.category))
      : null;

  const chips: string[] = [];
  if (location) chips.push(location);
  if (workplace) chips.push(workplace);
  if (insideIr35) chips.push("Inside IR35");

  if (job.rag_focus === "yes") chips.push("RAG");
  else if (job.rag_focus === "no") chips.push("No RAG");

  if (job.enterprise_focus === "yes") chips.push("Enterprise");
  else if (job.enterprise_focus === "no") chips.push("SMB");

  if (categoryShort) chips.push(categoryShort);

  const labelHits = job.classification_labels
    .slice(0, 3)
    .map((l) => l.label.replace(/_/g, " "))
    .filter((label) => !chips.some((c) => c.toLowerCase() === label.toLowerCase()));
  chips.push(...labelHits);

  return {
    location,
    workplace,
    insideIr35,
    categoryShort,
    chips: [...new Set(chips)],
  };
}

export function deriveIr35Status(job: ReviewQueueRow): Ir35Status {
  const text = [job.title, job.company_hint ?? "", job.description_sample ?? ""].join("\n");
  const metadata = parseIr35Metadata(text);
  if (metadata.inside === true) return "inside";
  if (metadata.outside === true) return "outside";

  const labels = new Set(job.classification_labels.map((label) => label.label.toLowerCase()));
  if (labels.has("inside_ir35")) return "inside";
  if (labels.has("outside_ir35")) return "outside";
  if (isInsideIr35(text)) return "inside";
  if (/\boutside[\s-]*ir35\b/i.test(text)) return "outside";
  return "unknown";
}

function inferWorkplaceLabel(
  screening: ReturnType<typeof screenJob>,
  text: string,
  insideIr35: boolean,
): string | null {
  const codes = new Set(screening.reasons.map((r) => r.code));

  if (insideIr35 || codes.has("inside_ir35")) return "Inside IR35";
  if (codes.has("regular_hybrid_or_onsite")) return "Hybrid / onsite";
  if (codes.has("country_local_remote")) return "Country-local remote";
  if (codes.has("switzerland_local_or_ambiguous")) return "CH-local / hybrid";

  if (
    /\bworldwide\b|\bwork from anywhere\b|\bremote across europe\b|\bremote in europe\b/i.test(text)
  ) {
    return "Remote (broad)";
  }
  if (/\bfully remote\b|\b100%\s*remote\b|\bremote-first\b/i.test(text)) {
    return "Remote";
  }
  if (/\bhybrid\b/i.test(text)) return "Hybrid";
  if (/\bon[-\s]?site\b|\bin[-\s]?office\b|\bon[-\s]?person\b/i.test(text)) {
    return "Onsite";
  }
  if (/\bremote\b/i.test(text) && !codes.has("location_or_remote_unclear")) {
    return "Remote?";
  }
  if (codes.has("location_or_remote_unclear")) return "Location unclear";

  return null;
}

function extractLocationFromText(text: string): string | null {
  const patterns = [
    /\blocation:\s*([^\n|]+)/i,
    /\bworkplace type:\s*([^\n|]+)/i,
    /\bremote\s*\(\s*([^)]+)\)/i,
    /\b(?:based in|located in)\s+([A-Za-z][A-Za-z\s,.-]{2,40})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.trim();
    if (value && value.length > 2 && value.length < 80) return value;
  }
  return null;
}

function formatToken(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}
